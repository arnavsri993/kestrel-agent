import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtectedDatabaseError } from "@kestrel/database";
import { afterEach, describe, expect, it } from "vitest";
import { SecureStorageError } from "./credential-broker";
import {
	archiveProtectedProfile,
	startupRecoveryCopy,
} from "./startup-recovery";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("desktop startup recovery copy", () => {
	it("explains the Keychain action only for secure-storage failures", () => {
		const copy = startupRecoveryCopy(
			new SecureStorageError("Keychain access was denied."),
		);

		expect(copy.message).toBe("Kestrel needs access to its encrypted data.");
		expect(copy.detail).toContain("Always Allow");
		expect(copy.detail).not.toContain("separate from Keychain");
	});

	it("does not mislabel Agent Core failures as Keychain failures", () => {
		const copy = startupRecoveryCopy(
			new Error("The active agent configuration is unavailable."),
		);

		expect(copy.message).toBe("Kestrel's local Agent Core could not start.");
		expect(copy.detail).toContain("separate from Keychain");
		expect(copy.detail).toContain("active agent configuration");
	});

	it("offers a protected-profile backup instead of a silent reset", () => {
		const copy = startupRecoveryCopy(
			new ProtectedDatabaseError("The encrypted profile could not be decrypted."),
		);

		expect(copy.kind).toBe("protected-database");
		expect(copy.detail).toContain("will not overwrite or delete");
		expect(copy.detail).toContain("Start fresh (keep backup)");
	});

	it("archives the protected profile without changing its files", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-startup-recovery-"));
		roots.push(root);
		mkdirSync(join(root, "database"), { recursive: true });
		mkdirSync(join(root, "secure"), { recursive: true });
		writeFileSync(join(root, "database", "kestrel.sqlite"), "database bytes");
		writeFileSync(join(root, "secure", "database-key.bin"), "key bytes");

		const archive = await archiveProtectedProfile(
			root,
			new Date("2026-08-15T12:34:56.000Z"),
		);

		expect(
			statSync(join(archive.archivePath, "database", "kestrel.sqlite")).isFile(),
		).toBe(true);
		expect(
			readFileSync(
				join(archive.archivePath, "database", "kestrel.sqlite"),
				"utf8",
			),
		).toBe("database bytes");
		expect(
			readFileSync(
				join(archive.archivePath, "secure", "database-key.bin"),
				"utf8",
			),
		).toBe("key bytes");
		expect(() => statSync(join(root, "database"))).toThrow();
		expect(() => statSync(join(root, "secure"))).toThrow();
	});
});
