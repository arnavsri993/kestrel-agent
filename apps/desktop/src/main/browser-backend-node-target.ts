import type { BrowserInteractiveRef } from "@kestrel/agent-core";
import type { WebContents } from "electron";

export function publicInteractiveRefs(
	interactive: BrowserInteractiveRef[],
): Array<{ ref: string; role: string; name?: string }> {
	return interactive.map((item) => ({
		ref: item.ref,
		role: item.role,
		...(item.name ? { name: item.name } : {}),
	}));
}

export function rememberElementRefs(
	interactive: BrowserInteractiveRef[],
): Map<string, number> {
	const refs = new Map<string, number>();
	for (const item of interactive) {
		if (
			typeof item.backendDOMNodeId === "number" &&
			Number.isInteger(item.backendDOMNodeId) &&
			item.backendDOMNodeId > 0
		)
			refs.set(item.ref, item.backendDOMNodeId);
	}
	return refs;
}

export async function targetPointFromBackendNode(
	webContents: WebContents,
	backendNodeId: number,
	focus: boolean,
): Promise<{ x: number; y: number }> {
	if (!webContents.debugger.isAttached())
		webContents.debugger.attach("1.3");
	await webContents.debugger.sendCommand("DOM.scrollIntoViewIfNeeded", {
		backendNodeId,
	});
	const box = (await webContents.debugger.sendCommand("DOM.getBoxModel", {
		backendNodeId,
	})) as { model?: { content?: number[] } };
	const content = box.model?.content;
	if (!Array.isArray(content) || content.length < 8)
		throw new Error("Browser target bounds are invalid.");
	const x = (content[0]! + content[2]! + content[4]! + content[6]!) / 4;
	const y = (content[1]! + content[3]! + content[5]! + content[7]!) / 4;
	if (!Number.isFinite(x) || !Number.isFinite(y))
		throw new Error("Browser target bounds are invalid.");
	const width = Math.abs(content[2]! - content[0]!);
	const height = Math.abs(content[7]! - content[1]!);
	if (width <= 0 || height <= 0)
		throw new Error("Browser target is not visible.");
	if (focus)
		await webContents.debugger.sendCommand("DOM.focus", { backendNodeId });
	return { x, y };
}
