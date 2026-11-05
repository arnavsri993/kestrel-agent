import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { MemoryJobSchema, type MemoryJob } from "@kestrel/shared-types";

// These are encrypted, non-authoritative records. They preserve references and
// diagnostics from the historical schema-19 format without changing schema 18
// or reusing an old database key as a destination index key.
export const LEGACY_PROFILE_STATE_ROOT = "kestrel.legacy-profile19.";
export const LEGACY_PROFILE_STATE_PREFIX = `${LEGACY_PROFILE_STATE_ROOT}v1.`;
export const LEGACY_PROFILE_SECRET_KEY = `${LEGACY_PROFILE_STATE_PREFIX}secret`;
export const LEGACY_JOB_ALIAS_PREFIX = `${LEGACY_PROFILE_STATE_PREFIX}alias.`;
export const LEGACY_DIAGNOSTIC_PREFIX = `${LEGACY_PROFILE_STATE_PREFIX}diagnostic.`;
export type LegacyJobAlias = { version: 1; alias: string; jobId: string; jobKind: MemoryJob["kind"]; jobCreatedAt: string };
export type LegacyDiagnostic = { version: 1; id: string; severity: "error" | "warning"; source: string; createdAt: string; payloadUtf8Base64: string };
function fail(): never { throw new Error("Invalid preserved legacy profile state."); }
function fields(value: unknown, names: string[]): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
		JSON.stringify(Object.keys(value).sort()) === JSON.stringify(names.sort()));
}
function text(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum; }
export function legacyJobAlias(dedupeKey: string): string {
	return `memory-job-${createHash("sha256").update(dedupeKey).digest("hex").slice(0, 40)}`;
}
export function deriveLegacyProfileSecret(sourceKey: Buffer): Buffer {
	return createHmac("sha256", sourceKey).update("kestrel-legacy-profile19-state-secret-v1").digest();
}
export function parseLegacyProfileSecret(value: unknown): Buffer {
	if (!fields(value, ["version", "keyBase64"]) || value.version !== 1 || typeof value.keyBase64 !== "string") fail();
	const key = Buffer.from(value.keyBase64, "base64");
	if (key.length !== 32 || key.toString("base64") !== value.keyBase64) { key.fill(0); fail(); }
	return key;
}
export function legacyProfileStateKey(secret: Buffer, kind: "alias" | "diagnostic", identity: string): string {
	if (secret.length !== 32) fail();
	return `${kind === "alias" ? LEGACY_JOB_ALIAS_PREFIX : LEGACY_DIAGNOSTIC_PREFIX}${createHmac("sha256", secret).update(`kestrel-legacy-profile19-state-v1:${kind}:`).update(identity).digest("hex")}`;
}
function keyMatches(key: string, expected: string): boolean {
	return key.length === expected.length && key.slice(0, -64) === expected.slice(0, -64) && /^[a-f0-9]{64}$/.test(key.slice(-64)) &&
		timingSafeEqual(Buffer.from(key.slice(-64), "hex"), Buffer.from(expected.slice(-64), "hex"));
}
export function parseLegacyJobAlias(key: string, value: unknown, secret: Buffer): LegacyJobAlias {
	if (!fields(value, ["version", "alias", "jobId", "jobKind", "jobCreatedAt"]) || value.version !== 1 ||
		typeof value.alias !== "string" || !/^memory-job-[a-f0-9]{40}$/.test(value.alias) ||
		!MemoryJobSchema.shape.id.safeParse(value.jobId).success || !MemoryJobSchema.shape.kind.safeParse(value.jobKind).success ||
		!MemoryJobSchema.shape.createdAt.safeParse(value.jobCreatedAt).success ||
		!keyMatches(key, legacyProfileStateKey(secret, "alias", value.alias))) fail();
	return value as LegacyJobAlias;
}
export function legacyAliasMatchesJob(alias: LegacyJobAlias, job: MemoryJob): boolean {
	return alias.jobId === job.id && alias.jobKind === job.kind && alias.jobCreatedAt === job.createdAt && alias.alias === legacyJobAlias(job.dedupeKey);
}
export function parseLegacyDiagnostic(key: string, value: unknown, secret: Buffer): LegacyDiagnostic {
	if (!fields(value, ["version", "id", "severity", "source", "createdAt", "payloadUtf8Base64"]) || value.version !== 1 ||
		!text(value.id, 512) || !text(value.source, 10_000) || (value.severity !== "error" && value.severity !== "warning") ||
		!MemoryJobSchema.shape.createdAt.safeParse(value.createdAt).success || typeof value.payloadUtf8Base64 !== "string" ||
		value.payloadUtf8Base64.length > 64 * 1024 * 1024 ||
		Buffer.from(value.payloadUtf8Base64, "base64").toString("base64") !== value.payloadUtf8Base64 ||
		!keyMatches(key, legacyProfileStateKey(secret, "diagnostic", value.id))) fail();
	return value as LegacyDiagnostic;
}
