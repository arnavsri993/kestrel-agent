import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { afterEach, expect, it } from "vitest";
import { HostProfileTransferWorkerState } from "./host-profile-transfer-worker-state";

const roots: string[] = [], keys: Buffer[] = [], workers: HostProfileTransferWorkerState[] = [];
afterEach(() => { for (const worker of workers.splice(0)) worker.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); for (const key of keys.splice(0)) key.fill(0); });
function worker(now?: () => number) { const value = new HostProfileTransferWorkerState(now); workers.push(value); return value; }
const request = (method: string, fields = {}) => ({ requestId: randomUUID(), method, ...fields });
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-core-worker-state-"))); roots.push(root);
	const sourceDatabasePath = join(root, "source", "kestrel.sqlite"), destinationDatabasePath = join(root, "target", "kestrel.sqlite");
	mkdirSync(dirname(sourceDatabasePath), { mode: 0o700 }); mkdirSync(dirname(destinationDatabasePath), { mode: 0o700 });
	const sourceKey = randomBytes(32), destinationKey = randomBytes(32); keys.push(sourceKey, destinationKey);
	const db = new KestrelDatabase(sourceDatabasePath, sourceKey); db.setPrivateState("generated-proof", { value: "PRIVATE_WORKER_FIXTURE_ONLY" }); db.close();
	const plan = (state: HostProfileTransferWorkerState) => state.handle(request("plan", { sourceDatabasePath, destinationDatabasePath, sourceKeyBase64: sourceKey.toString("base64") }));
	return { sourceDatabasePath, destinationDatabasePath, sourceKey, destinationKey, plan,
		apply: (state: HostProfileTransferWorkerState, preview: Record<string, unknown>, approved = true) => state.handle(request("apply", { planId: preview.planId, acceptedPlanSha256: (preview.preview as { planSha256: string }).planSha256, approved, destinationKeyBase64: destinationKey.toString("base64") })) };
}

it("keeps preview content-free and applies once before read-only recovery", () => {
	const state = worker(), value = fixture(), before = readFileSync(value.sourceDatabasePath), plan = value.plan(state);
	expect(plan.ok).toBe(true); expect(JSON.stringify(plan)).not.toContain("PRIVATE_WORKER_FIXTURE_ONLY"); expect(JSON.stringify(plan)).not.toContain(value.sourceKey.toString("base64"));
	expect(readdirSync(dirname(value.destinationDatabasePath))).toEqual([]);
	expect(value.apply(state, plan, false)).toMatchObject({ ok: false, error: { code: "PLAN_NOT_ACCEPTED" } });
	const applied = value.apply(state, plan); expect(applied).toMatchObject({ ok: true, receipt: { activationPerformed: false } });
	expect(value.apply(state, plan)).toMatchObject({ ok: false, error: { code: "PLAN_EXPIRED" } });
	expect(state.handle(request("verify-recovery", { recoveryId: applied.recoveryId }))).toMatchObject({ ok: true, recovery: { originalReadable: true, destinationReadable: true } });
	expect(state.handle(request("discard-recovery", { recoveryId: applied.recoveryId }))).toMatchObject({ ok: true });
	expect(state.handle(request("verify-recovery", { recoveryId: applied.recoveryId }))).toMatchObject({ ok: false, error: { code: "RECOVERY_EXPIRED" } });
	expect(readFileSync(value.sourceDatabasePath)).toEqual(before);
});

it("does not accept a plan from another private worker", () => {
	const first = worker(), second = worker(), value = fixture(), plan = value.plan(first);
	expect(value.apply(second, plan)).toMatchObject({ ok: false, error: { code: "PLAN_EXPIRED" } });
	expect(first.handle(request("cancel", { planId: plan.planId }))).toMatchObject({ ok: true, cancelled: true });
	expect(value.apply(first, plan)).toMatchObject({ ok: false, error: { code: "PLAN_EXPIRED" } });
	expect(readdirSync(dirname(value.destinationDatabasePath))).toEqual([]);
});

it("expires pending reviews and recovery keys without changing files", () => {
	let now = 100; const state = worker(() => now), value = fixture(), plan = value.plan(state);
	now += 15 * 60_000; state.expire();
	expect(value.apply(state, plan)).toMatchObject({ ok: false, error: { code: "PLAN_EXPIRED" } });
	const fresh = value.plan(state), applied = value.apply(state, fresh); expect(applied.ok).toBe(true);
	const target = readFileSync(value.destinationDatabasePath);
	now += 5 * 60_000; state.expire();
	expect(state.handle(request("verify-recovery", { recoveryId: applied.recoveryId }))).toMatchObject({ ok: false, error: { code: "RECOVERY_EXPIRED" } });
	expect(readFileSync(value.destinationDatabasePath)).toEqual(target);
});

it("invalidates an older review when a new plan replaces it", () => {
	const state = worker(), value = fixture(), old = value.plan(state), fresh = value.plan(state);
	expect(old.planId).not.toBe(fresh.planId);
	expect(value.apply(state, old)).toMatchObject({ ok: false, error: { code: "PLAN_EXPIRED" } });
	expect(state.handle(request("cancel", { planId: fresh.planId }))).toMatchObject({ ok: true });
});

it("consumes a changed-source apply instead of leaving reusable execution authority", () => {
	const state = worker(), value = fixture(), plan = value.plan(state);
	const db = new KestrelDatabase(value.sourceDatabasePath, value.sourceKey); db.setPrivateState("later-source-work", { keep: true }); db.close();
	expect(value.apply(state, plan)).toMatchObject({ ok: false, error: { code: "SOURCE_CHANGED" } });
	expect(value.apply(state, plan)).toMatchObject({ ok: false, error: { code: "PLAN_EXPIRED" } });
	expect(readdirSync(dirname(value.destinationDatabasePath))).toEqual([]);
});

it.each([null, { method: "plan", requestId: "PRIVATE_WORKER_FIXTURE_ONLY" }, request("unknown-method"), request("plan", { untrustedPayload: "PRIVATE_WORKER_FIXTURE_ONLY" })])("rejects malformed requests without echoing input or private details", input => {
	const result = worker().handle(input);
	expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", published: false } });
	expect(JSON.stringify(result)).not.toContain("PRIVATE_WORKER_FIXTURE_ONLY");
});
