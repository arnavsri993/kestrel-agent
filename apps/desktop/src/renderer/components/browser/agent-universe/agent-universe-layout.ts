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

// The overview is a navigable field, not a poster. Eight planet slots keep the
// top-level systems legible, while the larger system gap makes each local
// agent-and-moons cluster read as its own small neighborhood.
export const AGENT_UNIVERSE_SYSTEM_GAP = 120;
const LABEL_CLEARANCE = 22;
const WORKER_GAP = 16;
const MOON_ORBIT_GAP = 24;
const MAX_MOONS_PER_ORBIT = 12;
const ORGANIC_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

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
	orbitBand: number;
	angle: number;
}

/**
 * Resolve the deterministic scaffold for one local hierarchy. The root is a
 * planet and each group of delegated sessions gets a compact moon orbit around
 * its parent. The bounded collision pass keeps the initial cluster legible
 * before the interaction physics takes over.
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
	const centerNode = root ?? system.nodes[0];
	if (!centerNode) {
		return {
			systemId: system.id,
			centerX,
			centerY,
			radius: 1,
			nodeLayouts: [],
			orbitRadii: [],
		};
	}
	const centerNodeId = centerNode.id;
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
		.sort((left, right) => left.depth - right.depth || stableNodeOrder(left, right));
	const rootPlacement: LocalPlacement = {
		node: centerNode,
		x: centerX,
		y: centerY,
		radius: rootRadius,
		packingRadius: rootPackingRadius,
		orbitBand: 0,
		angle: 0,
	};
	const nodeIds = new Set(system.nodes.map((node) => node.id));
	const placements = new Map<string, LocalPlacement>();
	const childrenByParent = new Map<string, AgentNodeProjection[]>();
	for (const node of workers) {
		// Missing parents remain inspectable, but visually behave as moons of the
		// system planet rather than becoming an unrelated second cluster.
		const parentId =
			node.parentId && node.parentId !== node.id && nodeIds.has(node.parentId)
				? node.parentId
				: centerNodeId;
		const children = childrenByParent.get(parentId) ?? [];
		children.push(node);
		childrenByParent.set(parentId, children);
	}
	for (const children of childrenByParent.values())
		children.sort(stableNodeOrder);

	const plannedOrbitRadii: number[] = [];
	const parentDepth = new Map<string, number>([
		[centerNodeId, 0],
		...system.nodes.map((node) => [node.id, node.depth] as const),
	]);
	const groups = [...childrenByParent.entries()].sort(
		([leftId], [rightId]) =>
			(parentDepth.get(leftId) ?? 0) - (parentDepth.get(rightId) ?? 0) ||
			leftId.localeCompare(rightId),
	);

	for (const [parentId, children] of groups) {
		const parent = placements.get(parentId) ??
			(parentId === centerNodeId ? rootPlacement : undefined);
		if (!parent) continue;
		for (let band = 0; band * MAX_MOONS_PER_ORBIT < children.length; band += 1) {
			const bandStart = band * MAX_MOONS_PER_ORBIT;
			const bandChildren = children.slice(
				bandStart,
				bandStart + MAX_MOONS_PER_ORBIT,
			);
			const maximumPackingRadius = Math.max(
				...bandChildren.map((node) =>
					nodePackingRadiusForDepth(node, childCounts.get(node.id) ?? 0),
				),
			);
			const circumferenceMinimum =
				(bandChildren.length * (maximumPackingRadius * 2 + WORKER_GAP)) /
				(2 * Math.PI);
			const distance = Math.max(
				parent.packingRadius +
					MOON_ORBIT_GAP +
					maximumPackingRadius +
					band * (maximumPackingRadius * 2 + MOON_ORBIT_GAP),
				circumferenceMinimum,
			);
			if (parentId === centerNodeId) plannedOrbitRadii.push(distance);
			const phase = stableAgentAngle(
				`${system.id}:${parentId}:moon-orbit:${band}`,
			);
			for (const [index, node] of bandChildren.entries()) {
				const packingRadius = nodePackingRadiusForDepth(
					node,
					childCounts.get(node.id) ?? 0,
				);
				// A golden-angle scaffold with a small per-node jitter keeps the
				// hierarchy legible without making every moon look stamped onto an
				// even ring. The finite collision pass below resolves the few
				// intentional near misses in true two-dimensional space.
				const angleJitter =
					((stableAgentAngle(`${system.id}:${node.id}:angle`) + Math.PI / 2) /
						(Math.PI * 2) -
						0.5) *
					0.28;
				const radialJitter =
					((stableAgentAngle(`${system.id}:${node.id}:radius`, band + 1) + Math.PI / 2) /
						(Math.PI * 2) -
						0.5) *
					Math.min(46, distance * 0.16);
				const angle = phase + index * ORGANIC_GOLDEN_ANGLE + angleJitter;
				const organicDistance = Math.max(
					parent.packingRadius + MOON_ORBIT_GAP + packingRadius,
					distance + radialJitter,
				);
				placements.set(node.id, {
					node,
					x: parent.x + Math.cos(angle) * organicDistance,
					y: parent.y + Math.sin(angle) * organicDistance,
					radius: nodeRadiusForDepth(
						node,
						childCounts.get(node.id) ?? 0,
					),
					packingRadius,
					orbitBand: Math.max(1, parent.orbitBand + band + 1),
					angle,
				});
			}
		}
	}

	// A malformed depth/parent graph should never make a session disappear
	// from the map. If a parent could not be placed in the ordered pass, put the
	// remaining node on a deterministic root orbit as a final safe fallback.
	for (const node of workers) {
		if (placements.has(node.id)) continue;
		const packingRadius = nodePackingRadiusForDepth(
			node,
			childCounts.get(node.id) ?? 0,
		);
		const angle = stableAgentAngle(`${system.id}:${node.id}:fallback-moon`);
		const distance = rootPackingRadius + MOON_ORBIT_GAP + packingRadius;
		placements.set(node.id, {
			node,
			x: centerX + Math.cos(angle) * distance,
			y: centerY + Math.sin(angle) * distance,
			radius: nodeRadiusForDepth(node, childCounts.get(node.id) ?? 0),
			packingRadius,
			orbitBand: 1,
			angle,
		});
		if (!plannedOrbitRadii.length) plannedOrbitRadii.push(distance);
	}

	const placementList = workers.flatMap((node) => {
		const placement = placements.get(node.id);
		return placement ? [placement] : [];
	});

	// The initial scaffold is intentionally a finite, deterministic collision
	// solve. It handles large profiles without waking a runtime animation loop.
	for (let iteration = 0; iteration < 72; iteration += 1) {
		let moved = false;
		for (const placement of placementList) {
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
		for (let left = 0; left < placementList.length; left += 1) {
			for (let right = left + 1; right < placementList.length; right += 1) {
				const first = placementList[left]!;
				const second = placementList[right]!;
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

	for (const placement of placementList) {
		const relativeX = placement.x - centerX;
		const relativeY = placement.y - centerY;
		const orbitRadius = Math.hypot(relativeX, relativeY);
		nodeLayouts.push({
			nodeId: placement.node.id,
			x: placement.x,
			y: placement.y,
			radius: placement.radius,
			orbitRadius,
			orbitBand: placement.orbitBand,
			angle: Math.atan2(relativeY, relativeX),
		});
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
		// Only root-centered rings are rendered. Nested descendants still use
		// parent-relative moon placement, but do not add a forest of guides.
		orbitRadii: uniqueNumbers(plannedOrbitRadii),
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
	// grow a deterministic, jittered spiral around it. A spiral is deliberately
	// used instead of equal rings: the map should feel like a navigable field,
	// not a chart with every planet pinned to a clock face.
	const ordered = [...systems];
	const locals = ordered.map((system) => layoutAgentSystem(system));
	if (ordered.length === 0) return [];
	const placed: PlacedSystem[] = [
		{ system: ordered[0]!, layout: locals[0]!, x: 0, y: 0 },
	];
	if (ordered.length === 1) return placed;

	const largestRadius = Math.max(...locals.map((layout) => layout.radius));
	const first = placed[0]!;
	for (let index = 1; index < ordered.length; index += 1) {
		const system = ordered[index]!;
		const local = locals[index]!;
		const minimumFromCenter =
			first.layout.radius + local.radius + AGENT_UNIVERSE_SYSTEM_GAP;
		let candidate: PlacedSystem | undefined;
		// Try bounded points along a golden-angle spiral. Each retry moves
		// farther out only when the current point would collide with an earlier
		// system, which keeps the common case compact while remaining total for
		// pathological profiles.
		for (let attempt = 0; attempt < 240 && !candidate; attempt += 1) {
			const angle =
				stableAgentAngle(`agent-universe:${system.id}:position:${attempt}`) +
				(index - 1) * ORGANIC_GOLDEN_ANGLE * 0.62;
			const jitter =
				((stableAgentAngle(`agent-universe:${system.id}:radius:${attempt}`) +
					Math.PI / 2) /
					(Math.PI * 2) -
					0.5) *
				18;
			const distance =
				minimumFromCenter +
				Math.sqrt(index) * Math.min(110, largestRadius * 0.42) +
				attempt * Math.max(18, largestRadius * 0.11) +
				jitter;
			const x = Math.cos(angle) * distance;
			const y = Math.sin(angle) * distance;
			const overlaps = placed.some(
				(existing) =>
					Math.hypot(existing.x - x, existing.y - y) <
						existing.layout.radius + local.radius + AGENT_UNIVERSE_SYSTEM_GAP,
			);
			if (!overlaps) candidate = { system, layout: local, x, y };
		}
		if (!candidate) {
			// The retry budget is intentionally finite. This fallback still keeps
			// the geometry honest by placing the body beyond every existing
			// bounding radius instead of silently overlapping it.
			const distance = placed.reduce(
				(maximum, existing) =>
					Math.max(
						maximum,
						Math.hypot(existing.x, existing.y) +
							existing.layout.radius +
							local.radius +
							AGENT_UNIVERSE_SYSTEM_GAP,
					),
				minimumFromCenter,
			);
			const angle = stableAgentAngle(`agent-universe:${system.id}:fallback`);
			candidate = {
				system,
				layout: local,
				x: Math.cos(angle) * distance,
				y: Math.sin(angle) * distance,
			};
		}
		placed.push(candidate);
	}

	// Defensively resolve any near misses as a true 2D separation pass. Keep
	// the focal system at the origin so fitting and focus framing remain stable.
	for (let iteration = 0; iteration < 96; iteration += 1) {
		let moved = false;
		for (let index = 1; index < placed.length; index += 1) {
			const item = placed[index]!;
			const distance = Math.hypot(item.x, item.y);
			const minimum = first.layout.radius + item.layout.radius + AGENT_UNIVERSE_SYSTEM_GAP;
			if (distance >= minimum) continue;
			const angle =
				distance > 0.001
					? Math.atan2(item.y, item.x)
					: stableAgentAngle(`${item.system.id}:origin-separation`);
			item.x = Math.cos(angle) * minimum;
			item.y = Math.sin(angle) * minimum;
			moved = true;
		}
		for (let left = 1; left < placed.length; left += 1) {
			for (let right = left + 1; right < placed.length; right += 1) {
				const firstItem = placed[left]!;
				const secondItem = placed[right]!;
				const dx = secondItem.x - firstItem.x;
				const dy = secondItem.y - firstItem.y;
				const distance = Math.hypot(dx, dy);
				const minimum =
					firstItem.layout.radius +
					secondItem.layout.radius +
					AGENT_UNIVERSE_SYSTEM_GAP;
				if (distance >= minimum) continue;
				const angle =
					distance > 0.001
						? Math.atan2(dy, dx)
						: stableAgentAngle(
								`${firstItem.system.id}:${secondItem.system.id}:separation`,
							);
				const push = (minimum - distance) / 2;
				firstItem.x -= Math.cos(angle) * push;
				firstItem.y -= Math.sin(angle) * push;
				secondItem.x += Math.cos(angle) * push;
				secondItem.y += Math.sin(angle) * push;
				moved = true;
			}
		}
		if (!moved) break;
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
	const overviewIds =
		snapshot.overviewSystemIds.length > 0 || snapshot.systems.length === 0
			? new Set(snapshot.overviewSystemIds)
			: new Set(snapshot.systems.map((system) => system.id));
	const systems = focused
		? [focused]
		: snapshot.systems.filter((system) => overviewIds.has(system.id));
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
