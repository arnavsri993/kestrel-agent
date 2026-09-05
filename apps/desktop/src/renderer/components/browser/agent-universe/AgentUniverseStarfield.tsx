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
	tiles: HTMLCanvasElement[];
	tileWidth: number;
	tileHeight: number;
}

// A small bank of independent tiles is cheaper than a single retina-sized
// texture, while the coordinate-selected variants stop the eye from finding a
// repeating wallpaper pattern after a long pan. Four variants is enough to
// make the accessible plane feel unbounded without multiplying the runtime
// draw work.
export const AGENT_UNIVERSE_STAR_TILE_VARIANT_COUNT = 4;
export const AGENT_UNIVERSE_STARFIELD_DPR_CAP = 1.25;

const STAR_TILE_MIN_CSS_SIZE = 360;
const STAR_TILE_MAX_CSS_SIZE = 560;
const STAR_TILE_SIZE_RATIO = 0.64;

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

function mixSeed(...values: number[]): number {
	let state = 0x9e3779b9;
	for (const value of values) {
		state = Math.imul(state ^ (value >>> 0), 0x85ebca6b);
		state ^= state >>> 13;
		state = Math.imul(state, 0xc2b2ae35);
	}
	return (state ^ (state >>> 16)) >>> 0;
}

/**
 * Pick a tile variant from the tile's world coordinate, rather than from its
 * render order. This keeps a camera repaint stable and makes neighbouring
 * tiles statistically independent even though the tile canvases are cached.
 */
export function agentUniverseStarfieldTileVariant(
	seed: number,
	tileX: number,
	tileY: number,
	variantCount = AGENT_UNIVERSE_STAR_TILE_VARIANT_COUNT,
): number {
	const safeCount = Math.max(1, Math.floor(variantCount));
	return mixSeed(seed, tileX, tileY) % safeCount;
}

export interface AgentUniverseStarfieldTilePlacement {
	x: number;
	y: number;
	tileX: number;
	tileY: number;
	variant: number;
}

interface StarfieldTileCoverageOptions {
	pixelWidth: number;
	pixelHeight: number;
	tileWidth: number;
	tileHeight: number;
	transform: AgentUniverseStarfieldTransform;
	phaseX?: number;
	phaseY?: number;
	tileIndexOffsetX?: number;
	tileIndexOffsetY?: number;
	variantCount?: number;
	seed?: number;
}

function tileIndexRange(
	pixelSize: number,
	tileSize: number,
	center: number,
	pan: number,
	scale: number,
	phase: number,
): { start: number; end: number } {
	const safePixelSize = Math.max(1, pixelSize);
	const safeTileSize = Math.max(1, tileSize);
	const safeScale = Math.max(0.01, Number.isFinite(scale) ? scale : 1);
	const safePan = Number.isFinite(pan) ? pan : 0;
	const safePhase = ((phase % safeTileSize) + safeTileSize) % safeTileSize;
	// Convert the two viewport edges back into the untransformed tile plane.
	// One extra cell on the near side handles exact boundary hits without
	// relying on floating-point equality, and the intersection check below
	// removes any genuinely unnecessary cell.
	const worldStart = center + (0 - center - safePan) / safeScale;
	const worldEnd =
		center + (safePixelSize - center - safePan) / safeScale;
	const minimum = Math.min(worldStart, worldEnd);
	const maximum = Math.max(worldStart, worldEnd);
	return {
		start: Math.floor((minimum - safePhase) / safeTileSize) - 1,
		end: Math.floor((maximum - safePhase) / safeTileSize),
	};
}

/**
 * Return the minimum set of cached tiles whose transformed rectangles cover
 * the complete canvas. The old implementation always painted four copies;
 * that left holes when camera pan and zoom moved the transformed tile lattice
 * farther than those four copies could reach.
 */
export function starfieldTilePlacementsForViewport({
	pixelWidth,
	pixelHeight,
	tileWidth,
	tileHeight,
	transform,
	phaseX = 0,
	phaseY = 0,
	tileIndexOffsetX = 0,
	tileIndexOffsetY = 0,
	variantCount = AGENT_UNIVERSE_STAR_TILE_VARIANT_COUNT,
	seed = 0,
}: StarfieldTileCoverageOptions): AgentUniverseStarfieldTilePlacement[] {
	const safeWidth = Math.max(1, pixelWidth);
	const safeHeight = Math.max(1, pixelHeight);
	const safeTileWidth = Math.max(1, tileWidth);
	const safeTileHeight = Math.max(1, tileHeight);
	const scale = Math.max(
		0.01,
		Number.isFinite(transform.scale) ? transform.scale : 1,
	);
	const panX = Number.isFinite(transform.panX) ? transform.panX : 0;
	const panY = Number.isFinite(transform.panY) ? transform.panY : 0;
	const normalizedPhaseX =
		((phaseX % safeTileWidth) + safeTileWidth) % safeTileWidth;
	const normalizedPhaseY =
		((phaseY % safeTileHeight) + safeTileHeight) % safeTileHeight;
	const xRange = tileIndexRange(
		safeWidth,
		safeTileWidth,
		safeWidth / 2,
		panX,
		scale,
		normalizedPhaseX,
	);
	const yRange = tileIndexRange(
		safeHeight,
		safeTileHeight,
		safeHeight / 2,
		panY,
		scale,
		normalizedPhaseY,
	);
	const placements: AgentUniverseStarfieldTilePlacement[] = [];
	const safeVariantCount = Math.max(1, Math.floor(variantCount));
	for (let tileY = yRange.start; tileY <= yRange.end; tileY += 1) {
		const y = tileY * safeTileHeight + normalizedPhaseY;
		const transformedTop =
			safeHeight / 2 + panY + scale * (y - safeHeight / 2);
		const transformedBottom = transformedTop + scale * safeTileHeight;
		if (transformedBottom <= 0 || transformedTop >= safeHeight) continue;
		for (let tileX = xRange.start; tileX <= xRange.end; tileX += 1) {
			const x = tileX * safeTileWidth + normalizedPhaseX;
			const transformedLeft =
				safeWidth / 2 + panX + scale * (x - safeWidth / 2);
			const transformedRight = transformedLeft + scale * safeTileWidth;
			if (transformedRight <= 0 || transformedLeft >= safeWidth) continue;
			const absoluteTileX = tileX + Math.trunc(tileIndexOffsetX);
			const absoluteTileY = tileY + Math.trunc(tileIndexOffsetY);
			placements.push({
				x,
				y,
				tileX: absoluteTileX,
				tileY: absoluteTileY,
				variant: agentUniverseStarfieldTileVariant(
					seed,
					absoluteTileX,
					absoluteTileY,
					safeVariantCount,
				),
			});
		}
	}
	return placements;
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
	// something to find. Tiles are smaller than the viewport and several are
	// composited, so keep each tile modest; this bounds startup work and memory
	// even on a retina display while preserving the same visible density.
	const baseCount = Math.round(clamp(area / 420, 320, 1_600));
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
	const cloudCount = layer.density > 0.5 ? 3 : 2;
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

interface StarBucket {
	color: string;
	alpha: number;
	points: AgentUniverseStarPoint[];
}

function paintStarPoints(
	context: CanvasRenderingContext2D,
	points: AgentUniverseStarPoint[],
	dpr: number,
): void {
	const buckets = new Map<string, StarBucket>();
	for (const point of points) {
		// Quantizing alpha lets the renderer batch most of the pinpricks into a
		// handful of paths. The tiny visual difference is far less noticeable
		// than the CPU saved by avoiding one fill/style change per star.
		const alpha = Math.round(point.alpha * 28) / 28;
		const key = `${point.color}:${alpha}`;
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.points.push(point);
		} else {
			buckets.set(key, { color: point.color, alpha, points: [point] });
		}
	}

	// Soft halos are reserved for the small bright tail. Most stars are cheap
	// filled dots, but the few luminous ones still keep the photographic bloom.
	for (const point of points) {
		if (point.glow <= 0.72) continue;
		const glowRadius = point.radius * (2.1 + point.glow * 3.2);
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
			rgbaFromHex(point.color, point.alpha * 0.24 * point.glow),
		);
		glow.addColorStop(0.24, rgbaFromHex(point.color, point.alpha * 0.07));
		glow.addColorStop(1, rgbaFromHex(point.color, 0));
		context.fillStyle = glow;
		context.globalAlpha = 1;
		context.beginPath();
		context.arc(point.x, point.y, glowRadius, 0, Math.PI * 2);
		context.fill();
	}

	for (const bucket of buckets.values()) {
		context.fillStyle = bucket.color;
		context.globalAlpha = bucket.alpha;
		context.beginPath();
		for (const point of bucket.points) {
			const radius = point.radius * (0.66 + point.glow * 0.3);
			if (radius <= dpr * 0.9) {
				const size = Math.max(0.75, radius * 1.45);
				context.rect(point.x - size / 2, point.y - size / 2, size, size);
			} else {
				context.moveTo(point.x + radius, point.y);
				context.arc(point.x, point.y, radius, 0, Math.PI * 2);
			}
		}
		context.fill();
	}

	// Only the bright tail gets the extra white core and diffraction cross.
	// Keeping these individual passes rare makes resize and first paint cheap.
	for (const point of points) {
		if (point.glow > 0.56) {
			const coreRadius = point.radius * 0.42;
			context.fillStyle = "#ffffff";
			context.globalAlpha = point.alpha * (0.4 + point.glow * 0.2);
			context.beginPath();
			context.arc(point.x, point.y, coreRadius, 0, Math.PI * 2);
			context.fill();
		}
		if (point.flare) {
			const flareLength = point.radius * (1.8 + point.glow * 4.2);
			context.strokeStyle = point.color;
			context.lineWidth = Math.max(0.35, point.radius * 0.12);
			context.globalAlpha = point.alpha * 0.2 * point.glow;
			context.beginPath();
			context.moveTo(point.x - flareLength, point.y);
			context.lineTo(point.x + flareLength, point.y);
			context.moveTo(point.x, point.y - flareLength);
			context.lineTo(point.x, point.y + flareLength);
			context.stroke();
		}
	}
	context.globalAlpha = 1;
}

function buildLayer(
	layer: StarLayer,
	pixelWidth: number,
	pixelHeight: number,
	dpr: number,
	sessionSeed: number,
): RenderedStarLayer {
	const tiles = Array.from(
		{ length: AGENT_UNIVERSE_STAR_TILE_VARIANT_COUNT },
		(_, variant) => {
			const tile = document.createElement("canvas");
			tile.width = pixelWidth;
			tile.height = pixelHeight;
			const context = tile.getContext("2d");
			if (!context) return tile;
			const variantLayer = {
				...layer,
				seed: mixSeed(layer.seed, sessionSeed, variant + 1),
			};
			context.imageSmoothingEnabled = true;
			paintNebula(context, variantLayer, pixelWidth, pixelHeight);
			paintStarPoints(
				context,
				generateAgentUniverseStarPoints(
					variantLayer,
					pixelWidth,
					pixelHeight,
					dpr,
				),
				dpr,
			);
			return tile;
		},
	);
	return {
		...layer,
		tiles,
		tileWidth: pixelWidth,
		tileHeight: pixelHeight,
	};
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
	const sessionSeedRef = useRef<number | null>(null);
	if (sessionSeedRef.current === null) {
		const values = new Uint32Array(1);
		if (globalThis.crypto?.getRandomValues) {
			globalThis.crypto.getRandomValues(values);
			sessionSeedRef.current = values[0] ?? 0;
		} else {
			sessionSeedRef.current = Math.floor(Math.random() * 4_294_967_296) >>> 0;
		}
	}
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

		const draw = (_time: number) => {
			if (!pixelWidth || !pixelHeight) return;
			context.clearRect(0, 0, pixelWidth, pixelHeight);
			for (const layer of renderedLayers) {
				const transform = starfieldTransformForCamera(
					cameraRef.current,
					layer.parallax,
				);
				const centerX = pixelWidth / 2;
				const centerY = pixelHeight / 2;
				const placements = starfieldTilePlacementsForViewport({
					pixelWidth,
					pixelHeight,
					tileWidth: layer.tileWidth,
					tileHeight: layer.tileHeight,
					transform: {
						...transform,
						panX: transform.panX * dpr,
						panY: transform.panY * dpr,
					},
					variantCount: layer.tiles.length,
					seed: mixSeed(sessionSeedRef.current ?? 0, layer.seed),
				});
				context.save();
				context.translate(
					centerX + transform.panX * dpr,
					centerY + transform.panY * dpr,
				);
				context.scale(transform.scale, transform.scale);
				context.translate(-centerX, -centerY);
				for (const placement of placements) {
					const tile = layer.tiles[placement.variant];
					if (tile) context.drawImage(tile, placement.x, placement.y);
				}
				context.restore();
			}
		};
		drawRef.current = draw;

		const resize = () => {
			const rect = canvas.getBoundingClientRect();
			const width = Math.max(0, Math.round(rect.width));
			const height = Math.max(0, Math.round(rect.height));
			if (!width || !height) return;
			// A capped backing store is deliberate: the field is ambient texture,
			// not content that benefits from a full 2x retina surface. This keeps
			// memory and fill work bounded on weak hardware.
			dpr = Math.min(
				AGENT_UNIVERSE_STARFIELD_DPR_CAP,
				Math.max(1, window.devicePixelRatio || 1),
			);
			pixelWidth = Math.max(1, Math.round(width * dpr));
			pixelHeight = Math.max(1, Math.round(height * dpr));
			canvas.width = pixelWidth;
			canvas.height = pixelHeight;
			const tileCssSize = Math.round(
				clamp(
					Math.min(width, height) * STAR_TILE_SIZE_RATIO,
					STAR_TILE_MIN_CSS_SIZE,
					STAR_TILE_MAX_CSS_SIZE,
				),
			);
			const tilePixelSize = Math.max(1, Math.round(tileCssSize * dpr));
			renderedLayers = STAR_LAYERS.map((layer) =>
				buildLayer(
					layer,
					tilePixelSize,
					tilePixelSize,
					dpr,
					sessionSeedRef.current ?? 0,
				),
			);
			draw(performance.now());
		};

		const observer = new ResizeObserver(resize);
		observer.observe(canvas);
		resize();

		return () => {
			observer.disconnect();
			drawRef.current = null;
		};
	}, [reducedMotion]);

	useEffect(() => {
		// The field is intentionally idle between camera/size changes. A
		// camera-aware repaint is enough to keep parallax responsive without a
		// permanent RAF loop consuming a core on low-power machines.
		drawRef.current?.(performance.now());
	}, [camera]);

	return (
		<canvas
			ref={canvasRef}
			className="agent-universe-starfield"
			aria-hidden="true"
		/>
	);
}
