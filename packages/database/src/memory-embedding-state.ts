import { createHmac, randomBytes, randomUUID } from "node:crypto";

export const EMBEDDING_STATE_SECRET_KEY = "kestrel.embedding-generation.v1.secret";
export const EMBEDDING_STATE_OWNER_PREFIX = "kestrel.embedding-generation.v1.owner.";
export type EmbeddingOwnerType =
	| "timeline_event" | "timeline_session" | "activity_block" | "daily_summary"
	| "memory" | "agent_memory" | "task";
export type EmbeddingStateSecret = { version: 1; key: string };
export type EmbeddingOwnerState = {
	version: 1;
	ownerType: EmbeddingOwnerType;
	ownerId: string;
	generation: string;
	fingerprint: string;
};
const OWNER_TYPES = new Set<string>([
	"timeline_event", "timeline_session", "activity_block", "daily_summary", "memory", "agent_memory", "task",
]);
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newEmbeddingStateSecret(): EmbeddingStateSecret {
	return { version: 1, key: randomBytes(32).toString("hex") };
}

export function embeddingMac(secret: EmbeddingStateSecret, domain: string, value: string): string {
	return createHmac("sha256", Buffer.from(secret.key, "hex"))
		.update(domain).update("\0").update(value).digest("hex");
}

export function embeddingOwnerKey(secret: EmbeddingStateSecret, type: EmbeddingOwnerType, id: string): string {
	return `${EMBEDDING_STATE_OWNER_PREFIX}${type}.${embeddingMac(secret, "owner", `${type}\0${id}`)}`;
}

export function newEmbeddingOwnerState(
	ownerType: EmbeddingOwnerType, ownerId: string, fingerprint: string,
): EmbeddingOwnerState {
	return { version: 1, ownerType, ownerId, generation: randomUUID(), fingerprint };
}

/** Validate reserved private-state values and, with a secret, their owner-key binding. */
export function parseReservedEmbeddingState(
	key: string, value: unknown, secret?: EmbeddingStateSecret,
): EmbeddingStateSecret | EmbeddingOwnerState | undefined {
	if (key !== EMBEDDING_STATE_SECRET_KEY && !key.startsWith(EMBEDDING_STATE_OWNER_PREFIX)) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid embedding generation state.");
	const record = value as Record<string, unknown>;
	if (key === EMBEDDING_STATE_SECRET_KEY) {
		if (record.version !== 1 || typeof record.key !== "string" || !HEX.test(record.key) || Object.keys(record).length !== 2)
			throw new Error("Invalid embedding generation secret.");
		return { version: 1, key: record.key };
	}
	if (record.version !== 1 || typeof record.ownerType !== "string" || !OWNER_TYPES.has(record.ownerType) ||
		typeof record.ownerId !== "string" || !record.ownerId || record.ownerId.length > 200 ||
		typeof record.generation !== "string" || !UUID.test(record.generation) ||
		typeof record.fingerprint !== "string" || !HEX.test(record.fingerprint) || Object.keys(record).length !== 5)
		throw new Error("Invalid embedding owner generation state.");
	const parsed = record as EmbeddingOwnerState;
	const prefix = `${EMBEDDING_STATE_OWNER_PREFIX}${parsed.ownerType}.`;
	if (!key.startsWith(prefix) || !HEX.test(key.slice(prefix.length)) ||
		(secret && embeddingOwnerKey(secret, parsed.ownerType, parsed.ownerId) !== key))
		throw new Error("Invalid embedding owner generation binding.");
	return parsed;
}
