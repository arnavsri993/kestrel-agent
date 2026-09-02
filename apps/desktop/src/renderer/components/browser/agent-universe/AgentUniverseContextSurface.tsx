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

function useContextSurfacePosition(anchor: { x: number; y: number } | undefined) {
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
		const gap = 26;
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

export function AgentUniverseContextSurface({
	system,
	node,
	runs,
	runsLoading,
	runsError,
	pendingApprovals,
	anchor,
	colorId,
	onColorChange,
	onClose,
	onOpenSession,
	onOpenApprovals,
}: {
	system: AgentSystemProjection;
	node?: AgentNodeProjection;
	runs?: readonly AgentRun[];
	runsLoading: boolean;
	runsError?: string;
	pendingApprovals: number;
	anchor?: { x: number; y: number };
	colorId: AgentUniverseColorId;
	onColorChange(systemId: string, colorId: AgentUniverseColorId): void;
	onClose(): void;
	onOpenSession(sessionId: string): void;
	onOpenApprovals(): void;
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
	const messageLifecycleRef = useRef(createAgentUniverseMessageLifecycle());
	const inspected = node;
	const parent = inspected?.parentId
		? system.nodes.find((item) => item.id === inspected.parentId)
		: undefined;
	const run = latestRun(runs) ?? inspected?.latestRun;
	const title = inspected?.name ?? system.name;
	const status = inspected?.status ?? system.status;
	const openSessionId = inspected?.id ?? system.rootNodeId;
	const isRoot = inspected?.id === system.rootNodeId || !inspected;
	const activeWorkers = system.nodes.filter((item) => item.status === "active").length;
	const waitingWorkers = system.nodes.filter((item) => item.status === "waiting").length;
	const systemColor =
		AGENT_UNIVERSE_SYSTEM_COLORS.find((color) => color.id === colorId) ??
		AGENT_UNIVERSE_SYSTEM_COLORS[0]!;

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

	const sendMessage = useCallback(async () => {
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
		} catch (cause) {
			if (!isCurrentAgentUniverseMessage(messageLifecycleRef.current, attempt)) return;
			setInput(message);
			setMessageError(
				cause instanceof Error
					? cause.message
					: "The selected agent could not be reached.",
			);
			setMessageState("error");
		} finally {
			finishAgentUniverseMessage(messageLifecycleRef.current, attempt);
		}
	}, [input, messageState, openSessionId]);

	return (
		<aside
			ref={surfacePosition.surfaceRef}
			className="agent-universe-context-surface"
			style={{
				...surfacePosition.style,
				"--agent-system-color": systemColor.css,
			} as CSSProperties}
			data-system-color={systemColor.id}
			data-placement={surfacePosition.placement}
			aria-label={isRoot ? `System controls for ${title}` : `Inspect ${title}`}
		>
			<header className="agent-universe-context-header">
				<div className="agent-universe-context-title">
					<span className="agent-universe-context-kicker">
						{isRoot ? "System orchestrator" : "Agent worker"}
					</span>
					<h2>{title}</h2>
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
				<span>Updated {agentSessionRecency(inspected?.updatedAt ?? system.lastActivityAt)}</span>
			</div>

			<dl className="agent-universe-context-details">
				{isRoot ? (
					<>
						<DefinitionRow label="Sessions">{system.nodes.length}</DefinitionRow>
						<DefinitionRow label="Working">{activeWorkers}</DefinitionRow>
						{waitingWorkers > 0 ? (
							<DefinitionRow label="Waiting">{waitingWorkers}</DefinitionRow>
						) : null}
						{system.workspaceName ? (
							<DefinitionRow label="Workspace">{system.workspaceName}</DefinitionRow>
						) : null}
					</>
				) : (
					<>
						{parent ? <DefinitionRow label="Derived from">{parent.name}</DefinitionRow> : null}
						<DefinitionRow label="Depth">
							{inspected?.depth === 0 ? "Root" : `Delegated · ${inspected?.depth}`}
						</DefinitionRow>
						{inspected?.workspaceName ? (
							<DefinitionRow label="Workspace">
								<span title={inspected.workspaceRoot}>{inspected.workspaceName}</span>
							</DefinitionRow>
						) : null}
						<DefinitionRow label="Created">{formatTimestamp(inspected!.createdAt)}</DefinitionRow>
					</>
				)}
			</dl>

			<section className="agent-universe-context-section agent-universe-context-color-section">
				<div className="agent-universe-context-section-heading">
					<h3>System color</h3>
					<span>Saved on this device</span>
				</div>
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
			</section>

			{inspected?.allowedTools.length ? (
				<section className="agent-universe-context-section">
					<h3>Capabilities</h3>
					<ul className="agent-universe-tool-list">
						{inspected.allowedTools.slice(0, 6).map((tool) => (
							<li key={tool}>{tool}</li>
							))}
					</ul>
					{inspected.allowedTools.length > 6 ? (
						<small>{inspected.allowedTools.length - 6} more tool grants recorded</small>
					) : null}
				</section>
			) : null}

			{inspected && (runsLoading || runsError || run) ? (
				<section className="agent-universe-context-section">
					<h3>Latest route</h3>
					{runsLoading ? <p>Reading the latest verified run…</p> : null}
					{runsError ? <p role="alert">{runsError}</p> : null}
					{run ? (
						<dl className="agent-universe-context-details agent-universe-routing-details">
							<DefinitionRow label="Model">{run.model}</DefinitionRow>
							<DefinitionRow label="Provider">
								{run.providerIds.filter((provider) => provider !== "auto").join(", ") || "Automatic routing"}
							</DefinitionRow>
							{run.reasoningEffort ? (
								<DefinitionRow label="Reasoning">{run.reasoningEffort}</DefinitionRow>
							) : null}
						</dl>
					) : null}
				</section>
			) : null}

			<section className="agent-universe-context-section agent-universe-context-message-section">
				<div className="agent-universe-context-section-heading">
					<h3>Direct message</h3>
					<span>{isRoot ? "Routes across this system" : "Targets this worker"}</span>
				</div>
				{lastMessage ? (
					<div className="agent-universe-context-message-log" aria-live="polite">
						<div className="agent-universe-context-message user">
							<span>You</span>
							<p>{lastMessage}</p>
						</div>
						{messageState === "sending" ? (
							<div className="agent-universe-context-message agent">
								<span>{title}</span>
								<p>{streamText || "Working with automatic routing…"}</p>
							</div>
						) : lastResponse ? (
							<div className="agent-universe-context-message agent">
								<span>{title}</span>
								<p>{lastResponse}</p>
							</div>
						) : messageState === "complete" ? (
							<p className="agent-universe-context-message-confirmation" role="status">
								Run completed. Open the task for the full transcript.
							</p>
						) : null}
					</div>
				) : null}
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
						id={`agent-context-message-${openSessionId}`}
						rows={2}
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

			<footer className="agent-universe-context-actions">
				<Button variant="solid" size="compact" onClick={() => onOpenSession(openSessionId)}>
					Open task
					<Icon name="arrow" />
				</Button>
				{status === "waiting" || pendingApprovals > 0 ? (
					<Button variant="quiet" size="compact" onClick={onOpenApprovals}>
						Review approvals
					</Button>
				) : null}
			</footer>
		</aside>
	);
}
