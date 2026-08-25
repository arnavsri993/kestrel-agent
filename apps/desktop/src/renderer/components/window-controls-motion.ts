export const WINDOW_CONTROL_REVEAL_RADIUS = 72;
export const WINDOW_CONTROL_ACTIVE_RADIUS = 34;

export interface WindowControlPoint {
	x: number;
	y: number;
}

export interface WindowControlBounds {
	left: number;
	top: number;
	width: number;
	height: number;
	right: number;
	bottom: number;
}

export interface WindowControlMotion {
	distance: number;
	isInside: boolean;
	iconOpacity: number;
	iconScale: number;
	controlScale: number;
	lift: number;
	tilt: number;
	triangleX: number;
	triangleY: number;
	fillShade: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

export function centeredWindowControlsTop(
	barTop: number,
	barHeight: number,
	controlHeight: number,
): number {
	return barTop + Math.max(0, (barHeight - controlHeight) / 2);
}

export function calculateWindowControlMotion(
	pointer: WindowControlPoint,
	bounds: WindowControlBounds,
): WindowControlMotion {
	const width = Math.max(1, bounds.width);
	const height = Math.max(1, bounds.height);
	const dx = pointer.x - (bounds.left + width / 2);
	const dy = pointer.y - (bounds.top + height / 2);
	const distance = Math.hypot(dx, dy);
	const raw = clamp(1 - distance / WINDOW_CONTROL_REVEAL_RADIUS, 0, 1);
	const eased = raw * raw * (3 - 2 * raw);
	const normalizedX = clamp(dx / (width / 2), -1, 1);
	const normalizedY = clamp(dy / (height / 2), -1, 1);
	const isInside =
		pointer.x >= bounds.left &&
		pointer.x <= bounds.right &&
		pointer.y >= bounds.top &&
		pointer.y <= bounds.bottom;

	return {
		distance,
		isInside,
		iconOpacity: eased * 0.92,
		iconScale: 1 + eased * 0.06,
		controlScale: 1 + eased * 0.045,
		lift: -eased * 1.35,
		tilt: normalizedX * eased * 5.5,
		triangleX: normalizedX * eased * 0.8,
		triangleY: normalizedY * eased * 0.55,
		fillShade: clamp(eased * 0.12 + (isInside ? 0.04 : 0), 0, 0.16),
	};
}

export function activeWindowControlIndex(
	motions: readonly WindowControlMotion[],
): number {
	let nearestIndex = -1;
	let nearestDistance = Number.POSITIVE_INFINITY;
	motions.forEach(({ distance }, index) => {
		if (distance < nearestDistance) {
			nearestIndex = index;
			nearestDistance = distance;
		}
	});
	return nearestDistance <= WINDOW_CONTROL_ACTIVE_RADIUS ? nearestIndex : -1;
}
