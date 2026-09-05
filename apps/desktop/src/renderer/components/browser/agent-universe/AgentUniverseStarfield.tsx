import { useEffect, useRef, useState } from "react";
import {
	DEFAULT_AGENT_UNIVERSE_CAMERA,
	type AgentUniverseCamera,
} from "./agent-universe-camera";

interface StarLayer {
	density: number;
	speed: number;
	parallax: number;
	seed: number;
	hazeOpacity: number;
}

export interface AgentUniverseStarPoint {
	x: number;
	y: number;
	radius: number;
	alpha: number;
	color: string;
	glow: number;
}

interface RenderedStarLayer extends StarLayer {
	tile: HTMLCanvasElement;
}

const STAR_LAYERS: StarLayer[] = [
	{
		density: 1,
		speed: 0.55,
		parallax: 0.86,
		seed: 0x12ab34cd,
		hazeOpacity: 0.9,
	},
	{
		density: 0.58,
		speed: 0.3,
		parallax: 0.52,
		seed: 0x6e2f11a7,
		hazeOpacity: 0.62,
	},
	{
		density: 0.24,
		speed: 0.14,
		parallax: 0.28,
		seed: 0xb91d70e3,
		hazeOpacity: 0.38,
	},
];

const STAR_COLORS = [
	"#f4f7ff",
	"#dbe9ff",
	"#c4dcff",
	"#fff0d4",
	"#ffd4ae",
] as const;

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

const STARFIELD_SEED_RANGE = 4_294_967_296;

/**
 * Give each mounted universe its own constellation while keeping every
 * resize/repaint deterministic for the lifetime of that opening. Prefer the
 * browser's cryptographic source so two quick openings do not accidentally
 * receive the same time-based seed; the Math.random fallback keeps the visual
 * surface usable in older or restricted renderer environments.
 */
export function createAgentUniverseStarfieldSeed(): number {
	try {
		const randomValues = new Uint32Array(1);
		if (globalThis.crypto?.getRandomValues) {
			globalThis.crypto.getRandomValues(randomValues);
			return randomValues[0] ?? 0;
		}
	} catch {
		// Fall through to the non-cryptographic renderer-safe fallback.
	}
	return Math.floor(Math.random() * STARFIELD_SEED_RANGE) >>> 0;
}

/** Mix the per-opening seed into each layer without losing layer separation. */
export function agentUniverseStarfieldSeedForLayer(
	layerSeed: number,
	openingSeed: number,
): number {
	let state = (layerSeed ^ openingSeed) >>> 0;
	state = Math.imul(state ^ (state >>> 16), 0x21f0aaad);
	state = Math.imul(state ^ (state >>> 15), 0x735a2d97);
	return (state ^ (state >>> 15)) >>> 0;
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
	// The reference field has a dense, photographic star count: most points are
	// pinpricks, with a small bright tail that gives the eye something to find.
	const baseCount = Math.round(clamp(area / 1_750, 420, 1_800));
	const count = Math.max(1, Math.round(baseCount * layer.density));
	const random = seededRandom(layer.seed ^ safeWidth ^ (safeHeight << 1));
	const clusterCount = Math.round(clamp(area / 88_000, 10, 28));
	const clusterRadius = Math.min(safeWidth, safeHeight) * 0.16;
	const clusters = Array.from({ length: clusterCount }, () => ({
		x: random() * safeWidth,
		y: random() * safeHeight,
		radius: clusterRadius * (0.45 + random() * 0.7),
	}));
	const points: AgentUniverseStarPoint[] = [];
	for (let index = 0; index < count; index += 1) {
		const clustered = random() < 0.46;
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
		const colorRoll = random();
		const color =
			colorRoll < 0.06
				? STAR_COLORS[4]
				: colorRoll < 0.17
					? STAR_COLORS[3]
					: colorRoll < 0.43
						? STAR_COLORS[1]
						: colorRoll < 0.62
							? STAR_COLORS[2]
							: STAR_COLORS[0];
		const radius = 0.22 + Math.pow(sizeRoll, 2.8) * 2.0;
		const alpha = 0.1 + Math.pow(brightnessRoll, 2.8) * 0.82;
		points.push({
			x,
			y,
			// Most points stay below one CSS pixel. A small foreground tail supplies
			// depth without turning the background into decorative glitter.
			radius: radius * safeDpr,
			alpha,
			color,
			glow: clamp(
				(radius - 0.72) * 0.72 + (alpha - 0.42) * 0.66,
				0,
				1,
			),
		});
	}
	return points;
}

function rgbaFromHex(hex: string, alpha: number): string {
	const value = hex.replace(/^#/, "");
	const red = Number.parseInt(value.slice(0, 2), 16);
	const green = Number.parseInt(value.slice(2, 4), 16);
	const blue = Number.parseInt(value.slice(4, 6), 16);
	return `rgba(${red}, ${green}, ${blue}, ${clamp(alpha, 0, 1)})`;
}

function paintNebula(
	context: CanvasRenderingContext2D,
	layer: StarLayer,
	pixelWidth: number,
	pixelHeight: number,
): void {
	const random = seededRandom(layer.seed ^ 0x4f1bbcdc);
	const cloudCount = layer.density > 0.5 ? 4 : 3;
	for (let index = 0; index < cloudCount; index += 1) {
		const x = pixelWidth * (0.08 + random() * 0.84);
		const y = pixelHeight * (0.04 + random() * 0.92);
		const radius =
			Math.min(pixelWidth, pixelHeight) * (0.16 + random() * 0.22);
		const color = random() < 0.78 ? "#5178b0" : "#9c6d62";
		const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
		gradient.addColorStop(
			0,
			rgbaFromHex(color, 0.045 * layer.hazeOpacity),
		);
		gradient.addColorStop(
			0.52,
			rgbaFromHex(color, 0.014 * layer.hazeOpacity),
		);
		gradient.addColorStop(1, rgbaFromHex(color, 0));
		context.fillStyle = gradient;
		context.beginPath();
		context.ellipse(x, y, radius * 1.65, radius, random() * Math.PI, 0, Math.PI * 2);
		context.fill();
	}
}

function buildLayer(
	layer: StarLayer,
	pixelWidth: number,
	pixelHeight: number,
	dpr: number,
	openingSeed: number,
): RenderedStarLayer {
	const tile = document.createElement("canvas");
	tile.width = pixelWidth;
	tile.height = pixelHeight;
	const context = tile.getContext("2d");
	if (!context) return { ...layer, tile };
	paintNebula(context, layer, pixelWidth, pixelHeight);

	const points = generateAgentUniverseStarPoints(
		{
			...layer,
			seed: agentUniverseStarfieldSeedForLayer(layer.seed, openingSeed),
		},
		pixelWidth,
		pixelHeight,
		dpr,
	);
	for (const point of points) {
		context.globalAlpha = 1;
		if (point.glow > 0.08) {
			const glowRadius = point.radius * (3.2 + point.glow * 5.4);
			const glow = context.createRadialGradient(
				point.x,
				point.y,
				0,
				point.x,
				point.y,
				glowRadius,
			);
			glow.addColorStop(
				0,
				rgbaFromHex(point.color, point.alpha * 0.28 * point.glow),
			);
			glow.addColorStop(0.18, rgbaFromHex(point.color, point.alpha * 0.1));
			glow.addColorStop(1, rgbaFromHex(point.color, 0));
			context.fillStyle = glow;
			context.beginPath();
			context.arc(point.x, point.y, glowRadius, 0, Math.PI * 2);
			context.fill();
		}
		context.fillStyle = point.color;
		context.globalAlpha = point.alpha;
		context.beginPath();
		context.arc(
			point.x,
			point.y,
			point.radius * (0.72 + point.glow * 0.22),
			0,
			Math.PI * 2,
		);
		context.fill();
		if (point.glow > 0.78) {
			const flareLength = point.radius * (2.2 + point.glow * 2.5);
			context.strokeStyle = point.color;
			context.lineWidth = Math.max(0.35, point.radius * 0.16);
			context.globalAlpha = point.alpha * 0.26 * point.glow;
			context.beginPath();
			context.moveTo(point.x - flareLength, point.y);
			context.lineTo(point.x + flareLength, point.y);
			context.moveTo(point.x, point.y - flareLength);
			context.lineTo(point.x, point.y + flareLength);
			context.stroke();
		}
	}
	context.globalAlpha = 1;
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
	const [openingSeed] = useState(() => createAgentUniverseStarfieldSeed());
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
				buildLayer(layer, pixelWidth, pixelHeight, dpr, openingSeed),
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
	}, [openingSeed, reducedMotion]);

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
