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

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const SYSTEM_GAP = 96;
const LABEL_CLEARANCE = 48;

function safeDimension(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 1;
}

function nodeRadiusForDepth(depth: number): number {
	return Math.max(15, 24 - Math.min(7, Math.max(0, depth - 1)) * 1.5);
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
	const rootRadius = 58;
	const root = system.nodes.find((node) => node.id === system.rootNodeId);
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
		const radius = rootRadius + 84 + Math.max(0, depth - 1) * 72;
		const minimumSeparation = 66;
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
				radius + band * 72,
				(bandNodes.length * minimumSeparation) / (Math.PI * 2),
			);
			orbitRadii.push(bandRadius);
			const phase = stableAgentAngle(`${system.id}:${depth}`, band);
			for (const [index, node] of bandNodes.entries()) {
				const angle = phase + (index / bandNodes.length) * Math.PI * 2;
				const nodeRadius = nodeRadiusForDepth(node.depth);
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
	const ordered = [...systems].sort((left, right) => left.id.localeCompare(right.id));
	const placed: PlacedSystem[] = [];
	for (const [index, system] of ordered.entries()) {
		const local = layoutAgentSystem(system);
		if (index === 0) {
			placed.push({ system, layout: local, x: 0, y: 0 });
			continue;
		}
		let x = 0;
		let y = 0;
		let accepted = false;
		for (let attempt = 1; attempt <= 512; attempt += 1) {
			const angle = stableAgentAngle(system.id) + attempt * GOLDEN_ANGLE;
			const distance =
				Math.max(
					240,
					...placed.map((item) => item.layout.radius + local.radius + SYSTEM_GAP),
				) +
				Math.sqrt(attempt) * 92;
			const candidateX = Math.cos(angle) * distance;
			const candidateY = Math.sin(angle) * distance;
			const collides = placed.some((item) => {
				const dx = candidateX - item.x;
				const dy = candidateY - item.y;
				return (
					Math.sqrt(dx * dx + dy * dy) <
					item.layout.radius + local.radius + SYSTEM_GAP
				);
			});
			if (!collides) {
				x = candidateX;
				y = candidateY;
				accepted = true;
				break;
			}
		}
		if (!accepted) {
			const fallbackAngle = stableAgentAngle(`${system.id}:fallback`);
			const distance =
				Math.max(
					240,
					...placed.map((item) => item.layout.radius + local.radius + SYSTEM_GAP),
				) +
				(placed.length + 1) * 120;
			x = Math.cos(fallbackAngle) * distance;
			y = Math.sin(fallbackAngle) * distance;
		}
		placed.push({ system, layout: local, x, y });
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
	const margin = Math.min(96, Math.max(42, Math.min(safeWidth, safeHeight) * 0.08));
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
