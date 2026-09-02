import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
	agentSessionStatusLabel,
	agentSessionRecency,
} from "../../../agent-workspace";
import { layoutAgentUniverse, type AgentNodeLayout } from "./agent-universe-layout";
import {
	agentUniverseSearchMatches,
	type AgentNodeProjection,
	type AgentSystemProjection,
	type AgentUniverseActivity,
	type AgentUniverseSnapshot,
} from "./agent-universe-model";

interface AgentUniverseSceneProps {
	snapshot: AgentUniverseSnapshot;
	focusedSystemId: string | null;
	selectedNodeId: string | null;
	query: string;
	activities: AgentUniverseActivity[];
	reducedMotion: boolean;
	onNodeActivate(nodeId: string, systemId: string): void;
	onBackgroundClick(): void;
}

interface Size {
	width: number;
	height: number;
}

const PULSE_LIFETIME_MS = 2_200;

function compactLabel(value: string, maximum: number): string {
	return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

function statusClass(status: AgentNodeProjection["status"]): string {
	return `agent-status-${status}`;
}

function layoutForNode(
	nodeLayouts: AgentNodeLayout[],
	nodeId: string,
): AgentNodeLayout | undefined {
	return nodeLayouts.find((layout) => layout.nodeId === nodeId);
}

function edgeIsRelated(
	sourceId: string,
	targetId: string,
	selectedNodeId: string | null,
	nodesById: ReadonlyMap<string, AgentNodeProjection>,
): boolean {
	if (!selectedNodeId) return false;
	if (sourceId === selectedNodeId || targetId === selectedNodeId) return true;
	const selected = nodesById.get(selectedNodeId);
	return selected?.parentId === sourceId || selected?.parentId === targetId;
}

function activityTime(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function AgentUniverseScene({
	snapshot,
	focusedSystemId,
	selectedNodeId,
	query,
	activities,
	reducedMotion,
	onNodeActivate,
	onBackgroundClick,
}: AgentUniverseSceneProps) {
	const sceneRef = useRef<HTMLElement>(null);
	const [size, setSize] = useState<Size>({ width: 0, height: 0 });
	const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
	const [pulseNow, setPulseNow] = useState(() => Date.now());
	const layout = useMemo(
		() =>
			layoutAgentUniverse(
				snapshot,
				size.width,
				size.height,
				focusedSystemId,
			),
		[snapshot, size.height, size.width, focusedSystemId],
	);
	const matches = useMemo(
		() => agentUniverseSearchMatches(snapshot, query),
		[snapshot, query],
	);
	const activeActivities = useMemo(() => {
		const bySession = new Map<string, AgentUniverseActivity>();
		for (const activity of activities) {
			if (pulseNow - activityTime(activity.createdAt) > PULSE_LIFETIME_MS)
				continue;
			const current = bySession.get(activity.sessionId);
			if (!current || activityTime(activity.createdAt) >= activityTime(current.createdAt))
				bySession.set(activity.sessionId, activity);
		}
		return bySession;
	}, [activities, pulseNow]);

	useEffect(() => {
		const scene = sceneRef.current;
		if (!scene || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			const rect = scene.getBoundingClientRect();
			setSize({
				width: Math.max(0, Math.round(rect.width)),
				height: Math.max(0, Math.round(rect.height)),
			});
		});
		observer.observe(scene);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (activities.length === 0) return;
		const latest = activities.at(-1);
		if (!latest) return;
		const delay = Math.max(
			0,
			PULSE_LIFETIME_MS - (Date.now() - activityTime(latest.createdAt)),
		);
		const timer = window.setTimeout(() => setPulseNow(Date.now()), delay + 40);
		return () => window.clearTimeout(timer);
	}, [activities]);

	const selectedNode = selectedNodeId
		? snapshot.nodes.find((node) => node.id === selectedNodeId)
		: undefined;
	const activeSystem = layout.systems[0];

	return (
		<section
			ref={sceneRef}
			className={`agent-universe-scene${focusedSystemId ? " is-focused" : ""}`}
			aria-label={focusedSystemId ? "Focused agent system map" : "Agent systems map"}
		>
			<svg
				className="agent-universe-svg"
				viewBox={`0 0 ${layout.width} ${layout.height}`}
				role="group"
				aria-label={
					focusedSystemId
						? `Focused system with ${activeSystem?.nodeLayouts.length ?? 0} sessions`
						: `${snapshot.systems.length} agent system${snapshot.systems.length === 1 ? "" : "s"}`
				}
				onClick={onBackgroundClick}
				onMouseLeave={() => setHoveredNodeId(null)}
			>
				<rect
					className="agent-universe-scene-hit-area"
					x="0"
					y="0"
					width={layout.width}
					height={layout.height}
					aria-hidden="true"
				/>
				{layout.systems.map((systemLayout) => {
					const system = snapshot.systems.find(
						(item) => item.id === systemLayout.systemId,
					);
					if (!system) return null;
					const matchedNodeInSystem = system.nodes.some((node) =>
						matches.nodeIds.has(node.id),
					);
					return (
						<AgentSystemScene
							key={system.id}
							system={system}
							layout={systemLayout}
							focused={focusedSystemId === system.id}
							queryActive={Boolean(query.trim())}
							matchedSystem={matches.systemIds.has(system.id)}
							hasSearchMatch={matches.systemIds.has(system.id) || matchedNodeInSystem}
							matchedNodeIds={matches.nodeIds}
							selectedNodeId={selectedNodeId}
							{...(selectedNode ? { selectedNode } : {})}
							hoveredNodeId={hoveredNodeId}
							activeActivities={activeActivities}
							reducedMotion={reducedMotion}
							onHover={setHoveredNodeId}
							onNodeActivate={onNodeActivate}
						/>
					);
				})}
			</svg>
			<p className="sr-only" aria-live="polite">
				{selectedNode
					? `${selectedNode.name}, ${agentSessionStatusLabel(selectedNode.status)}, updated ${agentSessionRecency(selectedNode.updatedAt)}`
					: focusedSystemId
						? "Focused system. Use Tab to move through sessions."
						: "Agent systems overview. Use Tab to focus a system or session."}
			</p>
		</section>
	);
}

function AgentSystemScene({
	system,
	layout,
	focused,
	queryActive,
	matchedSystem,
	hasSearchMatch,
	matchedNodeIds,
	selectedNodeId,
	selectedNode,
	hoveredNodeId,
	activeActivities,
	reducedMotion,
	onHover,
	onNodeActivate,
}: {
	system: AgentSystemProjection;
	layout: ReturnType<typeof layoutAgentUniverse>["systems"][number];
	focused: boolean;
	queryActive: boolean;
	matchedSystem: boolean;
	hasSearchMatch: boolean;
	matchedNodeIds: ReadonlySet<string>;
	selectedNodeId: string | null;
	selectedNode?: AgentNodeProjection;
	hoveredNodeId: string | null;
	activeActivities: ReadonlyMap<string, AgentUniverseActivity>;
	reducedMotion: boolean;
	onHover(nodeId: string | null): void;
	onNodeActivate(nodeId: string, systemId: string): void;
}) {
	const nodesById = new Map(system.nodes.map((node) => [node.id, node]));
	const layoutsById = new Map(
		layout.nodeLayouts.map((nodeLayout) => [nodeLayout.nodeId, nodeLayout]),
	);
	const directChildren = selectedNode
		? new Set(
				system.nodes
					.filter((node) => node.parentId === selectedNode.id)
					.map((node) => node.id),
			)
		: new Set<string>();
	return (
		<g
			className={`agent-universe-system${focused ? " is-focused" : ""}${
				queryActive && !hasSearchMatch ? " is-query-dimmed" : ""
			}`}
			data-system-id={system.id}
		>
			<g className="agent-universe-orbits" aria-hidden="true">
				{layout.orbitRadii.map((radius, index) => (
					<circle
						key={`${system.id}-orbit-${index}`}
						className="agent-universe-orbit-ring"
						cx={layout.centerX}
						cy={layout.centerY}
						r={radius}
						style={
							{
								"--orbit-duration": `${78 + index * 21}s`,
								"--orbit-delay": `${-index * 11}s`,
							} as CSSProperties
						}
					/>
				))}
			</g>
			<g className="agent-universe-edges" aria-hidden="true">
				{system.edges.map((edge) => {
					const source = layoutsById.get(edge.sourceId);
					const target = layoutsById.get(edge.targetId);
					if (!source || !target) return null;
					const active = activeActivities.get(edge.targetId);
					const related = edgeIsRelated(
						edge.sourceId,
						edge.targetId,
						selectedNodeId,
						nodesById,
					);
					const pathId = `agent-edge-${system.id}-${edge.targetId}`.replace(
						/[^a-zA-Z0-9_-]/g,
						"-",
					);
					return (
						<g
							key={edge.id}
							className={`agent-universe-edge${related ? " is-related" : ""}${
								active ? " is-active" : ""
							}`}
						>
							<line
								id={pathId}
								x1={source.x}
								y1={source.y}
								x2={target.x}
								y2={target.y}
								vectorEffect="non-scaling-stroke"
							/>
							{active ? (
								<circle
									className="agent-universe-signal"
									cx={reducedMotion ? target.x : source.x}
									cy={reducedMotion ? target.y : source.y}
									r="2.6"
								>
									{!reducedMotion ? (
										<>
											<animate
												attributeName="cx"
												from={source.x}
												to={target.x}
												dur="1.2s"
												fill="freeze"
											/>
											<animate
												attributeName="cy"
												from={source.y}
												to={target.y}
												dur="1.2s"
												fill="freeze"
											/>
										</>
									) : null}
								</circle>
							) : null}
						</g>
					);
				})}
			</g>
			<g className="agent-universe-nodes">
				{system.nodes.map((node) => {
					const nodeLayout = layoutsById.get(node.id);
					if (!nodeLayout) return null;
					const isRoot = node.id === system.rootNodeId;
					const isSelected = selectedNodeId === node.id;
					const isHovered = hoveredNodeId === node.id;
					const activity = activeActivities.has(node.id);
					const queryMatch = matchedNodeIds.has(node.id);
					const showLabel =
						isRoot ||
						focused ||
						queryMatch ||
						(!queryActive &&
							node.depth === 1 &&
							system.nodes.filter((item) => item.depth === 1).length <= 4);
					const selectedRelation =
						!selectedNodeId ||
						isSelected ||
						node.parentId === selectedNodeId ||
						directChildren.has(node.id);
					return (
						<g
							key={node.id}
							className={`agent-universe-node ${
								isRoot ? "is-core" : "is-worker"
							}${isSelected ? " is-selected" : ""}${isHovered ? " is-hovered" : ""}${
								activity ? " is-activity-active" : ""
							}${
								selectedNodeId && !selectedRelation ? " is-selection-dimmed" : ""
							}${queryActive && !queryMatch && !matchedSystem ? " is-query-dimmed" : ""}`}
							transform={`translate(${nodeLayout.x} ${nodeLayout.y})`}
							data-node-id={node.id}
							role="button"
							tabIndex={0}
							aria-pressed={isSelected}
							aria-label={`${node.name}, ${agentSessionStatusLabel(node.status)}${
								isRoot ? ", system root" : `, delegated session at depth ${node.depth}`
							}`}
							onMouseEnter={() => onHover(node.id)}
							onFocus={() => onHover(node.id)}
							onBlur={() => onHover(null)}
							onClick={(event) => {
								event.stopPropagation();
								onNodeActivate(node.id, system.id);
							}}
							onKeyDown={(event) => {
								if (event.key !== "Enter" && event.key !== " ") return;
								event.preventDefault();
								event.stopPropagation();
								onNodeActivate(node.id, system.id);
							}}
						>
							<title>
								{node.name} · {agentSessionStatusLabel(node.status)}
							</title>
							{isRoot ? (
								<>
									<circle className="agent-universe-core-aura" r={nodeLayout.radius + 18} />
									<circle className="agent-universe-node-hit" r={Math.max(42, nodeLayout.radius + 13)} />
									<circle className={`agent-universe-core-rim ${statusClass(node.status)}`} r={nodeLayout.radius} />
									<circle className="agent-universe-core-inner" r={Math.max(12, nodeLayout.radius - 6)} />
									{showLabel ? (
										<text className="agent-universe-core-label" textAnchor="middle" y="4">
											{compactLabel(node.name, 24)}
										</text>
									) : null}
								</>
							) : (
								<>
									<circle className="agent-universe-node-hit" r={Math.max(30, nodeLayout.radius + 10)} />
									<circle className={`agent-universe-worker-rim ${statusClass(node.status)}`} r={nodeLayout.radius} />
									<circle className="agent-universe-worker-inner" r={Math.max(4, nodeLayout.radius - 4)} />
									{showLabel ? (
										<text
											className="agent-universe-worker-label"
											x={Math.cos(nodeLayout.angle) >= 0 ? nodeLayout.radius + 12 : -nodeLayout.radius - 12}
											textAnchor={Math.cos(nodeLayout.angle) >= 0 ? "start" : "end"}
											y="4"
										>
											{compactLabel(node.name, focused ? 30 : 22)}
										</text>
									) : null}
								</>
							)}
							{node.status !== "active" && node.status !== "completed" ? (
								<text
									className="agent-universe-node-status"
									x={isRoot ? 0 : Math.cos(nodeLayout.angle) >= 0 ? nodeLayout.radius + 12 : -nodeLayout.radius - 12}
									y={isRoot ? nodeLayout.radius + 18 : 20}
									textAnchor={isRoot ? "middle" : Math.cos(nodeLayout.angle) >= 0 ? "start" : "end"}
								>
									{agentSessionStatusLabel(node.status)}
								</text>
							) : null}
						</g>
					);
				})}
			</g>
		</g>
	);
}
