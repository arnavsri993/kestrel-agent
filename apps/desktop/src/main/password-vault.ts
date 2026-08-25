import { randomUUID } from "node:crypto";
import {
	PasswordEntrySchema,
	PasswordEntrySummarySchema,
	type PasswordEntry,
	type PasswordEntryId,
	type PasswordEntrySummary,
} from "@kestrel/shared-types";
import { z } from "zod";
import type { CredentialBroker } from "./credential-broker";

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
		updatedAt: entry.updatedAt,
	});
}

export class PasswordVault {
	private entriesPromise: Promise<PasswordEntry[]> | undefined;

	constructor(private readonly broker: CredentialBroker) {}

	async list(): Promise<PasswordEntrySummary[]> {
		const entries = await this.entries();
		return entries
			.slice()
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.map(summary);
	}

	async listForOrigin(origin: string): Promise<PasswordEntrySummary[]> {
		const normalized = normalizedOrigin(origin);
		return (await this.entries())
			.filter((entry) => entry.origin === normalized)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.map(summary);
	}

	async getForOrigin(
		id: PasswordEntryId,
		origin: string,
	): Promise<PasswordEntry | undefined> {
		const normalized = normalizedOrigin(origin);
		return (await this.entries()).find(
			(entry) => entry.id === id && entry.origin === normalized,
		);
	}

	async save(input: SavePasswordInput): Promise<PasswordEntrySummary[]> {
		const origin = normalizedOrigin(input.origin);
		const username = input.username.trim();
		const title = (input.title?.trim() || titleForOrigin(origin)).slice(0, 200);
		if (username.length > 500)
			throw new Error("Usernames must be 500 characters or fewer.");
		if (
			!input.password ||
			input.password.length > 100_000 ||
			input.password.includes("\0")
		)
			throw new Error("Passwords must be between 1 and 100,000 characters.");

		const now = new Date().toISOString();
		const entries = await this.entries();
		const existing = entries.find(
			(entry) => entry.origin === origin && entry.username === username,
		);
		const next = PasswordEntrySchema.parse({
			id: existing?.id ?? `password-${randomUUID()}`,
			origin,
			title,
			username,
			password: input.password,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		});
		const nextEntries = existing
			? entries.map((entry) => (entry.id === existing.id ? next : entry))
			: [...entries, next];
		if (nextEntries.length > MAX_PASSWORD_ENTRIES)
			throw new Error("Kestrel can store up to 2,000 saved passwords.");
		await this.writeEntries(nextEntries);
		return this.list();
	}

	async remove(id: PasswordEntryId): Promise<PasswordEntrySummary[]> {
		const entries = await this.entries();
		const next = entries.filter((entry) => entry.id !== id);
		if (next.length !== entries.length) await this.writeEntries(next);
		return this.list();
	}

	private async entries(): Promise<PasswordEntry[]> {
		this.entriesPromise ??= this.loadEntries();
		try {
			return await this.entriesPromise;
		} catch (error) {
			this.entriesPromise = undefined;
			throw error;
		}
	}

	private async loadEntries(): Promise<PasswordEntry[]> {
		const raw = await this.broker.getOpaqueSecret(PASSWORD_VAULT_SECRET_ID);
		if (!raw) return [];
		try {
			const parsed: unknown = JSON.parse(raw);
			const vault = StoredPasswordVaultSchema.parse(parsed);
			return vault.entries.map((entry) => PasswordEntrySchema.parse(entry));
		} catch (error) {
			throw new Error("The saved passwords store is malformed.", { cause: error });
		}
	}

	private async writeEntries(entries: PasswordEntry[]): Promise<void> {
		if (entries.length === 0) {
			await this.broker.removeOpaqueSecret(PASSWORD_VAULT_SECRET_ID);
		} else {
			await this.broker.setOpaqueSecret(
				PASSWORD_VAULT_SECRET_ID,
				JSON.stringify({ version: PASSWORD_VAULT_VERSION, entries }),
			);
		}
		this.entriesPromise = Promise.resolve(entries);
	}
}

export { normalizedOrigin as passwordOrigin };
