import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CredentialBroker,
	PlaintextSecretProtection,
} from "./credential-broker";
import { PasswordVault } from "./password-vault";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createVault() {
	const root = mkdtempSync(join(tmpdir(), "kestrel-password-vault-"));
	roots.push(root);
	return new PasswordVault(
		new CredentialBroker(root, new PlaintextSecretProtection()),
	);
}

describe("password vault", () => {
	it("stores encrypted secrets while listing only summaries", async () => {
		const vault = createVault();
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
			(roots[0] as string),
			"secure",
			"credentials",
			"opaque-browser-password-vault.bin",
		);
		expect(readFileSync(storedPath, "utf8")).not.toContain(
			"correct horse battery staple",
		);
	});

	it("requires the exact HTTPS origin before returning a secret", async () => {
		const vault = createVault();
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
		const vault = createVault();
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

	it("removes the protected vault when the last entry is removed", async () => {
		const vault = createVault();
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
					roots[0] as string,
					"secure",
					"credentials",
					"opaque-browser-password-vault.bin",
				),
			),
		).toThrow();
	});
});
