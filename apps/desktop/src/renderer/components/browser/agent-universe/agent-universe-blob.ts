import { stableAgentHash } from "./agent-universe-model";

export interface AgentUniverseBlobPoint {
	x: number;
	y: number;
}

export interface AgentUniverseBlobGeometry {
	points: readonly AgentUniverseBlobPoint[];
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = Math.imul(state ^ (state >>> 15), 1 | state);
		state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
		return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function finiteRadius(radius: number): number {
	return Number.isFinite(radius) && radius > 0 ? radius : 1;
}

function format(value: number): string {
	return value.toFixed(2);
}

/**
 * Draw a closed, low-frequency silhouette rather than a circle. The points
 * are created once per session and are deliberately seed-derived, so a body
 * keeps the same visual identity while its position or tension changes.
 */
export function createAgentUniverseBlobGeometry(
	id: string,
	radius: number,
	isRoot = false,
): AgentUniverseBlobGeometry {
	const safeRadius = finiteRadius(radius);
	const count = isRoot ? 14 : 11;
	const random = seededRandom(stableAgentHash(`agent-universe-blob:${id}`));
	const phase = (random() - 0.5) * 0.16;
	const points: AgentUniverseBlobPoint[] = [];
	for (let index = 0; index < count; index += 1) {
		const angle = phase + (index / count) * Math.PI * 2;
		// Keep the silhouette soft and tactile. A low amplitude plus smooth
		// interpolation avoids the spiky or gelatinous look of noisy polygons.
		const radialScale = 0.91 + random() * 0.13;
		const x = Math.cos(angle) * safeRadius * radialScale;
		const y = Math.sin(angle) * safeRadius * radialScale;
		points.push({ x, y });
	}
	return { points };
}

function pathThroughPoints(points: readonly AgentUniverseBlobPoint[]): string {
	if (points.length === 0) return "";
	if (points.length === 1) {
		const point = points[0]!;
		return `M ${format(point.x)} ${format(point.y)} Z`;
	}

	const first = points[0]!;
	let path = `M ${format(first.x)} ${format(first.y)}`;
	for (let index = 0; index < points.length; index += 1) {
		const previous = points[(index - 1 + points.length) % points.length]!;
		const current = points[index]!;
		const next = points[(index + 1) % points.length]!;
		const nextNext = points[(index + 2) % points.length]!;
		// Catmull-Rom to cubic conversion. The 1/6 control-point factor keeps
		// the curve close to the sampled mass instead of making a soft star.
		const controlOne = {
			x: current.x + (next.x - previous.x) / 6,
			y: current.y + (next.y - previous.y) / 6,
		};
		const controlTwo = {
			x: next.x - (nextNext.x - current.x) / 6,
			y: next.y - (nextNext.y - current.y) / 6,
		};
		path += ` C ${format(controlOne.x)} ${format(controlOne.y)} ${format(controlTwo.x)} ${format(controlTwo.y)} ${format(next.x)} ${format(next.y)}`;
	}
	return `${path} Z`;
}

/**
 * Deform an existing silhouette along the vector from a worker to its parent.
 * The transform is intentionally anisotropic and bounded, but it is applied
 * to an irregular path rather than to a circle with scaleX.
 */
export function agentUniverseBlobPath(
	geometry: AgentUniverseBlobGeometry,
	tension = 0,
	parentAngle = 0,
): string {
	const boundedTension = clamp(tension, 0, 1);
	if (boundedTension <= 0.0001) return pathThroughPoints(geometry.points);

	const towardParentX = Math.cos(parentAngle);
	const towardParentY = Math.sin(parentAngle);
	const perpendicularX = -towardParentY;
	const perpendicularY = towardParentX;
	const alongScale = 1 + boundedTension * 0.23;
	const acrossScale = 1 - boundedTension * 0.075;
	const points = geometry.points.map((point) => {
		const along = point.x * towardParentX + point.y * towardParentY;
		const across = point.x * perpendicularX + point.y * perpendicularY;
		// Add a small leading-side bulge and a restrained trailing compression.
		const leadingBulge = Math.max(0, along) * boundedTension * 0.045;
		const compressedAlong =
			along * alongScale * (1 - Math.max(0, -along) / 200 * boundedTension * 0.05);
		const nextAlong = compressedAlong + leadingBulge;
		return {
			x: towardParentX * nextAlong + perpendicularX * across * acrossScale,
			y: towardParentY * nextAlong + perpendicularY * across * acrossScale,
		};
	});
	return pathThroughPoints(points);
}

export function agentUniverseBlobTension(
	displacement: number,
	radius: number,
	returnSpeed = 0,
): number {
	const safeRadius = finiteRadius(radius);
	const dragDistance = Math.max(0, displacement);
	const distanceProgress = clamp(dragDistance / (safeRadius * 2.8), 0, 1);
	const speedProgress = clamp(returnSpeed / (safeRadius * 5.5), 0, 1);
	// No visible deformation for a tiny nudge. The curve becomes noticeable
	// only after the worker has clearly left its equilibrium.
	return clamp(
		Math.max(Math.pow(distanceProgress, 1.2), speedProgress * 0.42),
		0,
		1,
	);
}
