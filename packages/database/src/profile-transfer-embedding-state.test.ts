import { createEncryptionKey } from "@kestrel/encryption";
import { afterEach, describe, expect, it } from "vitest";
import {
	EMBEDDING_STATE_SECRET_KEY,
	embeddingOwnerKey,
	newEmbeddingOwnerState,
	newEmbeddingStateSecret,
} from "./memory-embedding-state.js";
import { embeddingAuthorityStateKey, newEmbeddingAuthorityState } from "./memory-embedding-authority.js";
import { KestrelDatabase } from "./index.js";
import { computeHostProfileTransferSemanticHash } from "./profile-transfer.js";

const databases: KestrelDatabase[] = [];
function database(key = createEncryptionKey()): KestrelDatabase {
	const value = new KestrelDatabase(":memory:", key);
	databases.push(value);
	return value;
}
afterEach(() => { for (const value of databases.splice(0)) value.close(); });

function setValidEmbeddingState(db: KestrelDatabase): { secret: ReturnType<typeof newEmbeddingStateSecret>; owner: ReturnType<typeof newEmbeddingOwnerState>; ownerKey: string } {
	const secret = newEmbeddingStateSecret();
	const ownerType = "memory" as const;
	const ownerId = "generated-memory-owner";
	const owner = newEmbeddingOwnerState(ownerType, ownerId, "b".repeat(64));
	const ownerKey = embeddingOwnerKey(secret, ownerType, ownerId);
	db.setPrivateState(EMBEDDING_STATE_SECRET_KEY, secret);
	db.setPrivateState(ownerKey, owner);
	return { secret, owner, ownerKey };
}

describe("host profile transfer embedding state validation", () => {
	it("preserves bound dependency authority epochs under an independent database key", () => {
		const source = database();
		const target = database();
		const { secret } = setValidEmbeddingState(source);
		const state = newEmbeddingAuthorityState("runtime_session", "generated-session", "d".repeat(64));
		const key = embeddingAuthorityStateKey(secret, state.scope, state.identity);
		source.setPrivateState(key, state);
		const snapshot = source.exportHostProfileTransferSnapshot();
		target.importHostProfileTransferSnapshot(snapshot);
		expect(target.getPrivateState(key)).toEqual(state);
		expect(target.exportHostProfileTransferSnapshot().semanticSha256).toBe(snapshot.semanticSha256);
	});

	it("rejects unknown, malformed, missing-secret and incorrectly bound authority epochs", () => {
		const cases: Array<(db: KestrelDatabase) => void> = [
			db => db.setPrivateState("kestrel.embedding-authority.v2.ref.owner.future", { version: 2 }),
			db => db.setPrivateState("kestrel.embedding-authority.v1.unknown", { version: 1 }),
			db => {
				const { secret } = setValidEmbeddingState(db);
				const state = newEmbeddingAuthorityState("capture", "generated-capture", "c".repeat(64));
				db.setPrivateState(embeddingAuthorityStateKey(secret, state.scope, state.identity), { ...state, epoch: "invalid" });
			},
			db => {
				const secret = newEmbeddingStateSecret();
				const state = newEmbeddingAuthorityState("owner", "generated-owner", "c".repeat(64));
				db.setPrivateState(embeddingAuthorityStateKey(secret, state.scope, state.identity), state);
			},
			db => {
				const { secret } = setValidEmbeddingState(db);
				const state = newEmbeddingAuthorityState("owner", "generated-owner", "c".repeat(64));
				db.setPrivateState(embeddingAuthorityStateKey(secret, state.scope, state.identity), { ...state, identity: "different-owner" });
			},
		];
		for (const seed of cases) {
			const source = database(); seed(source);
			expect(() => source.exportHostProfileTransferSnapshot()).toThrow();
		}
	});

	it("rejects a forged authority binding before importing any destination rows", () => {
		const source = database();
		const target = database();
		const { secret } = setValidEmbeddingState(source);
		const state = newEmbeddingAuthorityState("provenance", "generated-provenance", "c".repeat(64));
		const key = embeddingAuthorityStateKey(secret, state.scope, state.identity);
		source.setPrivateState(key, state);
		const snapshot = source.exportHostProfileTransferSnapshot();
		const row = snapshot.rows.private_runtime_state!.find(value => value.values.key === key)!;
		row.cleartext!.value_ciphertext = JSON.stringify({ ...state, identity: "different-provenance" });
		snapshot.semanticSha256 = computeHostProfileTransferSemanticHash(snapshot.rows);
		expect(() => target.importHostProfileTransferSnapshot(snapshot)).toThrow();
		expect(target.db.prepare("SELECT COUNT(*) AS count FROM private_runtime_state").get()).toEqual({ count: 0 });
	});

	it("copies valid reserved state unchanged and re-encrypts it under an independent database key", () => {
		const source = database(createEncryptionKey());
		const target = database(createEncryptionKey());
		const state = setValidEmbeddingState(source);
		const snapshot = source.exportHostProfileTransferSnapshot();

		target.importHostProfileTransferSnapshot(snapshot);

		expect(target.getPrivateState(EMBEDDING_STATE_SECRET_KEY)).toEqual(state.secret);
		expect(target.getPrivateState(state.ownerKey)).toEqual(state.owner);
		expect(target.exportHostProfileTransferSnapshot().semanticSha256).toBe(snapshot.semanticSha256);
	});

	it("preserves older profiles without reserved state and unrelated private JSON", () => {
		const source = database();
		const target = database();
		source.setPrivateState("generated-unrelated-array", ["kept", 7, false, null]);
		const snapshot = source.exportHostProfileTransferSnapshot();

		target.importHostProfileTransferSnapshot(snapshot);

		expect(target.getPrivateState("generated-unrelated-array")).toEqual(["kept", 7, false, null]);
		expect(target.getPrivateState(EMBEDDING_STATE_SECRET_KEY)).toBeUndefined();
		expect(target.exportHostProfileTransferSnapshot().semanticSha256).toBe(snapshot.semanticSha256);
	});

	it("rejects malformed, unsupported, unknown, or unbound reserved source state", () => {
		const cases: Array<(db: KestrelDatabase) => void> = [
			db => db.setPrivateState("kestrel.embedding-generation.v2.secret", { version: 1, key: "a".repeat(64) }),
			db => db.setPrivateState("kestrel.embedding-generation.v1.unknown", { version: 1 }),
			db => db.setPrivateState(EMBEDDING_STATE_SECRET_KEY, { version: 2, key: "a".repeat(64) }),
			db => {
				const state = setValidEmbeddingState(db);
				db.setPrivateState(state.ownerKey, { ...state.owner, ownerId: "different-generated-owner" });
			},
			db => {
				const secret = newEmbeddingStateSecret();
				const owner = newEmbeddingOwnerState("memory", "generated-owner-without-secret", "c".repeat(64));
				db.setPrivateState(embeddingOwnerKey(secret, "memory", owner.ownerId), owner);
			},
		];
		for (const seedCase of cases) {
			const source = database();
			seedCase(source);
			expect(() => source.exportHostProfileTransferSnapshot()).toThrow();
		}
	});

	it("validates keyed binding on a forged snapshot before writing any destination rows", () => {
		const source = database();
		const target = database();
		const state = setValidEmbeddingState(source);
		const snapshot = source.exportHostProfileTransferSnapshot();
		const ownerRow = snapshot.rows.private_runtime_state!.find(row => row.values.key === state.ownerKey)!;
		const owner = JSON.parse(String(ownerRow.cleartext!.value_ciphertext)) as Record<string, unknown>;
		owner.ownerId = "forged-generated-owner";
		ownerRow.cleartext!.value_ciphertext = JSON.stringify(owner);
		snapshot.semanticSha256 = computeHostProfileTransferSemanticHash(snapshot.rows);

		expect(() => target.importHostProfileTransferSnapshot(snapshot)).toThrow();
		expect(target.db.prepare("SELECT COUNT(*) AS count FROM private_runtime_state").get()).toEqual({ count: 0 });
	});

	it("rejects duplicate secret records in a forged snapshot", () => {
		const source = database();
		const target = database();
		setValidEmbeddingState(source);
		const snapshot = source.exportHostProfileTransferSnapshot();
		const secretRow = snapshot.rows.private_runtime_state!.find(row => row.values.key === EMBEDDING_STATE_SECRET_KEY)!;
		snapshot.rows.private_runtime_state!.push(structuredClone(secretRow));
		snapshot.counts.private_runtime_state = (snapshot.counts.private_runtime_state ?? 0) + 1;
		snapshot.semanticSha256 = computeHostProfileTransferSemanticHash(snapshot.rows);

		expect(() => target.importHostProfileTransferSnapshot(snapshot)).toThrow();
		expect(target.db.prepare("SELECT COUNT(*) AS count FROM private_runtime_state").get()).toEqual({ count: 0 });
	});
});
