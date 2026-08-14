import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fal } from "@fal-ai/client";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..");
const approvedEndpoints = new Set([
	"fal-ai/ltx-2.3-22b/text-to-video",
	"fal-ai/flux-pro/v1.1",
]);

const BriefSchema = z.object({
	id: z.string(),
	purpose: z.string(),
	targetSection: z.string(),
	narrativeGoal: z.string(),
	visualDescription: z.string(),
	movementDescription: z.string(),
	cameraDescription: z.string(),
	aspectRatio: z.string(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	durationSeconds: z.number().positive().optional(),
	processedDurationSeconds: z.number().positive().optional(),
	shouldLoop: z.boolean(),
	referenceAssets: z.array(z.string()),
	prohibitedContent: z.array(z.string()),
	costLimit: z.number().positive(),
	websitePresentationOnly: z.literal(true),
	notAProductCapability: z.literal(true),
	notEvidenceOfBuiltInVideoFeature: z.literal(true),
	noReadableGeneratedUiText: z.literal(true),
	endpointId: z.string(),
	status: z.literal("approved"),
});
export type MarketingAssetBrief = z.infer<typeof BriefSchema>;

interface FalManifest {
	id: string;
	purpose: string;
	endpointId: string;
	requestId?: string;
	prompt: string;
	negativePrompt?: string;
	seed?: number;
	inputAssetPaths: string[];
	originalOutputPath: string;
	processedOutputPaths: string[];
	aspectRatio: string;
	durationSeconds?: number;
	resolution?: string;
	estimatedCost?: number;
	actualCost?: number;
	generatedAt: string;
	reviewedBy?: string;
	status:
		| "brief"
		| "generated"
		| "rejected"
		| "approved"
		| "processed"
		| "published";
	configHash?: string;
	rejectionReason?: string;
	remoteUrl?: string;
}

export interface ApprovedAssetRequest {
	brief: MarketingAssetBrief;
	prompt: string;
	estimatedCost: number;
}
export interface GeneratedAsset {
	requestId: string;
	localPath: string;
	remoteUrl: string;
	estimatedCost: number;
}

class FalDownloadError extends Error {
	constructor(
		message: string,
		readonly requestId: string,
		readonly remoteUrl: string,
	) {
		super(message);
		this.name = "FalDownloadError";
	}
}

function promptFor(brief: MarketingAssetBrief): string {
	return `${brief.visualDescription} Narrative: ${brief.narrativeGoal} Movement: ${brief.movementDescription} Camera: ${brief.cameraDescription} Color and material: matte charcoal, graphite, off-white, one acid-chartreuse accent. Website presentation atmosphere only. No readable generated UI or text. Avoid: ${brief.prohibitedContent.join(", ")}.`;
}

function estimate(brief: MarketingAssetBrief): number {
	if (brief.endpointId.includes("ltx-2.3-22b"))
		return Number(
			(((brief.width * brief.height * 161) / 1_000_000) * 0.001605).toFixed(3),
		);
	return Number(
		(Math.ceil((brief.width * brief.height) / 1_000_000) * 0.04).toFixed(3),
	);
}

async function loadJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}
async function saveJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function downloadWithRetry(url: string, attempts = 4): Promise<Buffer> {
	let latest = "unknown response";
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const response = await fetch(url);
			if (response.ok) return Buffer.from(await response.arrayBuffer());
			latest = `HTTP ${response.status}`;
		} catch (error) {
			latest = error instanceof Error ? error.message : String(error);
		}
		if (attempt < attempts - 1)
			await new Promise((resolveDelay) =>
				setTimeout(resolveDelay, 500 * 2 ** attempt),
			);
	}
	throw new Error(latest);
}

export class FalAssetGenerator {
	constructor(private readonly credential: string) {
		if (!credential)
			throw new Error(
				"FAL_KEY is required only for deliberate asset generation.",
			);
		fal.config({ credentials: credential });
	}

	async generateImage(request: ApprovedAssetRequest): Promise<GeneratedAsset> {
		return this.generate(request, "image");
	}
	async generateVideo(request: ApprovedAssetRequest): Promise<GeneratedAsset> {
		return this.generate(request, "video");
	}

	private async generate(
		request: ApprovedAssetRequest,
		kind: "image" | "video",
	): Promise<GeneratedAsset> {
		const { brief, prompt, estimatedCost } = request;
		if (!approvedEndpoints.has(brief.endpointId))
			throw new Error(`Endpoint ${brief.endpointId} is not allowlisted.`);
		if (estimatedCost > brief.costLimit)
			throw new Error(
				`${brief.id} estimated cost $${estimatedCost} exceeds $${brief.costLimit} limit.`,
			);
		const input =
			kind === "video"
				? {
						prompt,
						num_frames: 161,
						video_size: { width: brief.width, height: brief.height },
						generate_audio: false,
						use_multiscale: true,
						fps: 25,
					}
				: {
						prompt,
						image_size: { width: brief.width, height: brief.height },
						output_format: "jpeg",
						seed: 1729,
						enhance_prompt: false,
					};
		const result = await fal.subscribe(brief.endpointId, {
			input,
			logs: true,
			onQueueUpdate(update) {
				if (update.status === "IN_PROGRESS")
					process.stdout.write(`  ${brief.id}: generating…\r`);
			},
		});
		const data = result.data as {
			video?: { url?: string };
			images?: Array<{ url?: string }>;
			seed?: number;
		};
		const remoteUrl =
			kind === "video" ? data.video?.url : data.images?.[0]?.url;
		if (!remoteUrl)
			throw new Error(
				`${brief.id} completed without a downloadable ${kind} URL.`,
			);
		const suffix =
			kind === "video"
				? ".mp4"
				: extname(new URL(remoteUrl).pathname) || ".jpg";
		const localPath = join(
			root,
			"website-media",
			"originals",
			`${brief.id}${suffix}`,
		);
		await mkdir(dirname(localPath), { recursive: true, mode: 0o700 });
		try {
			await writeFile(localPath, await downloadWithRetry(remoteUrl));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new FalDownloadError(
				`Download failed for ${brief.id} after four attempts: ${reason}.`,
				result.requestId,
				remoteUrl,
			);
		}
		return { requestId: result.requestId, localPath, remoteUrl, estimatedCost };
	}

	checkStatus(endpointId: string, requestId: string) {
		return fal.queue.status(endpointId, { requestId, logs: true });
	}
	downloadResult(endpointId: string, requestId: string) {
		return fal.queue.result(endpointId, { requestId });
	}
	cancel(endpointId: string, requestId: string) {
		return fal.queue.cancel(endpointId, { requestId });
	}
}

export async function generateApprovedAsset(
	id: string,
	execute: boolean,
): Promise<void> {
	const briefPath = join(root, "website-media", "briefs", `${id}.json`);
	const manifestPath = join(root, "website-media", "manifests", `${id}.json`);
	const brief = BriefSchema.parse(await loadJson(briefPath));
	const manifest = await loadJson<FalManifest>(manifestPath);
	const prompt = promptFor(brief);
	const estimatedCost = estimate(brief);
	const configHash = createHash("sha256")
		.update(
			JSON.stringify({
				schemaVersion: 2,
				endpointId: brief.endpointId,
				prompt,
				width: brief.width,
				height: brief.height,
				duration: brief.durationSeconds,
			}),
		)
		.digest("hex");
	if (manifest.configHash === configHash && manifest.status !== "brief")
		throw new Error(
			`${id} already has a generation for the same configuration (${manifest.status}).`,
		);
	if (!execute) {
		console.log(
			`${id}: dry run · ${brief.endpointId} · estimated $${estimatedCost.toFixed(3)} (limit $${brief.costLimit.toFixed(2)})`,
		);
		return;
	}
	const credential = process.env["FAL_KEY"] ?? "";
	const lockPath = join(root, "website-media", ".locks", `${configHash}.lock`);
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	try {
		await writeFile(lockPath, `${new Date().toISOString()}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	} catch {
		throw new Error(
			`${id} is already being generated or an earlier lock needs review.`,
		);
	}
	try {
		try {
			const generator = new FalAssetGenerator(credential);
			const request = { brief, prompt, estimatedCost };
			const result = brief.endpointId.includes("text-to-video")
				? await generator.generateVideo(request)
				: await generator.generateImage(request);
			const next: FalManifest = {
				...manifest,
				requestId: result.requestId,
				prompt,
				...(brief.endpointId.includes("flux") ? { seed: 1729 } : {}),
				originalOutputPath: result.localPath.slice(root.length + 1),
				estimatedCost,
				generatedAt: new Date().toISOString(),
				status: "generated",
				configHash,
				remoteUrl: result.remoteUrl,
				rejectionReason: undefined,
			};
			await saveJson(manifestPath, next);
			console.log(
				`\n${id}: downloaded ${basename(result.localPath)} · request ${result.requestId} · estimated $${estimatedCost.toFixed(3)}`,
			);
		} catch (error) {
			const failure: FalManifest = {
				...manifest,
				prompt,
				estimatedCost,
				generatedAt: new Date().toISOString(),
				status: "rejected",
				configHash,
				rejectionReason: error instanceof Error ? error.message : String(error),
				...(error instanceof FalDownloadError
					? { requestId: error.requestId, remoteUrl: error.remoteUrl }
					: {}),
			};
			await saveJson(manifestPath, failure);
			throw error;
		}
	} finally {
		const { unlink } = await import("node:fs/promises");
		await unlink(lockPath).catch(() => undefined);
	}
}

export function executionRequested(): boolean {
	return process.argv.includes("--execute");
}
