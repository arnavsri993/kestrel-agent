import sharp from "sharp";
import { z } from "zod";

const MAX_PIXELS = 8_000_000;
const frameSchema = z.object({
	version: z.literal(1), encoding: z.literal("png"),
	width: z.number().int().min(1).max(4_096), height: z.number().int().min(1).max(4_096),
	pngBase64: z.string().min(44).max(700_000), trust: z.literal("untrusted_browser"),
});
let activeDecodes = 0;
const INVALID = "The browser returned an invalid or oversized screenshot.";

// Native pipes carry a bounded compressed image. Decode only in Core with an
// independent pixel cap, rather than expanding millions of RGBA JSON numbers
// in the authenticated browser transport.
export async function decodeNativeBrowserScreenshot(raw: unknown, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const result = frameSchema.safeParse(raw);
	if (!result.success) throw new Error(INVALID);
	const { width, height, pngBase64 } = result.data;
	if (width * height > MAX_PIXELS || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pngBase64)) throw new Error(INVALID);
	const png = Buffer.from(pngBase64, "base64");
	if (png.toString("base64") !== pngBase64 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(INVALID);
	if (activeDecodes >= 2) throw new Error("Wait for the current browser captures to finish before capturing another image.");
	activeDecodes++;
	const image = sharp(png, { limitInputPixels: MAX_PIXELS, failOn: "warning" });
	const abort = () => image.destroy();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		signal?.throwIfAborted();
		const metadata = await image.metadata();
		if (metadata.format !== "png" || metadata.width !== width || metadata.height !== height || (metadata.pages ?? 1) !== 1) throw new Error(INVALID);
		const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		signal?.throwIfAborted();
		if (info.width !== width || info.height !== height || info.channels !== 4 || data.byteLength !== width * height * 4) throw new Error(INVALID);
		return { width, height, rgba: new Uint8Array(data), png: new Uint8Array(png), trust: "untrusted_browser" as const };
	} catch {
		signal?.throwIfAborted();
		throw new Error(INVALID);
	} finally { signal?.removeEventListener("abort", abort); image.destroy(); activeDecodes--; }
}
