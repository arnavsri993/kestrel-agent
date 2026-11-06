import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEncryptionKey } from "@kestrel/encryption";
import { EntityRecordSchema } from "@kestrel/shared-types";
import { afterEach, expect, it } from "vitest";
import { KestrelDatabase } from "./index";
import { planHostProfileFileTransfer, reviewHostProfileProjectReferences } from "./host-profile-file-transfer";

const roots: string[] = [], keys: Buffer[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); for (const key of keys.splice(0)) key.fill(0); });
const at = "2026-11-06T14:00:00.000Z";
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-project-review-"))); roots.push(root);
	const sourceRoot = join(root, "source"), destinationRoot = join(root, "destination");
	mkdirSync(sourceRoot, { mode: 0o700 }); mkdirSync(destinationRoot, { mode: 0o700 });
	const sourceKey = createEncryptionKey(); keys.push(sourceKey);
	const sourceDatabasePath = join(sourceRoot, "kestrel.sqlite"), destinationDatabasePath = join(destinationRoot, "kestrel.sqlite");
	const db = new KestrelDatabase(sourceDatabasePath, sourceKey);
	return { db, sourceRoot, destinationRoot, sourceDatabasePath, sourceKey, destinationDatabasePath };
}
function session(db: KestrelDatabase, id: string, projectId: string, privacyMode: "private" | "incognito" = "private") {
	db.saveRuntimeSession({ id, title: "Generated project handoff", projectId, workspaceRoot: "/never-probe-this-project", privacyMode, allowedTools: [], status: "active", checkpoints: [], createdAt: at, updatedAt: at });
	db.saveRuntimeMessage({ id: `message-${id}`, sessionId: id, role: "user", content: "Generated authenticated private fixture", createdAt: at });
}
function entity(db: KestrelDatabase, id: string, status: "active" | "deleted") {
	db.upsertMemoryEntity(EntityRecordSchema.parse({ id: `entity-${id}`, kind: "project", canonicalName: "Generated project", aliases: [], structuredData: { projectId: id, path: "/never-probe-this-project" },
		sourceIds: [`project:${id}`], confidence: 1, sensitivity: "restricted", status, firstSeenAt: at, lastSeenAt: at, createdAt: at, updatedAt: at }));
}

it("reviews authenticated project identities without writing source/destination or reviving deleted entities", () => {
	const f = fixture();
	session(f.db, "a", "custom-project"); session(f.db, "b", "custom-project", "incognito");
	entity(f.db, "orphan-active", "active"); entity(f.db, "deleted-project", "deleted"); f.db.close();
	const sourceBytes = readFileSync(f.sourceDatabasePath), files = readdirSync(f.sourceRoot);
	const plan = planHostProfileFileTransfer(f), planBytes = JSON.stringify(plan);
	expect(reviewHostProfileProjectReferences({ plan, sourceKey: f.sourceKey })).toEqual({ projectIds: ["custom-project", "orphan-active"] });
	expect(JSON.stringify(plan)).toBe(planBytes); expect(readFileSync(f.sourceDatabasePath)).toEqual(sourceBytes);
	expect(readdirSync(f.sourceRoot)).toEqual(files); expect(readdirSync(f.destinationRoot)).toEqual([]);
});

it("rejects changed or unauthenticated sources and tampered plans without disclosing contents", () => {
	const f = fixture(); session(f.db, "a", "custom-project"); f.db.close();
	const plan = planHostProfileFileTransfer(f), wrongKey = createEncryptionKey(); keys.push(wrongKey);
	expect(() => reviewHostProfileProjectReferences({ plan, sourceKey: wrongKey })).toThrow();
	const tampered = structuredClone(plan); tampered.summary.counts.runtime_sessions = 0;
	expect(() => reviewHostProfileProjectReferences({ plan: tampered, sourceKey: f.sourceKey })).toThrow("review is invalid");
	const source = new KestrelDatabase(f.sourceDatabasePath, f.sourceKey); session(source, "b", "another-project"); source.close();
	const before = readFileSync(f.sourceDatabasePath);
	expect(() => reviewHostProfileProjectReferences({ plan, sourceKey: f.sourceKey })).toThrow("source changed");
	expect(readFileSync(f.sourceDatabasePath)).toEqual(before); expect(readdirSync(f.destinationRoot)).toEqual([]);
});

it("refuses unsupported identities or excess unique references instead of dropping them", () => {
	for (const excess of [false, true]) {
		const f = fixture();
		if (excess) { for (let i = 0; i < 501; i++) session(f.db, `s-${i}`, `project-${i}`); }
		else session(f.db, "a", "x".repeat(201));
		f.db.close(); const plan = planHostProfileFileTransfer(f), before = readFileSync(f.sourceDatabasePath);
		expect(() => reviewHostProfileProjectReferences({ plan, sourceKey: f.sourceKey })).toThrow(excess ? "pending-project limit" : "unsupported project identities");
		expect(readFileSync(f.sourceDatabasePath)).toEqual(before); expect(readdirSync(f.destinationRoot)).toEqual([]);
	}
});
