import {
	type BrowserInteractiveRef,
	normalizeBrowserElementRef,
} from "@kestrel/agent-core";
import type { WebContents } from "electron";

const BROWSER_TARGET_OPERATION_TIMEOUT_MS = 2_000;
const BROWSER_INPUT_RELEASE_TIMEOUT_MS = 250;

type BrowserDebuggerNode = {
	backendNodeId?: number;
	nodeId?: number;
};

async function sendBoundedDebuggerCommand<T>(
	webContents: WebContents,
	method: string,
	params: Record<string, unknown>,
	signal: AbortSignal,
	deadline: number,
): Promise<T> {
	if (signal.aborted) throw signal.reason;
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("Browser target operation timed out.");
	let timeout: NodeJS.Timeout | undefined;
	let abort: (() => void) | undefined;
	try {
		return (await Promise.race([
			webContents.debugger.sendCommand(method, params),
			new Promise<never>((_resolvePromise, reject) => {
				timeout = setTimeout(
					() => reject(new Error("Browser target operation timed out.")),
					remaining,
				);
			}),
			new Promise<never>((_resolvePromise, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
			}),
		])) as T;
	} finally {
		if (timeout) clearTimeout(timeout);
		if (abort) signal.removeEventListener("abort", abort);
	}
}

function browserInputDeadline(maximumWaitMs: number): number {
	if (!Number.isFinite(maximumWaitMs) || maximumWaitMs < 1)
		throw new Error("Browser input wait must be positive and finite.");
	return Date.now() + maximumWaitMs;
}

function attachDebugger(webContents: WebContents): void {
	if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
}

export async function dispatchBrowserMouseClick(
	webContents: WebContents,
	point: { x: number; y: number },
	signal: AbortSignal,
	maximumWaitMs = BROWSER_TARGET_OPERATION_TIMEOUT_MS,
): Promise<void> {
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
		throw new Error("Browser target bounds are invalid.");
	if (signal.aborted) throw signal.reason;
	attachDebugger(webContents);
	const deadline = browserInputDeadline(maximumWaitMs);
	const pointer = {
		x: point.x,
		y: point.y,
		modifiers: 0,
		pointerType: "mouse",
	};
	await sendBoundedDebuggerCommand(
		webContents,
		"Input.dispatchMouseEvent",
		{
			...pointer,
			type: "mouseMoved",
			button: "none",
			buttons: 0,
			clickCount: 0,
		},
		signal,
		deadline,
	);
	if (signal.aborted) throw signal.reason;
	const release = {
		...pointer,
		type: "mouseReleased",
		button: "left",
		buttons: 0,
		clickCount: 1,
	};
	let releaseRequired = false;
	try {
		// A timed-out command may still have reached Chromium, so mark the button
		// for release before awaiting its acknowledgement.
		releaseRequired = true;
		await sendBoundedDebuggerCommand(
			webContents,
			"Input.dispatchMouseEvent",
			{
				...pointer,
				type: "mousePressed",
				button: "left",
				buttons: 1,
				clickCount: 1,
			},
			signal,
			deadline,
		);
		if (signal.aborted) throw signal.reason;
		await sendBoundedDebuggerCommand(
			webContents,
			"Input.dispatchMouseEvent",
			release,
			signal,
			deadline,
		);
		releaseRequired = false;
	} finally {
		if (releaseRequired) {
			const cleanupSignal = new AbortController().signal;
			await sendBoundedDebuggerCommand(
				webContents,
				"Input.dispatchMouseEvent",
				release,
				cleanupSignal,
				Date.now() + Math.min(BROWSER_INPUT_RELEASE_TIMEOUT_MS, maximumWaitMs),
			).catch(() => undefined);
		}
	}
}

export async function dispatchBrowserKey(
	webContents: WebContents,
	key: string,
	signal: AbortSignal,
	maximumWaitMs = BROWSER_TARGET_OPERATION_TIMEOUT_MS,
): Promise<void> {
	if (signal.aborted) throw signal.reason;
	attachDebugger(webContents);
	const deadline = browserInputDeadline(maximumWaitMs);
	const release = { type: "keyUp", key };
	let releaseRequired = false;
	try {
		// As with pointer input, cleanup must run even if the acknowledgement for
		// keyDown never arrives after Chromium accepted the event.
		releaseRequired = true;
		await sendBoundedDebuggerCommand(
			webContents,
			"Input.dispatchKeyEvent",
			{ type: "keyDown", key },
			signal,
			deadline,
		);
		if (signal.aborted) throw signal.reason;
		await sendBoundedDebuggerCommand(
			webContents,
			"Input.dispatchKeyEvent",
			release,
			signal,
			deadline,
		);
		releaseRequired = false;
	} finally {
		if (releaseRequired) {
			const cleanupSignal = new AbortController().signal;
			await sendBoundedDebuggerCommand(
				webContents,
				"Input.dispatchKeyEvent",
				release,
				cleanupSignal,
				Date.now() + Math.min(BROWSER_INPUT_RELEASE_TIMEOUT_MS, maximumWaitMs),
			).catch(() => undefined);
		}
	}
}

function browserTargetError(code: unknown): Error {
	if (code === "not_found") return new Error("Browser target was not found.");
	if (code === "not_select")
		return new Error("Browser target is not a select element.");
	if (code === "not_visible")
		return new Error("Browser target is not visible.");
	if (code === "disabled") return new Error("Browser target is disabled.");
	if (code === "outside_viewport")
		return new Error("Browser target is outside the viewport.");
	if (code === "obscured")
		return new Error(
			"Browser target is obscured or cannot receive pointer input.",
		);
	if (code === "missing_value")
		return new Error("Browser select value is unavailable.");
	if (code === "mismatch")
		return new Error("Browser select value did not remain selected.");
	return new Error("Browser target action failed.");
}

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
	signal: AbortSignal,
): Promise<{ x: number; y: number }> {
	if (!webContents.debugger.isAttached())
		webContents.debugger.attach("1.3");
	const deadline = Date.now() + BROWSER_TARGET_OPERATION_TIMEOUT_MS;
	await sendBoundedDebuggerCommand(
		webContents,
		"DOM.scrollIntoViewIfNeeded",
		{ backendNodeId },
		signal,
		deadline,
	);
	const resolved = await sendBoundedDebuggerCommand<{
		object?: { objectId?: string };
	}>(
		webContents,
		"DOM.resolveNode",
		{ backendNodeId },
		signal,
		deadline,
	);
	const objectId = resolved.object?.objectId;
	if (!objectId) throw new Error("Browser target was not found.");
	try {
		const remaining = Math.max(1, deadline - Date.now());
		const inspected = await sendBoundedDebuggerCommand<{
			result?: {
				value?: { ok?: boolean; code?: unknown; x?: number; y?: number };
			};
			exceptionDetails?: unknown;
		}>(
			webContents,
			"Runtime.callFunctionOn",
			{
				objectId,
				functionDeclaration: `async function (shouldFocus) {
  const node = this;
  if (!(node instanceof Element)) return { ok: false, code: "not_found" };
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const box = node.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const styles = [];
  for (let current = node; current; current = current.parentElement) styles.push(getComputedStyle(current));
  if (
    !Number.isFinite(box.left) ||
    !Number.isFinite(box.top) ||
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    box.width <= 0 ||
    box.height <= 0 ||
    styles.some((style) =>
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden" ||
      Number(style.opacity) <= 0
    )
  ) return { ok: false, code: "not_visible" };
  if (node.matches(":disabled") || node.getAttribute("aria-disabled") === "true") {
    return { ok: false, code: "disabled" };
  }
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const right = Math.min(viewportWidth, box.right);
  const bottom = Math.min(viewportHeight, box.bottom);
  if (right <= left || bottom <= top) return { ok: false, code: "outside_viewport" };
  const x = left + (right - left) / 2;
  const y = top + (bottom - top) / 2;
  const hit = document.elementFromPoint(x, y);
  if (!(hit instanceof Element) || (hit !== node && !node.contains(hit))) {
    return { ok: false, code: "obscured" };
  }
  if (shouldFocus && typeof node.focus === "function") node.focus({ preventScroll: true });
  return { ok: true, x, y };
}`,
				arguments: [{ value: focus }],
				returnByValue: true,
				awaitPromise: true,
				timeout: Math.min(1_000, remaining),
			},
			signal,
			deadline,
		);
		const result = inspected.result?.value;
		if (inspected.exceptionDetails || result?.ok !== true)
			throw browserTargetError(result?.code);
		if (!Number.isFinite(result.x) || !Number.isFinite(result.y))
			throw new Error("Browser target bounds are invalid.");
		return { x: result.x!, y: result.y! };
	} finally {
		void webContents.debugger
			.sendCommand("Runtime.releaseObject", { objectId })
			.catch(() => undefined);
	}
}

export async function selectBrowserOption(
	webContents: WebContents,
	target: string,
	value: string,
	elementRefs: ReadonlyMap<string, number> | undefined,
	signal: AbortSignal,
): Promise<void> {
	if (!target || target.length > 2_000)
		throw new Error("Browser selector is invalid.");
	if (value.length > 2_000)
		throw new Error(
			"Browser select values are limited to 2,000 characters per action.",
		);
	if (signal.aborted) throw signal.reason;
	if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
	const ref = normalizeBrowserElementRef(target);
	let backendNodeId: number | undefined;
	if (ref) {
		backendNodeId = elementRefs?.get(ref);
		if (backendNodeId === undefined)
			throw new Error("Browser target ref is stale. Take a new snapshot.");
	} else {
		const deadline = Date.now() + BROWSER_TARGET_OPERATION_TIMEOUT_MS;
		const documentResult = await sendBoundedDebuggerCommand<{
			root?: BrowserDebuggerNode;
		}>(
			webContents,
			"DOM.getDocument",
			{ depth: 0, pierce: false },
			signal,
			deadline,
		);
		const rootNodeId = documentResult.root?.nodeId;
		if (!Number.isInteger(rootNodeId) || !rootNodeId)
			throw new Error("Browser document is unavailable.");
		const queryResult = await sendBoundedDebuggerCommand<{ nodeId?: number }>(
			webContents,
			"DOM.querySelector",
			{ nodeId: rootNodeId, selector: target },
			signal,
			deadline,
		).catch((error: unknown) => {
			if (
				error instanceof Error &&
				(error.message === "Browser target operation timed out." ||
					signal.aborted)
			)
				throw error;
			if (
				error instanceof Error &&
				/selector|syntax|dom error while querying/i.test(error.message)
			)
				throw new Error("Browser selector is invalid.");
			throw error;
		});
		if (!queryResult.nodeId)
			throw new Error("Browser target was not found.");
		const described = await sendBoundedDebuggerCommand<{
			node?: BrowserDebuggerNode;
		}>(
			webContents,
			"DOM.describeNode",
			{ nodeId: queryResult.nodeId },
			signal,
			deadline,
		);
		backendNodeId = described.node?.backendNodeId;
		if (!Number.isInteger(backendNodeId) || !backendNodeId)
			throw new Error("Browser target was not found.");
	}

	await targetPointFromBackendNode(
		webContents,
		backendNodeId,
		false,
		signal,
	);
	const deadline = Date.now() + BROWSER_TARGET_OPERATION_TIMEOUT_MS;
	const resolved = await sendBoundedDebuggerCommand<{
		object?: { objectId?: string };
	}>(
		webContents,
		"DOM.resolveNode",
		{ backendNodeId },
		signal,
		deadline,
	);
	const objectId = resolved.object?.objectId;
	if (!objectId) throw new Error("Browser target was not found.");
	try {
		const remaining = Math.max(1, deadline - Date.now());
		const changed = await sendBoundedDebuggerCommand<{
			result?: { value?: { ok?: boolean; code?: unknown } };
			exceptionDetails?: unknown;
		}>(
			webContents,
			"Runtime.callFunctionOn",
			{
				objectId,
				functionDeclaration: `function (nextValue) {
  const node = this;
  if (!(node instanceof HTMLSelectElement)) return { ok: false, code: "not_select" };
  if (!Array.from(node.options).some((option) => option.value === nextValue)) {
    return { ok: false, code: "missing_value" };
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (typeof setter !== "function") return { ok: false, code: "mismatch" };
  setter.call(node, nextValue);
  node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  node.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return node.value === nextValue
    ? { ok: true }
    : { ok: false, code: "mismatch" };
}`,
				arguments: [{ value }],
				returnByValue: true,
				awaitPromise: false,
				userGesture: true,
				timeout: Math.min(1_000, remaining),
			},
			signal,
			deadline,
		);
		if (changed.exceptionDetails || changed.result?.value?.ok !== true)
			throw browserTargetError(changed.result?.value?.code);
	} finally {
		void webContents.debugger
			.sendCommand("Runtime.releaseObject", { objectId })
			.catch(() => undefined);
	}
	if (signal.aborted) throw signal.reason;
}
