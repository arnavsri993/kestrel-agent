import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEncryptionKey, decryptText } from "@kestrel/encryption";
import { MemoryJobSchema, type MemoryJob } from "@kestrel/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "./index";

const timestamp = "2026-11-02T12:00:00.000Z";
const later = "2026-11-02T12:01:00.000Z";
const opened: KestrelDatabase[] = [];
const directories: string[] = [];

function fixture(onDisk = false) {
	const key = createEncryptionKey();
	let path = ":memory:";
	if (onDisk) {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-job-state-"));
		directories.push(directory);
		path = join(directory, "fixture.sqlite");
	}
	const database = new KestrelDatabase(path, key);
	opened.push(database);
	return { database, key, path };
}

function job(overrides: Partial<MemoryJob> = {}): MemoryJob {
	return MemoryJobSchema.parse({
		id: "generated-job", kind: "cleanup", dedupeKey: "generated-cleanup",
		status: "pending", payload: { fixture: "private generated text" },
		attempts: 0, maxAttempts: 2, runAfter: timestamp,
		createdAt: timestamp, updatedAt: timestamp, ...overrides,
	});
}

function row(database: KestrelDatabase, id = "generated-job") {
	return database.db.prepare("SELECT * FROM memory_jobs WHERE id = ?").get(id) as {
		payload_ciphertext: string; payload_iv: string; payload_auth_tag: string;
		status: string; attempts: number; max_attempts: number; run_after: string;
		locked_at: string | null; lease_until: string | null;
		last_error: string | null; updated_at: string;
	};
}

function expectCoherent(database: KestrelDatabase, key: Buffer, expected: MemoryJob) {
	const stored = row(database, expected.id);
	const decrypted = JSON.parse(decryptText({
		ciphertext: stored.payload_ciphertext, iv: stored.payload_iv,
		authTag: stored.payload_auth_tag,
	}, key));
	// JSON serialization intentionally removes optional undefined properties.
	expect(decrypted).toEqual(JSON.parse(JSON.stringify(expected)));
	expect(stored).toMatchObject({
		status: expected.status, attempts: expected.attempts,
		max_attempts: expected.maxAttempts, run_after: expected.runAfter,
		locked_at: expected.lockedAt ?? null, lease_until: expected.leaseUntil ?? null,
		last_error: expected.lastError ?? null, updated_at: expected.updatedAt,
	});
	expect(database.getMemoryJob(expected.id)).toEqual(expected);
	expect(database.getMemoryJobByDedupeKey(expected.dedupeKey)).toEqual(expected);
	expect(database.listMemoryJobs({ status: expected.status })).toContainEqual(expected);
}

afterEach(() => {
	for (const database of opened.splice(0)) database.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("memory job transition persistence", () => {
	it("returns the acquired lease and preserves completion in SQL, ciphertext and a reopened profile", () => {
		const { database, key, path } = fixture(true);
		database.queueMemoryJob(job());
		const claimed = database.claimMemoryJob(timestamp, 10_000)!;
		expect(claimed).toMatchObject({
			status: "running", attempts: 1, lockedAt: timestamp,
			leaseUntil: "2026-11-02T12:00:10.000Z",
		});
		expectCoherent(database, key, claimed);
		expect(database.claimMemoryJob(timestamp)).toBeUndefined();
		expect(database.completeMemoryJob(claimed.id, later)).toBe(true);
		const completed = database.getMemoryJob(claimed.id)!;
		expect(completed).toMatchObject({ status: "completed", attempts: 1, updatedAt: later });
		expect(completed.lockedAt).toBeUndefined();
		expectCoherent(database, key, completed);
		const reopened = new KestrelDatabase(path, key);
		opened.push(reopened);
		expectCoherent(reopened, key, completed);
		expect(reopened.claimMemoryJob(later)).toBeUndefined();
		expect(reopened.completeMemoryJob(claimed.id, later)).toBe(false);
	});

	it("retries only when due and stops at the actual attempt limit", () => {
		const { database, key } = fixture();
		database.queueMemoryJob(job());
		expect(database.claimMemoryJob(timestamp)?.attempts).toBe(1);
		const retry = database.failMemoryJob("generated-job", "generated failure", timestamp, 10_000)!;
		expect(retry).toMatchObject({ status: "pending", attempts: 1, runAfter: "2026-11-02T12:00:10.000Z" });
		expectCoherent(database, key, retry);
		expect(database.claimMemoryJob(timestamp)).toBeUndefined();
		expect(database.claimMemoryJob(retry.runAfter)?.attempts).toBe(2);
		const failed = database.failMemoryJob(retry.id, "x".repeat(10_001), later)!;
		expect(failed.status).toBe("failed");
		expect(failed.lastError).toHaveLength(10_000);
		expectCoherent(database, key, failed);
		expect(database.claimMemoryJob(later)).toBeUndefined();
		expect(database.failMemoryJob(retry.id, "ignored", later)).toBeUndefined();
	});

	it("reclaims expired leases and exhausts every page without resetting attempts", () => {
		const { database, key } = fixture();
		for (let i = 0; i < 205; i++) database.queueMemoryJob(job({
			id: `expired-${i}`, dedupeKey: `expired-${i}`, status: "running",
			attempts: 2, lockedAt: timestamp, leaseUntil: timestamp,
		}));
		database.queueMemoryJob(job({ attempts: 1, status: "running", lockedAt: timestamp, leaseUntil: timestamp }));
		const claimed = database.claimMemoryJob(later)!;
		expect(claimed).toMatchObject({ id: "generated-job", status: "running", attempts: 2 });
		expectCoherent(database, key, claimed);
		const exhausted = database.listMemoryJobs({ status: "failed", limit: 500 });
		expect(exhausted).toHaveLength(205);
		for (const item of exhausted) {
			expect(item.lastError).toBe("Maximum retry attempts exceeded");
			expect(item.leaseUntil).toBeUndefined();
			expectCoherent(database, key, item);
		}
	});

	it("projects legacy SQL-only transitions without changing source bytes, then repairs on transition", () => {
		const { database, key } = fixture();
		database.queueMemoryJob(job());
		database.db.prepare(`UPDATE memory_jobs SET status='running', attempts=1,
			locked_at=?, lease_until=?, last_error=?, updated_at=? WHERE id=?`)
			.run(timestamp, later, "generated previous error", timestamp, "generated-job");
		const before = row(database);
		const legacy = database.getMemoryJob("generated-job")!;
		expect(legacy).toMatchObject({ status: "running", attempts: 1, lockedAt: timestamp, leaseUntil: later, lastError: "generated previous error" });
		expect(database.getMemoryJobByDedupeKey(legacy.dedupeKey)).toEqual(legacy);
		expect(database.listMemoryJobs({ status: "running" })).toEqual([legacy]);
		expect(row(database)).toEqual(before);
		expect(database.completeMemoryJob(legacy.id, later)).toBe(true);
		expectCoherent(database, key, database.getMemoryJob(legacy.id)!);
	});

	it("retains explicit queue updates, including retry policy changes", () => {
		const { database, key } = fixture();
		database.queueMemoryJob(job());
		const replacement = job({ maxAttempts: 3, createdAt: later, updatedAt: later });
		database.queueMemoryJob(replacement);
		expectCoherent(database, key, replacement);
	});

	it.each(["kind", "dedupe_key", "max_attempts", "created_at"])("refuses mismatched legacy identity: %s", (column) => {
		const { database } = fixture();
		database.queueMemoryJob(job());
		const value = column === "max_attempts" ? 3 : column === "kind" ? "embed" : column === "created_at" ? later : "other-generated-key";
		database.db.prepare(`UPDATE memory_jobs SET ${column}=?`).run(value);
		expect(() => database.getMemoryJob("generated-job")).toThrow("identity does not match");
	});

	it("rolls back already-reclaimed rows if a later legacy row is corrupt", () => {
		const { database } = fixture();
		for (const id of ["a-generated", "z-generated"]) database.queueMemoryJob(job({
			id, dedupeKey: id, status: "running", attempts: 1, lockedAt: timestamp, leaseUntil: timestamp,
		}));
		database.db.prepare("UPDATE memory_jobs SET dedupe_key='corrupt-generated' WHERE id='z-generated'").run();
		const before = row(database, "a-generated");
		expect(() => database.claimMemoryJob(later)).toThrow("identity does not match");
		expect(row(database, "a-generated")).toEqual(before);
	});

	it("rejects malformed mutable metadata and invalid transition parameters without writes", () => {
		const { database } = fixture();
		database.queueMemoryJob(job());
		const before = row(database);
		for (const lease of [NaN, Infinity]) expect(() => database.claimMemoryJob(timestamp, lease)).toThrow();
		expect(() => database.claimMemoryJob("November 2, 2026")).toThrow();
		expect(row(database)).toEqual(before);
		database.claimMemoryJob(timestamp);
		const running = row(database);
		expect(() => database.completeMemoryJob("generated-job", "invalid")).toThrow();
		expect(() => database.failMemoryJob("generated-job", "fixture", timestamp, Infinity)).toThrow();
		expect(row(database)).toEqual(running);
		database.db.prepare("UPDATE memory_jobs SET updated_at='not-a-timestamp'").run();
		expect(() => database.getMemoryJob("generated-job")).toThrow();
	});
});
