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
	const acceleration =
		(-config.stiffness * (position - target) - config.damping * velocity) /
		config.mass;
	const nextVelocity = velocity + acceleration * delta;
	return {
		position: position + nextVelocity * delta,
		velocity: nextVelocity,
	};
}
