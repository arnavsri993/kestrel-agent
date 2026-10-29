import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { decodeNativeBrowserScreenshot } from "./browser-screenshot";

async function fixture() {
	const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 1 } } }).png().toBuffer();
	return { version: 1, encoding: "png", width: 3, height: 2, pngBase64: png.toString("base64"), trust: "untrusted_browser" };
}
describe("native compressed screenshot boundary", () => {
	it("decodes a bounded PNG into the existing Core screenshot contract", async () => {
		const frame = await fixture(); const result = await decodeNativeBrowserScreenshot(frame);
		expect(result.width).toBe(3); expect(result.height).toBe(2); expect(result.rgba.byteLength).toBe(24);
		expect(Array.from(result.rgba.slice(0, 4))).toEqual([20, 40, 80, 255]);
		expect(Buffer.from(result.png).toString("base64")).toBe(frame.pngBase64); expect(result.trust).toBe("untrusted_browser");
	});
	it("rejects mismatched dimensions, invalid encodings, excessive pixels and malformed images", async () => {
		const frame = await fixture();
		for (const value of [{ ...frame, width: 4 }, { ...frame, width: 4_096, height: 4_096 }, { ...frame, encoding: "jpeg" }, { ...frame, pngBase64: "fixture-private-diagnostic" }, { ...frame, pngBase64: "x".repeat(700_001) }, { ...frame, pngBase64: Buffer.from("invalid image fixture-private-diagnostic").toString("base64") }])
			await expect(decodeNativeBrowserScreenshot(value)).rejects.toThrow("invalid or oversized");
	});
	it("honors cancellation before allocating a decoder", async () => {
		const controller = new AbortController(); controller.abort();
		await expect(decodeNativeBrowserScreenshot(await fixture(), controller.signal)).rejects.toThrow();
	});
});
