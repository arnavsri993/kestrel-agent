import type {
	AgentRun,
	AgentState,
	CoreResponse,
	RuntimeSession,
} from "@kestrel/shared-types";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	agentStateLabel,
	type AgentSessionFilter,
} from "../../agent-workspace";
import { Icon } from "../Icon";
import { Button, PageFrame } from "../ui";
import { SurfaceBackButton } from "./SurfaceBackButton";
import { AgentTaskListView } from "./agent-universe/AgentTaskListView";
import { AgentUniverseInspector } from "./agent-universe/AgentUniverseInspector";
import { AgentUniverseScene } from "./agent-universe/AgentUniverseScene";
import { AgentUniverseStarfield } from "./agent-universe/AgentUniverseStarfield";
import {
	projectAgentUniverse,
	type AgentUniverseActivity,
	type AgentUniverseSnapshot,
} from "./agent-universe/agent-universe-model";
import "./surface-pages.css";
import "./agent-universe/agent-universe.css";

type AgentUniverseView = "universe" | "list";
type SessionLoadState = "loading" | "ready" | "error";

function AgentUniverseEmptyState({ onNewTask }: { onNewTask(): void }) {
	return (
		<div className="agent-universe-empty-state">
			<span className="agent-universe-empty-mark" aria-hidden="true">
				<Icon name="agent" />
			</span>
			<h2>No agent systems yet</h2>
			<p>
				Start a task and delegated work will appear here as Kestrel coordinates it.
			</p>
			<Button variant="solid" onClick={onNewTask}>
				Start a task
			</Button>
		</div>
	);
}

function AgentUniverseLoadingState() {
	return (
		<div className="agent-universe-state-message" role="status" aria-live="polite">
			<span className="agent-universe-loading-mark" aria-hidden="true" />
			<strong>Reading agent systems</strong>
			<span>Looking at Kestrel’s local runtime.</span>
		</div>
	);
}

function AgentUniverseErrorState({ onRetry }: { onRetry?(): void }) {
	return (
		<div className="agent-universe-state-message is-error" role="alert">
			<span className="agent-universe-error-mark" aria-hidden="true">!</span>
			<strong>Agent systems could not be loaded</strong>
			<span>The local runtime did not return a session list.</span>
			{onRetry ? (
				<Button variant="bordered" size="compact" onClick={onRetry}>
					Try again
				</Button>
			) : null}
		</div>
	);
}

function AgentUniverseSessionNotice({
	state,
	onRetry,
}: {
	state: Exclude<SessionLoadState, "ready">;
	onRetry?(): void;
}) {
	const refreshing = state === "loading";
	return (
		<div className="agent-universe-session-notice" role="status" aria-live="polite">
			<span
				aria-hidden="true"
				className={`agent-universe-notice-dot${refreshing ? " is-refreshing" : ""}`}
			/>
			<span>
				{refreshing
					? "Refreshing the local session map…"
					: "The local session list is unavailable. Showing the last known map."}
			</span>
			{!refreshing && onRetry ? (
				<button type="button" onClick={onRetry}>
					Retry
				</button>
			) : null}
		</div>
	);
}

function AgentUniverseRuntimeStatus({
	state,
	pendingApprovals,
	onOpenApprovals,
}: {
	state: AgentState;
	pendingApprovals: number;
	onOpenApprovals(): void;
}) {
	return (
		<div className="agent-universe-runtime-status" aria-label="Agent runtime status">
			<span
				className={`agent-universe-status-dot ${state}`}
				aria-hidden="true"
			/>
			<span>{agentStateLabel(state)}</span>
			{pendingApprovals > 0 ? (
				<button type="button" onClick={onOpenApprovals}>
					{pendingApprovals} approval{pendingApprovals === 1 ? "" : "s"} waiting
				</button>
			) : null}
		</div>
	);
}

export function AgentWorkspace({
	sessions,
	activeSessionId,
	agentState,
	pendingApprovals,
	activities = [],
	sessionLoadState = "ready",
	onNewTask,
	onOpenSession,
	onOpenApprovals,
	onOpenWork,
	onRetrySessions,
	onBack,
}: {
	sessions: RuntimeSession[];
	activeSessionId: string | null;
	agentState: AgentState;
	pendingApprovals: number;
	activities?: AgentUniverseActivity[];
	sessionLoadState?: SessionLoadState;
	onNewTask(): void;
	onOpenSession(sessionId: string): void;
	onOpenApprovals(): void;
	onOpenWork(): void;
	onRetrySessions?(): void;
	onBack?(): void;
}) {
	const [view, setView] = useState<AgentUniverseView>("universe");
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<AgentSessionFilter>("all");
	const [focusedSystemId, setFocusedSystemId] = useState<string | null>(null);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [runsBySession, setRunsBySession] = useState<Record<string, AgentRun[]>>({});
	const [runsLoading, setRunsLoading] = useState(false);
	const [runsError, setRunsError] = useState("");
	const reducedMotion = Boolean(useReducedMotion());

	const runsMap = useMemo(
		() => new Map(Object.entries(runsBySession)),
		[runsBySession],
	);
	const universe = useMemo<AgentUniverseSnapshot>(
		() => projectAgentUniverse(sessions, { runsBySession: runsMap }),
		[runsMap, sessions],
	);
	const focusedSystem = focusedSystemId
		? universe.systems.find((system) => system.id === focusedSystemId)
		: undefined;
	const selectedNode = selectedNodeId
		? universe.nodes.find((node) => node.id === selectedNodeId)
		: undefined;
	const hasSystems = universe.systems.length > 0;
	const hasInspector = Boolean(focusedSystem);

	useEffect(() => {
		if (focusedSystemId && !focusedSystem) setFocusedSystemId(null);
		if (selectedNodeId && !selectedNode) setSelectedNodeId(null);
	}, [focusedSystem, focusedSystemId, selectedNode, selectedNodeId]);

	useEffect(() => {
		if (!selectedNode) {
			setRunsLoading(false);
			setRunsError("");
			return;
		}
		if (runsBySession[selectedNode.id]) return;
		let active = true;
		setRunsLoading(true);
		setRunsError("");
		void window.kestrel
			.request({ type: "runtime-list-runs", sessionId: selectedNode.id })
			.then((raw) => {
				if (!active) return;
				const response = raw as CoreResponse;
				if (!response.ok) throw new Error(response.error);
				setRunsBySession((current) => ({
					...current,
					[selectedNode.id]: response.runs ?? [],
				}));
			})
			.catch((cause) => {
				if (active)
					setRunsError(
						cause instanceof Error
							? cause.message
							: "Routing details are unavailable.",
					);
			})
			.finally(() => {
				if (active) setRunsLoading(false);
			});
		return () => {
			active = false;
		};
	}, [runsBySession, selectedNode]);

	const activateNode = useCallback(
		(nodeId: string, systemId: string) => {
			const node = universe.nodes.find((item) => item.id === nodeId);
			const system = universe.systems.find((item) => item.id === systemId);
			if (!node || !system) return;
			if (focusedSystemId !== systemId) {
				setFocusedSystemId(systemId);
				setSelectedNodeId(node.id === system.rootNodeId ? null : nodeId);
				return;
			}
			setSelectedNodeId(nodeId);
		},
		[focusedSystemId, universe.nodes, universe.systems],
	);

	const handleBackgroundClick = useCallback(() => {
		if (selectedNodeId) setSelectedNodeId(null);
	}, [selectedNodeId]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLElement>) => {
			if (event.key !== "Escape" || view !== "universe") return;
			event.preventDefault();
			if (selectedNodeId) setSelectedNodeId(null);
			else if (focusedSystemId) setFocusedSystemId(null);
		},
		[focusedSystemId, selectedNodeId, view],
	);

	const pageActions = (
		<>
			{onBack ? <SurfaceBackButton onBack={onBack} /> : null}
			{hasSystems ? (
				<>
					{view === "universe" && focusedSystem ? (
						<Button
							variant="quiet"
							size="compact"
							onClick={() => {
								setSelectedNodeId(null);
								setFocusedSystemId(null);
							}}
						>
							<Icon name="back" />
							All systems
						</Button>
					) : null}
					<div
						className="agent-universe-view-switch"
						role="group"
						aria-label="Agent view"
					>
						<button
							type="button"
							aria-pressed={view === "universe"}
							onClick={() => setView("universe")}
						>
							Universe
						</button>
						<button
							type="button"
							aria-pressed={view === "list"}
							onClick={() => setView("list")}
						>
							List
						</button>
					</div>
					<label className="agent-universe-search">
						<Icon name="search" />
						<span className="sr-only">Find a system or task</span>
						<input
							type="search"
							value={query}
							placeholder="Find systems or tasks"
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<Button variant="quiet" size="compact" onClick={onOpenWork}>
						<Icon name="work" />
						Work
					</Button>
				</>
			) : null}
			<Button variant="solid" size="compact" onClick={onNewTask}>
				Start a task
			</Button>
		</>
	);

	return (
		<main
			className="agent-workspace agent-universe-workspace"
			aria-labelledby="agent-workspace-title"
			onKeyDown={handleKeyDown}
		>
			<PageFrame
				as="div"
				eyebrow="Operational map"
				title="Agent Universe"
				titleId="agent-workspace-title"
				description="Real sessions and delegated work, mapped from Kestrel’s local runtime."
				measure="full"
				actions={pageActions}
			>
				{hasSystems ? (
					<AgentUniverseRuntimeStatus
						state={agentState}
						pendingApprovals={pendingApprovals}
						onOpenApprovals={onOpenApprovals}
					/>
				) : null}
				{hasSystems && sessionLoadState !== "ready" ? (
					<AgentUniverseSessionNotice
						state={sessionLoadState}
						{...(onRetrySessions ? { onRetry: onRetrySessions } : {})}
					/>
				) : null}
				{sessionLoadState === "loading" && !hasSystems ? (
					<div className="agent-universe-stage agent-universe-stage-state">
						<AgentUniverseStarfield reducedMotion={reducedMotion} />
						<AgentUniverseLoadingState />
					</div>
				) : sessionLoadState === "error" && !hasSystems ? (
					<div className="agent-universe-stage agent-universe-stage-state">
						<AgentUniverseStarfield reducedMotion={reducedMotion} />
						<AgentUniverseErrorState
							{...(onRetrySessions ? { onRetry: onRetrySessions } : {})}
						/>
					</div>
				) : !hasSystems ? (
					<div className="agent-universe-stage">
						<AgentUniverseStarfield reducedMotion={reducedMotion} />
						<AgentUniverseEmptyState onNewTask={onNewTask} />
					</div>
				) : view === "list" ? (
					<AgentTaskListView
						sessions={sessions}
						query={query}
						filter={filter}
						activeSessionId={activeSessionId}
						onFilterChange={setFilter}
						onNewTask={onNewTask}
						onOpenSession={onOpenSession}
					/>
				) : (
					<div
						className={`agent-universe-stage${hasInspector ? " has-inspector" : ""}`}
					>
						<div className="agent-universe-visual-plane">
							<AgentUniverseStarfield reducedMotion={reducedMotion} />
							<AgentUniverseScene
								snapshot={universe}
								focusedSystemId={focusedSystemId}
								selectedNodeId={selectedNodeId}
								query={query}
								activities={activities}
								reducedMotion={reducedMotion}
								onNodeActivate={activateNode}
								onBackgroundClick={handleBackgroundClick}
							/>
						</div>
						{focusedSystem ? (
							<AgentUniverseInspector
								system={focusedSystem}
								{...(selectedNode ? { node: selectedNode } : {})}
								{...(selectedNode && runsBySession[selectedNode.id]
									? { runs: runsBySession[selectedNode.id] }
									: {})}
								runsLoading={runsLoading}
								{...(runsError ? { runsError } : {})}
								pendingApprovals={pendingApprovals}
								onClose={() => setSelectedNodeId(null)}
								onOpenSession={onOpenSession}
								onOpenApprovals={onOpenApprovals}
							/>
						) : null}
					</div>
				)}
			</PageFrame>
		</main>
	);
}
