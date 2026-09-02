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
	const baseCount = Math.round(clamp(area / 10_500, 58, 168));
	const count = Math.round(baseCount * layer.density);
	const random = seededRandom(layer.seed ^ pixelWidth ^ (pixelHeight << 1));
	for (let index = 0; index < count; index += 1) {
		const sizeRoll = random();
		const brightnessRoll = random();
		const radius = (0.35 + Math.pow(sizeRoll, 2.8) * 1.45) * dpr;
		const alpha = 0.1 + Math.pow(brightnessRoll, 2.7) * 0.72;
		const x = random() * pixelWidth;
		const y = random() * pixelHeight;
		const warm = random() > 0.84;
		const red = warm ? 245 : 231;
		const green = warm ? 241 : 235;
		const blue = warm ? 230 : 243;
		const focal = brightnessRoll > 0.9 && radius > 1.15 * dpr;
		if (focal) {
			const halo = context.createRadialGradient(x, y, 0, x, y, radius * 5.5);
			halo.addColorStop(0, `rgba(${red}, ${green}, ${blue}, ${alpha * 0.42})`);
			halo.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
			context.fillStyle = halo;
			context.beginPath();
			context.arc(x, y, radius * 5.5, 0, Math.PI * 2);
			context.fill();
		}
		context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
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
		let animationFrame: number | null = null;
		let renderedLayers: RenderedStarLayer[] = [];
		let pixelWidth = 0;
		let pixelHeight = 0;
		let dpr = 1;
		let running = false;
		let animationStartedAt: number | null = null;

		const stop = () => {
			running = false;
			animationStartedAt = null;
			if (animationFrame !== null) {
				window.cancelAnimationFrame(animationFrame);
				animationFrame = null;
			}
		};

		const draw = (elapsedMs: number) => {
			if (!pixelWidth || !pixelHeight) return;
			context.clearRect(0, 0, pixelWidth, pixelHeight);
			for (const layer of renderedLayers) {
				const offset = reducedMotion
					? 0
					: ((elapsedMs / 1_000) * layer.speed * dpr) % pixelWidth;
				context.drawImage(layer.tile, offset, 0);
				if (!reducedMotion && offset > 0)
					context.drawImage(layer.tile, offset - pixelWidth, 0);
			}
		};

		const animate = (time: number) => {
			if (!running || document.hidden) return;
			animationStartedAt ??= time;
			draw(time - animationStartedAt);
			animationFrame = window.requestAnimationFrame(animate);
		};

		const start = () => {
			if (reducedMotion || document.hidden || running || !pixelWidth) return;
			running = true;
			animationFrame = window.requestAnimationFrame(animate);
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
			stop();
			draw(0);
			start();
		};

		const observer = new ResizeObserver(resize);
		observer.observe(canvas);
		const onVisibilityChange = () => {
			if (document.hidden) stop();
			else {
				draw(0);
				start();
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		resize();

		return () => {
			stop();
			observer.disconnect();
			document.removeEventListener("visibilitychange", onVisibilityChange);
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
