import { describe, expect, it, vi } from "vitest";
import {
	focusDialogEdge,
	restoreDialogOpener,
} from "./DefaultBrowserPrompt";

function focusable() {
	return { focus: vi.fn() } as unknown as HTMLElement;
}

function tabEvent(shiftKey = false) {
	return {
		key: "Tab",
		shiftKey,
		preventDefault: vi.fn(),
	};
}

describe("DefaultBrowserPrompt dialog focus contract", () => {
	it("wraps Tab from the final control back to the initial control", () => {
		const first = focusable();
		const last = focusable();
		const event = tabEvent();

		focusDialogEdge(event, last, [first, last]);

		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(first.focus).toHaveBeenCalledOnce();
		expect(last.focus).not.toHaveBeenCalled();
	});

	it("wraps Shift+Tab from the initial control to the final control", () => {
		const first = focusable();
		const last = focusable();
		const event = tabEvent(true);

		focusDialogEdge(event, first, [first, last]);

		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(last.focus).toHaveBeenCalledOnce();
		expect(first.focus).not.toHaveBeenCalled();
	});

	it("restores focus only to an opener that survived dismissal", () => {
		const opener = {
			isConnected: true,
			focus: vi.fn(),
		} as unknown as HTMLElement;
		restoreDialogOpener(opener);
		expect(opener.focus).toHaveBeenCalledOnce();

		Object.defineProperty(opener, "isConnected", { value: false });
		restoreDialogOpener(opener);
		expect(opener.focus).toHaveBeenCalledOnce();
	});
});
