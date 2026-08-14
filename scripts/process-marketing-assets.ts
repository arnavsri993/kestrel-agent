import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const manifestDir = join(root, "website-media", "manifests");
const publicDir = join(root, "apps", "website", "public", "media", "generated");
const registryPath = join(
	root,
	"apps",
	"website",
	"src",
	"data",
	"media-registry.json",
);

interface Manifest {
	id: string;
	purpose: string;
	originalOutputPath: string;
	processedOutputPaths: string[];
	status: string;
	durationSeconds?: number;
	[key: string]: unknown;
}
interface RegistryAsset {
	id: string;
	purpose: string;
	posterPath: string;
	mp4Path?: string;
	webmPath?: string;
	mobilePosterPath?: string;
	mobileMp4Path?: string;
	mobileWebmPath?: string;
	width: number;
	height: number;
	durationSeconds?: number;
	muted: boolean;
	loop: boolean;
	checksum: string;
	sourceManifestId: string;
	status: string;
}

async function sha256(path: string) {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}
async function probe(path: string) {
	const { stdout } = await run("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration:stream=width,height",
		"-of",
		"json",
		path,
	]);
	return JSON.parse(stdout) as {
		format: { duration: string };
		streams: Array<{ width?: number; height?: number }>;
	};
}
async function encode(
	input: string,
	output: string,
	format: "mp4" | "webm",
	duration?: number,
) {
	const loopArgs = duration && duration > 10 ? ["-stream_loop", "1"] : [];
	const codec =
		format === "mp4"
			? [
					"-c:v",
					"libx264",
					"-crf",
					"25",
					"-preset",
					"medium",
					"-pix_fmt",
					"yuv420p",
					"-movflags",
					"+faststart",
				]
			: ["-c:v", "libvpx-vp9", "-crf", "38", "-b:v", "0"];
	await run(
		"ffmpeg",
		[
			"-y",
			...loopArgs,
			"-i",
			input,
			...(duration ? ["-t", String(duration)] : []),
			"-an",
			"-vf",
			"scale='min(1280,iw)':-2",
			...codec,
			output,
		],
		{ maxBuffer: 2_000_000 },
	);
}

async function processImageManifest(
	path: string,
	manifest: Manifest,
	registry: RegistryAsset[],
) {
	if (
		manifest.status !== "approved" ||
		!/\.(jpe?g|png)$/i.test(manifest.originalOutputPath)
	)
		return;
	const input = join(root, manifest.originalOutputPath);
	await mkdir(publicDir, { recursive: true });
	const isSocial = manifest.purpose === "social-preview";
	const output = join(publicDir, `${manifest.id}.jpg`);
	const target = isSocial
		? { width: 1200, height: 628 }
		: { width: 1920, height: 1080 };
	const crop = `crop='min(iw,ih*${target.width}/${target.height})':'min(ih,iw*${target.height}/${target.width})'`;
	const color = manifest.id === "poster-signal-wide" ? ",hue=h=-15" : "";
	await run(
		"ffmpeg",
		[
			"-y",
			"-i",
			input,
			"-vf",
			`${crop},scale=${target.width}:${target.height}${color}`,
			"-q:v",
			"3",
			output,
		],
		{ maxBuffer: 2_000_000 },
	);
	const assetId =
		manifest.purpose === "poster-image" ? "hero-signal-field" : manifest.id;
	const existing = registry.findIndex((item) => item.id === assetId);
	const current = existing >= 0 ? registry[existing] : undefined;
	const asset: RegistryAsset = {
		id: assetId,
		purpose:
			manifest.purpose === "poster-image"
				? "hero-background"
				: manifest.purpose,
		posterPath: `/media/generated/${basename(output)}`,
		...(current?.mobilePosterPath
			? { mobilePosterPath: current.mobilePosterPath }
			: {}),
		width: target.width,
		height: target.height,
		muted: true,
		loop: manifest.purpose === "poster-image",
		checksum: await sha256(output),
		sourceManifestId: manifest.id,
		status: "published",
	};
	if (existing >= 0) registry[existing] = asset;
	else registry.push(asset);
	manifest.processedOutputPaths = [output.slice(root.length + 1)];
	manifest.status = "published";
	await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function processManifest(path: string, registry: RegistryAsset[]) {
	const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
	await processImageManifest(path, manifest, registry);
	if (
		manifest.status !== "approved" ||
		!manifest.originalOutputPath.endsWith(".mp4")
	)
		return;
	const input = join(root, manifest.originalOutputPath);
	const sourceProbe = await probe(input);
	const targetDuration = manifest.id.startsWith("hero-")
		? 12.88
		: Number(sourceProbe.format.duration);
	await mkdir(publicDir, { recursive: true });
	const mp4 = join(publicDir, `${manifest.id}.mp4`);
	const webm = join(publicDir, `${manifest.id}.webm`);
	const poster = join(publicDir, `${manifest.id}-poster.webp`);
	await encode(input, mp4, "mp4", targetDuration);
	await encode(input, webm, "webm", targetDuration);
	await run("ffmpeg", [
		"-y",
		"-ss",
		"1",
		"-i",
		input,
		"-frames:v",
		"1",
		"-vf",
		"scale='min(1600,iw)':-2",
		poster,
	]);
	const outputProbe = await probe(mp4);
	const stream = outputProbe.streams.find((item) => item.width && item.height)!;
	const assetId =
		manifest.purpose === "hero-background"
			? "hero-signal-field"
			: manifest.purpose === "cta-background"
				? "cta-resolution-field"
				: manifest.id;
	const asset: RegistryAsset = {
		id: assetId,
		purpose: manifest.purpose,
		posterPath: `/media/generated/${basename(poster)}`,
		mp4Path: `/media/generated/${basename(mp4)}`,
		webmPath: `/media/generated/${basename(webm)}`,
		width: stream.width!,
		height: stream.height!,
		durationSeconds: Number(outputProbe.format.duration),
		muted: true,
		loop: manifest.purpose !== "transition-video",
		checksum: await sha256(mp4),
		sourceManifestId: manifest.id,
		status: "published",
	};
	const existing = registry.findIndex(
		(item) => item.sourceManifestId === manifest.id || item.id === assetId,
	);
	if (existing >= 0) registry[existing] = asset;
	else registry.push(asset);
	manifest.processedOutputPaths = [mp4, webm, poster].map((item) =>
		item.slice(root.length + 1),
	);
	manifest.status = "published";
	await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

await run("ffmpeg", ["-version"]);
const { readdir } = await import("node:fs/promises");
const registry = JSON.parse(
	await readFile(registryPath, "utf8"),
) as RegistryAsset[];
for (const file of await readdir(manifestDir))
	if (file.endsWith(".json"))
		await processManifest(join(manifestDir, file), registry);
await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(
	`Processed approved video manifests. Registry contains ${registry.length} assets.`,
);
