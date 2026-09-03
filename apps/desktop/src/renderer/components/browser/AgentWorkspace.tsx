import type {
	AgentRun,
	AgentState,
	AgentGroupMemoryStatus,
	CoreResponse,
	RuntimeSession,
} from "@kestrel/shared-types";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	agentSessionIsRenderable,
	agentStateLabel,
} from "../../agent-workspace";
import { Icon } from "../Icon";
import { Button } from "../ui";
import { SurfaceBackButton } from "./SurfaceBackButton";
import { AgentUniverseScene } from "./agent-universe/AgentUniverseScene";
import { AgentUniverseStarfield } from "./agent-universe/AgentUniverseStarfield";
import {
	projectAgentUniverse,
	type AgentUniverseActivity,
	type AgentUniverseSnapshot,
} from "./agent-universe/agent-universe-model";
import {
	readAgentUniverseSystemColors,
	type AgentUniverseColorId,
	writeAgentUniverseSystemColors,
} from "./agent-universe/agent-universe-theme";
import "./surface-pages.css";
import "./agent-universe/agent-universe.css";

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
	agentState,
	pendingApprovals,
	activities = [],
	sessionLoadState = "ready",
	onNewTask,
	onOpenSession,
	onOpenApprovals,
	onOpenWork,
	onRetrySessions,
	onToggleAgentSidebar,
	onBack,
}: {
	sessions: RuntimeSession[];
	agentState: AgentState;
	pendingApprovals: number;
	activities?: AgentUniverseActivity[];
	sessionLoadState?: SessionLoadState;
	onNewTask(): void;
	onOpenSession(sessionId: string): void;
	onOpenApprovals(): void;
	onOpenWork(): void;
	onRetrySessions?(): void;
	onToggleAgentSidebar?(): void;
	onBack?(): void;
}) {
	const [query, setQuery] = useState("");
	const [focusedSystemId, setFocusedSystemId] = useState<string | null>(null);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [runsBySession, setRunsBySession] = useState<Record<string, AgentRun[]>>({});
	const [runsLoading, setRunsLoading] = useState(false);
	const [runsError, setRunsError] = useState("");
	const [groupMemoryBySystem, setGroupMemoryBySystem] = useState<
		Record<string, AgentGroupMemoryStatus>
	>({});
	const [groupMemoryLoading, setGroupMemoryLoading] = useState(false);
	const [groupMemoryError, setGroupMemoryError] = useState("");
	const groupMemoryRequestRef = useRef(0);
	const runsBySessionRef = useRef(runsBySession);
	const [systemColors, setSystemColors] = useState(readAgentUniverseSystemColors);
	const reducedMotion = Boolean(useReducedMotion());
	const renderableSessionIds = useMemo(
		() =>
			sessions
				.filter(agentSessionIsRenderable)
				.map((session) => session.id),
		[sessions],
	);
	const renderableSessionKey = useMemo(
		() =>
			sessions
				.filter(agentSessionIsRenderable)
				.map((session) => `${session.id}:${session.updatedAt}`)
				.join("|"),
		[sessions],
	);

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
	const focusedGroupId = focusedSystem?.rootNodeId ?? null;

	useEffect(() => {
		runsBySessionRef.current = runsBySession;
	}, [runsBySession]);

	useEffect(() => {
		if (renderableSessionIds.length === 0) return;
		let active = true;
		const refresh = async (sessionIds: readonly string[]) => {
			const entries = await Promise.all(
				sessionIds.map(async (sessionId): Promise<[string, AgentRun[]] | null> => {
					try {
						const raw = await window.kestrel.request({
							type: "runtime-list-runs",
							sessionId,
						});
						const response = raw as CoreResponse;
						if (!response.ok) return null;
						return [sessionId, response.runs ?? []];
					} catch {
						return null;
					}
				}),
			);
			if (!active) return;
			const successful = entries.filter(
				(entry): entry is [string, AgentRun[]] => entry !== null,
			);
			if (successful.length === 0) return;
			setRunsBySession((current) => {
				let changed = false;
				const next = { ...current };
				for (const [sessionId, runs] of successful) {
					const previous = current[sessionId];
					const same =
						previous?.length === runs.length &&
						previous.every(
							(run, index) =>
								run.id === runs[index]?.id &&
								run.status === runs[index]?.status &&
								run.updatedAt === runs[index]?.updatedAt,
						);
					if (same) continue;
					next[sessionId] = runs;
					changed = true;
				}
				return changed ? next : current;
			});
		};

		void refresh(renderableSessionIds);
		const timer = window.setInterval(() => {
			const activeSessionIds = renderableSessionIds.filter((sessionId) =>
				(runsBySessionRef.current[sessionId] ?? []).some(
					(run) =>
						run.status === "running" ||
						run.status === "waiting_approval" ||
						run.status === "waiting_input",
				),
			);
			if (activeSessionIds.length > 0) void refresh(activeSessionIds);
		}, 1_200);
		return () => {
			active = false;
			window.clearInterval(timer);
		};
	}, [renderableSessionIds, renderableSessionKey]);

	const loadGroupMemory = useCallback(async (groupId: string) => {
		const requestId = ++groupMemoryRequestRef.current;
		setGroupMemoryLoading(true);
		setGroupMemoryError("");
		try {
			const raw = await window.kestrel.request({
				type: "agent-group-memory-list",
				sessionId: groupId,
			});
			const response = raw as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			if (!response.groupMemory)
				throw new Error("Group memory did not return a status.");
			if (requestId !== groupMemoryRequestRef.current) return;
			setGroupMemoryBySystem((current) => ({
				...current,
				[groupId]: response.groupMemory!,
			}));
		} catch (cause) {
			if (requestId !== groupMemoryRequestRef.current) return;
			setGroupMemoryError(
				cause instanceof Error
					? cause.message
					: "Group memory is unavailable.",
			);
		} finally {
			if (requestId === groupMemoryRequestRef.current)
				setGroupMemoryLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!focusedGroupId) {
			setGroupMemoryLoading(false);
			setGroupMemoryError("");
			return;
		}
		void loadGroupMemory(focusedGroupId);
	}, [focusedGroupId, loadGroupMemory]);

	useEffect(() => {
		return window.kestrel.onRuntimeEvent((event) => {
			if (event.type !== "group-memory.updated") return;
			const groupId =
				typeof event.payload.groupId === "string"
					? event.payload.groupId
					: undefined;
			if (!groupId) return;
			setGroupMemoryBySystem((current) => {
				if (!current[groupId]) return current;
				const next = { ...current };
				delete next[groupId];
				return next;
			});
			if (focusedGroupId === groupId) void loadGroupMemory(groupId);
		});
	}, [focusedGroupId, loadGroupMemory]);

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
		if (runsBySession[selectedNode.id]) {
			// A cached selection can follow a still-loading uncached selection.
			// Reconcile the shared loading flags before returning so the new
			// context surface never inherits the previous request's state.
			setRunsLoading(false);
			setRunsError("");
			return;
		}
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
				setSelectedNodeId(nodeId);
				return;
			}
			setSelectedNodeId(nodeId);
		},
		[focusedSystemId, universe.nodes, universe.systems],
	);

	const updateSystemColor = useCallback(
		(systemId: string, colorId: AgentUniverseColorId) => {
			setSystemColors((current) => {
				const next = { ...current, [systemId]: colorId };
				writeAgentUniverseSystemColors(next);
				return next;
			});
		},
		[],
	);

	const focusSearchResult = useCallback(() => {
		const needle = query.trim().toLocaleLowerCase();
		if (!needle) return;
		for (const system of universe.systems) {
			const systemMatches = [system.name, system.workspaceName ?? ""]
				.join(" ")
				.toLocaleLowerCase()
				.includes(needle);
			const node = system.nodes.find(
				(item) =>
					[item.name, item.workspaceName ?? ""]
						.join(" ")
						.toLocaleLowerCase()
						.includes(needle),
			);
			if (systemMatches || node) {
				setFocusedSystemId(system.id);
				setSelectedNodeId(node?.id ?? system.rootNodeId);
				return;
			}
		}
	}, [query, universe.systems]);

	const handleBackgroundClick = useCallback(() => {
		if (selectedNodeId) setSelectedNodeId(null);
	}, [selectedNodeId]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLElement>) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			if (selectedNodeId) setSelectedNodeId(null);
			else if (focusedSystemId) setFocusedSystemId(null);
		},
		[focusedSystemId, selectedNodeId],
	);

	return (
		<main
			className="agent-workspace agent-universe-workspace"
			aria-labelledby="agent-workspace-title"
			onKeyDown={handleKeyDown}
		>
			<h1 id="agent-workspace-title" className="sr-only">
				Agent Universe
			</h1>
			<div className="agent-universe-stage">
				<div className="agent-universe-visual-plane">
					<AgentUniverseStarfield reducedMotion={reducedMotion} />
					{sessionLoadState === "loading" && !hasSystems ? (
						<AgentUniverseLoadingState />
					) : sessionLoadState === "error" && !hasSystems ? (
						<AgentUniverseErrorState
							{...(onRetrySessions ? { onRetry: onRetrySessions } : {})}
						/>
					) : !hasSystems ? (
						<AgentUniverseEmptyState onNewTask={onNewTask} />
					) : (
						<AgentUniverseScene
							snapshot={universe}
							focusedSystemId={focusedSystemId}
							selectedNodeId={selectedNodeId}
							query={query}
							activities={activities}
							reducedMotion={reducedMotion}
							systemColors={systemColors}
							{...(focusedGroupId && groupMemoryBySystem[focusedGroupId]
								? { contextGroupMemory: groupMemoryBySystem[focusedGroupId] }
								: {})}
							contextGroupMemoryLoading={Boolean(
								focusedGroupId && groupMemoryLoading,
							)}
							{...(focusedGroupId && groupMemoryError
								? { contextGroupMemoryError: groupMemoryError }
								: {})}
							{...(selectedNode && runsBySession[selectedNode.id]
								? { contextRuns: runsBySession[selectedNode.id] }
								: {})}
							contextRunsLoading={Boolean(selectedNode && runsLoading)}
							{...(selectedNode && runsError
								? { contextRunsError: runsError }
								: {})}
							onSystemColorChange={updateSystemColor}
							onNodeActivate={activateNode}
							onBackgroundClick={handleBackgroundClick}
							onCloseContext={() => setSelectedNodeId(null)}
							onOpenSession={onOpenSession}
						/>
					)}
				</div>

				<header className="agent-universe-mapbar">
					<div className="agent-universe-map-identity-stack">
						<div className="agent-universe-map-identity">
							{onBack ? <SurfaceBackButton onBack={onBack} /> : null}
							<div>
								<p className="agent-universe-map-eyebrow">Agent Universe</p>
								<p className="agent-universe-map-summary">
									{hasSystems
										? `${universe.systems.length} system${universe.systems.length === 1 ? "" : "s"} · ${universe.sessionCount} session${universe.sessionCount === 1 ? "" : "s"}`
										: "A blank field for the work you start here"}
								</p>
							</div>
						</div>
						{hasSystems ? (
							<div className="agent-universe-map-key" aria-label="Map key">
								<span><i className="is-core" aria-hidden="true" /> Main circle</span>
								<span><i className="is-worker" aria-hidden="true" /> Delegated</span>
								<span><i className="is-link" aria-hidden="true" /> Ownership</span>
							</div>
						) : null}
					</div>
					<div className="agent-universe-map-actions">
						{focusedSystem ? (
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
						{hasSystems ? (
							<>
								<label className="agent-universe-search">
									<Icon name="search" />
									<span className="sr-only">Find a system or task</span>
									<input
										type="search"
										value={query}
										placeholder="Find agents or systems"
										onChange={(event) => setQuery(event.target.value)}
										onKeyDown={(event) => {
											if (event.key !== "Enter") return;
											event.preventDefault();
											focusSearchResult();
										}}
									/>
								</label>
								<Button variant="quiet" size="compact" onClick={onOpenWork}>
									<Icon name="work" />
									Work
								</Button>
							</>
						) : null}
						{onToggleAgentSidebar ? (
							<button
								type="button"
								className="agent-universe-rail-toggle"
								aria-label="Open agent conversation rail"
								title="Open agent conversation rail"
								onClick={onToggleAgentSidebar}
							>
								<Icon name="chat" />
							</button>
						) : null}
						<button
							type="button"
							className="agent-universe-new-task"
							aria-label="Start a new task"
							title="Start a new task"
							onClick={onNewTask}
						>
							<Icon name="plus" />
						</button>
					</div>
				</header>

				{hasSystems && sessionLoadState !== "ready" ? (
					<AgentUniverseSessionNotice
						state={sessionLoadState}
						{...(onRetrySessions ? { onRetry: onRetrySessions } : {})}
					/>
				) : null}
				{hasSystems ? (
					<div className="agent-universe-map-footer">
						<AgentUniverseRuntimeStatus
							state={agentState}
							pendingApprovals={pendingApprovals}
							onOpenApprovals={onOpenApprovals}
						/>
						<span className="agent-universe-map-hint">
							Click a circle to inspect · drag to explore
						</span>
					</div>
				) : null}
			</div>
		</main>
	);
}
