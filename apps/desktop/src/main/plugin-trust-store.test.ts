import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTrustStore } from "./plugin-trust-store";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("plugin publisher trust store", () => {
	it("imports, persists, deduplicates, and removes Ed25519 publisher keys", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-plugin-trust-"));
		directories.push(root);
		const document = join(root, "publisher.json");
		const { publicKey } = generateKeyPairSync("ed25519");
		writeFileSync(
			document,
			JSON.stringify({
				keyId: "publisher.test",
				publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
			}),
		);
		const store = new PluginTrustStore(join(root, "trust.json"));
		const imported = await store.importDocument(document);
		expect(imported).toMatchObject({
			keyId: "publisher.test",
			fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(await store.importDocument(document)).toEqual(imported);
		expect(await store.trustKeys()).toMatchObject([
			{ keyId: "publisher.test" },
		]);
		await store.remove("publisher.test");
		expect(await store.list()).toEqual([]);
	});

	it("rejects non-Ed25519 documents and key-ID replacement", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-plugin-trust-reject-"));
		directories.push(root);
		const store = new PluginTrustStore(join(root, "trust.json"));
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
		const invalid = join(root, "rsa.json");
		writeFileSync(
			invalid,
			JSON.stringify({
				keyId: "publisher.test",
				publicKey: rsa.export({ type: "spki", format: "pem" }).toString(),
			}),
		);
		await expect(store.importDocument(invalid)).rejects.toThrow(
			"must be Ed25519",
		);

		const first = generateKeyPairSync("ed25519").publicKey;
		const second = generateKeyPairSync("ed25519").publicKey;
		const document = join(root, "publisher.json");
		writeFileSync(
			document,
			JSON.stringify({
				keyId: "publisher.test",
				publicKey: first.export({ type: "spki", format: "pem" }).toString(),
			}),
		);
		await store.importDocument(document);
		writeFileSync(
			document,
			JSON.stringify({
				keyId: "publisher.test",
				publicKey: second.export({ type: "spki", format: "pem" }).toString(),
			}),
		);
		await expect(store.importDocument(document)).rejects.toThrow(
			"different key",
		);
	});

	it("preserves concurrent imports from separate store instances", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "kestrel-plugin-trust-concurrent-"),
		);
		directories.push(root);
		const firstDocument = join(root, "first.json");
		const secondDocument = join(root, "second.json");
		const firstKey = generateKeyPairSync("ed25519").publicKey;
		const secondKey = generateKeyPairSync("ed25519").publicKey;
		writeFileSync(
			firstDocument,
			JSON.stringify({
				keyId: "first.publisher",
				publicKey: firstKey.export({ type: "spki", format: "pem" }).toString(),
			}),
		);
		writeFileSync(
			secondDocument,
			JSON.stringify({
				keyId: "second.publisher",
				publicKey: secondKey.export({ type: "spki", format: "pem" }).toString(),
			}),
		);
		const first = new PluginTrustStore(join(root, "trust.json"));
		const second = new PluginTrustStore(join(root, "trust.json"));

		await Promise.all([
			first.importDocument(firstDocument),
			second.importDocument(secondDocument),
		]);

		expect(await first.list()).toEqual([
			expect.objectContaining({ keyId: "first.publisher" }),
			expect.objectContaining({ keyId: "second.publisher" }),
		]);
	});
});
