import { describe, expect, it } from "vitest";
import { legacyProfileStateKey } from "./legacy-profile-state.js";
import { isLegacyJobConflictPurged, parseLegacyConflictedMemoryJob, parseLegacyPurgedConflictedMemoryJob, parseLegacyPurgedMemoryJobConflict, readLegacyMemoryJobConflict, readLegacyMemoryJobConflictByKey } from "./legacy-memory-job-conflicts.js";

const secret = Buffer.alloc(32, 7), time = "2026-01-01T00:00:00.000Z";
const original = { id: "private-job-1", dedupeKey: "private-dedupe", kind: "embed", status: "pending", payload: { ownerId: "private-owner", nested: { a: 1 } }, attempts: 0, maxAttempts: 3, runAfter: time, createdAt: time, updatedAt: time, leaseToken: "a9a530c0-c8e3-4a51-bebb-90497b0e61c6", unknown: { deep: [1, 2] } };
const jobKey = legacyProfileStateKey(secret, "conflicted-job", original.id);
const groupKey = legacyProfileStateKey(secret, "job-conflict", original.dedupeKey);
function preserved(observed: object) {
	return { version: 1, jobId: original.id, dedupeKey: original.dedupeKey, originalPayloadJson: JSON.stringify(original), observedPayloadJson: JSON.stringify(observed) };
}

describe("preserved memory job validation", () => {
	it("allows only projected SQL fields to differ, ignoring object key order", () => {
		const observed = { ...original, status: "running", attempts: 2, runAfter: "2026-02-01T00:00:00.000Z", lockedAt: time, leaseUntil: time, lastError: "error", updatedAt: time, payload: { nested: { a: 1 }, ownerId: "private-owner" } };
		expect(parseLegacyConflictedMemoryJob(jobKey, preserved(observed), secret)).toEqual(preserved(observed));
	});
	it.each([
		{ ...original, payload: { ownerId: "different", nested: { a: 1 } } },
		{ ...original, unknown: { deep: [2, 1] } },
		{ ...original, extra: "not in original" },
		{ ...original, leaseToken: "b9a530c0-c8e3-4a51-bebb-90497b0e61c6" },
	])("rejects changes outside the SQL projection", observed => {
		expect(() => parseLegacyConflictedMemoryJob(jobKey, preserved(observed), secret)).toThrow();
	});
});

describe("opaque purged memory job fences", () => {
	const otherKey = legacyProfileStateKey(secret, "conflicted-job", "private-job-2");
	const keys = [jobKey, otherKey].sort() as [string, string];
	const group = { version: 1 as const, purged: true as const, jobKeys: keys };
	const job = { version: 1 as const, purged: true as const, groupKey };
	it("validates linked tombstones without retaining private preimages", () => {
		const state = new Map<string, unknown>([[groupKey, group], [jobKey, job], [otherKey, job]]);
		const result = readLegacyMemoryJobConflict(secret, original.dedupeKey, key => state.get(key));
		expect(result).toEqual({ purged: true, group, jobs: [job, job] });
		expect(readLegacyMemoryJobConflictByKey(secret, groupKey, key => state.get(key))).toEqual(result);
		expect(() => readLegacyMemoryJobConflictByKey(secret, "raw-dedupe", key => state.get(key))).toThrow();
		expect(isLegacyJobConflictPurged(group)).toBe(true);
		for (const preimage of [original.id, "private-job-2", original.dedupeKey, original.payload.ownerId]) expect(JSON.stringify([...state])).not.toContain(preimage);
	});
	it("rejects malformed keys, extra fields, unsorted or duplicate references", () => {
		for (const value of [{ ...group, extra: "x" }, { ...group, jobKeys: [keys[1], keys[0]] }, { ...group, jobKeys: [keys[0], keys[0]] }, { ...group, jobKeys: [keys[0], "raw-job-id"] }]) {
			expect(() => parseLegacyPurgedMemoryJobConflict(groupKey, value)).toThrow();
		}
		expect(() => parseLegacyPurgedMemoryJobConflict("raw-dedupe", group)).toThrow();
		expect(() => parseLegacyPurgedConflictedMemoryJob(jobKey, { ...job, payload: original.payload })).toThrow();
		expect(() => parseLegacyPurgedConflictedMemoryJob(jobKey, { ...job, groupKey: "raw-dedupe" })).toThrow();
	});
	it("requires both job references to point back to the group", () => {
		const state = new Map<string, unknown>([[groupKey, group], [jobKey, job], [otherKey, { ...job, groupKey: legacyProfileStateKey(secret, "job-conflict", "another") }]]);
		expect(() => readLegacyMemoryJobConflict(secret, original.dedupeKey, key => state.get(key))).toThrow();
		state.delete(otherKey);
		expect(() => readLegacyMemoryJobConflict(secret, original.dedupeKey, key => state.get(key))).toThrow();
	});
	it("preserves an unrelated retained member when only one job is purged", () => {
		const retainedPayload = { ...original, id: "private-job-2", payload: { ownerId: "other-owner" } };
		const retained = { version: 1, jobId: retainedPayload.id, dedupeKey: retainedPayload.dedupeKey, originalPayloadJson: JSON.stringify(retainedPayload), observedPayloadJson: JSON.stringify(retainedPayload) };
		const state = new Map<string, unknown>([[groupKey, group], [jobKey, job], [otherKey, retained]]);
		const result = readLegacyMemoryJobConflictByKey(secret, groupKey, key => state.get(key));
		expect(result?.purged).toBe(true);
		expect(result?.jobs).toContainEqual(retained);
		expect(JSON.stringify(group)).not.toContain(original.dedupeKey);
		const wrongPayload = { ...retainedPayload, dedupeKey: "wrong-dedupe" };
		state.set(otherKey, { ...retained, dedupeKey: wrongPayload.dedupeKey, originalPayloadJson: JSON.stringify(wrongPayload), observedPayloadJson: JSON.stringify(wrongPayload) });
		expect(() => readLegacyMemoryJobConflictByKey(secret, groupKey, key => state.get(key))).toThrow();
		state.set(otherKey, { ...retained, jobId: "wrong-id" });
		expect(() => readLegacyMemoryJobConflictByKey(secret, groupKey, key => state.get(key))).toThrow();
	});
	it("rejects an opaque group without any purged member", () => {
		const second = { ...original, id: "private-job-2" };
		const retained = { version: 1, jobId: second.id, dedupeKey: second.dedupeKey, originalPayloadJson: JSON.stringify(second), observedPayloadJson: JSON.stringify(second) };
		const state = new Map<string, unknown>([[groupKey, group], [jobKey, preserved(original)], [otherKey, retained]]);
		expect(() => readLegacyMemoryJobConflictByKey(secret, groupKey, key => state.get(key))).toThrow();
	});
});
