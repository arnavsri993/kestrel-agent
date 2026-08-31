import { describe, expect, it, vi } from "vitest";
import { installFileDropGuard } from "./file-drag";

describe("main renderer file drop guard", () => {
	it("blocks file drops without extracting paths or sending an intake", () => {
		const listeners = new Map<string, (event: DragEvent) => void>();
		installFileDropGuard({
			addEventListener: (type, listener) => listeners.set(type, listener),
		});
		const preventDefault = vi.fn();
		const stopPropagation = vi.fn();
		const dataTransfer = {
			types: ["Files"],
			files: [],
			dropEffect: "copy",
		};
		const event = {
			isTrusted: true,
			dataTransfer,
			preventDefault,
			stopPropagation,
		} as unknown as DragEvent;

		listeners.get("dragover")?.(event);
		listeners.get("drop")?.(event);

		expect(preventDefault).toHaveBeenCalledTimes(2);
		expect(stopPropagation).toHaveBeenCalledTimes(2);
		expect(dataTransfer.dropEffect).toBe("none");
	});

	it("does not block ordinary drags", () => {
		const listeners = new Map<string, (event: DragEvent) => void>();
		installFileDropGuard({
			addEventListener: (type, listener) => listeners.set(type, listener),
		});
		const preventDefault = vi.fn();
		const event = {
			isTrusted: true,
			dataTransfer: { types: ["text/plain"], files: [] },
			preventDefault,
			stopPropagation: vi.fn(),
		} as unknown as DragEvent;

		listeners.get("drop")?.(event);

		expect(preventDefault).not.toHaveBeenCalled();
	});
});
