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
	{ density: 1, speed: 1.5, seed: 0x12ab34cd },
	{ density: 0.62, speed: 2.8, seed: 0x6e2f11a7 },
	{ density: 0.28, speed: 4.4, seed: 0xb91d70e3 },
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
	// A map texture should sit behind the work, not compete with it like a
	// screensaver. Keep the field sparse and let the runtime bodies carry the
	// visual signal.
	const baseCount = Math.round(clamp(area / 18_000, 24, 80));
	const count = Math.round(baseCount * layer.density);
	const random = seededRandom(layer.seed ^ pixelWidth ^ (pixelHeight << 1));
	for (let index = 0; index < count; index += 1) {
		const sizeRoll = random();
		const brightnessRoll = random();
		const radius = (0.24 + Math.pow(sizeRoll, 2.8) * 0.7) * dpr;
		const alpha = 0.03 + Math.pow(brightnessRoll, 2.7) * 0.19;
		const x = random() * pixelWidth;
		const y = random() * pixelHeight;
		context.fillStyle = `rgba(224, 230, 238, ${alpha})`;
		context.beginPath();
		context.arc(x, y, radius, 0, Math.PI * 2);
		context.fill();
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

		const draw = () => {
			if (!pixelWidth || !pixelHeight) return;
			context.clearRect(0, 0, pixelWidth, pixelHeight);
			for (const layer of renderedLayers) {
				// The field is intentionally static. Motion belongs to real agent
				// state, not to an ambient screensaver running behind the work.
				context.drawImage(layer.tile, 0, 0);
			}
		};

		const resize = () => {
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
			draw();
		};

		const observer = new ResizeObserver(resize);
		observer.observe(canvas);
		resize();

		return () => {
			observer.disconnect();
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
