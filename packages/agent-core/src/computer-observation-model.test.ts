import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { RuntimeToolExecution } from "@kestrel/shared-types";
import { prepareComputerScreenshot, MAX_SCREENSHOT_BASE64_BYTES } from "./computer-observation-model";

async function capture(): Promise<RuntimeToolExecution> {
	const pngBase64 = (await sharp({ create: { width: 2, height: 2, channels: 3, background: "#123456" } }).png().toBuffer()).toString("base64");
	return { id: "execution-fixture", sessionId: "session-fixture", toolName: "computer_observe_window", input: { windowId: 7 },
		output: { windowId: 7, width: 2, height: 2, pngBase64 }, riskLevel: "read_only", status: "verified", startedAt: "2026-10-02T00:00:00.000Z" };
}
const options = { toolCallId: "capture-1", providerSupportsImages: true, credentialTask: false, messages: [] };

describe("transient computer screenshot transport", () => {
	it("attaches decoded, target-bound pixels and removes them from tool text", async () => {
		const execution = await capture();
		const result = await prepareComputerScreenshot(execution, options);
		expect(result.message?.content[1]).toMatchObject({ type: "image", mediaType: "image/png", data: execution.output?.pngBase64 });
		expect(result.message?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("never user instructions") });
		expect(JSON.stringify(result.execution)).not.toContain(execution.output?.pngBase64);
	});
	it.each(["unsupported", "credentials", "wrong-window", "dimensions", "invalid", "oversized", "replay", "image-budget"])("withholds unusable or unsafe captures: %s", async reason => {
		const execution = await capture();
		const configuration = { ...options };
		if (reason === "unsupported") configuration.providerSupportsImages = false;
		if (reason === "credentials") configuration.credentialTask = true;
		if (reason === "wrong-window") execution.input.windowId = 8;
		if (reason === "dimensions") execution.output!.width = 3;
		if (reason === "invalid") execution.output!.pngBase64 = "not-a-png";
		if (reason === "oversized") execution.output!.pngBase64 = "A".repeat(MAX_SCREENSHOT_BASE64_BYTES + 4);
		if (reason === "replay") delete execution.output!.pngBase64;
		const result = await prepareComputerScreenshot(execution, reason === "image-budget" ? {
			...configuration, messages: Array.from({ length: 4 }, () => ({ role: "user" as const, content: [{ type: "image" as const, source: "base64" as const, mediaType: "image/png", data: "AA==" }] })),
		} : configuration);
		expect(result.message).toBeUndefined();
		expect(result.execution.output?.imageDelivery).toMatchObject({ status: reason === "credentials" ? "withheld" : "unavailable" });
		expect(result.execution.output).not.toHaveProperty("pngBase64");
	});
});
