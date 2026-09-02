/** Shared physical-motion constants and pure helpers for renderer interactions. */
export const KESTREL_CRITICAL_SPRING = {
	type: "spring" as const,
	stiffness: 520,
	damping: 42,
	mass: 0.85,
};

export const KESTREL_GENTLE_SPRING = {
	type: "spring" as const,
	stiffness: 360,
	damping: 35,
	mass: 0.85,
};

export const KESTREL_STATE_TRANSITION = {
	duration: 0.16,
	ease: [0.2, 0.8, 0.2, 1] as const,
};

/**
 * An interrupted rail transition may have accumulated a large velocity when
 * the window is running at a lower refresh rate. Carrying that value into the
 * opposite direction lets one delayed frame collapse the rail to an endpoint.
 * Preserve the gesture's direction, but hand the new spring a bounded amount
 * of momentum so reversal remains visibly continuous.
 */
export const MAX_INTERRUPTED_PANEL_VELOCITY = 720;

export function handoffSpringVelocity(
	position: number,
	velocity: number,
	target: number,
): number {
	if (!Number.isFinite(velocity) || !Number.isFinite(position) || !Number.isFinite(target))
		return 0;
	return Math.min(
		MAX_INTERRUPTED_PANEL_VELOCITY,
		Math.max(-MAX_INTERRUPTED_PANEL_VELOCITY, velocity),
	);
}

export function springDampingRatio({
	stiffness,
	damping,
	mass,
}: {
	stiffness: number;
	damping: number;
	mass: number;
}): number {
	return damping / (2 * Math.sqrt(stiffness * mass));
}

export function clampAgentPanelWidth(width: number, viewportWidth: number): number {
	const maximum = Math.max(288, Math.min(520, viewportWidth * 0.44));
	return Math.min(maximum, Math.max(288, width));
}

export function projectedPanelWidth(
	width: number,
	velocityPxPerSecond: number,
	viewportWidth: number,
): number {
	// A short projection preserves the release gesture without turning resize
	// into a fling. The critical spring absorbs the remainder without bounce.
	return clampAgentPanelWidth(width + velocityPxPerSecond * 0.08, viewportWidth);
}

export function springStep(
	position: number,
	velocity: number,
	target: number,
	deltaSeconds: number,
	config = KESTREL_CRITICAL_SPRING,
): { position: number; velocity: number } {
	const delta = Math.min(1 / 30, Math.max(0, deltaSeconds));
	// Semi-implicit Euler is intentionally integrated in small slices. A
	// throttled/background window can deliver a 30 Hz frame; applying the full
	// delta in one step makes this otherwise-critical spring overshoot and
	// oscillate. The slices keep the physical contract stable without changing
	// the public frame cadence.
	const sliceCount = Math.max(1, Math.ceil(delta / (1 / 120)));
	const slice = delta / sliceCount;
	let nextPosition = position;
	let nextVelocity = velocity;
	for (let index = 0; index < sliceCount; index += 1) {
		const acceleration =
			(-config.stiffness * (nextPosition - target) -
				config.damping * nextVelocity) /
			config.mass;
		nextVelocity += acceleration * slice;
		nextPosition += nextVelocity * slice;
	}
	return {
		position: nextPosition,
		velocity: nextVelocity,
	};
}
