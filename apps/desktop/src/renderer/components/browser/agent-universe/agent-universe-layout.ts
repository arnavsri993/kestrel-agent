import type {
	AgentNodeProjection,
	AgentSystemProjection,
	AgentUniverseSnapshot,
} from "./agent-universe-model";
import { stableAgentAngle, stableAgentHash } from "./agent-universe-model";

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
const SYSTEM_GAP = 44;
const LABEL_CLEARANCE = 20;
const WORKER_GAP = 16;

function safeDimension(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 1;
}

function nodeRadiusForDepth(
	node: AgentNodeProjection,
	childCount: number,
): number {
	const depthBase = 48 - Math.min(7, Math.max(0, node.depth - 1)) * 2.6;
	const statusBoost =
		node.status === "active"
			? 10
			: node.status === "waiting"
				? 3
				: node.status === "failed"
					? 0
					: node.status === "completed"
						? -9
						: -15;
	// A session that owns delegated work has real structural importance. Keep
	// the boost deliberately small so hierarchy never overwhelms status.
	const hierarchyBoost = childCount > 0 ? Math.min(5, childCount * 0.8) : 0;
	return Math.max(22, depthBase + statusBoost + hierarchyBoost);
}

/**
 * Reserve the largest truthful worker footprint for the band scaffold. The
 * rendered radius can respond to status, but the positions must not reshuffle
 * when a session starts or completes. That separation is what keeps the map
 * feeling like a place instead of a live chart.
 */
function nodePackingRadiusForDepth(
	node: AgentNodeProjection,
	childCount: number,
): number {
	const depthBase = 48 - Math.min(7, Math.max(0, node.depth - 1)) * 2.6;
	const hierarchyBoost = childCount > 0 ? Math.min(5, childCount * 0.8) : 0;
	return depthBase + 10 + hierarchyBoost;
}

function stableNodeOrder(left: AgentNodeProjection, right: AgentNodeProjection): number {
	return left.id.localeCompare(right.id);
}

function uniqueNumbers(values: number[]): number[] {
	return [...new Set(values.map((value) => Math.round(value * 100) / 100))].sort(
		(left, right) => left - right,
	);
}

interface LocalPlacement {
	node: AgentNodeProjection;
	x: number;
	y: number;
	radius: number;
	packingRadius: number;
}

/**
 * Resolve the deterministic scaffold for one local hierarchy. This is not a
 * force simulation and it does not expose rings: the seeded spiral gives each
 * worker a spatial memory, while the bounded collision pass keeps the initial
 * cluster legible before the interaction physics takes over.
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
	const root = system.nodes.find((node) => node.id === system.rootNodeId);
	const rootStatusBoost =
		root?.status === "active"
			? 7
			: root?.status === "waiting"
				? 2
				: root?.status === "failed"
					? -1
					: root?.status === "completed"
						? -7
						: -9;
	const rootImportanceBoost = root
		? Math.min(4, (childCounts.get(root.id) ?? 0) * 0.8)
		: 0;
	const rootRadius = Math.max(84, 118 + rootStatusBoost + rootImportanceBoost);
	// Keep this scaffold independent of status. A working session can become
	// idle without every neighbouring body changing its place in the universe.
	const rootPackingRadius = 128 + rootImportanceBoost;
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

	const workers = system.nodes
		.filter((node) => node.id !== system.rootNodeId)
		.sort(stableNodeOrder);
	const placements: LocalPlacement[] = [];
	const rootPlacement: LocalPlacement = {
		node: root ?? system.nodes[0]!,
		x: centerX,
		y: centerY,
		radius: rootRadius,
		packingRadius: rootPackingRadius,
	};
	for (const [index, node] of workers.entries()) {
		const nodeRadius = nodeRadiusForDepth(node, childCounts.get(node.id) ?? 0);
		const packingRadius = nodePackingRadiusForDepth(
			node,
			childCounts.get(node.id) ?? 0,
		);
		const hash = stableAgentHash(`${system.id}:${node.id}:placement`);
		const angle = stableAgentAngle(
			`${system.id}:${node.parentId ?? system.rootNodeId}:${node.id}`,
		);
		// A gentle square-root spread creates a cluster with a soft outer edge,
		// rather than a row or a collection of perfect rings. The stable hash
		// gives each agent an identity-preserving radial offset.
		const radialOffset = ((hash >>> 8) / 4_294_967_296 - 0.5) * 26;
		const distance =
			rootPackingRadius +
			58 +
			Math.sqrt(index + 1) * (36 + Math.min(14, packingRadius * 0.13)) +
			radialOffset +
			Math.min(4, node.depth) * 9;
		placements.push({
			node,
			x: centerX + Math.cos(angle) * distance,
			y: centerY + Math.sin(angle) * distance,
			radius: nodeRadius,
			packingRadius,
		});
	}

	// The initial scaffold is intentionally a finite, deterministic collision
	// solve. It handles large profiles without waking a runtime animation loop.
	for (let iteration = 0; iteration < 72; iteration += 1) {
		let moved = false;
		for (const placement of placements) {
			const dx = placement.x - rootPlacement.x;
			const dy = placement.y - rootPlacement.y;
			const distance = Math.hypot(dx, dy);
			const minimum = rootPlacement.packingRadius + placement.packingRadius + WORKER_GAP;
			if (distance < minimum) {
				const direction =
					distance > 0.001
						? { x: dx / distance, y: dy / distance }
						: { x: Math.cos(stableAgentAngle(placement.node.id)), y: Math.sin(stableAgentAngle(placement.node.id)) };
				const push = minimum - distance;
				placement.x += direction.x * push;
				placement.y += direction.y * push;
				moved = true;
			}
		}
		for (let left = 0; left < placements.length; left += 1) {
			for (let right = left + 1; right < placements.length; right += 1) {
				const first = placements[left]!;
				const second = placements[right]!;
				const dx = second.x - first.x;
				const dy = second.y - first.y;
				const distance = Math.hypot(dx, dy);
				const minimum = first.packingRadius + second.packingRadius + WORKER_GAP;
				if (distance >= minimum) continue;
				const direction =
					distance > 0.001
						? { x: dx / distance, y: dy / distance }
						: { x: Math.cos(stableAgentAngle(`${first.node.id}:${second.node.id}`)), y: Math.sin(stableAgentAngle(`${first.node.id}:${second.node.id}`)) };
				const push = (minimum - distance) / 2;
				first.x -= direction.x * push;
				first.y -= direction.y * push;
				second.x += direction.x * push;
				second.y += direction.y * push;
				moved = true;
			}
		}
		if (!moved) break;
	}

	const orbitRadii: number[] = [];
	for (const placement of placements) {
		const relativeX = placement.x - centerX;
		const relativeY = placement.y - centerY;
		const orbitRadius = Math.hypot(relativeX, relativeY);
		nodeLayouts.push({
			nodeId: placement.node.id,
			x: placement.x,
			y: placement.y,
			radius: placement.radius,
			// These legacy fields now describe the deterministic scaffold only.
			// There are no rendered orbit rings or orbital animations.
			orbitRadius,
			orbitBand: 0,
			angle: Math.atan2(relativeY, relativeX),
		});
		orbitRadii.push(orbitRadius);
	}

	const radius = Math.max(
		rootPackingRadius + LABEL_CLEARANCE,
		...nodeLayouts.map(
			(node) => {
				return node.orbitRadius +
					nodePackingRadiusForDepth(
						system.nodes.find((candidate) => candidate.id === node.nodeId) ?? rootPlacement.node,
						childCounts.get(node.nodeId) ?? 0,
					) +
					LABEL_CLEARANCE;
			},
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
	// Keep the map's lower edge clear of the floating camera controls and the
	// status line. This is part of the composition, not a post-render overlay
	// fix: important bodies should never sit behind chrome at the fit view.
	const bottomReserve = Math.min(112, Math.max(64, safeHeight * 0.14));
	const availableWidth = Math.max(1, safeWidth - margin * 2);
	const availableHeight = Math.max(1, safeHeight - margin * 2 - bottomReserve);
	const scale = Math.min(
		focused ? 1.7 : 1.25,
		availableWidth / boundsWidth,
		availableHeight / boundsHeight,
	);
	const worldCenterX = (bounds.minX + bounds.maxX) / 2;
	const worldCenterY = (bounds.minY + bounds.maxY) / 2;
	const translateX = safeWidth / 2 - worldCenterX * scale;
	const mapCenterY = margin + availableHeight / 2;
	const translateY = mapCenterY - worldCenterY * scale;

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
