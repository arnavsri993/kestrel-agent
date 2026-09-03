import { useEffect, useRef } from "react";

interface StarLayer {
	density: number;
	speed: number;
	seed: number;
}

interface RenderedStarLayer extends StarLayer {
	tile: HTMLCanvasElement;
}

const STAR_LAYERS: StarLayer[] = [
	{ density: 1, speed: 0.55, seed: 0x12ab34cd },
	{ density: 0.62, speed: 0.3, seed: 0x6e2f11a7 },
	{ density: 0.28, speed: 0.14, seed: 0xb91d70e3 },
];

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

	const area = (pixelWidth * pixelHeight) / (dpr * dpr);
	// The field is an orientation cue, not a screensaver. It still needs to
	// read as a field of stars at a normal desktop distance, though: the former
	// 0.035 alpha floor disappeared into the black plane on Retina displays.
	const baseCount = Math.round(clamp(area / 6_000, 120, 300));
	const count = Math.round(baseCount * layer.density);
	const random = seededRandom(layer.seed ^ pixelWidth ^ (pixelHeight << 1));
	for (let index = 0; index < count; index += 1) {
		const sizeRoll = random();
		const brightnessRoll = random();
		const radius = (0.28 + Math.pow(sizeRoll, 2.3) * 1.22) * dpr;
		const alpha = 0.14 + Math.pow(brightnessRoll, 2.2) * 0.48;
		const x = random() * pixelWidth;
		const y = random() * pixelHeight;
		context.fillStyle = `rgba(222, 231, 248, ${alpha})`;
		context.beginPath();
		context.arc(x, y, radius, 0, Math.PI * 2);
		context.fill();
		// A few nearer points get a four-point glint so these read as stars, not
		// as random canvas noise. It is drawn directly into the tile so the
		// animation remains one cheap texture translation per layer.
		if (brightnessRoll > 0.92 && sizeRoll > 0.63) {
			const ray = radius * (2.6 + sizeRoll * 3.2);
			context.strokeStyle = `rgba(232, 239, 255, ${Math.min(0.78, alpha + 0.12)})`;
			context.lineWidth = Math.max(0.5, dpr * 0.34);
			context.beginPath();
			context.moveTo(x - ray, y);
			context.lineTo(x + ray, y);
			context.moveTo(x, y - ray);
			context.lineTo(x, y + ray);
			context.stroke();
		}
		// A handful of the brightest points get a quiet optical halo. It is
		// intentionally drawn as a second soft point rather than a filter applied
		// to the whole field.
		if (brightnessRoll > 0.985) {
			context.fillStyle = `rgba(232, 239, 255, ${alpha * 0.2})`;
			context.beginPath();
			context.arc(x, y, radius * 2.8, 0, Math.PI * 2);
			context.fill();
		}
	}
	return { ...layer, tile };
}

export function AgentUniverseStarfield({
	reducedMotion = false,
}: {
	reducedMotion?: boolean;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

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
				// The layers drift in one stable direction at sub-pixel-per-frame
				// speeds. Wrapping the pre-rendered tile avoids seams and keeps this
				// ambient depth cue cheap instead of turning it into a particle loop.
				const x = wrappedOffset(elapsed * layer.speed * dpr, pixelWidth);
				const y = wrappedOffset(elapsed * layer.speed * 0.16 * dpr, pixelHeight);
				context.drawImage(layer.tile, x, y);
				context.drawImage(layer.tile, x - pixelWidth, y);
				context.drawImage(layer.tile, x, y - pixelHeight);
				context.drawImage(layer.tile, x - pixelWidth, y - pixelHeight);
			}
			if (!reducedMotion) frameId = requestAnimationFrame(draw);
		};

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
		};
	}, [reducedMotion]);

	return (
		<canvas
			ref={canvasRef}
			className="agent-universe-starfield"
			aria-hidden="true"
		/>
	);
}
