import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
	dispatchBrowserKey,
	dispatchBrowserMouseClick,
} from "./browser-backend-node-target";

function webContentsWith(
	sendCommand: (
		method: string,
		params: Record<string, unknown>,
	) => Promise<unknown>,
): WebContents {
	let attached = false;
	return {
		debugger: {
			isAttached: () => attached,
			attach: () => {
				attached = true;
			},
			sendCommand,
		},
	} as unknown as WebContents;
}

describe("bounded browser debugger input", () => {
	it("times out a stranded mouse press and still releases the button", async () => {
		const sendCommand = vi.fn(
			async (_method: string, params: Record<string, unknown>) => {
				if (params.type === "mousePressed")
					return new Promise<never>(() => undefined);
				return {};
			},
		);

		await expect(
			dispatchBrowserMouseClick(
				webContentsWith(sendCommand),
				{ x: 20, y: 30 },
				new AbortController().signal,
				5,
			),
		).rejects.toThrow("timed out");
		expect(sendCommand).toHaveBeenCalledWith(
			"Input.dispatchMouseEvent",
			expect.objectContaining({ type: "mouseReleased", buttons: 0 }),
		);
	});

	it("cancels a stranded key-down and still releases the key", async () => {
		const sendCommand = vi.fn(
			async (_method: string, params: Record<string, unknown>) => {
				if (params.type === "keyDown")
					return new Promise<never>(() => undefined);
				return {};
			},
		);
		const controller = new AbortController();
		const running = dispatchBrowserKey(
			webContentsWith(sendCommand),
			"Enter",
			controller.signal,
			1_000,
		);
		await vi.waitFor(() =>
			expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Enter",
			}),
		);
		controller.abort(new Error("cancelled browser key"));

		await expect(running).rejects.toThrow("cancelled browser key");
		expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Enter",
		});
	});
});
