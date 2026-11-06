import { randomUUID } from "node:crypto";
import { applyHostProfileFileTransfer, HostProfileFileTransferError, inspectInterruptedHostProfileFileTransfer, planHostProfileFileTransfer, recoverInterruptedHostProfileFileTransfer, verifyHostProfileFileTransferRecovery, type HostProfileFileTransferPlan, type HostProfileFileTransferReceipt, type HostProfileInterruptedTransferReview } from "@kestrel/database";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PLAN_TTL = 15 * 60_000, RECOVERY_TTL = 5 * 60_000;
type Pending = { id: string; plan: HostProfileFileTransferPlan; sourceKey: Buffer; expiresAt: number };
type Recovery = { id: string; receipt: HostProfileFileTransferReceipt; sourceKey: Buffer; destinationKey: Buffer; expiresAt: number };
type Interrupted = { id: string; review: HostProfileInterruptedTransferReview; expiresAt: number };
type Request = Record<string, unknown>;
const invalid = () => new HostProfileFileTransferError("INVALID_REQUEST", "The protected Core transfer request is invalid.");
function key(value: unknown): Buffer {
	if (typeof value !== "string") throw invalid();
	const bytes = Buffer.from(value, "base64");
	if (bytes.length !== 32 || bytes.toString("base64") !== value) { bytes.fill(0); throw invalid(); }
	return bytes;
}
function fields(request: Request, allowed: string[]): void {
	if (Object.keys(request).some(name => !["requestId", "method", ...allowed].includes(name))) throw invalid();
}
function path(value: unknown): string {
	if (typeof value !== "string" || !value.length || value.length > 4096) throw invalid();
	return value;
}

// One instance belongs to one native host's anonymous private pipes. This is
// not registered with Core, the renderer, agents, extensions, sockets or MCP.
// The native host must keep the plan private and obtain human apply consent;
// a JSON `approved` field or plan hash alone is not an authorization boundary.
export class HostProfileTransferWorkerState {
	private pending: Pending | undefined;
	private recovery: Recovery | undefined;
	private interrupted: Interrupted | undefined;
	constructor(private readonly now: () => number = Date.now) {}
	private clearPlan(): void { this.pending?.sourceKey.fill(0); this.pending = undefined; }
	private clearRecovery(): void { this.recovery?.sourceKey.fill(0); this.recovery?.destinationKey.fill(0); this.recovery = undefined; }
	close(): void { this.clearPlan(); this.clearRecovery(); this.interrupted = undefined; }
	expire(): void {
		if (this.pending && this.pending.expiresAt <= this.now()) this.clearPlan();
		if (this.recovery && this.recovery.expiresAt <= this.now()) this.clearRecovery();
		if (this.interrupted && this.interrupted.expiresAt <= this.now()) this.interrupted = undefined;
	}
	handle(input: unknown): Record<string, unknown> {
		this.expire();
		const request = input && typeof input === "object" && !Array.isArray(input) ? input as Request : {};
		const requestId = typeof request.requestId === "string" && UUID.test(request.requestId) ? request.requestId : null;
		try {
			if (!requestId) throw invalid();
			if (request.method === "inspect-interrupted") {
				fields(request, ["destinationDatabasePath"]); this.close();
				const review = inspectInterruptedHostProfileFileTransfer(path(request.destinationDatabasePath));
				this.interrupted = { id: randomUUID(), review, expiresAt: this.now() + PLAN_TTL };
				return { requestId, ok: true, reviewId: this.interrupted.id, expiresAt: this.interrupted.expiresAt,
					preview: { state: review.state, sourceDatabasePath: review.plan.source.path, destinationDatabasePath: review.destinationDatabasePath,
						counts: review.plan.summary.counts, excluded: review.plan.summary.excluded, ...(review.plan.summary.legacy ? { legacy: review.plan.summary.legacy } : {}), recoverySha256: review.recoverySha256 } };
			}
			if (request.method === "recover-interrupted") {
				fields(request, ["reviewId", "acceptedRecoverySha256", "approved", "sourceKeyBase64", "destinationKeyBase64"]);
				if (!this.interrupted || request.reviewId !== this.interrupted.id) throw new HostProfileFileTransferError("RECOVERY_EXPIRED", "The interrupted Core transfer review expired. Inspect it again.");
				if (request.approved !== true || request.acceptedRecoverySha256 !== this.interrupted.review.recoverySha256) throw new HostProfileFileTransferError("PLAN_NOT_ACCEPTED", "Review and accept the exact interrupted Core transfer before recovery.");
				const review = this.interrupted.review; this.interrupted = undefined;
				let sourceKey: Buffer | undefined, destinationKey: Buffer | undefined;
				try {
					sourceKey = key(request.sourceKeyBase64); destinationKey = key(request.destinationKeyBase64);
					delete request.sourceKeyBase64; delete request.destinationKeyBase64;
					const receipt = recoverInterruptedHostProfileFileTransfer({ destinationDatabasePath: review.destinationDatabasePath, sourceKey, destinationKey, acceptedRecoverySha256: review.recoverySha256, retainRecoveryJournal: true });
					this.recovery = { id: randomUUID(), receipt, sourceKey, destinationKey, expiresAt: this.now() + RECOVERY_TTL };
					return { requestId, ok: true, recoveryId: this.recovery.id, expiresAt: this.recovery.expiresAt, receipt };
				} catch (error) { sourceKey?.fill(0); destinationKey?.fill(0); throw error; }
			}
			if (request.method === "plan") {
				fields(request, ["sourceDatabasePath", "destinationDatabasePath", "sourceKeyBase64"]);
				this.close();
				const sourceKey = key(request.sourceKeyBase64); delete request.sourceKeyBase64;
				try {
					const plan = planHostProfileFileTransfer({ sourceDatabasePath: path(request.sourceDatabasePath), sourceKey, destinationDatabasePath: path(request.destinationDatabasePath) });
					this.pending = { id: randomUUID(), plan, sourceKey, expiresAt: this.now() + PLAN_TTL };
					return { requestId, ok: true, planId: this.pending.id, expiresAt: this.pending.expiresAt,
						preview: { sourceDatabasePath: plan.source.path, destinationDatabasePath: plan.destination.path, counts: plan.summary.counts,
							excluded: plan.summary.excluded, ...(plan.summary.legacy ? { legacy: plan.summary.legacy } : {}), authenticatedEnvelopes: plan.authenticatedEnvelopes, planSha256: plan.planSha256 } };
				} catch (error) { sourceKey.fill(0); throw error; }
			}
			if (request.method === "apply") {
				fields(request, ["planId", "acceptedPlanSha256", "approved", "destinationKeyBase64"]);
				if (!this.pending || request.planId !== this.pending.id) throw new HostProfileFileTransferError("PLAN_EXPIRED", "The Core transfer review expired or belongs to a different request. Review again.");
				if (request.approved !== true || request.acceptedPlanSha256 !== this.pending.plan.planSha256) throw new HostProfileFileTransferError("PLAN_NOT_ACCEPTED", "Review and accept the exact Core transfer before applying it.");
				const pending = this.pending; this.pending = undefined;
				let destinationKey: Buffer | undefined;
				try {
					destinationKey = key(request.destinationKeyBase64); delete request.destinationKeyBase64;
					const receipt = applyHostProfileFileTransfer({ plan: pending.plan, sourceKey: pending.sourceKey, destinationKey, acceptedPlanSha256: pending.plan.planSha256, retainRecoveryJournal: true });
					this.recovery = { id: randomUUID(), receipt, sourceKey: pending.sourceKey, destinationKey, expiresAt: this.now() + RECOVERY_TTL };
					return { requestId, ok: true, recoveryId: this.recovery.id, expiresAt: this.recovery.expiresAt, receipt };
				} catch (error) { pending.sourceKey.fill(0); destinationKey?.fill(0); throw error; }
			}
			if (request.method === "verify-recovery") {
				fields(request, ["recoveryId"]);
				if (!this.recovery || request.recoveryId !== this.recovery.id) throw new HostProfileFileTransferError("RECOVERY_EXPIRED", "The Core recovery check expired. Preserve both profiles and review recovery again.");
				return { requestId, ok: true, recovery: verifyHostProfileFileTransferRecovery(this.recovery.receipt, this.recovery) };
			}
			if (request.method === "cancel") {
				fields(request, ["planId"]);
				if (!this.pending || request.planId !== this.pending.id) throw new HostProfileFileTransferError("PLAN_EXPIRED", "The Core transfer review is no longer pending.");
				this.clearPlan(); return { requestId, ok: true, cancelled: true };
			}
			if (request.method === "discard-recovery") {
				fields(request, ["recoveryId"]);
				if (!this.recovery || request.recoveryId !== this.recovery.id) throw new HostProfileFileTransferError("RECOVERY_EXPIRED", "The Core recovery check is no longer pending.");
				this.clearRecovery(); return { requestId, ok: true, discarded: true };
			}
			throw invalid();
		} catch (error) {
			const safe = error instanceof HostProfileFileTransferError ? error : invalid();
			return { requestId, ok: false, error: { code: safe.code, message: safe.message, published: safe.published } };
		} finally {
			delete request.sourceKeyBase64; delete request.destinationKeyBase64;
		}
	}
}
