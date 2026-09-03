export interface AgentUniversePhysicsNodeInput {
	id: string;
	parentId?: string;
	x: number;
	y: number;
	radius: number;
	isRoot?: boolean;
}

export interface AgentUniversePhysicsPoint {
	x: number;
	y: number;
}

export interface AgentUniversePhysicsNodeState extends AgentUniversePhysicsNodeInput {
	homeX: number;
	homeY: number;
	parentHomeX: number;
	parentHomeY: number;
	x: number;
	y: number;
	vx: number;
	vy: number;
}

export interface AgentUniversePhysicsDragState {
	nodeId: string;
	target: AgentUniversePhysicsPoint;
	origin: AgentUniversePhysicsPoint;
	offset: AgentUniversePhysicsPoint;
}

export interface AgentUniversePhysicsState {
	nodes: AgentUniversePhysicsNodeState[];
	drag: AgentUniversePhysicsDragState | null;
}

export interface AgentUniversePhysicsRenderTarget {
	body: SVGElement;
}

export interface AgentUniversePhysicsEdgeRenderTarget {
	element: SVGLineElement;
	sourceId: string;
	targetId: string;
}

export interface AgentUniversePhysicsController {
	update(
		nodes: readonly AgentUniversePhysicsNodeInput[],
		targets: ReadonlyMap<string, AgentUniversePhysicsRenderTarget>,
		reducedMotion: boolean,
		edges?: readonly AgentUniversePhysicsEdgeRenderTarget[],
	): void;
	startDrag(nodeId: string, point: AgentUniversePhysicsPoint): boolean;
	moveDrag(point: AgentUniversePhysicsPoint): void;
	endDrag(): void;
	cancelDrag(): void;
	isDragging(): boolean;
	destroy(): void;
}

// The layout is already collision-resolved. Keep the physics gap small and
// proportional to the rendered body so a zoomed-out profile does not acquire
// an artificial seven-pixel exclusion zone around every tiny worker.
const MIN_COLLISION_GAP = 1.5;
const MAX_COLLISION_GAP = 5;
// Keep the soft part of the repulsion close to contact. It is only applied
// while a local cluster is moving; otherwise the deterministic scaffold stays
// exactly at rest instead of drifting away from its saved spatial memory.
const NEIGHBOR_REPULSION_RANGE = 12;
const NEIGHBOR_REPULSION_SPEED = 0.22;
const MAX_PHYSICS_STEP_SECONDS = 1 / 28;
const MAX_SPEED = 1_050;
const SETTLE_SPEED = 0.22;
const SETTLE_DISTANCE = 0.16;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function safeRadius(radius: number): number {
	return Number.isFinite(radius) && radius > 0 ? radius : 1;
}

function stableDirection(leftId: string, rightId: string): AgentUniversePhysicsPoint {
	let hash = 2_166_136_261;
	for (const character of `${leftId}:${rightId}`) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16_777_619);
	}
	const angle = ((hash >>> 0) / 4_294_967_296) * Math.PI * 2;
	return { x: Math.cos(angle), y: Math.sin(angle) };
}

function distanceBetween(
	left: AgentUniversePhysicsPoint,
	right: AgentUniversePhysicsPoint,
): number {
	return Math.hypot(left.x - right.x, left.y - right.y);
}

function velocityMagnitude(node: AgentUniversePhysicsNodeState): number {
	return Math.hypot(node.vx, node.vy);
}

function collisionGap(
	left: AgentUniversePhysicsNodeState,
	right: AgentUniversePhysicsNodeState,
): number {
	return clamp(
		Math.min(safeRadius(left.radius), safeRadius(right.radius)) * 0.08,
		MIN_COLLISION_GAP,
		MAX_COLLISION_GAP,
	);
}

function vectorToParent(
	node: AgentUniversePhysicsNodeState,
	byId: ReadonlyMap<string, AgentUniversePhysicsNodeState>,
): AgentUniversePhysicsPoint {
	const parent = node.parentId ? byId.get(node.parentId) : undefined;
	return parent
		? { x: parent.x - node.x, y: parent.y - node.y }
		: { x: node.parentHomeX - node.x, y: node.parentHomeY - node.y };
}

function targetForNode(
	node: AgentUniversePhysicsNodeState,
	byId: ReadonlyMap<string, AgentUniversePhysicsNodeState>,
	draggedNodeId: string | undefined,
): AgentUniversePhysicsPoint {
	const parent = node.parentId ? byId.get(node.parentId) : undefined;
	const parentX = parent?.x ?? node.parentHomeX;
	const parentY = parent?.y ?? node.parentHomeY;
	const target = {
		x: parentX + (node.homeX - node.parentHomeX),
		y: parentY + (node.homeY - node.parentHomeY),
	};
	if (!draggedNodeId || node.id === draggedNodeId) return target;

	const dragged = byId.get(draggedNodeId);
	if (!dragged) return target;
	const displacement = {
		x: dragged.x - dragged.homeX,
		y: dragged.y - dragged.homeY,
	};
	const distance = Math.hypot(displacement.x, displacement.y);
	if (distance < 1) return target;
	const vacancyStrength = clamp(distance / (safeRadius(dragged.radius) * 3.2), 0, 1) * 0.18;
	const distanceToVacancy = Math.hypot(
		dragged.homeX - target.x,
		dragged.homeY - target.y,
	);
	const falloff = clamp(
		1 - distanceToVacancy / (safeRadius(node.radius) * 4.5 + 180),
		0,
		1,
	);
	// The hole is the worker's old equilibrium. Neighbours lean toward it,
	// rather than toward the pointer, so the cluster remains a cohesive object.
	return {
		x: target.x + (dragged.homeX - target.x) * vacancyStrength * falloff,
		y: target.y + (dragged.homeY - target.y) * vacancyStrength * falloff,
	};
}

function initialPhysicsState(
	nodes: readonly AgentUniversePhysicsNodeInput[],
): AgentUniversePhysicsState {
	const root = nodes.find((node) => node.isRoot);
	const rootX = root?.x ?? nodes[0]?.x ?? 0;
	const rootY = root?.y ?? nodes[0]?.y ?? 0;
	const inputById = new Map(nodes.map((node) => [node.id, node]));
	const states = nodes.map((node) => {
		const parent = node.parentId ? inputById.get(node.parentId) : undefined;
		return {
			...node,
			radius: safeRadius(node.radius),
			homeX: node.x,
			homeY: node.y,
			parentHomeX: parent?.x ?? rootX,
			parentHomeY: parent?.y ?? rootY,
			x: node.x,
			y: node.y,
			vx: 0,
			vy: 0,
		};
	});
	return { nodes: states, drag: null };
}

/**
 * Reconcile a new layout without replacing the rendered frame with its final
 * coordinates. Layout can change when the window resizes, a session appears,
 * or the snapshot is refreshed. Keeping each surviving body's world position
 * and changing only its home lets the existing physics loop carry the body to
 * the new layout over real frames. New bodies still enter at their home so a
 * refresh cannot invent a travel path for data that was not previously shown.
 */
export function reconcileAgentUniversePhysicsState(
	previous: AgentUniversePhysicsState,
	nodes: readonly AgentUniversePhysicsNodeInput[],
): AgentUniversePhysicsState {
	if (previous.nodes.length === 0) return initialPhysicsState(nodes);

	const root = nodes.find((node) => node.isRoot);
	const rootX = root?.x ?? nodes[0]?.x ?? 0;
	const rootY = root?.y ?? nodes[0]?.y ?? 0;
	const inputById = new Map(nodes.map((node) => [node.id, node]));
	const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
	const nextNodes = nodes.map((node) => {
		const parent = node.parentId ? inputById.get(node.parentId) : undefined;
		const prior = previousById.get(node.id);
		return {
			...node,
			radius: safeRadius(node.radius),
			homeX: node.x,
			homeY: node.y,
			parentHomeX: parent?.x ?? rootX,
			parentHomeY: parent?.y ?? rootY,
			x: prior?.x ?? node.x,
			y: prior?.y ?? node.y,
			vx: prior?.vx ?? 0,
			vy: prior?.vy ?? 0,
		};
	});
	const drag = previous.drag && nextNodes.some((node) => node.id === previous.drag?.nodeId)
		? {
			...previous.drag,
			target: { ...previous.drag.target },
			origin: { ...previous.drag.origin },
			offset: { ...previous.drag.offset },
		}
		: null;
	return { nodes: nextNodes, drag };
}

export interface AgentUniversePhysicsStepOptions {
	dt: number;
	reducedMotion?: boolean;
}

/**
 * Advance one local cluster. The root is a fixed center of mass; workers are
 * tethered to their parent-relative rest position, gently repelled at close
 * range, and redistributed toward a dragged worker's vacated slot. The
 * function is deterministic for a given state and does not depend on React.
 */
export function stepAgentUniversePhysics(
	state: AgentUniversePhysicsState,
	options: AgentUniversePhysicsStepOptions,
): AgentUniversePhysicsState {
	const dt = clamp(options.dt, 0, MAX_PHYSICS_STEP_SECONDS);
	if (dt <= 0 || state.nodes.length === 0) return state;
	const reducedMotion = options.reducedMotion === true;
	const drag = state.drag;
	const nextNodes = state.nodes.map((node) => ({ ...node }));
	const nextById = new Map(nextNodes.map((node) => [node.id, node]));
	const accelerations = new Map<string, AgentUniversePhysicsPoint>();
	for (const node of nextNodes) accelerations.set(node.id, { x: 0, y: 0 });

	for (const node of nextNodes) {
		if (node.isRoot) {
			const acceleration = accelerations.get(node.id)!;
			const rootSpring = reducedMotion ? 30 : 18;
			acceleration.x += (node.homeX - node.x) * rootSpring;
			acceleration.y += (node.homeY - node.y) * rootSpring;
			continue;
		}
		const isDragged = drag?.nodeId === node.id;
		const target = isDragged
			? drag.target
			: targetForNode(node, nextById, drag?.nodeId);
		const spring = isDragged
			? reducedMotion
				? 72
				: 48
			: reducedMotion
				? 30
				: 18;
		const acceleration = accelerations.get(node.id)!;
		acceleration.x += (target.x - node.x) * spring;
		acceleration.y += (target.y - node.y) * spring;
	}

	// A local all-pairs pass is intentionally bounded to one system. Real
	// profiles have many systems but each cluster is small; avoiding a global
	// force graph keeps unrelated systems asleep and keeps this easy to reason
	// about. The early distance check makes distant pairs cheap.
	for (let leftIndex = 0; leftIndex < nextNodes.length; leftIndex += 1) {
		const left = nextNodes[leftIndex]!;
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < nextNodes.length;
			rightIndex += 1
		) {
			const right = nextNodes[rightIndex]!;
			let dx = right.x - left.x;
			let dy = right.y - left.y;
			let distance = Math.hypot(dx, dy);
			if (distance < 0.001) {
				const direction = stableDirection(left.id, right.id);
				dx = direction.x;
				dy = direction.y;
				distance = 1;
			}
			const minimumDistance =
				safeRadius(left.radius) +
				safeRadius(right.radius) +
				collisionGap(left, right);
			const repulsionRange = minimumDistance + NEIGHBOR_REPULSION_RANGE;
			if (distance >= repulsionRange) continue;
			const directionX = dx / distance;
			const directionY = dy / distance;
			const overlap = Math.max(0, minimumDistance - distance);
			const softRepulsion = clamp(
				1 - Math.max(0, distance - minimumDistance) / NEIGHBOR_REPULSION_RANGE,
				0,
				1,
			);
			const pairIsMoving =
				Boolean(drag) ||
				velocityMagnitude(left) > NEIGHBOR_REPULSION_SPEED ||
				velocityMagnitude(right) > NEIGHBOR_REPULSION_SPEED ||
				distanceBetween(left, { x: left.homeX, y: left.homeY }) >
					SETTLE_DISTANCE ||
				distanceBetween(right, { x: right.homeX, y: right.homeY }) >
					SETTLE_DISTANCE;
			const force = overlap * 26 + (pairIsMoving ? softRepulsion * 4 : 0);
			const leftAcceleration = accelerations.get(left.id)!;
			const rightAcceleration = accelerations.get(right.id)!;
			if (!left.isRoot) {
				leftAcceleration.x -= directionX * force;
				leftAcceleration.y -= directionY * force;
			}
			if (!right.isRoot) {
				rightAcceleration.x += directionX * force;
				rightAcceleration.y += directionY * force;
			}
		}
	}

	const damping = reducedMotion ? 14 : 8.8;
	const dragDamping = reducedMotion ? 18 : 11;
	for (const node of nextNodes) {
		const acceleration = accelerations.get(node.id)!;
		const activeDrag = drag?.nodeId === node.id;
		node.vx += acceleration.x * dt;
		node.vy += acceleration.y * dt;
		const dampingFactor = Math.exp(
			-(activeDrag ? dragDamping : damping) * dt,
		);
		node.vx *= dampingFactor;
		node.vy *= dampingFactor;
		const speed = velocityMagnitude(node);
		if (speed > MAX_SPEED) {
			const scale = MAX_SPEED / speed;
			node.vx *= scale;
			node.vy *= scale;
		}
		node.x += node.vx * dt;
		node.y += node.vy * dt;
	}

	return {
		nodes: nextNodes,
		drag,
	};
}

function hasSettled(state: AgentUniversePhysicsState): boolean {
	if (state.drag) return false;
	return state.nodes.every((node) => {
		return (
			velocityMagnitude(node) <= SETTLE_SPEED &&
			distanceBetween(node, { x: node.homeX, y: node.homeY }) <= SETTLE_DISTANCE
		);
	});
}

class AgentUniversePhysicsControllerImpl implements AgentUniversePhysicsController {
	private state: AgentUniversePhysicsState = { nodes: [], drag: null };
	private targets: ReadonlyMap<string, AgentUniversePhysicsRenderTarget> = new Map();
	private edgeTargets: readonly AgentUniversePhysicsEdgeRenderTarget[] = [];
	private reducedMotion = false;
	private signature = "";
	private frameId: number | null = null;
	private lastFrameTime = 0;
	private destroyed = false;

	update(
		nodes: readonly AgentUniversePhysicsNodeInput[],
		targets: ReadonlyMap<string, AgentUniversePhysicsRenderTarget>,
		reducedMotion: boolean,
		edges: readonly AgentUniversePhysicsEdgeRenderTarget[] = [],
	): void {
		// React StrictMode replays effect setup/cleanup once in development. A
		// later update is a safe signal that this controller is mounted again.
		this.destroyed = false;
		this.reducedMotion = reducedMotion;
		this.targets = targets;
		this.edgeTargets = edges;
		const signature = nodes
			.map(
				(node) =>
					`${node.id}:${node.parentId ?? ""}:${node.x}:${node.y}:${node.radius}:${node.isRoot ? 1 : 0}`,
			)
			.join("|");
		if (signature !== this.signature) {
			this.signature = signature;
			this.state = reconcileAgentUniversePhysicsState(this.state, nodes);
		}
		if (reducedMotion && !this.state.drag) this.snapToHomes();
		this.render();
		this.ensureFrame();
	}

	startDrag(nodeId: string, point: AgentUniversePhysicsPoint): boolean {
		if (this.destroyed) return false;
		const node = this.state.nodes.find((candidate) => candidate.id === nodeId);
		if (!node || node.isRoot) return false;
		const offset = { x: point.x - node.x, y: point.y - node.y };
		this.state.drag = {
			nodeId,
			target: { x: node.x, y: node.y },
			origin: { x: node.x, y: node.y },
			offset,
		};
		this.ensureFrame();
		return true;
	}

	moveDrag(point: AgentUniversePhysicsPoint): void {
		const drag = this.state.drag;
		if (!drag) return;
		drag.target = {
			x: point.x - drag.offset.x,
			y: point.y - drag.offset.y,
		};
		this.ensureFrame();
	}

	endDrag(): void {
		if (!this.state.drag) return;
		this.state.drag = null;
		if (this.reducedMotion) this.snapToHomes();
		this.render();
		this.ensureFrame();
	}

	cancelDrag(): void {
		if (!this.state.drag) return;
		const node = this.state.nodes.find(
			(candidate) => candidate.id === this.state.drag?.nodeId,
		);
		if (node) {
			node.x = node.homeX;
			node.y = node.homeY;
			node.vx = 0;
			node.vy = 0;
		}
		this.state.drag = null;
		this.render();
		this.ensureFrame();
	}

	isDragging(): boolean {
		return this.state.drag !== null;
	}

	destroy(): void {
		this.destroyed = true;
		if (this.frameId !== null) cancelAnimationFrame(this.frameId);
		this.frameId = null;
		this.targets = new Map();
		this.edgeTargets = [];
	}

	private ensureFrame(): void {
		if (this.destroyed || this.frameId !== null || hasSettled(this.state)) return;
		this.lastFrameTime = 0;
		this.frameId = requestAnimationFrame((time) => this.runFrame(time));
	}

	private runFrame(time: number): void {
		this.frameId = null;
		if (this.destroyed) return;
		const dt = this.lastFrameTime
			? clamp((time - this.lastFrameTime) / 1_000, 0, MAX_PHYSICS_STEP_SECONDS)
			: 1 / 60;
		this.lastFrameTime = time;
		if (this.reducedMotion && !this.state.drag) {
			this.snapToHomes();
		} else {
			this.state = stepAgentUniversePhysics(this.state, {
				dt,
				reducedMotion: this.reducedMotion,
			});
		}
		const settled = hasSettled(this.state);
		if (settled) {
			// Remove sub-pixel integration residue once the damped return is
			// visually complete. This preserves a clean spatial identity for the
			// next interaction and lets the controller sleep deterministically.
			for (const node of this.state.nodes) {
				node.x = node.homeX;
				node.y = node.homeY;
				node.vx = 0;
				node.vy = 0;
			}
		}
		this.render();
		if (!settled) this.ensureFrame();
	}

	private render(): void {
		const byId = new Map(this.state.nodes.map((node) => [node.id, node]));
		for (const node of this.state.nodes) {
			const target = this.targets.get(node.id);
			if (!target) continue;
			const deltaX = node.x - node.homeX;
			const deltaY = node.y - node.homeY;
			target.body.setAttribute(
				"transform",
				`translate(${deltaX.toFixed(2)} ${deltaY.toFixed(2)})`,
			);
			target.body.setAttribute("data-physics-x", node.x.toFixed(2));
			target.body.setAttribute("data-physics-y", node.y.toFixed(2));
			target.body.setAttribute(
				"data-physics-displacement",
				Math.hypot(deltaX, deltaY).toFixed(2),
			);
			target.body.setAttribute(
				"data-physics-dragging",
				this.state.drag?.nodeId === node.id ? "true" : "false",
			);
		}
		for (const edge of this.edgeTargets) {
			const source = byId.get(edge.sourceId);
			const target = byId.get(edge.targetId);
			if (!source || !target) continue;
			edge.element.setAttribute("x1", source.x.toFixed(2));
			edge.element.setAttribute("y1", source.y.toFixed(2));
			edge.element.setAttribute("x2", target.x.toFixed(2));
			edge.element.setAttribute("y2", target.y.toFixed(2));
		}
	}

	private snapToHomes(): void {
		for (const node of this.state.nodes) {
			if (this.state.drag?.nodeId === node.id) continue;
			node.x = node.homeX;
			node.y = node.homeY;
			node.vx = 0;
			node.vy = 0;
		}
	}
}

export function createAgentUniversePhysicsController(): AgentUniversePhysicsController {
	return new AgentUniversePhysicsControllerImpl();
}

export function createAgentUniversePhysicsState(
	nodes: readonly AgentUniversePhysicsNodeInput[],
): AgentUniversePhysicsState {
	return initialPhysicsState(nodes);
}
