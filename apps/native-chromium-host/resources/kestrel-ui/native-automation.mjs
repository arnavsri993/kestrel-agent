import { annotateAccessibilityTree, normalizeBrowserElementRef } from "../../../../packages/agent-core/src/browser-element-refs.ts";

const COUNTER_KEY = "kestrel.native.browser.referenceCounter.v1";
const SENSITIVE = /password|one[-_ ]?time|\botp\b|recovery|verification|security[-_ ]?code|cvv|cvc|cc-|credit[-_ ]?card|api[-_ ]?(?:key|token)|access[-_ ]?token|private[-_ ]?key/i;
const MAX_DOM_NODES = 10_000;
const MAX_AX_NODES = 1_500;
export function observationUrl(value) {
	try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return; url.search = ""; url.hash = ""; return url.href; }
	catch { return; }
}
function text(value, limit = 500) {
	return String(value ?? "").replace(/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,})\b/g, "[redacted credential]")
		.replace(/\b(api[_ -]?key|access[_ -]?token|authorization|client[_ -]?secret|password|secret|private[_ -]?key|credential)\b(\s*[:=]\s*)(["'`]?)([^\s"'`,;&}]{8,})(\3)/gi, "$1$2[redacted credential]")
		.replace(/\b(?:https?|file|ftp|data|javascript|blob):[^\s<>"'{}[\]]+/gi, value => observationUrl(value) ?? "[redacted URL]").slice(0, limit);
}

// Keep raw DOM/AX responses inside the private worker. Only whitelisted
// structural AX fields leave it; input values, descriptions, attributes and
// name sources never cross the native bridge. Unknown/deeper DOM nodes fail
// closed rather than inheriting an assumed public ancestor.
export function sanitizeNativeAccessibility(root, rawNodes) {
	const metadata = new Map(); const queue = [{ node: root, privateParent: false, editableParent: false }];
	let visited = 0; let hasSensitive = false; let truncated = false;
	while (queue.length) {
		if (++visited > MAX_DOM_NODES) { truncated = true; break; }
		const { node, privateParent, editableParent } = queue.pop();
		if (!node || !Number.isSafeInteger(node.backendNodeId)) continue;
		const attributes = new Map();
		const ambiguous = node.attributes !== undefined && (!Array.isArray(node.attributes) || node.attributes.length > 200 || node.attributes.length % 2 !== 0 || node.attributes.some((value, index) => index % 2 === 1 && String(value).length > 4_096));
		truncated ||= ambiguous;
		for (let i = 0; i + 1 < (node.attributes?.length ?? 0) && i < 200; i += 2) attributes.set(String(node.attributes[i]).toLowerCase(), String(node.attributes[i + 1]).slice(0, 4_096));
		const tag = String(node.nodeName || "").toLowerCase();
		const editable = tag === "textarea" || tag === "input" && !["submit", "button", "reset", "checkbox", "radio", "range"].includes(attributes.get("type") || "text") || attributes.has("contenteditable") && attributes.get("contenteditable") !== "false";
		const sensitive = SENSITIVE.test([attributes.get("type"), attributes.get("name"), attributes.get("id"), attributes.get("autocomplete"), attributes.get("aria-label"), attributes.get("placeholder")].join(" "));
		const blocked = ambiguous || privateParent || attributes.has("data-private") || attributes.has("data-sensitive") || attributes.has("hidden") || attributes.get("aria-hidden") === "true" || ["script", "style", "noscript", "template"].includes(tag);
		hasSensitive ||= ambiguous || sensitive || attributes.has("data-private") || attributes.has("data-sensitive");
		metadata.set(node.backendNodeId, { blocked: blocked || editableParent, sensitive, editable, tag, disabled: attributes.has("disabled") || attributes.get("aria-disabled") === "true", readOnly: attributes.has("readonly") });
		for (const child of node.children ?? []) queue.push({ node: child, privateParent: blocked, editableParent: editableParent || editable });
		// A separate document/shadow boundary needs its own bounded snapshot.
		if (node.shadowRoots?.length || node.contentDocument || node.childNodeCount > (node.children?.length ?? 0)) truncated = true;
	}
	const nodes = [];
	for (const raw of rawNodes) {
		if (nodes.length >= MAX_AX_NODES) { truncated = true; break; }
		const info = metadata.get(raw.backendDOMNodeId);
		if (!info || info.blocked || raw.ignored || !raw.role?.value) continue;
		nodes.push({ nodeId: String(raw.nodeId).slice(0, 100), role: { value: text(raw.role.value, 60) },
			name: { value: info.sensitive ? "Sensitive field" : text(raw.name?.value) },
			backendDOMNodeId: raw.backendDOMNodeId,
		});
	}
	return { accessibilityTree: { nodes }, metadata, hasSensitive, truncated };
}

// This source is owned by the worker, never supplied by a model or page. Run it
// in an isolated world and return only booleans/geometry; no DOM value escapes.
function inspectTarget(mode, value) {
	const node = this;
	const doc = node.ownerDocument;
	if (!doc || !node.isConnected || !(node instanceof Element) || node.getRootNode() !== doc) return { ok: false };
	for (let current = node; current; current = current.parentElement) {
		const style = getComputedStyle(current);
		if (current.matches("[data-private], [data-sensitive], [hidden], [inert], [aria-hidden='true']") || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return { ok: false };
		const hint = ["type", "name", "id", "autocomplete", "aria-label", "placeholder"].map(key => current.getAttribute(key) || "").join(" ");
		if (/password|one[-_ ]?time|\botp\b|recovery|verification|security[-_ ]?code|cvv|cvc|cc-|credit[-_ ]?card|api[-_ ]?(?:key|token)|access[-_ ]?token|private[-_ ]?key/i.test(hint)) return { ok: false, sensitive: true };
	}
	if (node.matches(":disabled, [aria-disabled='true']")) return { ok: false };
	const label = Array.from(node.labels || []).map(label => label.textContent || "").join(" ");
	if (/password|one[-_ ]?time|\botp\b|verification|recovery|security[-_ ]?code|cvv|cvc|credit[-_ ]?card|api[-_ ]?(?:key|token)|access[-_ ]?token|private[-_ ]?key/i.test(label)) return { ok: false, sensitive: true };
	const box = node.getBoundingClientRect();
	const left = Math.max(0, box.left), top = Math.max(0, box.top);
	const right = Math.min(doc.documentElement.clientWidth, box.right), bottom = Math.min(doc.documentElement.clientHeight, box.bottom);
	if (!(right > left && bottom > top)) return { ok: false };
	const x = (left + right) / 2, y = (top + bottom) / 2;
	const hit = doc.elementFromPoint(x, y);
	if (!hit || (hit !== node && !node.contains(hit))) return { ok: false };
	if (mode === "focused" && doc.activeElement !== node) return { ok: false };
	if (mode === "type" || mode === "focused") {
		if (node.readOnly || !(node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement && ["text", "search", "email", "url", "tel"].includes(node.type) || node.isContentEditable)) return { ok: false };
	}
	if (mode === "select") {
		if (!(node instanceof HTMLSelectElement) || node.multiple || !Array.from(node.options).some(option => option.value === value && !option.disabled && !option.parentElement?.disabled)) return { ok: false };
		const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
		setter.call(node, value);
		node.dispatchEvent(new Event("input", { bubbles: true }));
		node.dispatchEvent(new Event("change", { bubbles: true }));
		return { ok: node.isConnected && node.value === value };
	}
	return { ok: true, x, y };
}

export function createNativeAutomation(chromeApi, { invoke, resolveTab, operationTimeoutMs = 15_000, commandTimeoutMs = 3_000 }) {
	const busy = new Set(); const snapshots = new Map(); let counterQueue = Promise.resolve();
	if (![operationTimeoutMs, commandTimeoutMs].every(value => Number.isFinite(value) && value >= 1 && value <= 30_000)) throw new Error("Invalid native automation deadline.");
	async function bounded(promise, signal, deadline) {
		if (signal?.aborted) { promise.catch(() => {}); signal.throwIfAborted(); }
		let timer, abort;
		try {
			return await Promise.race([promise, new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("Native browser operation timed out; read the page before continuing. Do not replay the action.")), Math.max(0, deadline - Date.now()));
				abort = () => reject(signal.reason || new Error("Native browser operation cancelled."));
				signal?.addEventListener("abort", abort, { once: true });
			})]);
		} finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
	}
	async function counter() {
		const result = counterQueue.then(async () => {
			const stored = await invoke(chromeApi.storage.session, "get", COUNTER_KEY);
			const previous = stored[COUNTER_KEY] ?? 0;
			if (!Number.isSafeInteger(previous) || previous < 0 || previous > 999_999_600) throw new Error("Native browser reference storage is invalid or exhausted.");
			await invoke(chromeApi.storage.session, "set", { [COUNTER_KEY]: previous + 200 }); return previous + 1;
		}); counterQueue = result.catch(() => {}); return result;
	}
	async function pin(tabId, signal) {
		signal?.throwIfAborted(); const tab = await resolveTab(tabId);
		if (!observationUrl(tab?.url) || tab.pendingUrl && tab.pendingUrl !== tab.url || tab.discarded) throw new Error("Select a loaded HTTP(S) user page before using automation.");
		const frame = await invoke(chromeApi.webNavigation, "getFrame", { tabId: tab.id, frameId: 0 });
		if (!frame?.documentId || frame.url !== tab.url || frame.documentLifecycle !== "active") throw new Error("The browser document changed. Read it again before acting.");
		signal?.throwIfAborted(); return { tab: { ...tab }, frame: { ...frame } };
	}
	async function assertPinned(owner, signal) {
		signal?.throwIfAborted();
		const tab = await invoke(chromeApi.tabs, "get", owner.tab.id);
		const frame = await invoke(chromeApi.webNavigation, "getFrame", { tabId: owner.tab.id, frameId: 0 });
		if (!observationUrl(tab?.url) || tab.url !== owner.frame.url || tab.pendingUrl && tab.pendingUrl !== tab.url || frame?.documentId !== owner.frame.documentId || frame.url !== owner.frame.url || frame.documentLifecycle !== "active")
			throw new Error("The browser document changed. Discard this result and read the current page again.");
		signal?.throwIfAborted();
	}
	async function attached(tabId, signal, operation) {
		const deadline = Date.now() + operationTimeoutMs;
		const owner = await bounded(pin(tabId, signal), signal, Math.min(deadline, Date.now() + commandTimeoutMs));
		if (busy.has(owner.tab.id) || busy.size >= 8) throw new Error("Another native operation is using this page. Wait for it to finish.");
		busy.add(owner.tab.id); let attached = false, detachPromise; const pending = new Set();
		const run = async (promise, cleanup = false) => {
			pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {});
			return bounded(promise, cleanup ? undefined : signal, cleanup ? Date.now() + 250 : Math.min(deadline, Date.now() + commandTimeoutMs));
		};
		const raw = (method, params = {}, cleanup = false) => run(invoke(chromeApi.debugger, "sendCommand", { tabId: owner.tab.id }, method, params), cleanup);
		try {
			const attach = invoke(chromeApi.debugger, "attach", { tabId: owner.tab.id }, "1.3").then(() => { attached = true; });
			await run(attach);
			const command = async (method, params = {}, onSend) => {
				await run(assertPinned(owner, signal)); signal?.throwIfAborted();
				onSend?.(); const result = await raw(method, params);
				await run(assertPinned(owner, signal)); return result;
			};
			return await operation(owner, command, raw, run);
		} finally {
			// Quarantine a tab with an unacknowledged command until it settles. A
			// late attach is detached too; another debugger is never detached when
			// our attach failed. Input cleanup is best effort and never replays.
			const detachOnce = async () => {
				if (!attached) return;
				detachPromise ||= invoke(chromeApi.debugger, "detach", { tabId: owner.tab.id });
				await bounded(detachPromise, undefined, Date.now() + 250).catch(() => {});
			};
			const cleanup = async () => {
				await detachOnce();
				// A late detach must finish before another operation may attach.
				if (detachPromise) await detachPromise.catch(() => {});
				busy.delete(owner.tab.id);
			};
			if (pending.size) {
				await detachOnce();
				Promise.allSettled([...pending]).then(cleanup).catch(() => {});
			} else {
				await detachOnce();
				// Never block the caller on an unresponsive detach acknowledgement.
				cleanup().catch(() => {});
				if (!detachPromise) busy.delete(owner.tab.id);
			}
		}
	}
	async function snapshot(tabId, signal) {
		return attached(tabId, signal, async (owner, command, _raw, run) => {
			snapshots.delete(owner.tab.id);
			const tree = await command("Page.getFrameTree");
			const dom = await command("DOM.getDocument", { depth: 32, pierce: false });
			if (JSON.stringify(dom).length > 8_000_000) throw new Error("This page exceeds the bounded native snapshot limit.");
			const raw = await command("Accessibility.getFullAXTree", { frameId: tree.frameTree.frame.id, depth: 20 });
			const safe = sanitizeNativeAccessibility(dom.root, raw.nodes ?? []);
			const annotated = annotateAccessibilityTree(safe.accessibilityTree, 200, { firstRef: await run(counter()) });
			const snapshot = { url: observationUrl(owner.tab.url), title: text(owner.tab.title) || "Untitled page", accessibilityTree: annotated.accessibilityTree,
				interactive: annotated.interactive.map(({ backendDOMNodeId, ...ref }) => ref), truncated: safe.truncated || annotated.truncated, trust: "untrusted_browser" };
			if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 700_000) throw new Error("This page exceeds the bounded native snapshot limit.");
			await run(assertPinned(owner, signal));
			if (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value);
			snapshots.set(owner.tab.id, { owner, refs: new Map(annotated.interactive.map(ref => [ref.ref, ref])), metadata: new Map(annotated.interactive.map(ref => [ref.backendDOMNodeId, safe.metadata.get(ref.backendDOMNodeId)])), hasSensitive: safe.hasSensitive, truncated: snapshot.truncated, createdAt: Date.now() });
			return snapshot;
		});
	}
	async function act(tabId, action, signal) {
		if (!action || typeof action !== "object" || !["click", "type", "select", "key", "scroll"].includes(action.type)) throw new Error("Unsupported native browser action.");
		const targeted = ["click", "type", "select"].includes(action.type);
		const targetRef = targeted && typeof action.target === "string" ? normalizeBrowserElementRef(action.target) : undefined;
		if (targeted && !targetRef) throw new Error("Native actions require a fresh snapshot element ref.");
		if (action.type === "type" && (typeof action.text !== "string" || action.text.length > 20_000) || action.type === "select" && (typeof action.value !== "string" || action.value.length > 2_000)) throw new Error("Native browser input exceeds limits.");
		const keys = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32 };
		if (action.type === "key" && !Object.hasOwn(keys, action.key)) throw new Error("Native browser key is unsupported; use one unmodified page key.");
		if (action.type === "scroll" && ![action.x, action.y].every(value => Number.isFinite(value) && Math.abs(value) <= 100_000)) throw new Error("Native browser scroll exceeds limits.");
		return attached(tabId, signal, async (owner, command, raw, run) => {
			const saved = snapshots.get(owner.tab.id);
			if (!saved || saved.owner.frame.documentId !== owner.frame.documentId || saved.owner.frame.url !== owner.frame.url || Date.now() - saved.createdAt > 30_000) throw new Error("Read a fresh browser snapshot before acting; the document or refs are stale.");
			const ref = targeted ? saved.refs.get(targetRef) : undefined;
			if (targeted && !ref) throw new Error("Read a fresh browser snapshot; the target ref is stale.");
			// Consume the observation before any potentially mutating command.
			snapshots.delete(owner.tab.id);
			const dom = await command("DOM.getDocument", { depth: 32, pierce: false });
			if (JSON.stringify(dom).length > 8_000_000) throw new Error("This page exceeds the bounded native action limit.");
			const safe = sanitizeNativeAccessibility(dom.root, []);
			const tree = await command("Page.getFrameTree");
			if (!tree.frameTree?.frame?.id) throw new Error("Native browser frame is unavailable.");
			const world = await command("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "kestrel-native-actions", grantUniveralAccess: false });
			if (!Number.isSafeInteger(world.executionContextId)) throw new Error("Native browser isolated world is unavailable.");
			const objectIds = [];
			async function releaseInput(method, params) {
				try { await bounded(assertPinned(owner), undefined, Date.now() + 250); await raw(method, params, true); } catch {}
			}
			async function pairedInput(method, down, up) {
				await run(assertPinned(owner, signal)); signal?.throwIfAborted();
				let started = false, releaseSent = false;
				try {
					started = true;
					const pressed = raw(method, down);
					if (signal?.aborted) { await pressed.catch(() => {}); signal.throwIfAborted(); }
					// Submit both halves before awaiting either acknowledgment. A
					// valid gesture can itself navigate the pinned old document.
					releaseSent = true;
					const released = raw(method, up);
					await Promise.all([pressed, released]);
					// A changed document is an uncertain effect, never a performed
					// claim. Both halves have already been submitted once.
					await run(assertPinned(owner, signal));
				} finally { if (started && !releaseSent) await releaseInput(method, up); }
			}
			async function resolve(backendNodeId) {
				const result = await command("DOM.resolveNode", { backendNodeId, executionContextId: world.executionContextId });
				if (!result.object?.objectId) throw new Error("Native browser target is no longer present.");
				objectIds.push(result.object.objectId); return result.object.objectId;
			}
			async function inspect(objectId, mode, value) {
				const result = await command("Runtime.callFunctionOn", { objectId, functionDeclaration: inspectTarget.toString(), arguments: [{ value: mode }, { value }], returnByValue: true, awaitPromise: false });
				if (result.exceptionDetails || result.result?.value?.ok !== true) throw new Error(result.result?.value?.sensitive ? "Kestrel refuses sensitive fields. Ask the user to enter the value directly." : "Native browser target is private, hidden, disabled, obscured, or changed.");
				return result.result.value;
			}
			try {
				let backendNodeId = ref?.backendDOMNodeId;
				if (action.type === "key") {
					const documentObject = await resolve(dom.root.backendNodeId);
					const active = await command("Runtime.callFunctionOn", { objectId: documentObject, functionDeclaration: "function () { return this.activeElement; }", returnByValue: false });
					if (!active.result?.objectId || active.exceptionDetails) throw new Error("The focused page target is unavailable.");
					objectIds.push(active.result.objectId);
					backendNodeId = (await command("DOM.describeNode", { objectId: active.result.objectId, depth: 0 })).node?.backendNodeId;
					if (![...saved.refs.values()].some(item => item.backendDOMNodeId === backendNodeId)) throw new Error("The focused element needs a fresh snapshot ref.");
				}
				if (action.type === "scroll") {
					const layout = await command("Page.getLayoutMetrics");
					const viewport = layout.cssVisualViewport;
					if (!(viewport?.clientWidth > 0 && viewport?.clientHeight > 0) || viewport.scale !== 1) throw new Error("Native browser viewport is unsupported.");
					const x = viewport.clientWidth / 2, y = viewport.clientHeight / 2;
					const hit = await command("DOM.getNodeForLocation", { x: Math.floor(x), y: Math.floor(y), includeUserAgentShadowDOM: false });
					backendNodeId = hit.backendNodeId;
					const info = safe.metadata.get(backendNodeId);
					if (!info || info.blocked || info.sensitive) throw new Error("Native browser scroll target is private or unavailable.");
					await inspect(await resolve(backendNodeId), "click");
					await command("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: action.x, deltaY: action.y, modifiers: 0 });
				} else {
					const info = safe.metadata.get(backendNodeId);
					if (!info || info.blocked || info.sensitive || info.disabled) throw new Error("Native browser target is sensitive, private, disabled, or stale.");
					// A stable node id alone is insufficient if the page repurposes
					// the same node for a different control after the observation.
					const expected = ref || [...saved.refs.values()].find(item => item.backendDOMNodeId === backendNodeId);
					const ax = await command("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false });
					const current = sanitizeNativeAccessibility(dom.root, ax.nodes || []).accessibilityTree.nodes.find(node => node.backendDOMNodeId === backendNodeId);
					if (!current || current.role.value !== expected?.role || current.name.value.trim() !== (expected?.name || "")) throw new Error("The observed browser control changed. Read a fresh snapshot before acting.");
					const objectId = await resolve(backendNodeId);
					await inspect(objectId, action.type === "type" ? "type" : "click");
					if (action.type === "click") {
						const point = await inspect(objectId, "click");
						if (![point.x, point.y].every(Number.isFinite)) throw new Error("Native browser target bounds are invalid.");
						const pointer = { x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: 0 };
						await pairedInput("Input.dispatchMouseEvent", { ...pointer, type: "mousePressed", buttons: 1 }, { ...pointer, type: "mouseReleased", buttons: 0 });
					} else if (action.type === "type") {
						await command("DOM.focus", { backendNodeId });
						await inspect(objectId, "focused");
						await command("Input.insertText", { text: action.text });
					} else if (action.type === "select") await inspect(objectId, "select", action.value);
					else {
						// Validate focus immediately before dispatch; no global shortcuts,
						// modifiers, clipboard access, or browser chrome keys are exposed.
						const check = await command("Runtime.callFunctionOn", { objectId, functionDeclaration: "function () { return this.ownerDocument.activeElement === this; }", returnByValue: true });
						if (check.exceptionDetails || check.result?.value !== true) throw new Error("Native browser focus changed.");
						const event = { key: action.key, code: action.key === " " ? "Space" : action.key, windowsVirtualKeyCode: keys[action.key], modifiers: 0 };
						const text = action.key === "Enter" ? "\r" : action.key === " " ? " " : undefined;
						await pairedInput("Input.dispatchKeyEvent", { ...event, type: "keyDown", ...(text === undefined ? {} : { text, unmodifiedText: text }) }, { ...event, type: "keyUp" });
					}
				}
				return { performed: true, trust: "untrusted_browser" };
			} finally { for (const objectId of objectIds) await raw("Runtime.releaseObject", { objectId }, true).catch(() => {}); }
		});
	}
	async function screenshot(tabId, signal) {
		return attached(tabId, signal, async (_owner, command) => {
			const dom = await command("DOM.getDocument", { depth: 32, pierce: false });
			if (JSON.stringify(dom).length > 8_000_000) throw new Error("This page exceeds the bounded native screenshot limit.");
			const safe = sanitizeNativeAccessibility(dom.root, []);
			if (safe.truncated || safe.hasSensitive || [...safe.metadata.values()].some(info => info.editable || ["iframe", "frame", "fencedframe", "object", "embed", "canvas", "video"].includes(info.tag) || info.blocked && !["script", "style", "noscript", "template", "#text", "#comment"].includes(info.tag))) throw new Error("Screenshots of private, editable, or ambiguous pages are refused.");
			const layout = await command("Page.getLayoutMetrics");
			const viewport = layout.cssVisualViewport;
			const width = viewport?.clientWidth, height = viewport?.clientHeight;
			if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096) || viewport.scale !== 1 || width * height > 8_000_000) throw new Error("Native screenshot viewport exceeds limits.");
			const result = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true, clip: { x: viewport.pageX, y: viewport.pageY, width, height, scale: 1 } });
			// PNG signature + IHDR dimensions are checked before crossing the bridge.
			if (typeof result.data !== "string" || result.data.length > 650_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.data)) throw new Error("Native screenshot encoding exceeds limits.");
			const header = Uint8Array.from(atob(result.data.slice(0, 44)), char => char.charCodeAt(0));
			const view = new DataView(header.buffer);
			if (header.length < 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(12) !== 0x49484452) throw new Error("Native screenshot dimensions are invalid.");
			const pixelWidth = view.getUint32(16), pixelHeight = view.getUint32(20);
			// Chromium may capture physical Retina pixels. Require one uniform,
			// bounded device scale and report the actual PNG dimensions.
			const pixelScale = pixelWidth / width;
			if (![pixelWidth, pixelHeight].every(value => value > 0 && value <= 4096) || pixelWidth * pixelHeight > 8_000_000 || pixelScale < 0.5 || pixelScale > 4 || Math.abs(pixelHeight / height - pixelScale) > 0.001) throw new Error("Native screenshot dimensions are invalid.");
			// Recheck privacy after capture. Any change refuses the entire frame.
			const after = await command("DOM.getDocument", { depth: 32, pierce: false });
			const fresh = sanitizeNativeAccessibility(after.root, []);
			if (fresh.truncated || fresh.hasSensitive || [...fresh.metadata.values()].some(info => info.editable || ["iframe", "frame", "fencedframe", "object", "embed", "canvas", "video"].includes(info.tag) || info.blocked && !["script", "style", "noscript", "template", "#text", "#comment"].includes(info.tag)) || JSON.stringify([...safe.metadata]) !== JSON.stringify([...fresh.metadata])) throw new Error("The page changed during screenshot capture; discard the frame.");
			return { version: 1, encoding: "png", pngBase64: result.data, width: pixelWidth, height: pixelHeight, trust: "untrusted_browser" };
		});
	}
	chromeApi.tabs?.onRemoved?.addListener?.(tabId => snapshots.delete(tabId));
	chromeApi.webNavigation?.onCommitted?.addListener?.(info => { if (info.frameId === 0) snapshots.delete(info.tabId); });
	return { snapshot, act, screenshot };
}
