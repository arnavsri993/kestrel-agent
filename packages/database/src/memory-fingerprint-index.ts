import { createHmac, timingSafeEqual } from "node:crypto";

// Keep the historical domain so the reader can authenticate a private-index
// source without rewriting it. New hosts rekey these indexes on import.
export function memoryFingerprintIndex(key: Buffer, purpose: "job-dedupe" | "embedding-content" | "job-alias", value: string): string {
	return createHmac("sha256", key).update(`kestrel-memory-index-v1:${purpose}:`).update(value).digest("hex");
}

export function matchesMemoryFingerprintIndex(key: Buffer, purpose: "job-dedupe" | "embedding-content" | "job-alias", stored: unknown, logical: string): boolean {
	if (purpose !== "job-alias" && stored === logical) return true;
	return typeof stored === "string" && /^[a-f0-9]{64}$/.test(stored) &&
		timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(memoryFingerprintIndex(key, purpose, logical), "hex"));
}
