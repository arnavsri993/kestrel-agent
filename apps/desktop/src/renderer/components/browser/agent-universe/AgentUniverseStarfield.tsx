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
	starScale: number;
	alphaScale: number;
	clusterChance: number;
	clusterSpread: number;
	hazeOpacity: number;
	hazeColor: string;
	flareChance: number;
}

export interface AgentUniverseStarPoint {
	x: number;
	y: number;
	radius: number;
	alpha: number;
	color: string;
	glow: number;
	flare: boolean;
}

interface RenderedStarLayer extends StarLayer {
	tile: HTMLCanvasElement;
}

const STAR_LAYERS: StarLayer[] = [
	{
		// The farthest layer is almost all pinpricks. It is what keeps empty areas
		// from reading as a flat black fill while staying quiet behind the map.
		density: 1.5,
		speed: 0.04,
		parallax: 0.05,
		seed: 0x12ab34cd,
		starScale: 0.5,
		alphaScale: 0.76,
		clusterChance: 0.12,
		clusterSpread: 0.55,
		hazeOpacity: 0.32,
		hazeColor: "#2d456d",
		flareChance: 0,
	},
	{
		// Deep dust is plentiful but nearly still: it gives the black plane a
		// granular photographic base without competing with the map.
		density: 1.24,
		speed: 0.08,
		parallax: 0.1,
		seed: 0x8b63c4e2,
		starScale: 0.62,
		alphaScale: 0.84,
		clusterChance: 0.18,
		clusterSpread: 0.68,
		hazeOpacity: 0.42,
		hazeColor: "#334d78",
		flareChance: 0,
	},
	{
		density: 1,
		speed: 0.14,
		parallax: 0.22,
		seed: 0x6e2f11a7,
		starScale: 0.76,
		alphaScale: 0.82,
		clusterChance: 0.34,
		clusterSpread: 0.82,
		hazeOpacity: 0.55,
		hazeColor: "#3d6795",
		flareChance: 0.002,
	},
	{
		density: 0.78,
		speed: 0.23,
		parallax: 0.36,
		seed: 0xb91d70e3,
		starScale: 0.9,
		alphaScale: 0.9,
		clusterChance: 0.42,
		clusterSpread: 0.95,
		hazeOpacity: 0.72,
		hazeColor: "#536b9b",
		flareChance: 0.006,
	},
	{
		density: 0.55,
		speed: 0.35,
		parallax: 0.5,
		seed: 0x49d28b6f,
		starScale: 1.04,
		alphaScale: 0.94,
		clusterChance: 0.48,
		clusterSpread: 1.08,
		hazeOpacity: 0.86,
		hazeColor: "#68769c",
		flareChance: 0.012,
	},
	{
		density: 0.32,
		speed: 0.54,
		parallax: 0.68,
		seed: 0xd4a71f28,
		starScale: 1.18,
		alphaScale: 0.99,
		clusterChance: 0.38,
		clusterSpread: 1.18,
		hazeOpacity: 0.74,
		hazeColor: "#926b67",
		flareChance: 0.035,
	},
	{
		// A sparse near layer carries the larger colored stars and the occasional
		// diffraction flare that makes the field feel deep instead of noisy.
		density: 0.16,
		speed: 0.78,
		parallax: 0.86,
		seed: 0x7c4e3aa1,
		starScale: 1.4,
		alphaScale: 1.08,
		clusterChance: 0.28,
		clusterSpread: 1.3,
		hazeOpacity: 0.52,
		hazeColor: "#a77c6d",
		flareChance: 0.08,
	},
];

export const AGENT_UNIVERSE_STAR_LAYER_COUNT = STAR_LAYERS.length;

const STAR_COLORS = [
	"#f4f7ff",
	"#dbe9ff",
	"#c4dcff",
	"#fff0d4",
	"#ffd4ae",
	"#f4c3b2",
	"#d9ccff",
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

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Generate a stable, slightly clustered point field. The renderer only
 * paints these points into a tile; keeping generation separate makes the
 * density/shape contract testable without mounting a canvas.
 */
export function generateAgentUniverseStarPoints(
	layer: Pick<StarLayer, "density" | "seed"> &
		Partial<Omit<StarLayer, "density" | "seed">>,
	pixelWidth: number,
	pixelHeight: number,
	dpr: number,
): AgentUniverseStarPoint[] {
	const safeWidth = Math.max(1, Math.round(pixelWidth));
	const safeHeight = Math.max(1, Math.round(pixelHeight));
	const safeDpr = Math.max(1, Number.isFinite(dpr) ? dpr : 1);
	const area = (safeWidth * safeHeight) / (safeDpr * safeDpr);
	const starScale = clamp(finiteOrDefault(layer.starScale, 1), 0.1, 3);
	const alphaScale = clamp(finiteOrDefault(layer.alphaScale, 1), 0.1, 1.4);
	const clusterChance = clamp(finiteOrDefault(layer.clusterChance, 0.46), 0, 1);
	const clusterSpread = clamp(finiteOrDefault(layer.clusterSpread, 1), 0.2, 2);
	const flareChance = clamp(finiteOrDefault(layer.flareChance, 0.04), 0, 1);
	// The reference field has a dense, photographic star count: most points are
	// pinpricks, with a deliberately small bright tail that gives the eye
	// something to find. Multiple layers provide the density without making one
	// canvas tile carry every possible star size. The lower divisor is
	// intentional: the distant layers contribute many tiny points, while the
	// foreground layers keep their larger, brighter stars rare.
	const baseCount = Math.round(clamp(area / 300, 1_800, 5_000));
	const count = Math.max(1, Math.round(baseCount * layer.density));
	const random = seededRandom(layer.seed ^ safeWidth ^ (safeHeight << 1));
	const clusterCount = Math.round(clamp(area / 72_000, 14, 44));
	const clusterRadius = Math.min(safeWidth, safeHeight) * 0.12 * clusterSpread;
	const clusters = Array.from({ length: clusterCount }, () => ({
		x: random() * safeWidth,
		y: random() * safeHeight,
		radius: clusterRadius * (0.42 + random() * 0.78),
	}));
	const points: AgentUniverseStarPoint[] = [];
	for (let index = 0; index < count; index += 1) {
		const clustered = random() < clusterChance;
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
		const sizeBand = random();
		let radius: number;
		if (sizeBand < 0.74) {
			radius = 0.18 + Math.pow(random(), 2.6) * 0.62;
		} else if (sizeBand < 0.97) {
			radius = 0.46 + Math.pow(random(), 1.7) * 1.18;
		} else {
			radius = 1.12 + Math.pow(random(), 0.72) * 1.48;
		}
		// A physical sub-pixel disappears when the retina tile is composited back
		// into the CSS-sized map. Keep the floor just large enough for the distant
		// population to read as pinpricks rather than vanish entirely.
		radius = Math.max(0.46, radius * starScale);
		const brightnessRoll = random();
		const colorRoll = random();
		const color =
			colorRoll < 0.025
				? STAR_COLORS[6]
				: colorRoll < 0.055
				? STAR_COLORS[4]
				: colorRoll < 0.13
					? STAR_COLORS[3]
					: colorRoll < 0.18
						? STAR_COLORS[5]
						: colorRoll < 0.43
						? STAR_COLORS[1]
						: colorRoll < 0.67
							? STAR_COLORS[2]
							: STAR_COLORS[0];
		const alpha = clamp(
			(0.09 + Math.pow(brightnessRoll, 2.45) * 0.82) * alphaScale,
			0.05,
			0.96,
		);
		const glow = clamp(
			(radius - 0.7) * 0.58 + (alpha - 0.4) * 0.85,
			0,
			1,
		);
		points.push({
			x,
			y,
			// Most points stay below one CSS pixel. A long-tail mixture supplies
			// depth while keeping the larger stars rare and intentional.
			radius: radius * safeDpr,
			alpha,
			color,
			glow,
			flare: radius > 0.82 && alpha > 0.64 && random() < flareChance,
		});
	}
	return points;
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
	const cloudCount = layer.density > 0.5 ? 5 : 4;
	for (let index = 0; index < cloudCount; index += 1) {
		const x = pixelWidth * (0.08 + random() * 0.84);
		const y = pixelHeight * (0.04 + random() * 0.92);
		const radius =
			Math.min(pixelWidth, pixelHeight) * (0.14 + random() * 0.2);
		const color = layer.hazeColor;
		const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
		gradient.addColorStop(
			0,
			rgbaFromHex(color, 0.052 * layer.hazeOpacity),
		);
		gradient.addColorStop(
			0.52,
			rgbaFromHex(color, 0.017 * layer.hazeOpacity),
		);
		gradient.addColorStop(0.8, rgbaFromHex(color, 0.005 * layer.hazeOpacity));
		gradient.addColorStop(1, rgbaFromHex(color, 0));
		context.fillStyle = gradient;
		context.beginPath();
		context.ellipse(
			x,
			y,
			radius * (1.35 + random() * 0.55),
			radius * (0.72 + random() * 0.32),
			random() * Math.PI,
			0,
			Math.PI * 2,
		);
		context.fill();
	}
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
	context.imageSmoothingEnabled = true;
	paintNebula(context, layer, pixelWidth, pixelHeight);

	const points = generateAgentUniverseStarPoints(
		layer,
		pixelWidth,
		pixelHeight,
		dpr,
	);
	for (const point of points) {
		context.globalAlpha = 1;
		if (point.glow > 0.22) {
			const glowRadius = point.radius * (2.2 + point.glow * 4.2);
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
				rgbaFromHex(point.color, point.alpha * 0.3 * point.glow),
			);
			glow.addColorStop(0.2, rgbaFromHex(point.color, point.alpha * 0.1));
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
			point.radius * (0.66 + point.glow * 0.3),
			0,
			Math.PI * 2,
		);
		context.fill();
		if (point.glow > 0.56) {
			context.fillStyle = "#ffffff";
			context.globalAlpha = point.alpha * (0.44 + point.glow * 0.24);
			context.beginPath();
			context.arc(point.x, point.y, point.radius * 0.42, 0, Math.PI * 2);
			context.fill();
		}
		if (point.flare) {
			const flareLength = point.radius * (1.8 + point.glow * 4.8);
			context.strokeStyle = point.color;
			context.lineWidth = Math.max(0.35, point.radius * 0.12);
			context.globalAlpha = point.alpha * 0.24 * point.glow;
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
