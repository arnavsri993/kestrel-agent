import { isAbsolute, resolve } from "node:path";
import type { HostProfileFileTransferPlan, HostProfileFileTransferReceipt } from "@kestrel/database";
import { ProjectSchema } from "@kestrel/shared-types";
import { z } from "zod";

export const PROJECT_HANDOFF_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = ProjectSchema.shape.id;
const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const metadata = z.object({ id, name: z.string().min(1).max(200), instructions: z.string().max(20_000).optional(), pathHint: path,
	createdAt: ProjectSchema.shape.createdAt, updatedAt: ProjectSchema.shape.updatedAt, order: z.number().int().nonnegative() }).strict();
const schema = z.object({
	format: z.literal("kestrel-native-project-handoff"), version: z.literal(1), handoffId: z.string().regex(PROJECT_HANDOFF_ID),
	state: z.enum(["prepared", "ready"]), revision: z.number().int().nonnegative(), reviewSha256: sha,
	sourceProfileRoot: path, sourceWitness: z.record(z.string(), z.unknown()),
	corePlan: z.record(z.string(), z.unknown()), receipt: z.record(z.string(), z.unknown()).optional(),
	reviewedProjectIds: z.array(id).max(500), pendingProjectIds: z.array(id).max(500), projects: z.array(metadata).max(500),
	settledProjectIds: z.array(z.object({ id, disposition: z.enum(["connected", "removed"]) }).strict()).max(500),
	connection: z.object({ project: ProjectSchema.omit({ available: true }).strict(), beforeSha256: sha.nullable(), afterSha256: sha }).strict().optional(),
}).strict();
export type NativeProjectHandoffState = Omit<z.infer<typeof schema>, "corePlan" | "receipt"> & {
	corePlan: HostProfileFileTransferPlan; receipt?: HostProfileFileTransferReceipt;
};
export const PROJECT_HANDOFF_INVALID = "The project handoff is unavailable or incomplete. Existing profiles were preserved.";

/** Pending identities and display hints never become workspace grants here. */
export function parseNativeProjectHandoffState(value: unknown, handoffId: string): NativeProjectHandoffState {
	try {
		const parsed = schema.parse(value);
		const reviewed = new Set(parsed.reviewedProjectIds), pending = new Set(parsed.pendingProjectIds), settled = new Set(parsed.settledProjectIds.map(item => item.id));
		if (parsed.handoffId !== handoffId || reviewed.size !== parsed.reviewedProjectIds.length || pending.size !== parsed.pendingProjectIds.length || settled.size !== parsed.settledProjectIds.length ||
			[...pending].some(value => !reviewed.has(value) || settled.has(value)) || [...settled].some(value => !reviewed.has(value)) || pending.size + settled.size !== reviewed.size ||
			new Set(parsed.projects.map(item => item.id)).size !== parsed.projects.length || parsed.projects.some(item => !reviewed.has(item.id))) throw new Error();
		if (parsed.connection && (parsed.state !== "ready" || !pending.has(parsed.connection.project.id))) throw new Error();
		const plan = parsed.corePlan as unknown as HostProfileFileTransferPlan;
		if (plan.format !== "kestrel-host-core-file-transfer" || plan.version !== 1 || !/^[a-f0-9]{64}$/.test(plan.planSha256) ||
			plan.source?.path !== `${parsed.sourceProfileRoot}/database/kestrel.sqlite`) throw new Error();
		const receipt = parsed.receipt as unknown as HostProfileFileTransferReceipt | undefined;
		if (parsed.state === "ready" ? !receipt || receipt.format !== "kestrel-host-core-file-transfer-receipt" || receipt.version !== 1 || receipt.planSha256 !== plan.planSha256 || receipt.destination?.path !== plan.destination?.path || receipt.activationPerformed !== false : receipt !== undefined) throw new Error();
		return parsed as unknown as NativeProjectHandoffState;
	} catch { throw new Error(PROJECT_HANDOFF_INVALID); }
}
