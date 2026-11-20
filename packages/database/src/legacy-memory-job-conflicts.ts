import { MemoryJobSchema, type MemoryJob } from "@kestrel/shared-types";
import { isDeepStrictEqual } from "node:util";
import { LEGACY_JOB_CONFLICT_PREFIX, LEGACY_CONFLICTED_JOB_PREFIX, legacyProfileStateKey, legacyProfileStateKeyMatches } from "./legacy-profile-state.js";

// Only the recognized historical file-transfer adapter creates these records.
// They preserve authenticated payload bytes and observed SQL state separately;
// neither record is a runnable job, lease, approval or authority grant.
export type LegacyConflictedMemoryJob = {
	version: 1; jobId: string; dedupeKey: string;
	originalPayloadJson: string; observedPayloadJson: string;
};
export type LegacyMemoryJobConflict = { version: 1; dedupeKey: string; jobIds: [string, string] };
export type LegacyPurgedMemoryJobConflict = { version: 1; purged: true; jobKeys: [string, string] };
export type LegacyPurgedConflictedMemoryJob = { version: 1; purged: true; groupKey: string };
export type LegacyMemoryJobSourceState = Pick<LegacyConflictedMemoryJob, "originalPayloadJson" | "observedPayloadJson">;
function fail(): never { throw new Error("Invalid preserved memory job conflict."); }
function exact(value: unknown, names: string[]): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
		JSON.stringify(Object.keys(value).sort()) === JSON.stringify(names.sort()));
}
function payload(value: unknown): { parsed: MemoryJob; normalized: Record<string, unknown> } {
	if (typeof value !== "string" || value.length > 8 * 1024 * 1024) fail();
	const raw: unknown = JSON.parse(value), parsed = MemoryJobSchema.parse(raw);
	const normalized: Record<string, unknown> = { ...(raw as Record<string, unknown>), ...parsed };
	for (const field of ["status", "attempts", "runAfter", "lockedAt", "leaseUntil", "lastError", "updatedAt"]) delete normalized[field];
	return { parsed, normalized };
}
export function parseLegacyConflictedMemoryJob(key: string, value: unknown, secret: Buffer): LegacyConflictedMemoryJob {
	if (!exact(value, ["version", "jobId", "dedupeKey", "originalPayloadJson", "observedPayloadJson"]) || value.version !== 1 ||
		!MemoryJobSchema.shape.id.safeParse(value.jobId).success || !MemoryJobSchema.shape.dedupeKey.safeParse(value.dedupeKey).success) fail();
	const originalState = payload(value.originalPayloadJson), observedState = payload(value.observedPayloadJson);
	const original = originalState.parsed, observed = observedState.parsed;
	if (original.id !== value.jobId || observed.id !== value.jobId || original.dedupeKey !== value.dedupeKey || observed.dedupeKey !== value.dedupeKey ||
		!isDeepStrictEqual(originalState.normalized, observedState.normalized) ||
		!legacyProfileStateKeyMatches(key, legacyProfileStateKey(secret, "conflicted-job", original.id))) fail();
	return value as LegacyConflictedMemoryJob;
}
export function parseLegacyMemoryJobConflict(key: string, value: unknown, secret: Buffer): LegacyMemoryJobConflict {
	if (!exact(value, ["version", "dedupeKey", "jobIds"]) || value.version !== 1 ||
		!MemoryJobSchema.shape.dedupeKey.safeParse(value.dedupeKey).success || !Array.isArray(value.jobIds) || value.jobIds.length !== 2 ||
		!value.jobIds.every(id => MemoryJobSchema.shape.id.safeParse(id).success) ||
		typeof value.jobIds[0] !== "string" || typeof value.jobIds[1] !== "string" || value.jobIds[0] >= value.jobIds[1] ||
		!legacyProfileStateKeyMatches(key, legacyProfileStateKey(secret, "job-conflict", String(value.dedupeKey)))) fail();
	return value as LegacyMemoryJobConflict;
}
function opaqueKey(key: unknown, prefix: string): key is string {
	return typeof key === "string" && key.startsWith(prefix) && /^[a-f0-9]{64}$/.test(key.slice(prefix.length));
}
export function isLegacyJobConflictPurged(value: unknown): value is { purged: true } {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).purged === true);
}
export function parseLegacyPurgedMemoryJobConflict(key: string, value: unknown): LegacyPurgedMemoryJobConflict {
	if (!opaqueKey(key, LEGACY_JOB_CONFLICT_PREFIX) || !exact(value, ["version", "purged", "jobKeys"]) || value.version !== 1 || value.purged !== true ||
		!Array.isArray(value.jobKeys) || value.jobKeys.length !== 2 || !value.jobKeys.every(jobKey => opaqueKey(jobKey, LEGACY_CONFLICTED_JOB_PREFIX)) ||
		typeof value.jobKeys[0] !== "string" || typeof value.jobKeys[1] !== "string" || value.jobKeys[0] >= value.jobKeys[1]) fail();
	return value as LegacyPurgedMemoryJobConflict;
}
export function parseLegacyPurgedConflictedMemoryJob(key: string, value: unknown): LegacyPurgedConflictedMemoryJob {
	if (!opaqueKey(key, LEGACY_CONFLICTED_JOB_PREFIX) || !exact(value, ["version", "purged", "groupKey"]) || value.version !== 1 || value.purged !== true ||
		!opaqueKey(value.groupKey, LEGACY_JOB_CONFLICT_PREFIX)) fail();
	return value as LegacyPurgedConflictedMemoryJob;
}
export function readLegacyMemoryJobConflict(secret: Buffer, dedupeKey: string, read: (key: string) => unknown):
	{ purged: false; group: LegacyMemoryJobConflict; jobs: LegacyConflictedMemoryJob[] } |
	{ purged: true; group: LegacyPurgedMemoryJobConflict; jobs: (LegacyPurgedConflictedMemoryJob | LegacyConflictedMemoryJob)[] } | undefined {
	return readLegacyMemoryJobConflictByKey(secret, legacyProfileStateKey(secret, "job-conflict", dedupeKey), read);
}
export function readLegacyMemoryJobConflictByKey(secret: Buffer, groupKey: string, read: (key: string) => unknown):
	{ purged: false; group: LegacyMemoryJobConflict; jobs: LegacyConflictedMemoryJob[] } |
	{ purged: true; group: LegacyPurgedMemoryJobConflict; jobs: (LegacyPurgedConflictedMemoryJob | LegacyConflictedMemoryJob)[] } | undefined {
	if (!opaqueKey(groupKey, LEGACY_JOB_CONFLICT_PREFIX)) fail();
	const stored = read(groupKey);
	if (stored === undefined) return undefined;
	if (isLegacyJobConflictPurged(stored)) {
		const group = parseLegacyPurgedMemoryJobConflict(groupKey, stored);
		const jobs = group.jobKeys.map(key => {
			const value = read(key);
			if (isLegacyJobConflictPurged(value)) {
				const job = parseLegacyPurgedConflictedMemoryJob(key, value);
				if (job.groupKey !== groupKey) fail();
				return job;
			}
			const job = parseLegacyConflictedMemoryJob(key, value, secret);
			if (!legacyProfileStateKeyMatches(groupKey, legacyProfileStateKey(secret, "job-conflict", job.dedupeKey))) fail();
			return job;
		});
		if (!jobs.some(isLegacyJobConflictPurged)) fail();
		return { purged: true, group, jobs };
	}
	const group = parseLegacyMemoryJobConflict(groupKey, stored, secret);
	const jobs = group.jobIds.map(id => {
		const key = legacyProfileStateKey(secret, "conflicted-job", id), job = parseLegacyConflictedMemoryJob(key, read(key), secret);
		if (job.dedupeKey !== group.dedupeKey) fail();
		return job;
	});
	return { purged: false, group, jobs };
}
