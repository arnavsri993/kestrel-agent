import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentMemoryRecordSchema, CoreRequestSchema, type AgentMemoryRecord } from "@kestrel/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryManager } from "./memory";
import { MemorySubstrate } from "./memory-substrate";
import { AgentRuntime } from "./runtime";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(file = false) {
	const key = createEncryptionKey();
	const directory = file ? mkdtempSync(join(tmpdir(), "kestrel-reviewed-fade-")) : undefined;
	if (directory) directories.push(directory);
	const database = new KestrelDatabase(directory ? join(directory, "fixture.sqlite") : ":memory:", key);
	const now = () => new Date("2026-07-22T12:00:00.000Z");
	const runtime = new AgentRuntime(database, [], () => now().toISOString());
	const session = runtime.ensureMainSession();
	const legacyMemory = new MemoryManager(database, now);
	const substrate = new MemorySubstrate({ database, legacyMemory, now });
	substrate.attachRuntime(runtime);
	const identity = substrate.ensureAgentIdentity(session);
	function stale(id: string, overrides: Partial<AgentMemoryRecord> = {}) {
		const record = AgentMemoryRecordSchema.parse({
			id, agentId: identity.id, kind: "outcome", horizon: "mid_term", content: `Owned synthetic record ${id}`,
			sourceIds: ["synthetic:cleanup"], taskIds: [], projectIds: [], personIds: [], entityIds: [],
			confidence: 0.6, importance: 0.5, sensitivity: "personal", status: "active", pinned: false, accessCount: 0,
			createdAt: "2025-01-01T00:00:00.000Z", updatedAt: now().toISOString(), lastAccessedAt: "2025-01-01T00:00:00.000Z", fadesAt: "2025-03-01T00:00:00.000Z",
			...overrides,
		});
		database.upsertAgentMemory(record); return record;
	}
	return { database, key, directory, runtime, session, identity, legacyMemory, substrate, stale,
		async close() { await substrate.close(); runtime.close(); database.close(); } };
}

describe("reviewed memory cleanup", () => {
	it("leaves memory unchanged during review, requires approval, and rejects replay", async () => {
		const f = fixture();
		try {
			const record = f.stale("reviewed");
			const preview = f.substrate.planFadeCleanup();
			expect(preview.candidates).toEqual([{ id: record.id, kind: "agent", content: record.content }]);
			expect(f.database.getAgentMemory(record.id)).toEqual(record);
			expect(preview.plan.applied).toBe(false); expect(preview.plan.backupKey).toBeUndefined();
			await expect(f.substrate.applyFadeCleanup(preview.plan.id, false)).rejects.toThrow("approval");
			expect(CoreRequestSchema.safeParse({ type: "memory-fade-apply", planId: preview.plan.id }).success).toBe(false);
			const applied = await f.substrate.applyFadeCleanup(preview.plan.id, true);
			expect(applied.applied).toBe(true); expect(f.database.getAgentMemory(record.id)).toBeUndefined();
			expect(f.database.getPrivateState<{ agentMemories: AgentMemoryRecord[] }>(applied.backupKey!)?.agentMemories).toEqual([record]);
			await expect(f.substrate.applyFadeCleanup(preview.plan.id, true)).rejects.toThrow("expired");
			expect(f.substrate.planFadeCleanup().plan.applied).toBe(false);
		} finally { await f.close(); }
	});

	it.each(["edit", "recall", "pin"])("rejects a %s after review even when updatedAt stays the same", async change => {
		const f = fixture();
		try {
			const record = f.stale("changed"); const preview = f.substrate.planFadeCleanup();
			f.database.upsertAgentMemory({ ...record, ...(change === "edit" ? { content: "Revised owned fixture" } : change === "recall" ? { accessCount: 1 } : { pinned: true }) });
			await expect(f.substrate.applyFadeCleanup(preview.plan.id, true)).rejects.toThrow("changed after review");
			expect(f.database.getAgentMemory(record.id)).toBeDefined();
			expect(f.substrate.getFadeDryRun()?.applied).toBe(false);
		} finally { await f.close(); }
	});

	it("protects kept notes and rejects a superseded plan", async () => {
		const f = fixture();
		try {
			const kept = f.stale("kept"); f.stale("eligible"); f.stale("pinned", { pinned: true });
			f.database.upsertMemoryWorkspaceDocument({ id: `workspace:agent-memory:${kept.id}`, kind: "memory", title: "Saved fixture", text: kept.content, tier: "long_term", domainIds: [], ownerAgentId: f.identity.id, sharing: "owner_only", sourceIds: kept.sourceIds, confidence: kept.confidence, confirmation: "inferred", sensitivity: "personal", passages: [], origin: "legacy", version: 1, createdAt: kept.createdAt, updatedAt: kept.updatedAt });
			const first = f.substrate.planFadeCleanup(); expect(first.candidates.map(item => item.id)).toEqual(["eligible"]);
			f.stale("added"); const next = f.substrate.planFadeCleanup(); expect(next.plan.id).not.toBe(first.plan.id);
			await expect(f.substrate.applyFadeCleanup(first.plan.id, true)).rejects.toThrow("expired");
			await f.substrate.applyFadeCleanup(next.plan.id, true);
			expect(f.database.getAgentMemory(kept.id)).toBeDefined(); expect(f.database.getAgentMemory("pinned")).toBeDefined();
		} finally { await f.close(); }
	});

	it("rolls back all removals and the receipt when one deletion fails", async () => {
		const f = fixture();
		try {
			f.stale("a"); f.stale("b"); const preview = f.substrate.planFadeCleanup();
			const remove = f.database.deleteAgentMemory.bind(f.database); let calls = 0;
			vi.spyOn(f.database, "deleteAgentMemory").mockImplementation(id => { if (++calls === 2) throw new Error("Synthetic removal failure"); return remove(id); });
			await expect(f.substrate.applyFadeCleanup(preview.plan.id, true)).rejects.toThrow("Synthetic removal failure");
			expect(f.database.getAgentMemory("a")).toBeDefined(); expect(f.database.getAgentMemory("b")).toBeDefined();
			expect(f.substrate.getFadeDryRun()?.applied).toBe(false); expect(f.database.getPrivateState(`memory.fade.backup:${preview.plan.id}`)).toBeUndefined();
		} finally { await f.close(); }
	});

	it("creates a private, restorable WAL snapshot for every later approval", async () => {
		const f = fixture(true);
		try {
			const first = f.stale("first"); const review = f.substrate.planFadeCleanup();
			const applied = await f.substrate.applyFadeCleanup(review.plan.id, true);
			const backup = new KestrelDatabase(applied.backupKey!, f.key);
			try { expect(backup.getAgentMemory(first.id)).toEqual(first); } finally { backup.close(); }
			expect(statSync(applied.backupKey!).mode & 0o777).toBe(0o600);
			expect(readFileSync(applied.backupKey!).includes(Buffer.from(first.content))).toBe(false);
			const second = f.stale("second"); const later = f.substrate.planFadeCleanup();
			const secondApplied = await f.substrate.applyFadeCleanup(later.plan.id, true);
			expect(secondApplied.backupKey).not.toBe(applied.backupKey);
			const laterBackup = new KestrelDatabase(secondApplied.backupKey!, f.key);
			try { expect(laterBackup.getAgentMemory(second.id)).toEqual(second); expect(laterBackup.getAgentMemory(first.id)).toBeUndefined(); } finally { laterBackup.close(); }
		} finally { await f.close(); }
	});

	it("preserves notes when backup fails and rechecks changes made during backup", async () => {
		const f = fixture(true);
		try {
			const record = f.stale("protected"); const preview = f.substrate.planFadeCleanup();
			const backup = f.database.backupBeforeMemoryCleanup.bind(f.database);
			const spy = vi.spyOn(f.database, "backupBeforeMemoryCleanup").mockRejectedValueOnce(new Error("Synthetic backup failure"));
			await expect(f.substrate.applyFadeCleanup(preview.plan.id, true)).rejects.toThrow("Synthetic backup failure");
			expect(f.database.getAgentMemory(record.id)).toEqual(record);
			spy.mockImplementation(async now => { const path = await backup(now); f.database.upsertAgentMemory({ ...record, accessCount: 1 }); return path; });
			await expect(f.substrate.applyFadeCleanup(preview.plan.id, true)).rejects.toThrow("changed after review");
			expect(f.database.getAgentMemory(record.id)?.accessCount).toBe(1); expect(f.substrate.getFadeDryRun()?.applied).toBe(false);
		} finally { await f.close(); }
	});

	it("does not make a backup for an empty review", async () => {
		const f = fixture(true);
		try {
			const preview = f.substrate.planFadeCleanup(); const spy = vi.spyOn(f.database, "backupBeforeMemoryCleanup");
			await expect(f.substrate.applyFadeCleanup(preview.plan.id, true)).rejects.toThrow("no reviewed notes");
			expect(spy).not.toHaveBeenCalled(); expect(readdirSync(f.directory!)).not.toContain("backups");
		} finally { await f.close(); }
	});

	it("rejects cross-session pinning", async () => {
		const f = fixture();
		try {
			const record = f.stale("owned"); const other = f.runtime.createSession({ title: "Other owned fixture", kind: "agent" });
			expect(() => f.substrate.pinAgentMemory(other.id, record.id, true)).toThrow();
			expect(f.database.getAgentMemory(record.id)?.pinned).toBe(false);
			expect(f.substrate.pinAgentMemory(f.session.id, record.id, true).pinned).toBe(true);
		} finally { await f.close(); }
	});

	it("keeps a user-corrected agent note and preserves pins on legacy projections", async () => {
		const f = fixture();
		try {
			const record = f.stale("corrected");
			f.substrate.correctAgentMemory(f.session.id, record.id, "User corrected owned fixture");
			expect(f.substrate.planFadeCleanup().candidates).toEqual([]);
			const legacy = f.substrate.remember({ type: "semantic", content: "Unconfirmed owned fixture", structuredData: {}, sourceIds: ["synthetic:legacy"], sourceType: "fixture", confidence: .5, importance: .5, sensitivity: "personal", entityIds: [], userConfirmed: false, inferred: true });
			f.substrate.pinAgentMemory(f.session.id, `agent-memory-${legacy.id}`, true);
			expect(f.database.getMemory(legacy.id)?.pinned).toBe(true);
			f.substrate.remember({ type: "semantic", content: legacy.content, structuredData: {}, sourceIds: ["synthetic:legacy"], sourceType: "fixture", confidence: .5, importance: .5, sensitivity: "personal", entityIds: [], userConfirmed: false, inferred: true });
			expect(f.database.getAgentMemory(`agent-memory-${legacy.id}`)?.pinned).toBe(true);
		} finally { await f.close(); }
	});
});
