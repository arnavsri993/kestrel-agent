import type {
	AgentNodeProjection,
	AgentSystemProjection,
	AgentUniverseSnapshot,
} from "./agent-universe-model";
import { stableAgentAngle } from "./agent-universe-model";

export interface AgentNodeLayout {
	nodeId: string;
	x: number;
	y: number;
	radius: number;
	orbitRadius: number;
	orbitBand: number;
	angle: number;
}
export interface AgentSystemLayout {
	systemId: string;
	centerX: number;
	centerY: number;
	radius: number;
	nodeLayouts: AgentNodeLayout[];
	orbitRadii: number[];
}

export interface AgentUniverseLayout {
	width: number;
	height: number;
	scale: number;
	systems: AgentSystemLayout[];
}

// The overview is a navigable field, not a poster. Keep the packing compact
// enough that real profiles with many independent root sessions still have
// bodies with presence at the initial camera position. Labels are progressive
// and therefore do not need a large permanent exclusion zone.
const SYSTEM_GAP = 52;
const LABEL_CLEARANCE = 20;

function safeDimension(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 1;
}

function nodeRadiusForDepth(
	node: AgentNodeProjection,
	childCount: number,
): number {
	const depthBase = 39 - Math.min(7, Math.max(0, node.depth - 1)) * 2.5;
	const statusBoost =
		node.status === "active"
			? 10
			: node.status === "waiting"
				? 2
				: node.status === "failed"
					? 0
					: node.status === "completed"
						? -7
						: -11;
	// A session that owns delegated work has real structural importance. Keep
	// the boost deliberately small so hierarchy never overwhelms status.
	const hierarchyBoost = childCount > 0 ? Math.min(5, childCount * 0.8) : 0;
	return Math.max(20, depthBase + statusBoost + hierarchyBoost);
}

function stableNodeOrder(left: AgentNodeProjection, right: AgentNodeProjection): number {
	return left.id.localeCompare(right.id);
}

function uniqueNumbers(values: number[]): number[] {
	return [...new Set(values.map((value) => Math.round(value * 100) / 100))].sort(
		(left, right) => left - right,
	);
}

/**
 * Deterministically lay out one hierarchy as concentric delegated-work bands.
 * The function has no clock, physics loop, or random source: the same graph
 * always receives the same orbital phase and stable positions.
 */
export function layoutAgentSystem(
	system: AgentSystemProjection,
	centerX = 0,
	centerY = 0,
): AgentSystemLayout {
	const childCounts = new Map<string, number>();
	for (const node of system.nodes) {
		if (!node.parentId) continue;
		childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
	}
	const rootNode = system.nodes.find((node) => node.id === system.rootNodeId);
	const root = system.nodes.find((node) => node.id === system.rootNodeId);
	const rootStatusBoost =
		rootNode?.status === "active"
			? 7
			: rootNode?.status === "waiting"
				? 2
				: rootNode?.status === "failed"
					? -1
					: rootNode?.status === "completed"
						? -7
						: -9;
	const rootImportanceBoost = root
		? Math.min(4, (childCounts.get(root.id) ?? 0) * 0.8)
		: 0;
	const rootRadius = Math.max(72, 96 + rootStatusBoost + rootImportanceBoost);
	const nodeLayouts: AgentNodeLayout[] = [];
	if (root) {
		nodeLayouts.push({
			nodeId: root.id,
			x: centerX,
			y: centerY,
			radius: rootRadius,
			orbitRadius: 0,
			orbitBand: 0,
			angle: 0,
		});
	}

	const byDepth = new Map<number, AgentNodeProjection[]>();
	for (const node of system.nodes) {
		if (node.id === system.rootNodeId) continue;
		const nodes = byDepth.get(node.depth) ?? [];
		nodes.push(node);
		byDepth.set(node.depth, nodes);
	}

	const orbitRadii: number[] = [];
	for (const depth of [...byDepth.keys()].sort((left, right) => left - right)) {
		const nodes = [...byDepth.get(depth)!].sort(stableNodeOrder);
		const radius = rootRadius + 96 + Math.max(0, depth - 1) * 84;
		// Larger active blobs need more room before the angular packing step. A
		// fixed spacing would let a working node overlap its neighbour as the
		// visual hierarchy grows.
		const largestNodeRadius = Math.max(
			...nodes.map((node) =>
				nodeRadiusForDepth(node, childCounts.get(node.id) ?? 0),
			),
		);
		const minimumSeparation = Math.max(92, largestNodeRadius * 2 + 16);
		const bandStep = Math.max(116, largestNodeRadius * 2 + 22);
		const capacity = Math.max(
			1,
			Math.floor((Math.PI * 2 * radius) / minimumSeparation),
		);
		const bandCount = Math.max(1, Math.ceil(nodes.length / capacity));
		for (let band = 0; band < bandCount; band += 1) {
			const bandNodes = nodes.slice(
				band * capacity,
				Math.min(nodes.length, (band + 1) * capacity),
			);
			if (bandNodes.length === 0) continue;
			const bandRadius = Math.max(
				radius + band * bandStep,
				(bandNodes.length * minimumSeparation) / (Math.PI * 2),
			);
			orbitRadii.push(bandRadius);
			const phase = stableAgentAngle(`${system.id}:${depth}`, band);
			for (const [index, node] of bandNodes.entries()) {
				const angle = phase + (index / bandNodes.length) * Math.PI * 2;
				const nodeRadius = nodeRadiusForDepth(node, childCounts.get(node.id) ?? 0);
				nodeLayouts.push({
					nodeId: node.id,
					x: centerX + Math.cos(angle) * bandRadius,
					y: centerY + Math.sin(angle) * bandRadius,
					radius: nodeRadius,
					orbitRadius: bandRadius,
					orbitBand: band,
					angle,
				});
			}
		}
	}

	const radius = Math.max(
		rootRadius + LABEL_CLEARANCE,
		...nodeLayouts.map(
			(node) => node.orbitRadius + node.radius + LABEL_CLEARANCE,
		),
	);
	return {
		systemId: system.id,
		centerX,
		centerY,
		radius,
		nodeLayouts,
		orbitRadii: uniqueNumbers(orbitRadii),
	};
}

interface PlacedSystem {
	system: AgentSystemProjection;
	layout: AgentSystemLayout;
	x: number;
	y: number;
}

function packSystems(systems: AgentSystemProjection[]): PlacedSystem[] {
	// The first system is the most recently active one because the projection is
	// already sorted by last activity. Give it the quiet centre position, then
	// place the rest on deterministic rings. The old golden-angle retry loop
	// could push a later cluster much farther away than necessary, which made
	// every root shrink when the overview fitted the whole field.
	const ordered = [...systems];
	const locals = ordered.map((system) => layoutAgentSystem(system));
	if (ordered.length === 0) return [];
	const placed: PlacedSystem[] = [
		{ system: ordered[0]!, layout: locals[0]!, x: 0, y: 0 },
	];
	if (ordered.length === 1) return placed;

	const largestRadius = Math.max(...locals.map((layout) => layout.radius));
	const first = placed[0]!;
	const phase = stableAgentAngle("agent-universe-systems");
	let cursor = 1;
	let ring = 0;
	let previousRingRadius = 0;
	while (cursor < ordered.length) {
		const count = Math.min(8 + ring * 4, ordered.length - cursor);
		const ringRadius = Math.max(
			ring === 0
				? first.layout.radius + largestRadius + SYSTEM_GAP
				: previousRingRadius + largestRadius * 2 + SYSTEM_GAP,
			count > 1
				? (largestRadius + SYSTEM_GAP / 2) / Math.sin(Math.PI / count)
				: 0,
		);
		for (let index = 0; index < count; index += 1) {
			const system = ordered[cursor]!;
			const local = locals[cursor]!;
			const angle = phase + ring * 0.37 + (index / count) * Math.PI * 2;
			placed.push({
				system,
				layout: local,
				x: Math.cos(angle) * ringRadius,
				y: Math.sin(angle) * ringRadius,
			});
			cursor += 1;
		}
		previousRingRadius = ringRadius;
		ring += 1;
	}
	return placed;
}

/**
 * Fit the stable system pack to the available page plane. Focused mode uses
 * the exact same system layout and only changes the camera framing.
 */
export function layoutAgentUniverse(
	snapshot: AgentUniverseSnapshot,
	width: number,
	height: number,
	focusedSystemId?: string | null,
): AgentUniverseLayout {
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	const focused = focusedSystemId
		? snapshot.systems.find((system) => system.id === focusedSystemId)
		: undefined;
	const systems = focused ? [focused] : snapshot.systems;
	if (systems.length === 0)
		return { width: safeWidth, height: safeHeight, scale: 1, systems: [] };

	const placed = focused
		? [{
				system: focused,
				layout: layoutAgentSystem(focused),
				x: 0,
				y: 0,
			}]
		: packSystems(systems);
	const bounds = placed.reduce(
		(current, item) => ({
			minX: Math.min(current.minX, item.x - item.layout.radius),
			maxX: Math.max(current.maxX, item.x + item.layout.radius),
			minY: Math.min(current.minY, item.y - item.layout.radius),
			maxY: Math.max(current.maxY, item.y + item.layout.radius),
		}),
		{ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
	);
	const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
	const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
	const margin = Math.min(72, Math.max(24, Math.min(safeWidth, safeHeight) * 0.05));
	const availableWidth = Math.max(1, safeWidth - margin * 2);
	const availableHeight = Math.max(1, safeHeight - margin * 2);
	const scale = Math.min(
		focused ? 1.7 : 1.25,
		availableWidth / boundsWidth,
		availableHeight / boundsHeight,
	);
	const worldCenterX = (bounds.minX + bounds.maxX) / 2;
	const worldCenterY = (bounds.minY + bounds.maxY) / 2;
	const translateX = safeWidth / 2 - worldCenterX * scale;
	const translateY = safeHeight / 2 - worldCenterY * scale;

	return {
		width: safeWidth,
		height: safeHeight,
		scale,
		systems: placed.map((item) => ({
			...item.layout,
			centerX: translateX + item.x * scale,
			centerY: translateY + item.y * scale,
			radius: item.layout.radius * scale,
			nodeLayouts: item.layout.nodeLayouts.map((node) => ({
				...node,
				x: translateX + (item.x + node.x) * scale,
				y: translateY + (item.y + node.y) * scale,
				radius: node.radius * scale,
				orbitRadius: node.orbitRadius * scale,
			})),
			orbitRadii: item.layout.orbitRadii.map((radius) => radius * scale),
		})),
	};
}
