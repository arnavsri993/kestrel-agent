export interface AgentUniverseCamera {
	zoom: number;
	panX: number;
	panY: number;
}

export interface AgentUniversePoint {
	x: number;
	y: number;
}

export const AGENT_UNIVERSE_MIN_ZOOM = 0.72;
export const AGENT_UNIVERSE_MAX_ZOOM = 2.8;

export const DEFAULT_AGENT_UNIVERSE_CAMERA: AgentUniverseCamera = {
	zoom: 1,
	panX: 0,
	panY: 0,
};

function safeDimension(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 1;
}

export function clampAgentUniverseZoom(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_AGENT_UNIVERSE_CAMERA.zoom;
	return Math.min(AGENT_UNIVERSE_MAX_ZOOM, Math.max(AGENT_UNIVERSE_MIN_ZOOM, value));
}

export function cameraForWorldTarget(
	target: AgentUniversePoint,
	width: number,
	height: number,
	zoom: number,
	anchor: AgentUniversePoint = { x: 0.5, y: 0.5 },
): AgentUniverseCamera {
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	const centerX = safeWidth / 2;
	const centerY = safeHeight / 2;
	const nextZoom = clampAgentUniverseZoom(zoom);
	const anchorX = safeWidth * Math.min(1, Math.max(0, anchor.x));
	const anchorY = safeHeight * Math.min(1, Math.max(0, anchor.y));
	return {
		zoom: nextZoom,
		panX: anchorX - centerX - nextZoom * (target.x - centerX),
		panY: anchorY - centerY - nextZoom * (target.y - centerY),
	};
}

export function zoomAgentUniverseCameraAtPoint(
	camera: AgentUniverseCamera,
	factor: number,
	point: AgentUniversePoint,
	width: number,
	height: number,
): AgentUniverseCamera {
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	const centerX = safeWidth / 2;
	const centerY = safeHeight / 2;
	const nextZoom = clampAgentUniverseZoom(camera.zoom * factor);
	if (nextZoom === camera.zoom) return camera;

	// Keep the world point underneath the cursor underneath the cursor. This is
	// the small detail that makes wheel zoom feel like a map instead of a page
	// scaling around an arbitrary origin.
	const worldPoint = {
		x: centerX + (point.x - centerX - camera.panX) / camera.zoom,
		y: centerY + (point.y - centerY - camera.panY) / camera.zoom,
	};
	return cameraForWorldTarget(worldPoint, safeWidth, safeHeight, nextZoom, {
		x: point.x / safeWidth,
		y: point.y / safeHeight,
	});
}

export function panAgentUniverseCamera(
	camera: AgentUniverseCamera,
	delta: AgentUniversePoint,
	width: number,
	height: number,
): AgentUniverseCamera {
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	// Keep the interaction bounded without imposing a fake map boundary. The
	// user can explore around the scene, and Reset always provides a way home.
	const maxPanX = safeWidth * (0.78 + camera.zoom * 0.42);
	const maxPanY = safeHeight * (0.78 + camera.zoom * 0.42);
	return {
		zoom: camera.zoom,
		panX: Math.min(maxPanX, Math.max(-maxPanX, camera.panX + delta.x)),
		panY: Math.min(maxPanY, Math.max(-maxPanY, camera.panY + delta.y)),
	};
}

export function cameraTransform(
	camera: AgentUniverseCamera,
	width: number,
	height: number,
): string {
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	const centerX = safeWidth / 2;
	const centerY = safeHeight / 2;
	return `translate(${centerX + camera.panX} ${centerY + camera.panY}) scale(${camera.zoom}) translate(${-centerX} ${-centerY})`;
}

export function projectAgentUniversePoint(
	camera: AgentUniverseCamera,
	point: AgentUniversePoint,
	width: number,
	height: number,
): AgentUniversePoint {
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	const centerX = safeWidth / 2;
	const centerY = safeHeight / 2;
	return {
		x: centerX + camera.panX + camera.zoom * (point.x - centerX),
		y: centerY + camera.panY + camera.zoom * (point.y - centerY),
	};
}

export function unprojectAgentUniversePoint(
	camera: AgentUniverseCamera,
	point: AgentUniversePoint,
	width: number,
	height: number,
): AgentUniversePoint {
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	const centerX = safeWidth / 2;
	const centerY = safeHeight / 2;
	return {
		x: centerX + (point.x - centerX - camera.panX) / camera.zoom,
		y: centerY + (point.y - centerY - camera.panY) / camera.zoom,
	};
}
