import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialStore } from "./credential-store";
import { MacOSKeychainCredentialStore } from "./credential-store";
import { PasswordVault } from "./password-vault";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testProtectedStore(root: string): CredentialStore {
	const key = 0x5a;
	return new MacOSKeychainCredentialStore(root, {
		isEncryptionAvailable: () => true,
		encryptString: (value) =>
			Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ key)),
		decryptString: (value) =>
			Buffer.from(Buffer.from(value).map((byte) => byte ^ key)).toString("utf8"),
	});
}

function memoryStore(): CredentialStore {
	const values = new Map<string, string>();
	return {
		read: async (id) => values.get(id),
		write: async (id, value) => {
			values.set(id, value);
		},
		remove: async (id) => {
			values.delete(id);
		},
	};
}

function createVault(now: () => Date = () => new Date()) {
	const root = mkdtempSync(join(tmpdir(), "kestrel-password-vault-"));
	roots.push(root);
	return { vault: new PasswordVault(testProtectedStore(root), undefined, now), root };
}

describe("password vault", () => {
	it("stores encrypted secrets while listing only summaries", async () => {
		const { vault, root } = createVault();
		const summaries = await vault.save({
			origin: "https://accounts.example.test/login?next=%2Fhome",
			title: "Example account",
			username: "person@example.test",
			password: "correct horse battery staple",
		});

		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			origin: "https://accounts.example.test",
			username: "person@example.test",
			title: "Example account",
		});
		expect(summaries[0]).not.toHaveProperty("password");

		const storedPath = join(
			root,
			"secure",
			"passwords",
			"browser-password-vault.bin",
		);
		expect(readFileSync(storedPath).toString("utf8")).not.toContain(
			"correct horse battery staple",
		);
	});

	it("requires the exact HTTPS origin before returning a secret", async () => {
		const { vault } = createVault();
		const [entry] = await vault.save({
			origin: "https://accounts.example.test",
			username: "person",
			password: "a-secret-password",
		});

		expect(
			await vault.getForOrigin(entry!.id, "https://accounts.example.test"),
		).toMatchObject({ password: "a-secret-password" });
		expect(
			await vault.getForOrigin(entry!.id, "https://other.example.test"),
		).toBeUndefined();
		await expect(vault.save({
			origin: "http://accounts.example.test",
			username: "person",
			password: "a-secret-password",
		})).rejects.toThrow("HTTPS");
	});

	it("updates the same origin and username instead of duplicating it", async () => {
		const { vault } = createVault();
		const first = await vault.save({
			origin: "https://example.test",
			username: "person",
			password: "first-password",
		});
		const second = await vault.save({
			origin: "https://example.test/checkout",
			username: "person",
			password: "second-password",
		});

		expect(second).toHaveLength(1);
		expect(second[0]?.id).toBe(first[0]?.id);
		expect(
			await vault.getForOrigin(first[0]!.id, "https://example.test"),
		).toMatchObject({ password: "second-password" });
	});

	it("updates a saved login without changing its identity or exposing its password in summaries", async () => {
		let now = new Date("2026-01-01T00:00:00.000Z");
		const { vault } = createVault(() => now);
		const [saved] = await vault.save({
			origin: "https://accounts.example.test/login",
			title: "Accounts",
			username: "before@example.test",
			password: "before-secret",
		});
		now = new Date("2026-01-02T00:00:00.000Z");

		const summaries = await vault.update(
			saved!.id,
			"after@example.test",
			"after-secret",
		);
		const [updated] = summaries;

		expect(updated).toMatchObject({
			id: saved!.id,
			origin: "https://accounts.example.test",
			username: "after@example.test",
			createdAt: saved!.createdAt,
			updatedAt: "2026-01-02T00:00:00.000Z",
		});
		expect(updated).not.toHaveProperty("password");
		expect(
			await vault.getForOrigin(saved!.id, "https://accounts.example.test"),
		).toMatchObject({ password: "after-secret" });
	});

	it("keeps the current password when an update supplies only a username", async () => {
		const { vault } = createVault();
		const [saved] = await vault.save({
			origin: "https://accounts.example.test",
			username: "before",
			password: "unchanged-secret",
		});

		const summaries = await vault.update(saved!.id, "after");
		expect(summaries[0]).toMatchObject({ id: saved!.id, username: "after" });
		expect(summaries[0]).not.toHaveProperty("password");
		expect(
			await vault.getForOrigin(saved!.id, "https://accounts.example.test"),
		).toMatchObject({ password: "unchanged-secret" });
	});

	it("rejects colliding and stale login updates without changing the vault", async () => {
		const { vault } = createVault();
		const [first] = await vault.save({
			origin: "https://accounts.example.test",
			username: "first",
			password: "first-secret",
		});
		const added = await vault.save({
			origin: "https://accounts.example.test",
			username: "second",
			password: "second-secret",
		});
		const second = added.find((entry) => entry.username === "second")!;

		await expect(vault.update(first!.id, "second")).rejects.toThrow(
			"already exists",
		);
		await expect(
			vault.update("password-00000000-0000-4000-8000-000000000000", "stale"),
		).rejects.toThrow("no longer exists");
		expect(await vault.list()).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: first!.id, username: "first" }),
			expect.objectContaining({ id: second!.id, username: "second" }),
		]));
	});

	it("rejects invalid replacement passwords without changing the stored login", async () => {
		const { vault } = createVault();
		const [saved] = await vault.save({
			origin: "https://accounts.example.test",
			username: "person",
			password: "original-secret",
		});

		for (const password of ["", "contains\0nul", "x".repeat(4_097)]) {
			await expect(vault.update(saved!.id, "changed", password)).rejects.toThrow(
				"Passwords must be between 1 and 4,096 characters.",
			);
			expect(
				await vault.getForOrigin(saved!.id, "https://accounts.example.test"),
			).toMatchObject({ username: "person", password: "original-secret" });
		}
	});

	it("persists through a vault restart without returning a secret from list metadata", async () => {
		const { vault, root } = createVault();
		const [saved] = await vault.save({
			origin: "https://accounts.example.test",
			username: "person",
			password: "restart-safe-password",
		});
		const restarted = new PasswordVault(testProtectedStore(root));

		expect(await restarted.list()).toEqual([
			expect.objectContaining({ id: saved!.id, username: "person" }),
		]);
		expect(await restarted.getForOrigin(saved!.id, "https://accounts.example.test")).toMatchObject({
			password: "restart-safe-password",
		});
	});

	it("does not retain decrypted vault entries between privileged operations", async () => {
		const store = memoryStore();
		const writer = new PasswordVault(store);
		const [saved] = await writer.save({
			origin: "https://accounts.example.test",
			username: "person",
			password: "first-ephemeral-password",
		});
		const reader = new PasswordVault(store);
		await reader.list();
		await writer.save({
			origin: "https://accounts.example.test",
			username: "person",
			password: "second-ephemeral-password",
		});

		expect(
			await reader.getForOrigin(saved!.id, "https://accounts.example.test"),
		).toMatchObject({ password: "second-ephemeral-password" });
	});

	it("migrates a legacy encrypted vault into the protected credential store before deleting it", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-password-vault-migration-"));
		roots.push(root);
		const legacy = memoryStore();
		const legacyVault = new PasswordVault(legacy);
		const [legacyEntry] = await legacyVault.save({
			origin: "https://accounts.example.test",
			username: "person",
			password: "migrate-without-plaintext",
		});
		const primary = testProtectedStore(root);
		const migrated = new PasswordVault(primary, legacy);

		expect(await migrated.list()).toEqual([
			expect.objectContaining({ id: legacyEntry!.id, username: "person" }),
		]);
		expect(await legacy.read("browser-password-vault")).toBeUndefined();
		expect(
			readFileSync(
				join(root, "secure", "passwords", "browser-password-vault.bin"),
				"utf8",
			),
		).not.toContain("migrate-without-plaintext");
	});

	it("removes the protected vault when the last entry is removed", async () => {
		const { vault, root } = createVault();
		const [entry] = await vault.save({
			origin: "https://example.test",
			username: "person",
			password: "a-secret-password",
		});
		await vault.remove(entry!.id);

		expect(await vault.list()).toEqual([]);
		expect(() =>
			readFileSync(
				join(
					root,
					"secure",
					"passwords",
					"browser-password-vault.bin",
				),
			),
		).toThrow();
	});
});

describe("protected form profile", () => {
 it("persists encrypted profile info, merges serially, and clears without deleting passwords", async () => {
  const {vault,root} = createVault();
  await vault.save({origin:"https://example.test",username:"fixture",password:"fixture-secret"});
  await Promise.all([vault.saveProfile({name:"Fixture Person"},true),vault.saveProfile({bday:"2000-02-03"},true)]);
  expect(await vault.getProfile()).toEqual({name:"Fixture Person",bday:"2000-02-03"});
  expect(readFileSync(join(root,"secure","passwords","browser-autofill-profile.bin"),"utf8")).not.toContain("Fixture Person");
  await expect(vault.saveProfile({password:"never-store"} as never)).rejects.toThrow();
  await vault.saveProfile({});
  expect(await vault.getProfile()).toEqual({});
  expect(await vault.list()).toHaveLength(1);
 });
});
