import type {
	AgentRun,
	AgentGroupMemoryStatus,
	AgentIdentity,
	AgentMemoryRecord,
	CoreResponse,
	ProvenanceRecord,
	RuntimeMessage,
	WorkingTask,
} from "@kestrel/shared-types";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
} from "react";
import {
	agentSessionRecency,
	agentSessionStatusLabel,
} from "../../../agent-workspace";
import { Icon } from "../../Icon";
import { Button, Status, type StatusTone } from "../../ui";
import {
	agentUniverseRunIsPending,
	agentUniverseRunStatusLabel,
	type AgentNodeProjection,
	type AgentSystemProjection,
} from "./agent-universe-model";
import {
	AGENT_UNIVERSE_SYSTEM_COLORS,
	type AgentUniverseColorId,
} from "./agent-universe-theme";
import {
	beginAgentUniverseMessage,
	createAgentUniverseMessageLifecycle,
	finishAgentUniverseMessage,
	isCurrentAgentUniverseMessage,
	isCurrentAgentUniverseStream,
	resetAgentUniverseMessage,
	unmountAgentUniverseMessage,
} from "./agent-universe-message";

function statusTone(status: AgentNodeProjection["status"]): StatusTone {
	return status === "active"
		? "running"
		: status === "waiting"
			? "warning"
			: status === "failed"
				? "error"
				: status === "completed"
					? "verified"
					: "neutral";
}

function formatTimestamp(value: string): string {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp)
		? new Date(timestamp).toLocaleString([], {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: "Unknown";
}

function memoryPreview(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

function latestRun(runs: readonly AgentRun[] | undefined): AgentRun | undefined {
	return runs?.length
		? [...runs].sort(
				(left, right) =>
					Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
					left.id.localeCompare(right.id),
				)[0]
		: undefined;
}

function DefinitionRow({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="agent-universe-context-row">
			<dt>{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

interface ContextAnchor {
	x: number;
	y: number;
	radius?: number;
}

function useContextSurfacePosition(
	anchor: ContextAnchor | undefined,
	dockToRightRail = false,
) {
	const surfaceRef = useRef<HTMLElement | null>(null);
	const [position, setPosition] = useState({
		left: 18,
		top: 88,
		placement: "right" as "left" | "right",
	});
	const anchorRef = useRef(anchor);
	anchorRef.current = anchor;

	const place = useCallback(() => {
		const surface = surfaceRef.current;
		const container = surface?.offsetParent as HTMLElement | null;
		if (!surface || !container) return;
		const width = surface.offsetWidth;
		const height = surface.offsetHeight;
		const containerWidth = container.clientWidth;
		const containerHeight = container.clientHeight;
		const currentAnchor = anchorRef.current;
		const target = currentAnchor ?? {
			x: containerWidth / 2,
			y: containerHeight / 2,
		};
		// Anchor from the body's edge, not its centre. This keeps a selected
		// system readable beside a wide conversation surface.
		const gap = Math.max(26, (currentAnchor?.radius ?? 0) + 24);
		const useRightRail = dockToRightRail && containerWidth > 920;
		const canPlaceRight = target.x + gap + width <= containerWidth - 16;
		const canPlaceLeft = target.x - gap - width >= 16;
		const placement: "left" | "right" = useRightRail
			? "right"
			: canPlaceRight || !canPlaceLeft
				? "right"
				: "left";
		const left = useRightRail
			? containerWidth - width - 16
			: placement === "right"
				? target.x + gap
				: target.x - width - gap;
		const minimumTop = containerWidth <= 640 ? 126 : 82;
		const maximumTop = Math.max(
			minimumTop,
			containerHeight - height - (containerWidth <= 640 ? 68 : 84),
		);
		const nextPosition = {
			left: clamp(left, 16, Math.max(16, containerWidth - width - 16)),
			top: clamp(target.y - Math.min(148, height * 0.36), minimumTop, maximumTop),
			placement,
		};
		setPosition((current) =>
			current.left === nextPosition.left &&
			current.top === nextPosition.top &&
			current.placement === nextPosition.placement
				? current
				: nextPosition,
		);
	}, [dockToRightRail]);

	useLayoutEffect(() => {
		place();
	}, [anchor, place]);

	useLayoutEffect(() => {
		place();
		const surface = surfaceRef.current;
		const container = surface?.offsetParent as HTMLElement | null;
		if (!surface || !container || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(place);
		observer.observe(container);
		observer.observe(surface);
		window.addEventListener("resize", place);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
		};
	}, [place]);

	return {
		surfaceRef,
		style: {
			"--context-surface-left": `${position.left}px`,
			"--context-surface-top": `${position.top}px`,
		} as CSSProperties,
		placement: position.placement,
	};
}

function messagePreview(messages: readonly RuntimeMessage[] | undefined): string {
	const assistant = [...(messages ?? [])]
		.reverse()
		.find((message) => message.role === "assistant");
	return assistant?.content.trim() ?? "";
}

function conversationMessages(messages: readonly RuntimeMessage[]): RuntimeMessage[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant",
	);
}

export function AgentUniverseContextSurface({
	system,
	node,
	runs,
	runsLoading,
	runsError,
	anchor,
	groupMemory,
	groupMemoryLoading,
	groupMemoryError,
	agentMemory,
	agentMemoryLoading = false,
	agentMemoryError,
	colorId,
	onColorChange,
	onClose,
	onOpenSession,
	onRefreshAgentMemory,
}: {
	system: AgentSystemProjection;
	node?: AgentNodeProjection;
	runs?: readonly AgentRun[];
	runsLoading: boolean;
	runsError?: string;
	anchor?: ContextAnchor;
	groupMemory?: AgentGroupMemoryStatus;
	groupMemoryLoading: boolean;
	groupMemoryError?: string;
	agentMemory?: {
		identity: AgentIdentity;
		memories: AgentMemoryRecord[];
		tasks: WorkingTask[];
	};
	agentMemoryLoading?: boolean;
	agentMemoryError?: string;
	colorId: AgentUniverseColorId;
	onColorChange(systemId: string, colorId: AgentUniverseColorId): void;
	onClose(): void;
	onOpenSession(sessionId: string): void;
	onRefreshAgentMemory(sessionId: string): void;
}) {
	const [input, setInput] = useState("");
	const [messageState, setMessageState] = useState<
		"idle" | "sending" | "complete" | "error"
	>("idle");
	const [messageError, setMessageError] = useState("");
	const [streamText, setStreamText] = useState("");
	const [lastMessage, setLastMessage] = useState("");
	const [lastResponse, setLastResponse] = useState("");
	const [history, setHistory] = useState<RuntimeMessage[]>([]);
	const [historyLoading, setHistoryLoading] = useState(true);
	const [historyError, setHistoryError] = useState("");
	const messageLifecycleRef = useRef(createAgentUniverseMessageLifecycle());
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const messageLogRef = useRef<HTMLDivElement | null>(null);
	const historyRequestRef = useRef(0);
	const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
	const [memoryDraft, setMemoryDraft] = useState("");
	const [memoryMutationId, setMemoryMutationId] = useState<string | null>(null);
	const [memoryMutationError, setMemoryMutationError] = useState("");
	const [expandedProvenanceId, setExpandedProvenanceId] = useState<string | null>(null);
	const [provenanceByMemoryId, setProvenanceByMemoryId] = useState<Record<string, ProvenanceRecord[]>>({});
	const [provenanceLoadingId, setProvenanceLoadingId] = useState<string | null>(null);
	const [provenanceError, setProvenanceError] = useState("");
	const inspected = node;
	const parent = inspected?.parentId
		? system.nodes.find((item) => item.id === inspected.parentId)
		: undefined;
	const run = latestRun(runs) ?? inspected?.latestRun;
	const isRoot = inspected?.id === system.rootNodeId || !inspected;
	const title = isRoot ? system.name : inspected.name;
	const status = isRoot ? system.status : inspected.status;
	const openSessionId = isRoot ? system.rootNodeId : inspected.id;
	// Keep the inspector in the same predictable right rail as the coordinator
	// surface on wide maps. An inspector that floats beside a worker can cover
	// the very parent/child relationship the person selected it to understand.
	const surfacePosition = useContextSurfacePosition(anchor, true);
	const activeWorkers = system.nodes.filter(
		(item) => item.latestRun?.status === "running",
	).length;
	const waitingWorkers = system.nodes.filter((item) =>
		item.latestRun
			? agentUniverseRunIsPending(item.latestRun.status) &&
				item.latestRun.status !== "running"
			: item.status === "waiting",
	).length;
	const systemColor =
		AGENT_UNIVERSE_SYSTEM_COLORS.find((color) => color.id === colorId) ??
		AGENT_UNIVERSE_SYSTEM_COLORS[0]!;
	const runStatusTone = run?.status
		? run.status === "running"
			? "running"
			: run.status === "waiting_approval" || run.status === "waiting_input"
				? "warning"
				: run.status === "failed"
					? "error"
					: run.status === "completed"
						? "verified"
						: "neutral"
		: undefined;

	const loadHistory = useCallback(async () => {
		const requestId = ++historyRequestRef.current;
		setHistoryLoading(true);
		setHistoryError("");
		try {
			const raw = await window.kestrel.request({
				type: "runtime-list-messages",
				sessionId: openSessionId,
				limit: 100,
			});
			const response = raw as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			if (requestId !== historyRequestRef.current) return;
			setHistory(response.messages ?? []);
		} catch (cause) {
			if (requestId !== historyRequestRef.current) return;
			setHistoryError(
				cause instanceof Error
					? cause.message
					: "Conversation history is unavailable.",
			);
		} finally {
			if (requestId === historyRequestRef.current) setHistoryLoading(false);
		}
	}, [openSessionId]);

	const loadAgentMemoryProvenance = useCallback(
		async (memoryId: string) => {
			setExpandedProvenanceId((current) => (current === memoryId ? null : memoryId));
			if (provenanceByMemoryId[memoryId]) return;
			setProvenanceLoadingId(memoryId);
			setProvenanceError("");
			try {
				const raw = await window.kestrel.request({
					type: "memory-agent-provenance-list",
					sessionId: openSessionId,
					id: memoryId,
					limit: 40,
				});
				const response = raw as CoreResponse;
				if (!response.ok) throw new Error(response.error);
				setProvenanceByMemoryId((current) => ({
					...current,
					[memoryId]: response.memoryProvenance ?? [],
				}));
			} catch (cause) {
				setProvenanceError(
					cause instanceof Error
						? cause.message
						: "Memory provenance is unavailable.",
				);
			} finally {
				setProvenanceLoadingId((current) =>
					current === memoryId ? null : current,
				);
			}
		},
		[openSessionId, provenanceByMemoryId],
	);

	const correctAgentMemory = useCallback(
		async (memory: AgentMemoryRecord) => {
			const content = memoryDraft.trim();
			if (!content || content === memory.content || memoryMutationId) return;
			setMemoryMutationId(memory.id);
			setMemoryMutationError("");
			try {
				const raw = await window.kestrel.request({
					type: "memory-agent-correct",
					sessionId: openSessionId,
					id: memory.id,
					content,
				});
				const response = raw as CoreResponse;
				if (!response.ok) throw new Error(response.error);
				setEditingMemoryId(null);
				setProvenanceByMemoryId((current) => {
					const next = { ...current };
					delete next[memory.id];
					return next;
				});
				onRefreshAgentMemory(openSessionId);
			} catch (cause) {
				setMemoryMutationError(
					cause instanceof Error
						? cause.message
						: "Agent memory could not be corrected.",
				);
			} finally {
				setMemoryMutationId(null);
			}
		},
		[memoryDraft, memoryMutationId, onRefreshAgentMemory, openSessionId],
	);

	const forgetAgentMemory = useCallback(
		async (memory: AgentMemoryRecord) => {
			if (
				memoryMutationId ||
				(typeof window.confirm === "function" &&
					!window.confirm("Forget this memory for this agent?"))
			)
				return;
			setMemoryMutationId(memory.id);
			setMemoryMutationError("");
			try {
				const raw = await window.kestrel.request({
					type: "memory-agent-forget",
					sessionId: openSessionId,
					id: memory.id,
				});
				const response = raw as CoreResponse;
				if (!response.ok) throw new Error(response.error);
				setEditingMemoryId(null);
				setExpandedProvenanceId(null);
				setProvenanceByMemoryId((current) => {
					const next = { ...current };
					delete next[memory.id];
					return next;
				});
				onRefreshAgentMemory(openSessionId);
			} catch (cause) {
				setMemoryMutationError(
					cause instanceof Error
						? cause.message
						: "Agent memory could not be forgotten.",
				);
			} finally {
				setMemoryMutationId(null);
			}
		},
		[memoryMutationId, onRefreshAgentMemory, openSessionId],
	);

	useEffect(() => {
		setHistory([]);
		void loadHistory();
		return () => {
			historyRequestRef.current += 1;
		};
	}, [loadHistory]);

	useEffect(() => {
		const lifecycle = messageLifecycleRef.current;
		lifecycle.mounted = true;
		return () => unmountAgentUniverseMessage(lifecycle);
	}, []);

	useEffect(() => {
		const lifecycle = messageLifecycleRef.current;
		return window.kestrel.onAgentStream((event) => {
			if (!isCurrentAgentUniverseStream(lifecycle, event.streamId, event.sessionId))
				return;
			setStreamText((current) => current + event.delta);
		});
	}, []);

	useEffect(() => {
		resetAgentUniverseMessage(messageLifecycleRef.current);
		setInput("");
		setMessageState("idle");
		setMessageError("");
		setStreamText("");
		setLastMessage("");
		setLastResponse("");
		setEditingMemoryId(null);
		setMemoryDraft("");
		setMemoryMutationId(null);
		setMemoryMutationError("");
		setExpandedProvenanceId(null);
		setProvenanceByMemoryId({});
		setProvenanceLoadingId(null);
		setProvenanceError("");
	}, [openSessionId]);

	useLayoutEffect(() => {
		const textarea = inputRef.current;
		if (!textarea) return;
		textarea.style.height = "auto";
		const maxHeight = 132;
		textarea.style.height = `${Math.min(maxHeight, Math.max(42, textarea.scrollHeight))}px`;
		textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
	}, [input]);

	useLayoutEffect(() => {
		const log = messageLogRef.current;
		if (!log) return;
		// Runtime history is ordered oldest-first. Keep the newest conversation
		// visible when the panel opens or a streamed response grows, while the
		// log remains independently scrollable for deliberate history review.
		log.scrollTop = log.scrollHeight;
	}, [history.length, historyError, lastMessage, lastResponse, messageState, streamText]);

	const sendMessage = useCallback(async () => {
		if (!isRoot) return;
		const message = input.trim();
		if (!message || messageState === "sending") return;
		const streamId = crypto.randomUUID();
		const attempt = beginAgentUniverseMessage(
			messageLifecycleRef.current,
			openSessionId,
			streamId,
		);
		if (!attempt) return;
		setInput("");
		setLastMessage(message);
		setLastResponse("");
		setStreamText("");
		setMessageError("");
		setMessageState("sending");
		try {
			const raw = await window.kestrel.request({
				type: "runtime-run-agent",
				sessionId: openSessionId,
				message,
				model: "auto",
				providerIds: ["auto"],
				streamId,
			});
			const response = raw as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			if (!isCurrentAgentUniverseMessage(messageLifecycleRef.current, attempt)) return;
			setLastResponse(messagePreview(response.messages));
			setMessageState("complete");
			void loadHistory();
		} catch (cause) {
			if (!isCurrentAgentUniverseMessage(messageLifecycleRef.current, attempt)) return;
			setInput(message);
			setMessageError(
				cause instanceof Error
					? cause.message
					: "Kestrel Core could not be reached.",
			);
			setMessageState("error");
		} finally {
			finishAgentUniverseMessage(messageLifecycleRef.current, attempt);
		}
	}, [input, isRoot, loadHistory, messageState, openSessionId]);

	const renderedHistory = conversationMessages(history);
	const hasOptimisticMessage = Boolean(
		lastMessage &&
		!renderedHistory.some(
			(message) => message.role === "user" && message.content === lastMessage,
		),
	);
	const hasOptimisticResponse = Boolean(
		lastResponse &&
		!renderedHistory.some(
			(message) => message.role === "assistant" && message.content === lastResponse,
		),
	);

	return (
		<aside
			ref={surfacePosition.surfaceRef}
			className={`agent-universe-context-surface${isRoot ? " is-system" : " is-inspector"}`}
			style={{
				...surfacePosition.style,
				"--agent-system-color": systemColor.css,
				"--agent-system-surface": systemColor.surface,
			} as CSSProperties}
			data-system-color={systemColor.id}
			data-placement={surfacePosition.placement}
			aria-label={isRoot ? `Talk to the main circle, ${title}` : `Inspect ${title}`}
			onPointerDown={(event) => event.stopPropagation()}
			onWheel={(event) => event.stopPropagation()}
		>
			<header className="agent-universe-context-header">
				<div className="agent-universe-context-title">
					<span className="agent-universe-context-kicker">
						{isRoot ? "Main circle · coordinator" : "Inspecting worker"}
					</span>
					<h2>{title}</h2>
					<p className="agent-universe-context-subtitle">
						{isRoot
							? "Send the mission here. It can split independent work across real child agents, then reconcile the results for you."
							: "A delegated session within this system. Inspect its state and provenance here."}
					</p>
				</div>
				<button
					type="button"
					className="agent-universe-context-close"
					aria-label={`Close ${title} context`}
					title="Close"
					onClick={onClose}
				>
					<Icon name="close" />
				</button>
			</header>

			<div className="agent-universe-context-status">
				<Status tone={statusTone(status)}>{agentSessionStatusLabel(status)}</Status>
				{run && runStatusTone ? (
					<span className={`agent-universe-context-run-status is-${runStatusTone}`}>
						Last run · {agentUniverseRunStatusLabel(run.status)}
					</span>
				) : null}
				<span>Updated {agentSessionRecency(isRoot ? system.lastActivityAt : inspected.updatedAt)}</span>
			</div>

			{isRoot ? (
				<div className="agent-universe-context-brief">
					<span className="agent-universe-context-brief-mark" aria-hidden="true" />
					<span>
						{system.nodes.length} agent{system.nodes.length === 1 ? "" : "s"} in this system
						{activeWorkers > 0 ? ` · ${activeWorkers} working` : ""}
						{waitingWorkers > 0 ? ` · ${waitingWorkers} waiting` : ""}
					</span>
					{system.workspaceName ? <small>{system.workspaceName}</small> : null}
				</div>
			) : (
				<dl className="agent-universe-context-details">
					{parent ? <DefinitionRow label="Parent">{parent.name}</DefinitionRow> : null}
					<DefinitionRow label="Depth">
						{inspected.depth === 0 ? "Root" : `Delegated · ${inspected.depth}`}
					</DefinitionRow>
					{inspected.workspaceName ? (
						<DefinitionRow label="Workspace">
							<span title={inspected.workspaceRoot}>{inspected.workspaceName}</span>
						</DefinitionRow>
					) : null}
					<DefinitionRow label="Created">{formatTimestamp(inspected.createdAt)}</DefinitionRow>
				</dl>
			)}

			{groupMemoryLoading || groupMemoryError || groupMemory ? (
				<details
					className="agent-universe-context-secondary agent-universe-context-memory-details"
					open={Boolean(groupMemoryError)}
				>
					<summary>
						<span>Group memory</span>
						<small>
							{groupMemoryLoading
								? "Reading"
								: groupMemory
									? `${groupMemory.memoryCount} saved`
									: "Unavailable"}
						</small>
					</summary>
					<div className="agent-universe-context-memory-content">
						<p className="agent-universe-context-memory-note">
							Private to this system and its delegated agents. It is not shared
							with other agent systems.
						</p>
						{groupMemoryLoading ? <p>Reading durable group context…</p> : null}
						{groupMemoryError ? (
							<p className="agent-universe-context-error" role="alert">
								{groupMemoryError}
							</p>
						) : null}
						{groupMemory && groupMemory.memories.length > 0 ? (
							<ul className="agent-universe-memory-list">
								{groupMemory.memories.slice(0, 6).map((memory) => (
									<li key={memory.id} title={memory.content}>
										<span>{memoryPreview(memory.content)}</span>
										<small>
											{memory.sourceSessionId === system.rootNodeId
												? "Main circle"
												: "Delegated agent"}
										</small>
									</li>
								))}
							</ul>
							) : null}
						{groupMemory && groupMemory.memoryCount === 0 && !groupMemoryLoading ? (
							<p>No durable context has been saved for this system yet.</p>
						) : null}
						{groupMemory && groupMemory.memoryCount > 6 ? (
							<small className="agent-universe-memory-more">
								Showing the six most important entries · {groupMemory.memoryCount} total
							</small>
						) : null}
					</div>
				</details>
			) : null}

			{agentMemoryLoading || agentMemoryError || agentMemory ? (
				<details
					className="agent-universe-context-secondary agent-universe-context-memory-details"
					open={Boolean(agentMemoryError)}
				>
					<summary>
						<span>Agent continuity</span>
						<small>
							{agentMemoryLoading
								? "Reading"
								: agentMemory
									? `${agentMemory.memories.length} saved`
									: "Unavailable"}
						</small>
					</summary>
					<div className="agent-universe-context-memory-content">
						{agentMemoryLoading ? <p>Reading this agent's private continuity…</p> : null}
						{agentMemoryError ? (
							<p className="agent-universe-context-error" role="alert">
								{agentMemoryError}
							</p>
						) : null}
						{agentMemory ? (
							<>
								<p className="agent-universe-context-memory-note">
									Private to {agentMemory.identity.name}. It survives this task and is
									separate from shared group memory.
								</p>
								<dl className="agent-universe-context-details">
									<DefinitionRow label="Purpose">{agentMemory.identity.purpose}</DefinitionRow>
									<DefinitionRow label="Specialization">{agentMemory.identity.specialization}</DefinitionRow>
									<DefinitionRow label="Scope">{agentMemory.identity.memoryScope.replace("_", " ")}</DefinitionRow>
								</dl>
								{agentMemory.memories.length > 0 ? (
									<ul className="agent-universe-memory-list">
										{agentMemory.memories.slice(0, 6).map((memory) => {
											const editing = editingMemoryId === memory.id;
											const provenanceOpen = expandedProvenanceId === memory.id;
											const provenance = provenanceByMemoryId[memory.id];
											return (
												<li key={memory.id} title={memory.content}>
													<div className="agent-universe-memory-entry">
														<div>
															<span>{memoryPreview(memory.content)}</span>
															<small>
																{memory.kind} · {Math.round(memory.confidence * 100)}%
															</small>
														</div>
														<div className="agent-universe-memory-entry-actions">
															<button
																type="button"
																className="agent-universe-memory-action"
																onClick={() => {
																	setEditingMemoryId(editing ? null : memory.id);
																	setMemoryDraft(memory.content);
																	setMemoryMutationError("");
																}}
															>
																{editing ? "Close" : "Edit"}
															</button>
															<button
																type="button"
																className="agent-universe-memory-action"
																aria-expanded={provenanceOpen}
																onClick={() => void loadAgentMemoryProvenance(memory.id)}
															>
																{provenanceOpen ? "Hide source" : "Source"}
															</button>
														</div>
													</div>
													{editing ? (
														<form
															className="agent-universe-memory-edit"
															onSubmit={(event) => {
																event.preventDefault();
																void correctAgentMemory(memory);
															}}
														>
															<label>
																<span className="sr-only">Correct memory</span>
																<textarea
																	rows={3}
																	value={memoryDraft}
																	onChange={(event) => setMemoryDraft(event.target.value)}
																	disabled={memoryMutationId === memory.id}
																/>
															</label>
															<div className="agent-universe-memory-edit-actions">
																<button
																	type="submit"
																	className="agent-universe-memory-action is-primary"
																	disabled={
																		memoryMutationId === memory.id ||
																		!memoryDraft.trim() ||
																		memoryDraft.trim() === memory.content
																	}
																>
																	{memoryMutationId === memory.id ? "Saving…" : "Save correction"}
																</button>
																<button
																	type="button"
																	className="agent-universe-memory-action is-danger"
																	disabled={memoryMutationId === memory.id}
																	onClick={() => void forgetAgentMemory(memory)}
																>
																	Forget
																</button>
															</div>
														</form>
													) : null}
													{provenanceOpen ? (
														<div className="agent-universe-memory-provenance">
															{provenanceLoadingId === memory.id ? <small>Reading source…</small> : null}
															{provenanceError ? (
																	<small className="agent-universe-context-error" role="alert">
																		{provenanceError}
																	</small>
															) : null}
															{provenance ? (
																provenance.length > 0 ? (
																	<ul>
																		{provenance.map((item) => (
																			<li key={item.id}>
																				<strong>{item.sourceType}</strong>
																				<span>{item.excerpt ?? item.sourceId}</span>
																				<small>
																					{item.actor} · {item.extractionMethod} · {Math.round(item.confidence * 100)}%
																				</small>
																			</li>
																		))}
																	</ul>
																) : <small>No provenance record is attached.</small>
															) : null}
														</div>
													) : null}
												</li>
											);
										})}
									</ul>
								) : <p>No private lessons or outcomes yet.</p>}
								{memoryMutationError ? (
									<p className="agent-universe-context-error" role="alert">{memoryMutationError}</p>
								) : null}
								{agentMemory.tasks.length > 0 ? (
									<small className="agent-universe-memory-more">
										{agentMemory.tasks.length} working task{agentMemory.tasks.length === 1 ? "" : "s"} recorded
									</small>
								) : null}
							</>
						) : null}
					</div>
				</details>
			) : null}

			{!isRoot && inspected.allowedTools.length > 0 ? (
				<details className="agent-universe-context-secondary">
					<summary>
						<span>Capabilities</span>
						<small>{inspected.allowedTools.length}</small>
					</summary>
					<ul className="agent-universe-tool-list">
						{inspected.allowedTools.map((tool) => <li key={tool}>{tool}</li>)}
					</ul>
				</details>
			) : null}

			{!isRoot && (runsLoading || runsError || run) ? (
				<details className="agent-universe-context-secondary" open={Boolean(runsError)}>
					<summary>
						<span>Latest route</span>
						<small>{run?.model ?? (runsLoading ? "Reading" : "Unavailable")}</small>
					</summary>
					{runsLoading ? <p>Reading the latest verified run…</p> : null}
					{runsError ? <p role="alert">{runsError}</p> : null}
					{run ? (
						<dl className="agent-universe-context-details agent-universe-routing-details">
							<DefinitionRow label="Model">{run.model}</DefinitionRow>
							<DefinitionRow label="Provider">
								{run.providerIds.filter((provider) => provider !== "auto").join(", ") || "Automatic routing"}
							</DefinitionRow>
							{run.reasoningEffort ? <DefinitionRow label="Reasoning">{run.reasoningEffort}</DefinitionRow> : null}
						</dl>
					) : null}
				</details>
			) : null}

			<details className="agent-universe-context-secondary agent-universe-context-color-details">
				<summary>
					<span>System appearance</span>
					<small>{systemColor.label}</small>
				</summary>
				<div className="agent-universe-context-color-content">
					<span>Saved on this device</span>
					<div className="agent-universe-color-picker" role="group" aria-label="Choose system color">
						{AGENT_UNIVERSE_SYSTEM_COLORS.map((color) => (
							<button
								type="button"
								key={color.id}
								className="agent-universe-color-option"
								aria-label={`${color.label} system color`}
								aria-pressed={colorId === color.id}
								title={color.label}
								onClick={() => onColorChange(system.id, color.id)}
								style={{ "--color-option": color.css } as CSSProperties}
							/>
						))}
					</div>
				</div>
			</details>

			{isRoot ? (
				<section className="agent-universe-context-conversation">
					<div className="agent-universe-context-section-heading">
						<h3>Conversation</h3>
						<span>With {title}</span>
					</div>
					<div
						ref={messageLogRef}
						className="agent-universe-context-message-log"
						aria-live="polite"
					>
						{historyLoading && renderedHistory.length === 0 ? (
							<p className="agent-universe-context-empty">Loading the conversation…</p>
						) : null}
						{historyError ? <p className="agent-universe-context-error" role="alert">{historyError}</p> : null}
						{renderedHistory.map((message) => (
							<div className={`agent-universe-context-message ${message.role}`} key={message.id}>
								<span>{message.role === "user" ? "You" : title}</span>
								<p>{message.content}</p>
							</div>
						))}
						{hasOptimisticMessage ? (
							<div className="agent-universe-context-message user is-optimistic">
								<span>You</span>
								<p>{lastMessage}</p>
							</div>
						) : null}
						{messageState === "sending" ? (
							<div className="agent-universe-context-message assistant is-optimistic">
								<span>{title}</span>
								<p>{streamText || "Coordinating the next step…"}</p>
							</div>
						) : hasOptimisticResponse ? (
							<div className="agent-universe-context-message assistant is-optimistic">
								<span>{title}</span>
								<p>{lastResponse}</p>
							</div>
						) : null}
						{!historyLoading &&
							!historyError &&
							renderedHistory.length === 0 &&
							!lastMessage ? (
							<p className="agent-universe-context-empty">
								Message the main circle. It will decide what to keep,
								delegate, and bring back.
							</p>
						) : null}
					</div>
					{messageError ? <p className="agent-universe-context-error" role="alert">{messageError}</p> : null}
					<form
						className="agent-universe-context-composer"
						onSubmit={(event) => {
							event.preventDefault();
							void sendMessage();
						}}
					>
						<label className="sr-only" htmlFor={`agent-context-message-${openSessionId}`}>
							Message {title}
						</label>
						<textarea
							ref={inputRef}
							id={`agent-context-message-${openSessionId}`}
							rows={1}
							value={input}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.key !== "Enter" || event.shiftKey) return;
								event.preventDefault();
								void sendMessage();
							}}
							placeholder={`Message ${title}…`}
							disabled={messageState === "sending"}
						/>
						<button
							type="submit"
							className="agent-universe-context-send"
							aria-label={`Send message to ${title}`}
							title="Send message"
							disabled={!input.trim() || messageState === "sending"}
						>
							<Icon name={messageState === "sending" ? "loader" : "arrow"} />
						</button>
					</form>
				</section>
			) : null}

			<footer className="agent-universe-context-actions">
				<Button variant="quiet" size="compact" onClick={() => onOpenSession(openSessionId)}>
					Open task
					<Icon name="arrow" />
				</Button>
			</footer>
		</aside>
	);
}
