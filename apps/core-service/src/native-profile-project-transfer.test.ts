import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { afterEach, expect, it } from "vitest";
import { NativeProjectHandoffFile } from "../../desktop/src/main/native-project-handoff-file";
import { parseNativeProjectHandoffState } from "../../desktop/src/main/native-project-handoff-state";
import { NativeProfileProjectTransfer } from "./native-profile-project-transfer";

const roots: string[] = [], workers: NativeProfileProjectTransfer[] = [], keys: Buffer[] = [];
afterEach(async () => { for (const worker of workers.splice(0)) await worker.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); for (const key of keys.splice(0)) key.fill(0); });
const at = "2026-11-06T14:00:00.000Z", privateText = "Generated confidential project instructions\nkeep exact";
const record = { id: "custom-project", path: "/never-probe/imported-folder", name: "Custom project", instructions: privateText, createdAt: at, updatedAt: at, order: 0 };
async function fixture(registry = true, now?: () => number) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-project-transfer-"))); roots.push(root);
	const sourceProfileRoot = join(root, "source"), destinationCoreRoot = join(root, "destination");
	for (const folder of [sourceProfileRoot, destinationCoreRoot]) { await mkdir(folder, { mode: 0o700 }); await mkdir(join(folder, "database"), { mode: 0o700 }); }
	const sourceKey = randomBytes(32), destinationKey = randomBytes(32); keys.push(sourceKey, destinationKey);
	const source = join(sourceProfileRoot, "database/kestrel.sqlite"), destination = join(destinationCoreRoot, "database/kestrel.sqlite");
	const db = new KestrelDatabase(source, sourceKey);
	db.saveRuntimeSession({ id: "generated-session", title: "Generated", projectId: record.id, workspaceRoot: record.path, privacyMode: "private", allowedTools: [], status: "active", checkpoints: [], createdAt: at, updatedAt: at });
	db.saveRuntimeMessage({ id: "generated-message", sessionId: "generated-session", role: "user", content: privateText, createdAt: at }); db.close();
	if (registry) await writeFile(join(sourceProfileRoot, "workspace-grants.json"), JSON.stringify([record]), { mode: 0o600 });
	const worker = new NativeProfileProjectTransfer(now); workers.push(worker);
	const handoffId = randomUUID();
	async function request(method: string, values: Record<string, unknown> = {}) { return worker.handle({ requestId: randomUUID(), method, ...values }); }
	async function plan() { return request("plan-profile", { sourceProfileRoot, destinationCoreRoot, handoffId, sourceKeyBase64: sourceKey.toString("base64") }); }
	return { worker, request, plan, handoffId, sourceProfileRoot, destinationCoreRoot, source, destination, sourceKey, destinationKey };
}
function planned(value: Record<string, unknown>) {
	expect(value.ok).toBe(true);
	return value as unknown as { planId: string; preview: { planSha256: string; projectHandoff: { pendingIdentities: number; projects: number; registryPresent: boolean } } };
}

it("binds project metadata and identities to a reviewed encrypted transfer before becoming ready", async () => {
	const f = await fixture(), sourceBytes = await readFile(f.source), registryBytes = await readFile(join(f.sourceProfileRoot, "workspace-grants.json"));
	const plan = planned(await f.plan());
	expect(plan.preview.projectHandoff).toMatchObject({ pendingIdentities: 1, projects: 1, registryPresent: true });
	expect(JSON.stringify(plan)).not.toContain(privateText); expect(JSON.stringify(plan)).not.toContain(record.id);
	expect(await readdir(f.destinationCoreRoot)).toEqual(["database"]);
	const denied = await f.request("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: false, destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(denied).toMatchObject({ ok: false, error: { code: "PLAN_NOT_ACCEPTED" } });
	expect(await readdir(f.destinationCoreRoot)).toEqual(["database"]);
	const applied = await f.request("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(applied).toMatchObject({ ok: true, handoffId: f.handoffId });
	const file = new NativeProjectHandoffFile({ root: f.destinationCoreRoot, key: f.destinationKey });
	try {
		const value = await file.read(f.handoffId), state = parseNativeProjectHandoffState(value.value, f.handoffId);
		expect(state).toMatchObject({ state: "ready", pendingProjectIds: [record.id], reviewedProjectIds: [record.id], settledProjectIds: [], projects: [{ id: record.id, pathHint: record.path, instructions: privateText }] });
		expect(await f.request("verify-profile", { recoveryId: applied.recoveryId })).toMatchObject({ ok: true, handoffId: f.handoffId, recovery: { originalReadable: true, destinationReadable: true, activationPerformed: false } });
		expect(await readFile(join(f.destinationCoreRoot, "pending-project-handoff.json"), "utf8")).not.toContain(privateText);
	} finally { file.close(); }
	expect(await readFile(f.source)).toEqual(sourceBytes); expect(await readFile(join(f.sourceProfileRoot, "workspace-grants.json"))).toEqual(registryBytes);
	expect(await f.request("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") })).toMatchObject({ ok: false, error: { code: "PLAN_EXPIRED" } });
});

it("retains logical references when the source registry is absent", async () => {
	const f = await fixture(false), plan = planned(await f.plan());
	expect(plan.preview.projectHandoff).toMatchObject({ pendingIdentities: 1, projects: 0, registryPresent: false });
	const result = await f.request("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(result.ok).toBe(true);
	const file = new NativeProjectHandoffFile({ root: f.destinationCoreRoot, key: f.destinationKey });
	try { expect(parseNativeProjectHandoffState((await file.read(f.handoffId)).value, f.handoffId)).toMatchObject({ pendingProjectIds: [record.id], projects: [] }); } finally { file.close(); }
});

it("refuses changed registry presence/content and source rows before destination publication", async () => {
	for (const change of ["content", "appears", "database"] as const) {
		const f = await fixture(change !== "appears"), plan = planned(await f.plan());
		if (change === "database") { const db = new KestrelDatabase(f.source, f.sourceKey); db.setPrivateState("changed-fixture", { generated: true }); db.close(); }
		else await writeFile(join(f.sourceProfileRoot, "workspace-grants.json"), JSON.stringify(change === "appears" ? [] : [{ ...record, name: "Changed" }]), { mode: 0o600 });
		const before = await readFile(f.source);
		const applied = await f.request("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") });
		expect(applied.ok).toBe(false); expect(await readdir(f.destinationCoreRoot)).toEqual(["database"]); expect(await readFile(f.source)).toEqual(before);
	}
});

it("refuses reused/malformed keys, expired reviews, wrong hashes and unknown fields", async () => {
	for (const destinationKeyBase64 of ["bad", undefined]) {
		const f = await fixture(), plan = planned(await f.plan());
		const keyValue = destinationKeyBase64 ?? f.sourceKey.toString("base64");
		expect((await f.request("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: keyValue })).ok).toBe(false);
		expect(await readdir(f.destinationCoreRoot)).toEqual(["database"]);
	}
	let now = 0; const f = await fixture(true, () => now), plan = planned(await f.plan());
	expect(await f.request("apply-profile", { planId: plan.planId, acceptedPlanSha256: "changed", approved: true, destinationKeyBase64: f.destinationKey.toString("base64") })).toMatchObject({ ok: false, error: { code: "PLAN_NOT_ACCEPTED" } });
	expect(await f.request("cancel-profile", { planId: plan.planId, extra: true })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
	now = 15 * 60_000; await f.worker.expire();
	expect(await f.request("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") })).toMatchObject({ ok: false, error: { code: "PLAN_EXPIRED" } });
	expect(await readdir(f.destinationCoreRoot)).toEqual(["database"]);
});

it("refuses an independently changed handoff after successful database verification", async () => {
	const f = await fixture(), plan = planned(await f.plan());
	const applied = await f.request("apply-profile", { planId: plan.planId, acceptedPlanSha256: plan.preview.planSha256, approved: true, destinationKeyBase64: f.destinationKey.toString("base64") });
	expect(applied.ok).toBe(true);
	const file = new NativeProjectHandoffFile({ root: f.destinationCoreRoot, key: f.destinationKey });
	try { const before = await file.read(f.handoffId); await file.replace(f.handoffId, { ...before.value, revision: 1 }, before.witness); } finally { file.close(); }
	expect((await f.request("verify-profile", { recoveryId: applied.recoveryId })).ok).toBe(false);
});
