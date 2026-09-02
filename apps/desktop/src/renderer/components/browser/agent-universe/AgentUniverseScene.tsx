import type { AgentRun } from "@kestrel/shared-types";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent,
	type WheelEvent,
} from "react";
import {
	agentSessionStatusLabel,
	agentSessionRecency,
} from "../../../agent-workspace";
import { Icon } from "../../Icon";
import { AgentUniverseContextSurface } from "./AgentUniverseContextSurface";
import { layoutAgentUniverse, type AgentNodeLayout } from "./agent-universe-layout";
import {
	agentUniverseSearchMatches,
	stableAgentHash,
	type AgentNodeProjection,
	type AgentSystemProjection,
	type AgentUniverseActivity,
	type AgentUniverseSnapshot,
} from "./agent-universe-model";
import {
	agentUniverseColorFor,
	type AgentUniverseColorId,
	type AgentUniverseSystemColor,
} from "./agent-universe-theme";
import {
	cameraForWorldTarget,
	cameraTransform,
	clampAgentUniverseZoom,
	DEFAULT_AGENT_UNIVERSE_CAMERA,
	panAgentUniverseCamera,
	projectAgentUniversePoint,
	zoomAgentUniverseCameraAtPoint,
	type AgentUniverseCamera,
	type AgentUniversePoint,
} from "./agent-universe-camera";

interface AgentUniverseSceneProps {
	snapshot: AgentUniverseSnapshot;
	focusedSystemId: string | null;
	selectedNodeId: string | null;
	query: string;
	activities: AgentUniverseActivity[];
	reducedMotion: boolean;
	systemColors: Readonly<Record<string, AgentUniverseColorId>>;
	pendingApprovals: number;
	contextRuns?: readonly AgentRun[];
	contextRunsLoading: boolean;
	contextRunsError?: string;
	onSystemColorChange(systemId: string, colorId: AgentUniverseColorId): void;
	onNodeActivate(nodeId: string, systemId: string): void;
	onBackgroundClick(): void;
	onCloseContext(): void;
	onOpenSession(sessionId: string): void;
	onOpenApprovals(): void;
}

interface Size {
	width: number;
	height: number;
}

interface PointerSession {
	pointerId: number;
	startX: number;
	startY: number;
	lastX: number;
	lastY: number;
	moved: boolean;
}

const PULSE_LIFETIME_MS = 2_200;
const SYSTEM_FOCUS_ZOOM = 1.28;
const NODE_FOCUS_ZOOM = 1.46;
const FOCUSED_CAMERA_ANCHOR = { x: 0.46, y: 0.5 };

function focusZoomFor(layoutScale: number, baseZoom: number): number {
	// The overview may be compressed by a real profile with many independent
	// sessions. Give a focused system the same readable physical scale instead
	// of zooming into a still-tiny overview dot.
	const visibleScale = Math.min(1, Math.max(0.42, layoutScale));
	return clampAgentUniverseZoom(Math.max(baseZoom, baseZoom / visibleScale));
}

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

function activityTime(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function nodeMotionStyle(
	node: AgentNodeProjection,
	isRoot: boolean,
): CSSProperties {
	const hash = stableAgentHash(node.id);
	// Only working workers drift, and only by a couple of pixels. A single
	// eased out-and-back path has no corner or direction jump; the old
	// four-point path visibly snapped each time it changed direction.
	const movement = isRoot || node.status !== "active" ? 0 : 1.2 + (hash % 5) * 0.16;
	const x = movement * (hash & 1 ? 1 : -1);
	const y = movement * (hash & 2 ? 0.62 : -0.62);
	const duration = node.status === "active" ? 24 + (hash % 9) * 1.2 : 0;
	return {
		"--node-drift-x": `${x.toFixed(1)}px`,
		"--node-drift-y": `${y.toFixed(1)}px`,
		"--node-drift-duration": `${duration.toFixed(2)}s`,
		"--node-drift-delay": `${-((hash >>> 8) % 240) / 10}s`,
	} as CSSProperties;
}

function viewportWorldRect(
	camera: AgentUniverseCamera,
	width: number,
	height: number,
): { x: number; y: number; width: number; height: number } {
	const safeWidth = Math.max(1, width);
	const safeHeight = Math.max(1, height);
	const centerX = safeWidth / 2;
	const centerY = safeHeight / 2;
	return {
		x: centerX + (-centerX - camera.panX) / camera.zoom,
		y: centerY + (-centerY - camera.panY) / camera.zoom,
		width: safeWidth / camera.zoom,
		height: safeHeight / camera.zoom,
	};
}

export function AgentUniverseScene({
	snapshot,
	focusedSystemId,
	selectedNodeId,
	query,
	activities,
	reducedMotion,
	systemColors,
	pendingApprovals,
	contextRuns,
	contextRunsLoading,
	contextRunsError,
	onSystemColorChange,
	onNodeActivate,
	onBackgroundClick,
	onCloseContext,
	onOpenSession,
	onOpenApprovals,
}: AgentUniverseSceneProps) {
	const sceneRef = useRef<HTMLElement>(null);
	const [size, setSize] = useState<Size>({ width: 0, height: 0 });
	const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
	const [pulseNow, setPulseNow] = useState(() => Date.now());
	const [camera, setCamera] = useState<AgentUniverseCamera>(
		DEFAULT_AGENT_UNIVERSE_CAMERA,
	);
	const [isPanning, setIsPanning] = useState(false);
	const pointerSessionRef = useRef<PointerSession | null>(null);
	const suppressClickRef = useRef(false);
	const previousFocusKeyRef = useRef<string | null>(null);
	const focusCameraSizeRef = useRef<Size>({ width: 0, height: 0 });
	const focusCameraReadyRef = useRef(false);
	const layout = useMemo(
		() => layoutAgentUniverse(snapshot, size.width, size.height),
		[snapshot, size.height, size.width],
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
			if (
				!current ||
				activityTime(activity.createdAt) >= activityTime(current.createdAt)
			)
				bySession.set(activity.sessionId, activity);
		}
		return bySession;
	}, [activities, pulseNow]);

	useLayoutEffect(() => {
		const scene = sceneRef.current;
		if (!scene) return;
		const measure = () => {
			const rect = scene.getBoundingClientRect();
			const next = {
				width: Math.max(0, Math.round(rect.width)),
				height: Math.max(0, Math.round(rect.height)),
			};
			setSize((current) =>
				current.width === next.width && current.height === next.height
					? current
					: next,
			);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			measure();
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

	const setCameraFrom = useCallback(
		(update: (current: AgentUniverseCamera) => AgentUniverseCamera) => {
			setCamera((current) => update(current));
		},
		[],
	);

	const focusWorldPoint = useCallback(
		(target: AgentUniversePoint, zoom: number) => {
			setCamera(
				cameraForWorldTarget(
					target,
					size.width,
					size.height,
					zoom,
					FOCUSED_CAMERA_ANCHOR,
				),
			);
		},
		[focusedSystemId, size.height, size.width],
	);

	useEffect(() => {
		if (!focusedSystemId) {
			if (previousFocusKeyRef.current !== null || focusCameraReadyRef.current) {
				previousFocusKeyRef.current = null;
				focusCameraSizeRef.current = { width: 0, height: 0 };
				focusCameraReadyRef.current = false;
				setCamera(DEFAULT_AGENT_UNIVERSE_CAMERA);
			}
			return;
		}
		if (size.width <= 0 || size.height <= 0) return;
		const focusKey = `${focusedSystemId}:${selectedNodeId ?? ""}`;
		const dimensionsChanged =
			focusCameraSizeRef.current.width !== size.width ||
			focusCameraSizeRef.current.height !== size.height;
		if (
			previousFocusKeyRef.current === focusKey &&
			focusCameraReadyRef.current &&
			!dimensionsChanged
		)
			return;
		const system = layout.systems.find(
			(item) => item.systemId === focusedSystemId,
		);
		if (system) {
			previousFocusKeyRef.current = focusKey;
			focusCameraSizeRef.current = { width: size.width, height: size.height };
			focusCameraReadyRef.current = true;
			const selectedLayout = selectedNodeId
				? system.nodeLayouts.find((item) => item.nodeId === selectedNodeId)
				: undefined;
			const target = selectedLayout
				? { x: selectedLayout.x, y: selectedLayout.y }
				: { x: system.centerX, y: system.centerY };
			setCamera(
				cameraForWorldTarget(
					target,
					size.width,
					size.height,
					focusZoomFor(
						layout.scale,
						selectedLayout && selectedLayout.nodeId !== system.systemId
							? NODE_FOCUS_ZOOM
							: SYSTEM_FOCUS_ZOOM,
					),
					FOCUSED_CAMERA_ANCHOR,
				),
			);
		}
	}, [focusedSystemId, layout.scale, layout.systems, selectedNodeId, size.height, size.width]);

	const selectedNode = selectedNodeId
		? snapshot.nodes.find((node) => node.id === selectedNodeId)
		: undefined;
	const activeSystem = focusedSystemId
		? snapshot.systems.find((system) => system.id === focusedSystemId)
		: undefined;
	const activeSystemLayout = focusedSystemId
		? layout.systems.find((system) => system.systemId === focusedSystemId)
		: undefined;
	const selectedNodeLayout = selectedNodeId
		? layoutForNode(
				layout.systems.flatMap((system) => system.nodeLayouts),
				selectedNodeId,
			)
		: undefined;
	const contextAnchor = selectedNodeLayout
		? projectAgentUniversePoint(
				camera,
				{ x: selectedNodeLayout.x, y: selectedNodeLayout.y },
				size.width,
				size.height,
			)
		: activeSystemLayout
			? projectAgentUniversePoint(
				camera,
				{ x: activeSystemLayout.centerX, y: activeSystemLayout.centerY },
				size.width,
				size.height,
			)
			: undefined;

	const resetCamera = useCallback(() => {
		if (focusedSystemId && activeSystemLayout) {
			setCamera(
				cameraForWorldTarget(
					{ x: activeSystemLayout.centerX, y: activeSystemLayout.centerY },
					size.width,
					size.height,
					focusZoomFor(layout.scale, SYSTEM_FOCUS_ZOOM),
					FOCUSED_CAMERA_ANCHOR,
				),
			);
			return;
		}
		setCamera(DEFAULT_AGENT_UNIVERSE_CAMERA);
	}, [activeSystemLayout, focusedSystemId, layout.scale, size.height, size.width]);

	const zoomAtPoint = useCallback(
		(factor: number, point?: AgentUniversePoint) => {
			const fallback = {
				x: size.width / 2,
				y: size.height / 2,
			};
			setCameraFrom((current) =>
				zoomAgentUniverseCameraAtPoint(
					current,
					factor,
					point ?? fallback,
					size.width,
					size.height,
				),
			);
		},
		[setCameraFrom, size.height, size.width],
	);

	const handleNodeActivate = useCallback(
		(nodeId: string, systemId: string) => {
			onNodeActivate(nodeId, systemId);
			const node = snapshot.nodes.find((item) => item.id === nodeId);
			const nodeLayout = layout.systems
				.flatMap((system) => system.nodeLayouts)
				.find((item) => item.nodeId === nodeId);
			if (!node || !nodeLayout) return;
			focusWorldPoint(
				{ x: nodeLayout.x, y: nodeLayout.y },
				focusZoomFor(
					layout.scale,
					node.id === node.systemId ? SYSTEM_FOCUS_ZOOM : NODE_FOCUS_ZOOM,
				),
			);
		},
		[focusWorldPoint, layout.scale, layout.systems, onNodeActivate, snapshot.nodes],
	);

	const handleWheel = useCallback(
		(event: WheelEvent<HTMLElement>) => {
			if (
				event.target instanceof Element &&
				event.target.closest("button, input, textarea, a, [role=button]")
			)
				return;
			const rect = sceneRef.current?.getBoundingClientRect();
			if (!rect) return;
			event.preventDefault();
			const factor = Math.exp(-event.deltaY * 0.0013);
			zoomAtPoint(factor, {
				x: event.clientX - rect.left,
				y: event.clientY - rect.top,
			});
		},
		[zoomAtPoint],
	);

	const handlePointerDown = useCallback(
		(event: PointerEvent<HTMLElement>) => {
			if (
				event.button !== 0 ||
				(event.target instanceof Element &&
					event.target.closest("button, input, textarea, a, [role=button]"))
			)
				return;
			pointerSessionRef.current = {
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				lastX: event.clientX,
				lastY: event.clientY,
				moved: false,
			};
			event.currentTarget.setPointerCapture(event.pointerId);
		},
		[],
	);

	const handlePointerMove = useCallback(
		(event: PointerEvent<HTMLElement>) => {
			const pointer = pointerSessionRef.current;
			if (!pointer || pointer.pointerId !== event.pointerId) return;
			const distance = Math.hypot(
				event.clientX - pointer.startX,
				event.clientY - pointer.startY,
			);
			if (!pointer.moved && distance < 5) return;
			pointer.moved = true;
			setIsPanning(true);
			const delta = {
				x: event.clientX - pointer.lastX,
				y: event.clientY - pointer.lastY,
			};
			pointer.lastX = event.clientX;
			pointer.lastY = event.clientY;
			setCameraFrom((current) =>
				panAgentUniverseCamera(current, delta, size.width, size.height),
			);
		},
		[setCameraFrom, size.height, size.width],
	);

	const finishPointer = useCallback((event: PointerEvent<HTMLElement>) => {
		const pointer = pointerSessionRef.current;
		if (!pointer || pointer.pointerId !== event.pointerId) return;
		if (pointer.moved) suppressClickRef.current = true;
		pointerSessionRef.current = null;
		setIsPanning(false);
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId);
	}, []);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLElement>) => {
			if (
				event.target instanceof HTMLElement &&
				(event.target.matches("button, input, textarea, a, [role=button]") ||
					event.target !== event.currentTarget)
			)
				return;
			const panStep = Math.max(28, Math.min(size.width, size.height) * 0.08);
			if (
				event.key === "ArrowLeft" ||
				event.key === "ArrowRight" ||
				event.key === "ArrowUp" ||
				event.key === "ArrowDown"
			) {
				event.preventDefault();
				setCameraFrom((current) =>
					panAgentUniverseCamera(
						current,
						{
							x:
								event.key === "ArrowLeft"
									? panStep
									: event.key === "ArrowRight"
										? -panStep
										: 0,
							y:
								event.key === "ArrowUp"
									? panStep
									: event.key === "ArrowDown"
										? -panStep
										: 0,
						},
						size.width,
						size.height,
					),
				);
				return;
			}
			if (event.key === "+" || event.key === "=") {
				event.preventDefault();
				zoomAtPoint(1.18);
				return;
			}
			if (event.key === "-" || event.key === "_") {
				event.preventDefault();
				zoomAtPoint(1 / 1.18);
				return;
			}
			if (event.key === "0" || event.key.toLocaleLowerCase() === "f") {
				event.preventDefault();
				resetCamera();
			}
		},
		[resetCamera, setCameraFrom, size.height, size.width, zoomAtPoint],
	);

	const visibleSystems = focusedSystemId
		? layout.systems.filter((system) => system.systemId === focusedSystemId)
		: layout.systems;
	const minimapViewport = viewportWorldRect(camera, size.width, size.height);

	return (
		<section
			ref={sceneRef}
			className={`agent-universe-scene${focusedSystemId ? " is-focused" : ""}${isPanning ? " is-panning" : ""}`}
			aria-label={focusedSystemId ? "Focused agent system map" : "Agent systems map"}
			tabIndex={0}
			aria-describedby="agent-universe-map-help"
			onWheel={handleWheel}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={finishPointer}
			onPointerCancel={finishPointer}
			onKeyDown={handleKeyDown}
		>
			<svg
				className="agent-universe-svg"
				viewBox={`0 0 ${layout.width} ${layout.height}`}
				role="group"
				aria-label={
					focusedSystemId
						? `Focused system with ${activeSystem?.nodes.length ?? 0} sessions`
						: `${snapshot.systems.length} agent system${snapshot.systems.length === 1 ? "" : "s"}`
				}
				onClick={() => {
					if (suppressClickRef.current) {
						suppressClickRef.current = false;
						return;
					}
					onBackgroundClick();
				}}
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
				<g
					className="agent-universe-camera"
					transform={cameraTransform(camera, layout.width, layout.height)}
				>
					{visibleSystems.map((systemLayout) => {
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
					hoveredNodeId={hoveredNodeId}
					activeActivities={activeActivities}
						detailZoom={camera.zoom}
								systemColor={agentUniverseColorFor(
									system.id,
									systemColors,
									system.status,
								)}
								onHover={setHoveredNodeId}
								onNodeActivate={handleNodeActivate}
							/>
						);
					})}
				</g>
			</svg>

			<div className="agent-universe-minimap" role="group" aria-label="Map overview">
				<svg
					viewBox={`0 0 ${layout.width} ${layout.height}`}
					aria-hidden="true"
				>
					{layout.systems.map((systemLayout) => {
						const system = snapshot.systems.find(
							(item) => item.id === systemLayout.systemId,
						);
						if (!system) return null;
						const color = agentUniverseColorFor(
							system.id,
							systemColors,
							system.status,
						);
						return (
							<circle
								key={system.id}
								cx={systemLayout.centerX}
								cy={systemLayout.centerY}
								r={Math.max(7, systemLayout.radius * 0.07)}
								fill={color.css}
								opacity={focusedSystemId === system.id ? 1 : 0.72}
							/>
						);
					})}
					<rect
						className="agent-universe-minimap-viewport"
						x={minimapViewport.x}
						y={minimapViewport.y}
						width={minimapViewport.width}
						height={minimapViewport.height}
					/>
				</svg>
				<button
					type="button"
					aria-label={focusedSystemId ? "Fit current system" : "Fit all systems"}
					title={focusedSystemId ? "Fit current system" : "Fit all systems"}
					onClick={resetCamera}
				>
					<Icon name="expand" />
				</button>
			</div>

			<div className="agent-universe-camera-controls" role="group" aria-label="Map controls">
				<button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAtPoint(1 / 1.22)}>
					<Icon name="minus" />
				</button>
				<output aria-label="Map zoom" aria-live="polite">
					{Math.round(camera.zoom * 100)}%
				</output>
				<button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAtPoint(1.22)}>
					<Icon name="plus" />
				</button>
				<span className="agent-universe-camera-divider" aria-hidden="true" />
				<button
					type="button"
					aria-label={focusedSystemId ? "Fit current system" : "Reset map view"}
					title={focusedSystemId ? "Fit current system" : "Reset map view"}
					onClick={resetCamera}
				>
					<Icon name="compass" />
				</button>
			</div>
			<p id="agent-universe-map-help" className="agent-universe-map-help">
				Drag to pan · scroll or pinch to zoom · focus the map and use arrow keys, +/−, or 0 to navigate
			</p>
			{activeSystem && selectedNodeId ? (
				<AgentUniverseContextSurface
					key={`${activeSystem.id}:${selectedNodeId}`}
					system={activeSystem}
					{...(selectedNode ? { node: selectedNode } : {})}
					{...(selectedNode && contextRuns ? { runs: contextRuns } : {})}
					runsLoading={contextRunsLoading}
					{...(contextRunsError ? { runsError: contextRunsError } : {})}
					pendingApprovals={pendingApprovals}
					{...(contextAnchor ? { anchor: contextAnchor } : {})}
					colorId={agentUniverseColorFor(
						activeSystem.id,
						systemColors,
						activeSystem.status,
					).id}
					onColorChange={onSystemColorChange}
					onClose={onCloseContext}
					onOpenSession={onOpenSession}
					onOpenApprovals={onOpenApprovals}
				/>
			) : null}
			<p className="sr-only" aria-live="polite">
				{selectedNode
					? `${selectedNode.name}, ${agentSessionStatusLabel(selectedNode.status)}, updated ${agentSessionRecency(selectedNode.updatedAt)}`
					: focusedSystemId
						? `Focused ${activeSystem?.name ?? "agent system"} with ${activeSystem?.nodes.length ?? 0} sessions. Other systems are hidden. Use Tab to move through sessions.`
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
	hoveredNodeId,
	activeActivities,
	detailZoom,
	systemColor,
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
	hoveredNodeId: string | null;
	activeActivities: ReadonlyMap<string, AgentUniverseActivity>;
	detailZoom: number;
	systemColor: AgentUniverseSystemColor;
	onHover(nodeId: string | null): void;
	onNodeActivate(nodeId: string, systemId: string): void;
}) {
	const layoutsById = new Map(
		layout.nodeLayouts.map((nodeLayout) => [nodeLayout.nodeId, nodeLayout]),
	);
	return (
		<g
			className={`agent-universe-system${focused ? " is-focused" : ""}${
				queryActive && !hasSearchMatch ? " is-query-dimmed" : ""
			}`}
			data-system-id={system.id}
			style={{ "--agent-system-color": systemColor.css } as CSSProperties}
		>
			<g className="agent-universe-edges" aria-hidden="true">
				{system.edges.map((edge) => {
					const source = layoutsById.get(edge.sourceId);
					const target = layoutsById.get(edge.targetId);
					if (!source || !target) return null;
					return (
						<line
							key={edge.id}
							className="agent-universe-edge"
							x1={source.x}
							y1={source.y}
							x2={target.x}
							y2={target.y}
						/>
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
					const working = node.status === "active";
					const queryMatch = matchedNodeIds.has(node.id);
					const showLabel = isRoot
						? nodeLayout.radius >= (focused ? 52 : 38) ||
							isHovered ||
							isSelected ||
							queryMatch
						: isHovered ||
							isSelected ||
							queryMatch ||
							(!queryActive && detailZoom >= (focused ? 1.12 : 1.72));
					const screenRadius = nodeLayout.radius * detailZoom;
					const labelInside = isRoot || screenRadius >= (focused ? 27 : 34);
					const selectedRelation =
						!selectedNodeId ||
						isSelected ||
						node.parentId === selectedNodeId;
					return (
						<g
							key={node.id}
							className={`agent-universe-node ${isRoot ? "is-core" : "is-worker"}${
								isSelected ? " is-selected" : ""
							}${isHovered ? " is-hovered" : ""}${working ? " is-working" : ""}${
								activity ? " is-activity-active" : ""
							}${
								selectedNodeId && !selectedRelation ? " is-selection-dimmed" : ""
							}${queryActive && !queryMatch && !matchedSystem ? " is-query-dimmed" : ""}${
								` ${statusClass(node.status)}`
							}`}
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
							<g
								className="agent-universe-node-body"
								style={nodeMotionStyle(node, isRoot)}
							>
								{isRoot ? (
									<>
										{working ? (
											<circle
												className="agent-universe-core-aura"
												r={nodeLayout.radius + 18}
											/>
										) : null}
										<circle
											className="agent-universe-node-hit"
											r={Math.max(42, nodeLayout.radius + 13)}
										/>
										<circle
											className={`agent-universe-core-rim ${statusClass(node.status)}`}
											r={nodeLayout.radius}
										/>
										{textLabel(
											node,
											nodeLayout,
											showLabel,
											true,
											true,
											system.nodes.length > 1
												? `${system.nodes.length} agent${system.nodes.length === 1 ? "" : "s"}`
												: undefined,
										)}
									</>
								) : (
									<>
										<circle
											className="agent-universe-node-hit"
											r={Math.max(30, nodeLayout.radius + 10)}
										/>
										{working ? (
											<circle
												className="agent-universe-worker-aura"
												r={nodeLayout.radius + (activity ? 8 : 6)}
											/>
										) : null}
										<circle
											className={`agent-universe-worker-rim ${statusClass(node.status)}`}
											r={nodeLayout.radius}
										/>
										{textLabel(node, nodeLayout, showLabel, false, labelInside)}
									</>
								)}
								{node.status === "waiting" || node.status === "failed" ? (
									<circle
										className="agent-universe-node-status-mark"
										cx={isRoot ? nodeLayout.radius * 0.64 : Math.cos(nodeLayout.angle) * nodeLayout.radius * 0.78}
										cy={isRoot ? -nodeLayout.radius * 0.64 : Math.sin(nodeLayout.angle) * nodeLayout.radius * 0.78}
										r={3.2}
									/>
								) : null}
							</g>
						</g>
					);
				})}
			</g>
		</g>
	);
}

function textLabel(
	node: AgentNodeProjection,
	layout: AgentNodeLayout,
	show: boolean,
	isRoot: boolean,
	inside: boolean,
	subtitle?: string,
) {
	if (!show) return null;
	const right = Math.cos(layout.angle) >= 0;
	const maximum = inside
		? Math.max(10, Math.floor((layout.radius * 1.62) / 7))
		: 26;
	const label = compactLabel(node.name, isRoot ? maximum : Math.min(maximum, 26));
	return (
		<text
			className={isRoot ? "agent-universe-core-label" : "agent-universe-worker-label"}
			x={inside ? 0 : right ? layout.radius + 12 : -layout.radius - 12}
			textAnchor={inside ? "middle" : right ? "start" : "end"}
			y={subtitle && inside ? "-2" : "4"}
		>
			{subtitle && inside ? (
				<>
					<tspan x="0" dy="0">
						{label}
					</tspan>
					<tspan x="0" dy="15" className="agent-universe-core-label-subtitle">
						{subtitle}
					</tspan>
				</>
			) : (
				label
			)}
		</text>
	);
}
