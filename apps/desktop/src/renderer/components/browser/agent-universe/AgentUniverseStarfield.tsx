import { useEffect, useRef } from "react";
import {
	DEFAULT_AGENT_UNIVERSE_CAMERA,
	type AgentUniverseCamera,
} from "./agent-universe-camera";

interface StarLayer {
	density: number;
	speed: number;
	parallax: number;
	seed: number;
}

export interface AgentUniverseStarPoint {
	x: number;
	y: number;
	radius: number;
	alpha: number;
}

interface RenderedStarLayer extends StarLayer {
	tile: HTMLCanvasElement;
}

const STAR_LAYERS: StarLayer[] = [
	{ density: 1, speed: 0.55, parallax: 0.86, seed: 0x12ab34cd },
	{ density: 0.62, speed: 0.3, parallax: 0.52, seed: 0x6e2f11a7 },
	{ density: 0.28, speed: 0.14, parallax: 0.28, seed: 0xb91d70e3 },
];

export interface AgentUniverseStarfieldTransform {
	scale: number;
	panX: number;
	panY: number;
}

/**
 * Keep the field attached to the map without making every depth layer move as
 * if it were painted on the planets. The nearer layer follows the camera
 * most, while the distant layer gives the scene a restrained spatial depth.
 * Clamping the scale at 1 prevents zooming out from exposing an unpainted
 * canvas edge because the starfield is an ambient plane, not map content.
 */
export function starfieldTransformForCamera(
	camera: AgentUniverseCamera,
	parallax: number,
): AgentUniverseStarfieldTransform {
	const influence = clamp(parallax, 0, 1);
	const zoom = Number.isFinite(camera.zoom) ? camera.zoom : 1;
	return {
		scale: Math.max(1, 1 + (zoom - 1) * influence),
		panX: (Number.isFinite(camera.panX) ? camera.panX : 0) * influence,
		panY: (Number.isFinite(camera.panY) ? camera.panY : 0) * influence,
	};
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = Math.imul(state ^ (state >>> 15), 1 | state);
		state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
		return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Generate a stable, slightly clustered point field. The renderer only
 * paints these points into a tile; keeping generation separate makes the
 * density/shape contract testable without mounting a canvas.
 */
export function generateAgentUniverseStarPoints(
	layer: Pick<StarLayer, "density" | "seed">,
	pixelWidth: number,
	pixelHeight: number,
	dpr: number,
): AgentUniverseStarPoint[] {
	const safeWidth = Math.max(1, Math.round(pixelWidth));
	const safeHeight = Math.max(1, Math.round(pixelHeight));
	const safeDpr = Math.max(1, Number.isFinite(dpr) ? dpr : 1);
	const area = (safeWidth * safeHeight) / (safeDpr * safeDpr);
	const baseCount = Math.round(clamp(area / 2_800, 260, 900));
	const count = Math.max(1, Math.round(baseCount * layer.density));
	const random = seededRandom(layer.seed ^ safeWidth ^ (safeHeight << 1));
	const clusterCount = Math.round(clamp(area / 110_000, 8, 22));
	const clusterRadius = Math.min(safeWidth, safeHeight) * 0.13;
	const clusters = Array.from({ length: clusterCount }, () => ({
		x: random() * safeWidth,
		y: random() * safeHeight,
		radius: clusterRadius * (0.45 + random() * 0.7),
	}));
	const points: AgentUniverseStarPoint[] = [];
	for (let index = 0; index < count; index += 1) {
		const clustered = random() < 0.7;
		const cluster = clustered
			? clusters[Math.floor(random() * clusters.length)]
			: undefined;
		const angle = random() * Math.PI * 2;
		const distance = cluster
			? Math.pow(random(), 1.65) * cluster.radius
			: 0;
		const x = cluster
			? ((cluster.x + Math.cos(angle) * distance) % safeWidth + safeWidth) % safeWidth
			: random() * safeWidth;
		const y = cluster
			? ((cluster.y + Math.sin(angle) * distance) % safeHeight + safeHeight) % safeHeight
			: random() * safeHeight;
		const sizeRoll = random();
		const brightnessRoll = random();
		points.push({
			x,
			y,
			// Most points stay below one CSS pixel. A very small tail of nearer
			// points supplies depth without turning into decorative sparkles.
			radius: (0.28 + Math.pow(sizeRoll, 2.3) * 1.22) * safeDpr,
			alpha: 0.14 + Math.pow(brightnessRoll, 2.2) * 0.48,
		});
	}
	return points;
}

function buildLayer(
	layer: StarLayer,
	pixelWidth: number,
	pixelHeight: number,
	dpr: number,
): RenderedStarLayer {
	const tile = document.createElement("canvas");
	tile.width = pixelWidth;
	tile.height = pixelHeight;
	const context = tile.getContext("2d");
	if (!context) return { ...layer, tile };

	const points = generateAgentUniverseStarPoints(
		layer,
		pixelWidth,
		pixelHeight,
		dpr,
	);
	for (const point of points) {
		context.fillStyle = `rgba(222, 231, 248, ${point.alpha})`;
		context.beginPath();
		context.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
		context.fill();
	}
	return { ...layer, tile };
}

export function AgentUniverseStarfield({
	camera = DEFAULT_AGENT_UNIVERSE_CAMERA,
	reducedMotion = false,
}: {
	camera?: AgentUniverseCamera;
	reducedMotion?: boolean;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const cameraRef = useRef<AgentUniverseCamera>(camera);
	const drawRef = useRef<((time: number) => void) | null>(null);
	cameraRef.current = camera;

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const context = canvas.getContext("2d");
		if (!context) return;
		let renderedLayers: RenderedStarLayer[] = [];
		let pixelWidth = 0;
		let pixelHeight = 0;
		let dpr = 1;
		let frameId: number | null = null;
		const startedAt = performance.now();

		const wrappedOffset = (value: number, size: number) => {
			if (!size) return 0;
			return ((value % size) + size) % size;
		};

		const draw = (time: number) => {
			if (!pixelWidth || !pixelHeight) return;
			context.clearRect(0, 0, pixelWidth, pixelHeight);
			const elapsed = reducedMotion ? 0 : Math.max(0, time - startedAt) / 1_000;
			for (const layer of renderedLayers) {
				const { scale, panX, panY } = starfieldTransformForCamera(
					cameraRef.current,
					layer.parallax,
				);
				// The layers drift in one stable direction at sub-pixel-per-frame
				// speeds. Wrapping the pre-rendered tile avoids seams and keeps this
				// ambient depth cue cheap instead of turning it into a particle loop.
				const x = wrappedOffset(elapsed * layer.speed * dpr, pixelWidth);
				const y = wrappedOffset(elapsed * layer.speed * 0.16 * dpr, pixelHeight);
				const centerX = pixelWidth / 2;
				const centerY = pixelHeight / 2;
				context.save();
				context.translate(centerX + panX * dpr, centerY + panY * dpr);
				context.scale(scale, scale);
				context.translate(-centerX, -centerY);
				context.drawImage(layer.tile, x, y);
				context.drawImage(layer.tile, x - pixelWidth, y);
				context.drawImage(layer.tile, x, y - pixelHeight);
				context.drawImage(layer.tile, x - pixelWidth, y - pixelHeight);
				context.restore();
			}
			if (!reducedMotion) frameId = requestAnimationFrame(draw);
		};
		drawRef.current = draw;

		const resize = () => {
			if (frameId !== null) cancelAnimationFrame(frameId);
			frameId = null;
			const rect = canvas.getBoundingClientRect();
			const width = Math.max(0, Math.round(rect.width));
			const height = Math.max(0, Math.round(rect.height));
			if (!width || !height) return;
			dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
			pixelWidth = Math.max(1, Math.round(width * dpr));
			pixelHeight = Math.max(1, Math.round(height * dpr));
			canvas.width = pixelWidth;
			canvas.height = pixelHeight;
			renderedLayers = STAR_LAYERS.map((layer) =>
				buildLayer(layer, pixelWidth, pixelHeight, dpr),
			);
			draw(performance.now());
		};

		const observer = new ResizeObserver(resize);
		observer.observe(canvas);
		resize();

		return () => {
			observer.disconnect();
			if (frameId !== null) cancelAnimationFrame(frameId);
			drawRef.current = null;
		};
	}, [reducedMotion]);

	useEffect(() => {
		// Reduced motion intentionally has no RAF loop, but camera panning is
		// direct user input and still needs to repaint the attached field.
		if (reducedMotion) drawRef.current?.(performance.now());
	}, [camera, reducedMotion]);

	return (
		<canvas
			ref={canvasRef}
			className="agent-universe-starfield"
			aria-hidden="true"
		/>
	);
}
