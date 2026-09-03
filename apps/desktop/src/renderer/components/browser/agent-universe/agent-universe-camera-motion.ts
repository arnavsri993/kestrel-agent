import {
	KESTREL_GENTLE_SPRING,
	springStep,
} from "../../../motion-contract";
import type { AgentUniverseCamera } from "./agent-universe-camera";

export interface AgentUniverseCameraVelocity {
	zoom: number;
	panX: number;
	panY: number;
}

export interface AgentUniverseCameraMotionState {
	camera: AgentUniverseCamera;
	velocity: AgentUniverseCameraVelocity;
}

const CAMERA_SETTLE_DISTANCE = 0.08;
const CAMERA_SETTLE_SPEED = 1.5;

const ZERO_CAMERA_VELOCITY: AgentUniverseCameraVelocity = {
	zoom: 0,
	panX: 0,
	panY: 0,
};

function stepCameraValue(
	position: number,
	velocity: number,
	target: number,
	deltaSeconds: number,
): { position: number; velocity: number } {
	const next = springStep(
		position,
		velocity,
		target,
		deltaSeconds,
		KESTREL_GENTLE_SPRING,
	);
	if (
		Math.abs(next.position - target) <= CAMERA_SETTLE_DISTANCE &&
		Math.abs(next.velocity) <= CAMERA_SETTLE_SPEED
	) {
		return { position: target, velocity: 0 };
	}
	return next;
}

export function createAgentUniverseCameraMotionState(
	camera: AgentUniverseCamera,
): AgentUniverseCameraMotionState {
	return {
		camera,
		velocity: { ...ZERO_CAMERA_VELOCITY },
	};
}

/**
 * Advance the map camera as one interruptible, multi-frame motion. Keeping
 * this separate from the SVG's CSS means the map, minimap, and inspector all
 * observe the same rendered camera value on every frame instead of the map
 * easing while the surrounding overlays jump to the final target.
 */
export function stepAgentUniverseCameraMotion(
	state: AgentUniverseCameraMotionState,
	target: AgentUniverseCamera,
	deltaSeconds: number,
	reducedMotion = false,
): AgentUniverseCameraMotionState {
	if (reducedMotion) {
		return {
			camera: target,
			velocity: { ...ZERO_CAMERA_VELOCITY },
		};
	}

	const zoom = stepCameraValue(
		state.camera.zoom,
		state.velocity.zoom,
		target.zoom,
		deltaSeconds,
	);
	const panX = stepCameraValue(
		state.camera.panX,
		state.velocity.panX,
		target.panX,
		deltaSeconds,
	);
	const panY = stepCameraValue(
		state.camera.panY,
		state.velocity.panY,
		target.panY,
		deltaSeconds,
	);

	return {
		camera: {
			zoom: zoom.position,
			panX: panX.position,
			panY: panY.position,
		},
		velocity: {
			zoom: zoom.velocity,
			panX: panX.velocity,
			panY: panY.velocity,
		},
	};
}

export function agentUniverseCameraMotionSettled(
	state: AgentUniverseCameraMotionState,
	target: AgentUniverseCamera,
): boolean {
	return (
		Math.abs(state.camera.zoom - target.zoom) <= CAMERA_SETTLE_DISTANCE &&
		Math.abs(state.camera.panX - target.panX) <= CAMERA_SETTLE_DISTANCE &&
		Math.abs(state.camera.panY - target.panY) <= CAMERA_SETTLE_DISTANCE &&
		Math.abs(state.velocity.zoom) <= CAMERA_SETTLE_SPEED &&
		Math.abs(state.velocity.panX) <= CAMERA_SETTLE_SPEED &&
		Math.abs(state.velocity.panY) <= CAMERA_SETTLE_SPEED
	);
}
