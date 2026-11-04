import { mkdtemp, mkdir, writeFile, rename, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CoreRequestSchema, RendererRequestSchema } from "@kestrel/shared-types";
import { KestrelDatabase } from "@kestrel/database";
import { NativeEmbeddingRecoveryHost, type NativeEmbeddingRecoveryHostOptions } from "./native-embedding-recovery-host";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).reverse().map(callback => callback())); });
async function harness() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-embedding-recovery-host-")));
	await mkdir(join(root, "database"), { mode: 0o700 });
	const path = join(root, "database", "kestrel.sqlite");
	await writeFile(path, "generated fixture", { mode: 0o600 });
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const state = { now: Date.parse("2026-11-03T12:00:00Z"), stopped: false, busy: false, rejectStop: false,
		restart: false, beforeGate: undefined as (() => void) | undefined, snapshot: true };
	const keys: Buffer[] = [];
	const review = vi.fn((bindingKey: Buffer) => { keys.push(bindingKey); return state.snapshot ? { jobId: "private-generated-job", binding: "a".repeat(64) } : undefined; });
	const cancel = vi.fn(() => ({ cancelled: true as const }));
	const close = vi.fn();
	const openDatabase = vi.fn((_path: string, _key: Buffer, _options: { readonly: boolean }) => {
		expect(state.stopped).toBe(true);
		return { reviewLegacyEmbeddingLeaseRecovery: review, cancelLegacyEmbeddingLeaseRecovery: cancel, close };
	});
	const gate: NativeEmbeddingRecoveryHostOptions["withStoppedCore"] = async operation => {
		state.beforeGate?.();
		if (state.rejectStop) return { completed: false, error: Error("private provider detail"), coreStatus: "restart-required" };
		state.stopped = true;
		try { return { completed: true, value: await operation(), coreStatus: state.restart ? "restart-required" : "ready" }; }
		catch (error) { return { completed: false, error, coreStatus: state.restart ? "restart-required" : "ready" }; }
		finally { state.stopped = false; }
	};
	const host = new NativeEmbeddingRecoveryHost({ root, encryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"),
		withStoppedCore: gate, openDatabase, isBusy: () => state.busy, now: () => new Date(state.now) });
	cleanup.push(() => host.close());
	async function planId() {
		const response = await host.handle({ type: "native-embedding-recovery-review" });
		expect(response.ok && "nativeEmbeddingRecoveryPreview" in response && response.nativeEmbeddingRecoveryPreview.state).toBe("review");
		if (!response.ok || !("nativeEmbeddingRecoveryPreview" in response) || response.nativeEmbeddingRecoveryPreview.state !== "review") throw Error("missing review");
		expect(JSON.stringify(response)).not.toContain("private-generated-job");
		return response.nativeEmbeddingRecoveryPreview.planId;
	}
	return { root, path, state, host, review, cancel, close, openDatabase, keys, planId };
}
it("keeps the narrow recovery protocol out of Core and refuses client row/path metadata", () => {
	const request = { type: "native-embedding-recovery-apply", planId: randomUUID() };
	expect(RendererRequestSchema.safeParse(request).success).toBe(true);
	expect(CoreRequestSchema.safeParse(request).success).toBe(false);
	expect(RendererRequestSchema.safeParse({ ...request, jobId: "choose-another", path: "/tmp/other" }).success).toBe(false);
});
it("opens only inside the stopped-Core witness, consumes apply once, and wipes its private binding", async () => {
	const h = await harness(), planId = await h.planId();
	expect(h.openDatabase.mock.calls[0]![2]).toEqual({ readonly: true });
	expect(await h.host.handle({ type: "native-embedding-recovery-apply", planId })).toEqual({ ok: true, nativeEmbeddingRecoveryApplied: { cancelledJobs: 1, coreStatus: "ready" } });
	expect(h.openDatabase.mock.calls[1]![2]).toEqual({ readonly: false });
	expect(h.cancel).toHaveBeenCalledOnce();
	expect(h.keys[0]!.every(byte => byte === 0)).toBe(true);
	expect((await h.host.handle({ type: "native-embedding-recovery-apply", planId })).ok).toBe(false);
	expect(h.cancel).toHaveBeenCalledOnce();
});
it("refuses busy or unconfirmed shutdown without opening the database", async () => {
	const h = await harness(); h.state.busy = true;
	expect((await h.host.handle({ type: "native-embedding-recovery-review" })).ok).toBe(false);
	h.state.busy = false; h.state.rejectStop = true;
	const response = await h.host.handle({ type: "native-embedding-recovery-review" });
	expect(response.ok).toBe(false); expect(h.openDatabase).not.toHaveBeenCalled();
	expect(JSON.stringify(response)).not.toContain("private provider detail");
});
it("does not issue a usable plan if Core could not be restored after preview", async () => {
	const h = await harness(); h.state.restart = true;
	expect((await h.host.handle({ type: "native-embedding-recovery-review" })).ok).toBe(false);
	expect(h.keys[0]!.every(byte => byte === 0)).toBe(true);
	expect(h.cancel).not.toHaveBeenCalled();
});
it("preserves committed success when restart fails or cancellation arrives after commit", async () => {
	const h = await harness(), planId = await h.planId(); h.state.restart = true;
	const abort = new AbortController();
	h.cancel.mockImplementationOnce(() => { abort.abort(); return { cancelled: true }; });
	expect(await h.host.handle({ type: "native-embedding-recovery-apply", planId }, abort.signal)).toEqual({ ok: true, nativeEmbeddingRecoveryApplied: { cancelledJobs: 1, coreStatus: "restart-required" } });
});
it("expires plans before effect, including time spent waiting for shutdown", async () => {
	const h = await harness(), planId = await h.planId();
	h.state.beforeGate = () => { h.state.now += 120_000; };
	expect((await h.host.handle({ type: "native-embedding-recovery-apply", planId })).ok).toBe(false);
	expect(h.cancel).not.toHaveBeenCalled();
	expect(h.keys[0]!.every(byte => byte === 0)).toBe(true);
});
it("refuses changed database identity or unsafe named links before writable open", async () => {
	const h = await harness(), planId = await h.planId();
	await rename(h.path, h.path + ".old"); await writeFile(h.path, "replacement", { mode: 0o600 });
	expect((await h.host.handle({ type: "native-embedding-recovery-apply", planId })).ok).toBe(false);
	expect(h.openDatabase).toHaveBeenCalledOnce(); expect(h.cancel).not.toHaveBeenCalled();
	await rm(h.path); await symlink(h.path + ".old", h.path);
	expect((await h.host.handle({ type: "native-embedding-recovery-review" })).ok).toBe(false);
	expect(h.openDatabase).toHaveBeenCalledOnce();
});
it("discards only the matching plan, reports no work without a token, and closes late admission", async () => {
	const h = await harness(), old = await h.planId(), current = await h.planId();
	await h.host.handle({ type: "native-embedding-recovery-discard", planId: old });
	expect((await h.host.handle({ type: "native-embedding-recovery-apply", planId: current })).ok).toBe(true);
	h.state.snapshot = false;
	expect(await h.host.handle({ type: "native-embedding-recovery-review" })).toEqual({ ok: true, nativeEmbeddingRecoveryPreview: { state: "not-needed", coreStatus: "ready" } });
	await h.host.close();
	expect((await h.host.handle({ type: "native-embedding-recovery-review" })).ok).toBe(false);
});
it("repairs a real encrypted fixture without preview writes or resetting terminal budgets", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-real-lease-review-")));
	await mkdir(join(root, "database"), { mode: 0o700 });
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "database", "kestrel.sqlite"), key = Buffer.alloc(32, 13), now = new Date().toISOString();
	let db = new KestrelDatabase(path, key);
	db.upsertMemory({ id: "generated-owner", type: "semantic", content: "Generated private fixture only", sourceIds: [], sourceType: "fixture", structuredData: {}, confidence: 1, importance: 0.5, sensitivity: "personal", status: "active", entityIds: [], userConfirmed: true, inferred: false, createdAt: now, updatedAt: now });
	db.queueMemoryJob({ id: "generated-legacy", kind: "embed", dedupeKey: "generated-old-dedupe", payload: { ownerType: "memory", ownerId: "generated-owner" }, status: "running", attempts: 2, maxAttempts: 3, runAfter: now, lockedAt: now, createdAt: now, updatedAt: now });
	expect(db.migrateLegacyMemoryEmbeddingIdentifiers(now).blocked).toBe(true); db.close();
	const gate: NativeEmbeddingRecoveryHostOptions["withStoppedCore"] = async operation => ({ completed: true, value: await operation(), coreStatus: "ready" });
	const host = new NativeEmbeddingRecoveryHost({ root, encryptionKeyBase64: key.toString("base64"), withStoppedCore: gate }); cleanup.push(() => host.close());
	const reviewed = await host.handle({ type: "native-embedding-recovery-review" });
	if (!reviewed.ok || !("nativeEmbeddingRecoveryPreview" in reviewed) || reviewed.nativeEmbeddingRecoveryPreview.state !== "review") throw Error("Expected a real review");
	expect(JSON.stringify(reviewed)).not.toContain("Generated private fixture");
	db = new KestrelDatabase(path, key); expect(db.getMemoryJob("generated-legacy")?.status).toBe("running"); db.close();
	expect((await host.handle({ type: "native-embedding-recovery-apply", planId: reviewed.nativeEmbeddingRecoveryPreview.planId })).ok).toBe(true);
	db = new KestrelDatabase(path, key);
	try {
		expect(db.getMemoryJob("generated-legacy")).toMatchObject({ status: "cancelled", attempts: 2, maxAttempts: 3 });
		for (let i = 0; i < 8; i++) if (db.migrateLegacyMemoryEmbeddingIdentifiers(now).done) break;
		expect(db.listMemoryJobs({ kind: "embed", limit: 100 }).some(job => job.status === "cancelled" && job.attempts === 2 && job.maxAttempts === 3 && Boolean(job.payload.generation))).toBe(true);
		expect(db.listMemoryEmbeddings({ ownerType: "memory", ownerId: "generated-owner" })).toHaveLength(0);
	} finally { db.close(); }
});
