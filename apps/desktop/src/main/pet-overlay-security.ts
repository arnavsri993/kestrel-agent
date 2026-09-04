import type {
	PetActivityState,
	RendererRequest,
	RuntimeEvent,
} from "@kestrel/shared-types";

const PASSIVE_PET_REQUESTS = new Set<RendererRequest["type"]>([
	"pet-get",
	"pet-asset",
	"pet-overlay-close",
	"pet-overlay-toggle-main",
]);

const PET_STREAM_ID_PATTERN =
	/^pet-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PetOverlayRequestAccess {
	private readonly sessionIds = new Set<string>();
	private readonly streamIds = new Set<string>();

	assertAllowed(request: RendererRequest): void {
		if (PASSIVE_PET_REQUESTS.has(request.type)) return;
		if (request.type === "runtime-create-session") {
			if (request.kind || request.planetAssetId)
				throw new Error(
					"Pet quick tasks cannot create persistent agents or choose planet assets.",
				);
			if (request.workspaceRoot)
				throw new Error(
					"Pet quick tasks cannot request access to a project workspace.",
				);
			if (!request.title.startsWith("Pet · "))
				throw new Error(
					"Pet quick-task sessions must remain visibly attributed.",
				);
			return;
		}
		if (request.type === "runtime-run-agent") {
			if (!this.sessionIds.has(request.sessionId))
				throw new Error("Pet quick tasks can only run in a pet-owned session.");
			if (request.message.length > 10_000)
				throw new Error(
					"Pet quick-task prompts cannot exceed 10,000 characters.",
				);
			if (
				request.model !== "auto" ||
				request.providerIds.length !== 1 ||
				request.providerIds[0] !== "auto" ||
				request.providerModels !== undefined ||
				request.maximumTurns !== undefined ||
				request.approvalStatus !== undefined ||
				request.personalityId !== undefined ||
				request.attachments !== undefined
			)
				throw new Error(
					"Pet quick tasks must use fixed automatic routing without attachments or approval overrides.",
				);
			if (!request.streamId)
				throw new Error("Pet quick tasks require a cancellable stream.");
			if (!PET_STREAM_ID_PATTERN.test(request.streamId))
				throw new Error(
					"Pet quick tasks require an isolated pet stream identifier.",
				);
			if (this.streamIds.size > 0)
				throw new Error(
					"The pet overlay can run only one quick task at a time.",
				);
			return;
		}
		if (request.type === "runtime-cancel-stream") {
			if (!this.streamIds.has(request.streamId))
				throw new Error("Pet quick tasks can only cancel a pet-owned stream.");
			return;
		}
		throw new Error(
			`The pet overlay is not allowed to request ${request.type}.`,
		);
	}

	registerSession(sessionId: string): void {
		this.sessionIds.clear();
		this.sessionIds.add(sessionId);
	}

	ownsSession(sessionId: string): boolean {
		return this.sessionIds.has(sessionId);
	}

	beginStream(streamId: string): void {
		if (!PET_STREAM_ID_PATTERN.test(streamId))
			throw new Error("Pet stream identifier is invalid.");
		this.streamIds.add(streamId);
	}

	finishStream(streamId: string): void {
		this.streamIds.delete(streamId);
	}

	drainStreamIds(): string[] {
		const streamIds = [...this.streamIds];
		this.clear();
		return streamIds;
	}

	clear(): void {
		this.sessionIds.clear();
		this.streamIds.clear();
	}
}

export function petOverlayActivityForRuntimeEvent(
	access: PetOverlayRequestAccess,
	event: RuntimeEvent,
): PetActivityState | undefined {
	if (!access.ownsSession(event.sessionId)) return undefined;
	if (event.type === "tool.started" || event.type === "tool.progress")
		return "run";
	if (event.type === "tool.completed") {
		if (
			["failed", "blocked", "cancelled"].includes(
				String(event.payload.status ?? ""),
			)
		)
			return "failed";
		return /goal|task/.test(String(event.payload.toolName ?? ""))
			? "jump"
			: "review";
	}
	if (event.type === "message.appended")
		return event.payload.role === "assistant" ? "wave" : "review";
	return undefined;
}
