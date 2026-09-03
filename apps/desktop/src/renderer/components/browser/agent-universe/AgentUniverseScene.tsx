import type { AgentGroupMemoryStatus, AgentRun } from "@kestrel/shared-types";
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
	agentUniverseRunIsPending,
	agentUniverseRunStatusLabel,
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
	unprojectAgentUniversePoint,
	zoomAgentUniverseCameraAtPoint,
	type AgentUniverseCamera,
	type AgentUniversePoint,
} from "./agent-universe-camera";
import {
	createAgentUniversePhysicsController,
	type AgentUniversePhysicsEdgeRenderTarget,
	type AgentUniversePhysicsController,
	type AgentUniversePhysicsRenderTarget,
} from "./agent-universe-physics";
import {
	agentUniverseCameraMotionSettled,
	createAgentUniverseCameraMotionState,
	stepAgentUniverseCameraMotion,
} from "./agent-universe-camera-motion";

interface AgentUniverseSceneProps {
	snapshot: AgentUniverseSnapshot;
	focusedSystemId: string | null;
	selectedNodeId: string | null;
	query: string;
	activities: AgentUniverseActivity[];
	reducedMotion: boolean;
	systemColors: Readonly<Record<string, AgentUniverseColorId>>;
	contextGroupMemory?: AgentGroupMemoryStatus;
	contextGroupMemoryLoading: boolean;
	contextGroupMemoryError?: string;
	contextRuns?: readonly AgentRun[];
	contextRunsLoading: boolean;
	contextRunsError?: string;
	onSystemColorChange(systemId: string, colorId: AgentUniverseColorId): void;
	onNodeActivate(nodeId: string, systemId: string): void;
	onBackgroundClick(): void;
	onCloseContext(): void;
	onOpenSession(sessionId: string): void;
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
const SYSTEM_FOCUS_ZOOM = 1.16;
const NODE_FOCUS_ZOOM = 1.3;
// Leave room for the context surface on the right while keeping the whole
// local cluster in view. The inspector is a right rail, so the cluster can
// sit a little farther into the map without pushing worker labels through the
// left edge of the viewport.
const FOCUSED_CAMERA_ANCHOR = { x: 0.28, y: 0.5 };

function focusZoomFor(layoutScale: number, baseZoom: number): number {
	// The overview may be compressed by a real profile with many independent
	// sessions. Give a focused system the same readable physical scale instead
	// of zooming into a still-tiny overview dot.
	// Keep enough breathing room for the context surface and the long, truthful
	// worker labels. A very compressed overview should not turn focus into a
	// 187% close-up that hides the delegated cluster under the inspector.
	const visibleScale = Math.min(1, Math.max(0.95, layoutScale));
	return Math.min(
		1.9,
		clampAgentUniverseZoom(Math.max(baseZoom, baseZoom / visibleScale)),
	);
}

function compactLabel(value: string, maximum: number): string {
	if (value.length <= maximum) return value;
	const separator = Math.max(value.lastIndexOf(" - "), value.lastIndexOf(": "));
	const suffix = separator >= 0 ? value.slice(separator + 3).trim() : "";
	const prefixLength = maximum - suffix.length - 4;
	if (suffix && prefixLength >= 6) {
		return `${value.slice(0, prefixLength)}… · ${suffix}`;
	}
	const tailLength = Math.max(5, Math.floor((maximum - 1) * 0.34));
	return `${value.slice(0, maximum - tailLength - 1)}…${value.slice(-tailLength)}`;
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
	contextGroupMemory,
	contextGroupMemoryLoading,
	contextGroupMemoryError,
	contextRuns,
	contextRunsLoading,
	contextRunsError,
	onSystemColorChange,
	onNodeActivate,
	onBackgroundClick,
	onCloseContext,
	onOpenSession,
}: AgentUniverseSceneProps) {
	const sceneRef = useRef<HTMLElement>(null);
	const [size, setSize] = useState<Size>({ width: 0, height: 0 });
	const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
	const [pulseNow, setPulseNow] = useState(() => Date.now());
	const [camera, setCamera] = useState<AgentUniverseCamera>(
		DEFAULT_AGENT_UNIVERSE_CAMERA,
	);
	const cameraRef = useRef(camera);
	const cameraMotionRef = useRef(createAgentUniverseCameraMotionState(camera));
	const cameraTargetRef = useRef(camera);
	const cameraFrameRef = useRef<number | null>(null);
	const cameraLastFrameTimeRef = useRef(0);
	const reducedMotionRef = useRef(reducedMotion);
	reducedMotionRef.current = reducedMotion;
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

	const renderCamera = useCallback((next: AgentUniverseCamera) => {
		cameraRef.current = next;
		setCamera(next);
	}, []);

	const cancelCameraFrame = useCallback(() => {
		if (cameraFrameRef.current !== null)
			window.cancelAnimationFrame(cameraFrameRef.current);
		cameraFrameRef.current = null;
		cameraLastFrameTimeRef.current = 0;
	}, []);

	const cancelCameraMotion = useCallback(() => {
		cancelCameraFrame();
		const current = cameraRef.current;
		cameraMotionRef.current = createAgentUniverseCameraMotionState(current);
		cameraTargetRef.current = current;
	}, [cancelCameraFrame]);

	const runCameraMotionFrame = useCallback(
		(time: number) => {
			cameraFrameRef.current = null;
			const lastTime = cameraLastFrameTimeRef.current;
			const deltaSeconds = lastTime
				? Math.min(1 / 28, Math.max(0, (time - lastTime) / 1_000))
				: 1 / 60;
			cameraLastFrameTimeRef.current = time;
			const target = cameraTargetRef.current;
			const next = stepAgentUniverseCameraMotion(
				cameraMotionRef.current,
				target,
				deltaSeconds,
				reducedMotionRef.current,
			);
			cameraMotionRef.current = next;
			renderCamera(next.camera);

			if (
				reducedMotionRef.current ||
				agentUniverseCameraMotionSettled(next, target)
			) {
				cameraLastFrameTimeRef.current = 0;
				cameraMotionRef.current =
					createAgentUniverseCameraMotionState(target);
				return;
			}
			cameraFrameRef.current = window.requestAnimationFrame(
				runCameraMotionFrame,
			);
		},
		[renderCamera],
	);

	const animateCameraTo = useCallback(
		(target: AgentUniverseCamera) => {
			cameraTargetRef.current = target;
			if (reducedMotionRef.current) {
				cancelCameraFrame();
				cameraMotionRef.current = createAgentUniverseCameraMotionState(target);
				renderCamera(target);
				return;
			}
			if (cameraFrameRef.current !== null) return;
			cameraLastFrameTimeRef.current = 0;
			cameraFrameRef.current = window.requestAnimationFrame(
				runCameraMotionFrame,
			);
		},
		[cancelCameraFrame, renderCamera, runCameraMotionFrame],
	);

	const setCameraImmediately = useCallback(
		(update: (current: AgentUniverseCamera) => AgentUniverseCamera) => {
			cancelCameraMotion();
			const next = update(cameraRef.current);
			cameraMotionRef.current = createAgentUniverseCameraMotionState(next);
			cameraTargetRef.current = next;
			renderCamera(next);
		},
		[cancelCameraMotion, renderCamera],
	);

	useLayoutEffect(() => {
		if (!reducedMotion) return;
		const target = cameraTargetRef.current;
		cancelCameraFrame();
		cameraMotionRef.current = createAgentUniverseCameraMotionState(target);
		renderCamera(target);
	}, [cancelCameraFrame, reducedMotion, renderCamera]);

	useEffect(
		() => () => {
			cancelCameraFrame();
		},
		[cancelCameraFrame],
	);

	const focusWorldPoint = useCallback(
		(target: AgentUniversePoint, zoom: number) => {
			animateCameraTo(
				cameraForWorldTarget(
					target,
					size.width,
					size.height,
					zoom,
					FOCUSED_CAMERA_ANCHOR,
				),
			);
		},
		[animateCameraTo, size.height, size.width],
	);

	useEffect(() => {
		if (!focusedSystemId) {
			if (previousFocusKeyRef.current !== null || focusCameraReadyRef.current) {
				previousFocusKeyRef.current = null;
				focusCameraSizeRef.current = { width: 0, height: 0 };
				focusCameraReadyRef.current = false;
				animateCameraTo(DEFAULT_AGENT_UNIVERSE_CAMERA);
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
			animateCameraTo(
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
	}, [animateCameraTo, focusedSystemId, layout.scale, layout.systems, selectedNodeId, size.height, size.width]);

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
	const selectedNodeIsRoot =
		Boolean(selectedNodeLayout && activeSystemLayout) &&
		selectedNodeLayout?.nodeId === activeSystemLayout?.systemId;
	const contextAnchor = selectedNodeLayout
		? {
				...projectAgentUniversePoint(
					camera,
					{ x: selectedNodeLayout.x, y: selectedNodeLayout.y },
					size.width,
					size.height,
				),
				radius:
					(selectedNodeIsRoot && activeSystemLayout
						? activeSystemLayout.radius
						: selectedNodeLayout.radius) * camera.zoom,
			}
		: activeSystemLayout
			? {
					...projectAgentUniversePoint(
						camera,
						{ x: activeSystemLayout.centerX, y: activeSystemLayout.centerY },
						size.width,
						size.height,
					),
					radius: activeSystemLayout.radius * camera.zoom,
				}
			: undefined;

	const resetCamera = useCallback(() => {
		if (focusedSystemId && activeSystemLayout) {
			animateCameraTo(
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
		animateCameraTo(DEFAULT_AGENT_UNIVERSE_CAMERA);
	}, [activeSystemLayout, animateCameraTo, focusedSystemId, layout.scale, size.height, size.width]);

	const zoomAtPoint = useCallback(
		(factor: number, point?: AgentUniversePoint) => {
			const fallback = {
				x: size.width / 2,
				y: size.height / 2,
			};
			const next = zoomAgentUniverseCameraAtPoint(
				cameraRef.current,
				factor,
				point ?? fallback,
				size.width,
				size.height,
			);
			animateCameraTo(next);
		},
		[animateCameraTo, size.height, size.width],
	);

	const screenPointToWorld = useCallback(
		(clientX: number, clientY: number): AgentUniversePoint => {
			const rect = sceneRef.current?.getBoundingClientRect();
			if (!rect || rect.width <= 0 || rect.height <= 0) {
				return { x: size.width / 2, y: size.height / 2 };
			}
			const screenPoint = {
				x: ((clientX - rect.left) / rect.width) * layout.width,
				y: ((clientY - rect.top) / rect.height) * layout.height,
			};
			return unprojectAgentUniversePoint(
				cameraRef.current,
				screenPoint,
				layout.width,
				layout.height,
			);
		},
		[layout.height, layout.width, size.height, size.width],
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
			cancelCameraMotion();
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
		[cancelCameraMotion],
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
			setCameraImmediately((current) =>
				panAgentUniverseCamera(current, delta, size.width, size.height),
			);
		},
		[setCameraImmediately, size.height, size.width],
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
				setCameraImmediately((current) =>
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
		[resetCamera, setCameraImmediately, size.height, size.width, zoomAtPoint],
	);

	const visibleSystems = focusedSystemId
		? layout.systems.filter((system) => system.systemId === focusedSystemId)
		: layout.systems;
	const minimapViewport = viewportWorldRect(camera, size.width, size.height);

	return (
		<section
			ref={sceneRef}
			className={`agent-universe-scene${focusedSystemId ? " is-focused" : ""}${isPanning ? " is-panning" : ""}${reducedMotion ? " is-reduced-motion" : ""}`}
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
								prominent={!focusedSystemId && layout.systems[0]?.systemId === system.id}
								matchedNodeIds={matches.nodeIds}
								selectedNodeId={selectedNodeId}
								hoveredNodeId={hoveredNodeId}
								activeActivities={activeActivities}
								detailZoom={camera.zoom}
								screenPointToWorld={screenPointToWorld}
								systemColor={agentUniverseColorFor(
									system.id,
									systemColors,
									system.status,
								)}
								onHover={setHoveredNodeId}
								onNodeActivate={handleNodeActivate}
								reducedMotion={reducedMotion}
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
					{...(contextAnchor ? { anchor: contextAnchor } : {})}
					{...(contextGroupMemory ? { groupMemory: contextGroupMemory } : {})}
					groupMemoryLoading={contextGroupMemoryLoading}
					{...(contextGroupMemoryError
						? { groupMemoryError: contextGroupMemoryError }
						: {})}
					colorId={agentUniverseColorFor(
						activeSystem.id,
						systemColors,
						activeSystem.status,
					).id}
					onColorChange={onSystemColorChange}
					onClose={onCloseContext}
					onOpenSession={onOpenSession}
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
	prominent,
	matchedNodeIds,
	selectedNodeId,
	hoveredNodeId,
	activeActivities,
	detailZoom,
	systemColor,
	reducedMotion,
	screenPointToWorld,
	onHover,
	onNodeActivate,
}: {
	system: AgentSystemProjection;
	layout: ReturnType<typeof layoutAgentUniverse>["systems"][number];
	focused: boolean;
	queryActive: boolean;
	matchedSystem: boolean;
	hasSearchMatch: boolean;
	prominent: boolean;
	matchedNodeIds: ReadonlySet<string>;
	selectedNodeId: string | null;
	hoveredNodeId: string | null;
	activeActivities: ReadonlyMap<string, AgentUniverseActivity>;
	detailZoom: number;
	systemColor: AgentUniverseSystemColor;
	reducedMotion: boolean;
	screenPointToWorld(clientX: number, clientY: number): AgentUniversePoint;
	onHover(nodeId: string | null): void;
	onNodeActivate(nodeId: string, systemId: string): void;
}) {
	const layoutsById = useMemo(
		() =>
			new Map(
				layout.nodeLayouts.map((nodeLayout) => [nodeLayout.nodeId, nodeLayout]),
			),
		[layout.nodeLayouts],
	);
	const physicsRef = useRef<AgentUniversePhysicsController | null>(null);
	if (!physicsRef.current) {
		physicsRef.current = createAgentUniversePhysicsController();
	}
	const physics = physicsRef.current;
	const bodyRefs = useRef(new Map<string, SVGElement>());
	const linkRefs = useRef(new Map<string, SVGLineElement>());
	const nodePointerRef = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
		moved: boolean;
	} | null>(null);
	const suppressNodeClickRef = useRef(false);

	useLayoutEffect(() => {
		const targets = new Map<string, AgentUniversePhysicsRenderTarget>();
		for (const node of system.nodes) {
			const body = bodyRefs.current.get(node.id);
			const nodeLayout = layoutsById.get(node.id);
			if (!body || !nodeLayout) continue;
			targets.set(node.id, { body });
		}
		const edgeTargets: AgentUniversePhysicsEdgeRenderTarget[] = [];
		for (const edge of system.edges) {
			const element = linkRefs.current.get(edge.id);
			if (!element) continue;
			edgeTargets.push({
				element,
				sourceId: edge.sourceId,
				targetId: edge.targetId,
			});
		}
		physics.update(
			system.nodes.flatMap((node) => {
				const nodeLayout = layoutsById.get(node.id);
				if (!nodeLayout) return [];
				return [
					{
						id: node.id,
						...(node.parentId ? { parentId: node.parentId } : {}),
						x: nodeLayout.x,
						y: nodeLayout.y,
						radius: nodeLayout.radius,
						isRoot: node.id === system.rootNodeId,
					},
				];
			}),
			targets,
			reducedMotion,
			edgeTargets,
		);
	}, [
		layout.nodeLayouts,
		layoutsById,
		physics,
		reducedMotion,
		system.edges,
		system.nodes,
		system.rootNodeId,
	]);

	useEffect(() => () => physics.destroy(), [physics]);

	return (
		<g
			className={`agent-universe-system${focused ? " is-focused" : ""}${
				queryActive && !hasSearchMatch ? " is-query-dimmed" : ""
			}`}
			data-system-id={system.id}
			style={
				{
					"--agent-system-color": systemColor.css,
					"--agent-system-surface": systemColor.surface,
					"--agent-system-core": systemColor.core,
					"--agent-system-highlight": systemColor.highlight,
				} as CSSProperties
			}
		>
			<g className="agent-universe-delegation-links" aria-hidden="true">
				{system.edges.map((edge) => {
					const source = layoutsById.get(edge.sourceId);
					const target = layoutsById.get(edge.targetId);
					if (!source || !target) return null;
					const active =
						activeActivities.has(edge.sourceId) ||
						activeActivities.has(edge.targetId);
					return (
						<line
							key={edge.id}
							className={`agent-universe-delegation-link${active ? " is-active" : ""}`}
							x1={source.x}
							y1={source.y}
							x2={target.x}
							y2={target.y}
							ref={(element) => {
								if (element) linkRefs.current.set(edge.id, element);
								else linkRefs.current.delete(edge.id);
							}}
							data-edge-id={edge.id}
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
					const activity = activeActivities.get(node.id);
					const runStatus = node.latestRun?.status;
					const working = runStatus === "running";
					const waiting = runStatus
						? agentUniverseRunIsPending(runStatus) && !working
						: node.status === "waiting";
					const runFailed = runStatus === "failed";
					const queryMatch = matchedNodeIds.has(node.id);
					const showLabel = isRoot
						? focused ||
							prominent ||
							isHovered ||
							isSelected ||
							queryMatch
						: isHovered ||
							isSelected ||
							queryMatch ||
							(!queryActive && detailZoom >= (focused ? 1.12 : 1.72));
					const screenRadius = nodeLayout.radius * detailZoom;
					const labelInside = isRoot
						? focused || (prominent && screenRadius >= 28)
						: screenRadius >= (focused ? 27 : 34);
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
								}${waiting ? " is-runtime-waiting" : ""}${
									runFailed ? " is-runtime-failed" : ""
								}${
									isRoot && system.nodes.length > 1
										? " is-coordinator"
										: ""
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
							}${runStatus ? `, last run ${agentUniverseRunStatusLabel(runStatus)}` : ""}`}
							onPointerDown={
								isRoot
								? undefined
								: (event) => {
									if (event.button !== 0) return;
									event.stopPropagation();
									if (
										!physics.startDrag(
											node.id,
											screenPointToWorld(event.clientX, event.clientY),
										)
									)
										return;
									nodePointerRef.current = {
										pointerId: event.pointerId,
										startX: event.clientX,
										startY: event.clientY,
										moved: false,
									};
									event.currentTarget.setPointerCapture(event.pointerId);
								}
							}
							onPointerMove={
								isRoot
								? undefined
								: (event) => {
									const pointer = nodePointerRef.current;
									if (!pointer || pointer.pointerId !== event.pointerId) return;
									if (!pointer.moved) {
										pointer.moved =
											Math.hypot(
												event.clientX - pointer.startX,
												event.clientY - pointer.startY,
											) >= 5;
									}
									physics.moveDrag(
										screenPointToWorld(event.clientX, event.clientY),
									);
								}
							}
							onPointerUp={
								isRoot
								? undefined
								: (event) => {
									const pointer = nodePointerRef.current;
									if (!pointer || pointer.pointerId !== event.pointerId) return;
									event.stopPropagation();
									if (pointer.moved) suppressNodeClickRef.current = true;
									nodePointerRef.current = null;
									physics.endDrag();
									if (event.currentTarget.hasPointerCapture(event.pointerId))
										event.currentTarget.releasePointerCapture(event.pointerId);
								}
							}
							onPointerCancel={
								isRoot
								? undefined
								: (event) => {
									const pointer = nodePointerRef.current;
									if (!pointer || pointer.pointerId !== event.pointerId) return;
									event.stopPropagation();
									if (pointer.moved) suppressNodeClickRef.current = true;
									nodePointerRef.current = null;
									physics.cancelDrag();
									if (event.currentTarget.hasPointerCapture(event.pointerId))
										event.currentTarget.releasePointerCapture(event.pointerId);
								}
							}

							onMouseEnter={() => onHover(node.id)}
							onFocus={() => onHover(node.id)}
							onBlur={() => onHover(null)}
							onClick={(event) => {
								event.stopPropagation();
								if (suppressNodeClickRef.current) {
									suppressNodeClickRef.current = false;
									return;
								}
								onNodeActivate(node.id, system.id);
							}}
							onKeyDown={(event) => {
								if (event.key !== "Enter" && event.key !== " ") return;
								event.preventDefault();
								event.stopPropagation();
								onNodeActivate(node.id, system.id);
							}}
						>
							<title>{`${node.name} · ${agentSessionStatusLabel(node.status)}${
								runStatus ? ` · ${agentUniverseRunStatusLabel(runStatus)}` : ""
							}`}</title>
							<g
								className="agent-universe-node-body"
								ref={(element) => {
									if (element) bodyRefs.current.set(node.id, element);
									else bodyRefs.current.delete(node.id);
								}}
							>
								{isRoot ? (
									<>
										<circle
											className="agent-universe-node-hit"
											r={Math.max(42, nodeLayout.radius + 13)}
										/>
										{system.nodes.length > 1 ? (
											<circle
												className="agent-universe-coordinator-ring"
												r={nodeLayout.radius + 8}
											/>
										) : null}
										{working ? (
											<circle
												className={`agent-universe-state-ring${isRoot ? " is-core" : ""}`}
												r={nodeLayout.radius + (isRoot ? 12 : 8)}
											/>
										) : null}
										{activity ? (
											<circle
												key={activity.id}
												className="agent-universe-activity-pulse"
												r={nodeLayout.radius + (isRoot ? 7 : 5)}
												data-activity-id={activity.id}
											/>
										) : null}
										<circle
											className={`agent-universe-core-rim ${statusClass(node.status)}`}
											r={nodeLayout.radius}
										/>
										{textLabel(
											node,
											nodeLayout,
											showLabel,
											true,
											labelInside,
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
												className="agent-universe-state-ring"
												r={nodeLayout.radius + 8}
											/>
										) : null}
										{activity ? (
											<circle
												key={activity.id}
												className="agent-universe-activity-pulse"
												r={nodeLayout.radius + 5}
												data-activity-id={activity.id}
											/>
										) : null}
										<circle
											className={`agent-universe-worker-rim ${statusClass(node.status)}`}
											r={nodeLayout.radius}
										/>
										{textLabel(node, nodeLayout, showLabel, false, labelInside)}
									</>
								)}
								{waiting || runFailed || node.status === "failed" ? (
									<circle
										className="agent-universe-node-status-mark"
										cx={
											isRoot
												? nodeLayout.radius * 0.64
												: Math.cos(nodeLayout.angle) * nodeLayout.radius * 0.78
										}
										cy={
											isRoot
												? -nodeLayout.radius * 0.64
												: Math.sin(nodeLayout.angle) * nodeLayout.radius * 0.78
										}
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
	const label = compactLabel(
		node.name,
		isRoot ? Math.min(18, Math.max(12, maximum)) : Math.min(maximum, 26),
	);
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
