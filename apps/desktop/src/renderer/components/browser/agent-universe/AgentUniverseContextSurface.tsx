import type {
	AgentRun,
	CoreResponse,
	RuntimeMessage,
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
import type {
	AgentNodeProjection,
	AgentSystemProjection,
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

function useContextSurfacePosition(anchor: ContextAnchor | undefined) {
	const surfaceRef = useRef<HTMLElement | null>(null);
	const [position, setPosition] = useState({
		left: 18,
		top: 88,
		placement: "right" as "left" | "right",
	});

	const place = useCallback(() => {
		const surface = surfaceRef.current;
		const container = surface?.offsetParent as HTMLElement | null;
		if (!surface || !container) return;
		const width = surface.offsetWidth;
		const height = surface.offsetHeight;
		const containerWidth = container.clientWidth;
		const containerHeight = container.clientHeight;
		const target = anchor ?? {
			x: containerWidth / 2,
			y: containerHeight / 2,
		};
		// Anchor from the body's edge, not its centre. This keeps a selected
		// system readable beside a wide conversation surface.
		const gap = Math.max(26, (anchor?.radius ?? 0) + 24);
		const canPlaceRight = target.x + gap + width <= containerWidth - 16;
		const canPlaceLeft = target.x - gap - width >= 16;
		const placement = canPlaceRight || !canPlaceLeft ? "right" : "left";
		const left =
			placement === "right" ? target.x + gap : target.x - width - gap;
		const minimumTop = containerWidth <= 640 ? 126 : 82;
		const maximumTop = Math.max(
			minimumTop,
			containerHeight - height - (containerWidth <= 640 ? 68 : 84),
		);
		setPosition({
			left: clamp(left, 16, Math.max(16, containerWidth - width - 16)),
			top: clamp(target.y - Math.min(148, height * 0.36), minimumTop, maximumTop),
			placement,
		});
	}, [anchor]);

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
	colorId,
	onColorChange,
	onClose,
	onOpenSession,
}: {
	system: AgentSystemProjection;
	node?: AgentNodeProjection;
	runs?: readonly AgentRun[];
	runsLoading: boolean;
	runsError?: string;
	anchor?: ContextAnchor;
	colorId: AgentUniverseColorId;
	onColorChange(systemId: string, colorId: AgentUniverseColorId): void;
	onClose(): void;
	onOpenSession(sessionId: string): void;
}) {
	const surfacePosition = useContextSurfacePosition(anchor);
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
	const inspected = node;
	const parent = inspected?.parentId
		? system.nodes.find((item) => item.id === inspected.parentId)
		: undefined;
	const run = latestRun(runs) ?? inspected?.latestRun;
	const isRoot = inspected?.id === system.rootNodeId || !inspected;
	const title = isRoot ? system.name : inspected.name;
	const status = isRoot ? system.status : inspected.status;
	const openSessionId = isRoot ? system.rootNodeId : inspected.id;
	const activeWorkers = system.nodes.filter((item) => item.status === "active").length;
	const waitingWorkers = system.nodes.filter((item) => item.status === "waiting").length;
	const systemColor =
		AGENT_UNIVERSE_SYSTEM_COLORS.find((color) => color.id === colorId) ??
		AGENT_UNIVERSE_SYSTEM_COLORS[0]!;

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
			aria-label={isRoot ? `Talk to ${title}` : `Inspect ${title}`}
			onPointerDown={(event) => event.stopPropagation()}
			onWheel={(event) => event.stopPropagation()}
		>
			<header className="agent-universe-context-header">
				<div className="agent-universe-context-title">
					<span className="agent-universe-context-kicker">
						{isRoot ? "Main system" : "Inspecting worker"}
					</span>
					<h2>{title}</h2>
					<p className="agent-universe-context-subtitle">
						{isRoot
							? "The intelligence you talk to. Kestrel Core coordinates the work around it."
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
						{!historyLoading && !historyError && renderedHistory.length === 0 && !lastMessage ? (
							<p className="agent-universe-context-empty">Ask Kestrel Core to coordinate something for you.</p>
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
