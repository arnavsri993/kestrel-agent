import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtectedDatabaseError } from "@kestrel/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureStorageError } from "./credential-broker";
import {
	archiveProtectedProfile,
	startupRecoveryCopy,
} from "./startup-recovery";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, rename: vi.fn(actual.rename) };
});

const roots: string[] = [];

afterEach(() => {
	vi.mocked(rename).mockReset();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("desktop startup recovery copy", () => {
	it("explains the local key action only for secure-storage failures", () => {
		const copy = startupRecoveryCopy(
			new SecureStorageError("The local database key could not be read."),
		);

		expect(copy.message).toBe("Kestrel needs access to its encrypted data.");
		expect(copy.detail).toContain("Restore the local protected database key");
		expect(copy.detail).not.toContain("separate from the protected database key");
	});

	it("does not mislabel Agent Core failures as protected-key failures", () => {
		const copy = startupRecoveryCopy(
			new Error("The active agent configuration is unavailable."),
		);

		expect(copy.message).toBe("Kestrel's local Agent Core could not start.");
		expect(copy.detail).toContain("separate from the protected database key");
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

	it("restores already moved files when a later archive move fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-startup-recovery-"));
		roots.push(root);
		mkdirSync(join(root, "database"));
		mkdirSync(join(root, "secure"));
		writeFileSync(join(root, "database", "kestrel.sqlite"), "database bytes");
		writeFileSync(join(root, "secure", "database-key.bin"), "key bytes");
		const actual = await vi.importActual<typeof import("node:fs/promises")>(
			"node:fs/promises",
		);
		const moveFailure = new Error("Secure directory could not be moved.");
		vi.mocked(rename)
			.mockImplementationOnce(actual.rename)
			.mockRejectedValueOnce(moveFailure);

		await expect(archiveProtectedProfile(root)).rejects.toBe(moveFailure);

		expect(readFileSync(join(root, "database", "kestrel.sqlite"), "utf8")).toBe(
			"database bytes",
		);
		expect(readFileSync(join(root, "secure", "database-key.bin"), "utf8")).toBe(
			"key bytes",
		);
		expect(readdirSync(join(root, "recovery"))).toEqual([]);
	});

	it("preserves the recovery copy and reports its path if rollback also fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-startup-recovery-"));
		roots.push(root);
		mkdirSync(join(root, "database"));
		mkdirSync(join(root, "secure"));
		writeFileSync(join(root, "database", "kestrel.sqlite"), "database bytes");
		writeFileSync(join(root, "secure", "database-key.bin"), "key bytes");
		const actual = await vi.importActual<typeof import("node:fs/promises")>(
			"node:fs/promises",
		);
		const moveFailure = new Error("Secure directory could not be moved.");
		const rollbackFailure = new Error("Database directory could not be restored.");
		vi.mocked(rename)
			.mockImplementationOnce(actual.rename)
			.mockRejectedValueOnce(moveFailure)
			.mockRejectedValueOnce(rollbackFailure);

		const error = await archiveProtectedProfile(root).catch((cause: unknown) => cause);
		const archives = readdirSync(join(root, "recovery"));
		expect(archives).toHaveLength(1);
		const archivePath = join(root, "recovery", archives[0]!);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([moveFailure, rollbackFailure]);
		expect((error as Error).message).toContain(archivePath);
		expect((error as Error).message).toContain("before trying again");
		expect(
			readFileSync(join(archivePath, "database", "kestrel.sqlite"), "utf8"),
		).toBe("database bytes");
		expect(readFileSync(join(root, "secure", "database-key.bin"), "utf8")).toBe(
			"key bytes",
		);
	});
});
