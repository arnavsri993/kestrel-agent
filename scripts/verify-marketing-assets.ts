import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const defaultRoot = resolve(import.meta.dirname, "..");
const generatedStatuses = new Set([
	"generated",
	"approved",
	"processed",
	"published",
]);
const registryPathFields = [
	"posterPath",
	"mp4Path",
	"webmPath",
	"mobilePosterPath",
	"mobileMp4Path",
	"mobileWebmPath",
] as const;
const videoExtensions = new Set([".mp4", ".webm"]);

interface MarketingAssetManifest {
	id: string;
	status: string;
	originalOutputPath: string;
	processedOutputPaths: string[];
}

interface RegistryAsset {
	id: string;
	sourceManifestId: string;
	status: string;
	muted?: boolean;
	checksum?: string;
	posterPath?: string;
	mp4Path?: string;
	webmPath?: string;
	mobilePosterPath?: string;
	mobileMp4Path?: string;
	mobileWebmPath?: string;
}

export interface MarketingAssetVerificationResult {
	manifests: number;
	registryEntries: number;
}

export interface MarketingAssetVerificationOptions {
	root?: string;
	probeVideo?: (path: string) => Promise<void>;
}

async function defaultProbeVideo(path: string): Promise<void> {
	await run("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"default=nw=1",
		path,
	]);
}

function repositoryPath(
	root: string,
	value: string,
	label: string,
	problems: string[],
): string | undefined {
	if (!value || value.includes("\0")) {
		problems.push(`${label} is invalid`);
		return undefined;
	}
	const path = resolve(root, value);
	const withinRoot = relative(root, path);
	if (withinRoot.startsWith("..") || resolve(root, withinRoot) !== path) {
		problems.push(`${label} leaves the repository`);
		return undefined;
	}
	return path;
}

function publicAssetPath(
	publicRoot: string,
	value: unknown,
	label: string,
	problems: string[],
): string | undefined {
	if (
		typeof value !== "string" ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("?") ||
		value.includes("#") ||
		value.includes("\0")
	) {
		problems.push(`${label} is not a local public asset path`);
		return undefined;
	}
	const path = resolve(publicRoot, value.slice(1));
	const withinPublic = relative(publicRoot, path);
	if (
		withinPublic.startsWith("..") ||
		resolve(publicRoot, withinPublic) !== path
	) {
		problems.push(`${label} leaves the website public directory`);
		return undefined;
	}
	return path;
}

async function optionalFileSize(path: string): Promise<number | undefined> {
	try {
		const metadata = await lstat(path);
		return metadata.isFile() ? metadata.size : -1;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function requireNonEmptyFile(
	path: string,
	label: string,
	problems: string[],
): Promise<boolean> {
	const size = await optionalFileSize(path);
	if (size === undefined) {
		problems.push(`${label} is missing`);
		return false;
	}
	if (size <= 0) {
		problems.push(`${label} is empty or not a regular file`);
		return false;
	}
	return true;
}

async function verifyVideo(
	path: string,
	label: string,
	probeVideo: (path: string) => Promise<void>,
	problems: string[],
): Promise<void> {
	if (!videoExtensions.has(extname(path).toLowerCase())) return;
	try {
		await probeVideo(path);
	} catch (error) {
		problems.push(
			`${label} failed ffprobe: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function sha256(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

async function verifyRegistryAssetFiles(
	asset: RegistryAsset,
	publicRoot: string,
	probeVideo: (path: string) => Promise<void>,
	problems: string[],
): Promise<void> {
	const assetLabel = `registry entry ${asset.id || "(missing id)"}`;
	if (!asset.posterPath) problems.push(`${assetLabel} has no poster`);
	if (asset.muted !== true) problems.push(`${assetLabel} is not marked muted`);

	const verifiedPaths = new Map<string, string>();
	for (const field of registryPathFields) {
		const value = asset[field];
		if (value === undefined) continue;
		const path = publicAssetPath(
			publicRoot,
			value,
			`${assetLabel} ${field}`,
			problems,
		);
		if (!path) continue;
		if (
			await requireNonEmptyFile(
				path,
				`${assetLabel} ${field} ${value}`,
				problems,
			)
		) {
			verifiedPaths.set(field, path);
			await verifyVideo(
				path,
				`${assetLabel} ${field} ${value}`,
				probeVideo,
				problems,
			);
		}
	}

	const checksumPath =
		verifiedPaths.get("mp4Path") ?? verifiedPaths.get("posterPath");
	if (
		checksumPath &&
		asset.checksum &&
		asset.checksum !== "development-fallback" &&
		(await sha256(checksumPath)) !== asset.checksum
	)
		problems.push(`${assetLabel} checksum does not match its public asset`);
}

export async function verifyMarketingAssets(
	options: MarketingAssetVerificationOptions = {},
): Promise<MarketingAssetVerificationResult> {
	const root = resolve(options.root ?? defaultRoot);
	const probeVideo = options.probeVideo ?? defaultProbeVideo;
	const manifestDir = resolve(root, "website-media", "manifests");
	const publicRoot = resolve(root, "apps", "website", "public");
	const registryFile = resolve(
		root,
		"apps",
		"website",
		"src",
		"data",
		"media-registry.json",
	);
	const registry = JSON.parse(
		await readFile(registryFile, "utf8"),
	) as RegistryAsset[];
	const problems: string[] = [];
	let manifestCount = 0;
	const publishedManifestIds = new Set<string>();
	const verifiedRegistryAssets = new Set<RegistryAsset>();
	const registryIds = new Set<string>();

	for (const asset of registry) {
		if (!asset.id) problems.push("registry entry has no id");
		else if (registryIds.has(asset.id))
			problems.push(`registry entry id ${asset.id} is duplicated`);
		else registryIds.add(asset.id);
		if (!asset.sourceManifestId)
			problems.push(
				`registry entry ${asset.id || "(missing id)"} has no source manifest`,
			);
	}

	for (const file of await readdir(manifestDir)) {
		if (!file.endsWith(".json")) continue;
		manifestCount += 1;
		const manifest = JSON.parse(
			await readFile(resolve(manifestDir, file), "utf8"),
		) as MarketingAssetManifest;
		const label = manifest.id || file;

		if (generatedStatuses.has(manifest.status)) {
			const original = repositoryPath(
				root,
				manifest.originalOutputPath,
				`${label}: original path`,
				problems,
			);
			if (original) {
				// Originals are intentionally ignored. Validate them when a developer
				// has them locally, but do not make clean checkouts depend on them.
				const originalSize = await optionalFileSize(original);
				if (originalSize !== undefined && originalSize <= 0)
					problems.push(
						`${label}: local original is empty or not a regular file`,
					);
			}
		}

		if (manifest.status !== "published") continue;
		publishedManifestIds.add(manifest.id);
		if (
			!Array.isArray(manifest.processedOutputPaths) ||
			!manifest.processedOutputPaths.length
		) {
			problems.push(`${label}: published manifest has no processed outputs`);
		} else {
			for (const value of manifest.processedOutputPaths) {
				const processed = repositoryPath(
					root,
					typeof value === "string" ? value : "",
					`${label}: processed output path`,
					problems,
				);
				if (!processed) continue;
				const outputLabel = `${label}: processed output ${value}`;
				if (await requireNonEmptyFile(processed, outputLabel, problems))
					await verifyVideo(processed, outputLabel, probeVideo, problems);
			}
		}

		const assets = registry.filter(
			(asset) => asset.sourceManifestId === manifest.id,
		);
		if (!assets.length) {
			problems.push(`${label}: published without a registry entry`);
			continue;
		}
		for (const asset of assets) {
			const assetLabel = `${label}: registry entry ${asset.id || "(missing id)"}`;
			if (asset.status !== "published")
				problems.push(`${assetLabel} is not marked published`);
			verifiedRegistryAssets.add(asset);
			await verifyRegistryAssetFiles(asset, publicRoot, probeVideo, problems);
		}
	}

	for (const asset of registry) {
		if (!verifiedRegistryAssets.has(asset))
			await verifyRegistryAssetFiles(asset, publicRoot, probeVideo, problems);
		if (
			asset.status === "published" &&
			!publishedManifestIds.has(asset.sourceManifestId)
		)
			problems.push(
				`registry entry ${asset.id || "(missing id)"} is published without a published source manifest`,
			);
	}

	if (problems.length)
		throw new Error(
			`Marketing asset verification failed:\n${problems.join("\n")}`,
		);
	return { manifests: manifestCount, registryEntries: registry.length };
}

function isDirectExecution(): boolean {
	const entry = process.argv[1];
	return Boolean(
		entry && pathToFileURL(resolve(entry)).href === import.meta.url,
	);
}

if (isDirectExecution()) {
	const result = await verifyMarketingAssets();
	console.log(
		`Marketing asset verification passed for ${result.registryEntries} registry entries across ${result.manifests} manifests.`,
	);
}
