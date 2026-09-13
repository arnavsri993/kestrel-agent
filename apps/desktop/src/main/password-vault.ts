import { randomUUID } from "node:crypto";
import {
	AutofillProfileSchema,
	type AutofillProfile,
	PasswordEntrySchema,
	PasswordEntrySummarySchema,
	type PasswordEntry,
	type PasswordEntryId,
	type PasswordEntrySummary,
} from "@kestrel/shared-types";
import { z } from "zod";
import type { CredentialStore } from "./credential-store";

const PASSWORD_VAULT_SECRET_ID = "browser-password-vault";
const PASSWORD_VAULT_VERSION = 1 as const;
const MAX_PASSWORD_ENTRIES = 2_000;

const StoredPasswordVaultSchema = z.object({
	version: z.literal(PASSWORD_VAULT_VERSION),
	entries: z.array(PasswordEntrySchema).max(MAX_PASSWORD_ENTRIES),
});

export interface SavePasswordInput {
	origin: string;
	title?: string;
	username: string;
	password: string;
	rejectExisting?: boolean;
}

function normalizedOrigin(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Passwords can only be saved for a valid HTTPS website.");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.origin === "null"
	)
		throw new Error("Passwords can only be saved for a valid HTTPS website.");
	return parsed.origin;
}

function titleForOrigin(origin: string): string {
	try {
		return new URL(origin).hostname.replace(/^www\./, "") || origin;
	} catch {
		return origin;
	}
}

function summary(entry: PasswordEntry): PasswordEntrySummary {
	return PasswordEntrySummarySchema.parse({
		id: entry.id,
		origin: entry.origin,
		title: entry.title,
		username: entry.username,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {}),
	});
}

function summaries(entries: PasswordEntry[]): PasswordEntrySummary[] {
	return entries
		.slice()
		.sort((left, right) => {
			const leftAt = left.lastUsedAt ?? left.updatedAt;
			const rightAt = right.lastUsedAt ?? right.updatedAt;
			return rightAt.localeCompare(leftAt);
		})
		.map(summary);
}

/** Best-effort disposal for copies that were decrypted only to complete one
 * main-process operation. JavaScript cannot guarantee zeroization of strings,
 * but keeping no class-level plaintext cache and clearing mutable entry fields
 * keeps their reachable lifetime bounded. */
function disposeEntries(entries: Iterable<PasswordEntry>): void {
	for (const entry of entries) entry.password = "";
}

/**
 * Main-process password metadata and secret vault. The supplied CredentialStore
 * is deliberately narrower than the general credential broker so a browser
 * password never shares Agent Core's storage or transport path.
 */
export class PasswordVault {
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly store: CredentialStore,
		private readonly legacyStore?: CredentialStore,
		private readonly now: () => Date = () => new Date(),
	) {}

	async getProfile(): Promise<AutofillProfile> {
		await this.mutationQueue;
		const raw = await this.store.read("browser-autofill-profile");
		return raw ? AutofillProfileSchema.parse(JSON.parse(raw)) : {};
	}

	async saveProfile(profile: AutofillProfile, merge = false): Promise<AutofillProfile> {
		return this.mutate(async () => {
			const raw = merge ? await this.store.read("browser-autofill-profile") : undefined;
			const previous = raw ? AutofillProfileSchema.parse(JSON.parse(raw)) : {};
			const next = AutofillProfileSchema.parse({ ...previous, ...profile });
			for (const key of Object.keys(next) as (keyof AutofillProfile)[])
				if (!next[key]?.trim()) delete next[key];
			if (Object.keys(next).length) await this.store.write("browser-autofill-profile", JSON.stringify(next));
			else await this.store.remove("browser-autofill-profile");
			return next;
		});
	}

	async list(): Promise<PasswordEntrySummary[]> {
		await this.mutationQueue;
		const entries = await this.loadEntries();
		try {
			return summaries(entries);
		} finally {
			disposeEntries(entries);
		}
	}

	async listForOrigin(origin: string): Promise<PasswordEntrySummary[]> {
		const normalized = normalizedOrigin(origin);
		await this.mutationQueue;
		const entries = await this.loadEntries();
		try {
			return summaries(entries.filter((entry) => entry.origin === normalized));
		} finally {
			disposeEntries(entries);
		}
	}

	async getForOrigin(
		id: PasswordEntryId,
		origin: string,
	): Promise<PasswordEntry | undefined> {
		const normalized = normalizedOrigin(origin);
		await this.mutationQueue;
		const entries = await this.loadEntries();
		try {
			const entry = entries.find(
				(candidate) => candidate.id === id && candidate.origin === normalized,
			);
			return entry ? { ...entry } : undefined;
		} finally {
			disposeEntries(entries);
		}
	}

	async get(id: PasswordEntryId): Promise<PasswordEntry | undefined> {
		await this.mutationQueue;
		const entries = await this.loadEntries();
		try {
			const entry = entries.find((candidate) => candidate.id === id);
			return entry ? { ...entry } : undefined;
		} finally {
			disposeEntries(entries);
		}
	}

	async save(input: SavePasswordInput): Promise<PasswordEntrySummary[]> {
		return this.mutate(async () => {
			const origin = normalizedOrigin(input.origin);
			const username = input.username.trim();
			const title = (input.title?.trim() || titleForOrigin(origin)).slice(0, 200);
			if (username.length > 500)
				throw new Error("Usernames must be 500 characters or fewer.");
			if (
				!input.password ||
				input.password.length > 4_096 ||
				input.password.includes("\0")
			)
				throw new Error("Passwords must be between 1 and 4,096 characters.");

			const now = this.now().toISOString();
			const entries = await this.loadEntries();
			let nextEntries: PasswordEntry[] | undefined;
			try {
				const existing = entries.find(
					(entry) => entry.origin === origin && entry.username === username,
				);
				if (existing && input.rejectExisting)
					throw new Error("This login is already saved. Edit the existing login to change its password.");
				const next = PasswordEntrySchema.parse({
					id: existing?.id ?? `password-${randomUUID()}`,
					origin,
					title,
					username,
					password: input.password,
					createdAt: existing?.createdAt ?? now,
					updatedAt: now,
					...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
				});
				nextEntries = existing
					? entries.map((entry) => (entry.id === existing.id ? next : entry))
					: [...entries, next];
				if (nextEntries.length > MAX_PASSWORD_ENTRIES)
					throw new Error("Kestrel can store up to 2,000 saved passwords.");
				await this.writeEntries(nextEntries);
				return summaries(nextEntries);
			} finally {
				disposeEntries(entries);
				if (nextEntries && nextEntries !== entries) disposeEntries(nextEntries);
			}
		});
	}

	async updateUsername(
		id: PasswordEntryId,
		username: string,
	): Promise<PasswordEntrySummary[]> {
		return this.update(id, username);
	}

	async update(
		id: PasswordEntryId,
		username: string,
		password?: string,
	): Promise<PasswordEntrySummary[]> {
		return this.mutate(async () => {
			const normalizedUsername = username.trim();
			if (normalizedUsername.length > 500)
				throw new Error("Usernames must be 500 characters or fewer.");
			if (password !== undefined && (!password || password.length > 4096 || password.includes("\0")))
				throw new Error("Passwords must be between 1 and 4,096 characters.");
			const entries = await this.loadEntries();
			let nextEntries: PasswordEntry[] | undefined;
			try {
				const existing = entries.find((entry) => entry.id === id);
				if (!existing) throw new Error("That saved login no longer exists.");
				if (
					entries.some(
						(entry) =>
							entry.id !== id &&
							entry.origin === existing.origin &&
							entry.username === normalizedUsername,
					)
				)
					throw new Error(
						"A saved login with that username already exists for this site.",
					);
				const updated = PasswordEntrySchema.parse({
					...existing,
					username: normalizedUsername,
					...(password !== undefined ? { password } : {}),
					updatedAt: this.now().toISOString(),
				});
				nextEntries = entries.map((entry) =>
					entry.id === id ? updated : entry,
				);
				await this.writeEntries(nextEntries);
				return summaries(nextEntries);
			} finally {
				disposeEntries(entries);
				if (nextEntries && nextEntries !== entries) disposeEntries(nextEntries);
			}
		});
	}

	async markUsed(id: PasswordEntryId, origin: string): Promise<void> {
		await this.mutate(async () => {
			const normalized = normalizedOrigin(origin);
			const entries = await this.loadEntries();
			let nextEntries: PasswordEntry[] | undefined;
			try {
				const existing = entries.find(
					(entry) => entry.id === id && entry.origin === normalized,
				);
				if (!existing) return;
				const usedAt = this.now().toISOString();
				nextEntries = entries.map((entry) =>
					entry.id === id ? { ...entry, lastUsedAt: usedAt } : entry,
				);
				await this.writeEntries(nextEntries);
			} finally {
				disposeEntries(entries);
				if (nextEntries && nextEntries !== entries) disposeEntries(nextEntries);
			}
		});
	}

	async remove(id: PasswordEntryId): Promise<PasswordEntrySummary[]> {
		return this.mutate(async () => {
			const entries = await this.loadEntries();
			try {
				const nextEntries = entries.filter((entry) => entry.id !== id);
				if (nextEntries.length !== entries.length)
					await this.writeEntries(nextEntries);
				return summaries(nextEntries);
			} finally {
				disposeEntries(entries);
			}
		});
	}

	private async loadEntries(): Promise<PasswordEntry[]> {
		const raw = await this.store.read(PASSWORD_VAULT_SECRET_ID);
		if (raw) return this.parseEntries(raw);
		if (!this.legacyStore) return [];

		const legacy = await this.legacyStore.read(PASSWORD_VAULT_SECRET_ID);
		if (!legacy) return [];
		const entries = this.parseEntries(legacy);
		// Copy before deletion so a Keychain failure leaves the existing vault
		// recoverable through the legacy broker.
		await this.store.write(PASSWORD_VAULT_SECRET_ID, legacy);
		await this.legacyStore.remove(PASSWORD_VAULT_SECRET_ID);
		return entries;
	}

	private parseEntries(raw: string): PasswordEntry[] {
		try {
			const vault = StoredPasswordVaultSchema.parse(JSON.parse(raw) as unknown);
			return vault.entries.map((entry) => PasswordEntrySchema.parse(entry));
		} catch (error) {
			throw new Error("The saved passwords store is malformed.", { cause: error });
		}
	}

	private async writeEntries(entries: PasswordEntry[]): Promise<void> {
		if (entries.length === 0) await this.store.remove(PASSWORD_VAULT_SECRET_ID);
		else
			await this.store.write(
				PASSWORD_VAULT_SECRET_ID,
				JSON.stringify({ version: PASSWORD_VAULT_VERSION, entries }),
			);
	}

	private mutate<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationQueue.then(operation, operation);
		this.mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export { normalizedOrigin as passwordOrigin };
