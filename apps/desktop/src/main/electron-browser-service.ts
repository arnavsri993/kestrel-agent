import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
	annotateAccessibilityTree,
	type BrowserAction,
	type BrowserDiagnostic,
	type BrowserDownload,
	type BrowserSnapshot,
	type BrowserViewport,
	type DesktopAction,
	normalizeBrowserElementRef,
	normalizeIsolatedBrowserOrigins,
	type ScreenshotFrame,
} from "@kestrel/agent-core";
import {
	app,
	BrowserWindow,
	desktopCapturer,
	session as electronSession,
	screen,
	type Session,
	systemPreferences,
} from "electron";
import {
	type AutomationBrowserBackendWireRequest,
} from "./browser-backend-wire";
import {
	MAX_AX_SNAPSHOT_BYTES,
	MAX_AX_SNAPSHOT_NODES,
	MAX_INTERACTIVE_REFS,
	redactUntrustedBrowserText,
	sanitizeBrowserUrl,
	sanitizeUntrustedBrowserValue,
} from "./browser-tab-store";
import {
	dispatchBrowserKey,
	dispatchBrowserMouseClick,
	publicInteractiveRefs,
	rememberElementRefs,
	selectBrowserOption,
	targetPointFromBackendNode,
} from "./browser-backend-node-target";

export function uniqueIsolatedDownloadFilename(
	requested: string,
	occupied: Iterable<string>,
	fallbackId: string,
): string {
	const taken = new Set(occupied);
	const sanitized =
		requested.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120) ||
		`${fallbackId}.bin`;
	if (!taken.has(sanitized)) return sanitized;
	const extension = extname(sanitized);
	const stem = basename(sanitized, extension).slice(0, 80) || fallbackId;
	for (let n = 2; n < 10_000; n += 1) {
		const candidate = `${stem}-${n}${extension}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${fallbackId}.bin`;
}

export type { AutomationBrowserBackendWireRequest };

interface BrowserRecord {
	window: BrowserWindow;
	partition: Session;
	allowedOrigins: Set<string>;
	diagnostics: BrowserDiagnostic[];
	downloads: BrowserDownload[];
	downloadDirectory: string;
}

export interface DesktopDisplayBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface DesktopCaptureMetadata {
	captureId: string;
	displayId: string;
	bounds: DesktopDisplayBounds;
	capturedAt: string;
}

interface DesktopForegroundProcess {
	pid: number;
	bundleId: string;
}

interface DesktopCaptureRecord {
	metadata: DesktopCaptureMetadata;
	foreground: DesktopForegroundProcess;
}

const DESKTOP_CAPTURE_MAX_AGE_MS = 120_000;

export function mapDesktopScreenshotPoint(
	x: number,
	y: number,
	bounds: DesktopDisplayBounds,
): { x: number; y: number } {
	if (!Number.isInteger(x) || !Number.isInteger(y))
		throw new Error("Desktop click coordinates must be integers.");
	if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height)
		throw new Error("Desktop click is outside the captured display.");
	return { x: bounds.x + x, y: bounds.y + y };
}

export function buildDesktopKeyScript(
	keyCodeOrKey: number | string,
	modifiers: readonly string[] = [],
): string {
	const allowed = new Set(["Command", "Control", "Alt", "Shift"]);
	if (modifiers.some((modifier) => !allowed.has(modifier)))
		throw new Error("Desktop key modifiers are invalid.");
	const modifierNames = modifiers.map((modifier) => {
		if (modifier === "Command") return "command down";
		if (modifier === "Control") return "control down";
		if (modifier === "Alt") return "option down";
		return "shift down";
	});
	const using = modifierNames.length ? ` using {${modifierNames.join(", ")}}` : "";
	if (typeof keyCodeOrKey === "string") {
		if (!/^[A-Za-z0-9]$/.test(keyCodeOrKey))
			throw new Error("Desktop key is invalid.");
		return `tell application "System Events" to keystroke ${JSON.stringify(keyCodeOrKey)}${using}`;
	}
	return `tell application "System Events" to key code ${keyCodeOrKey}${using}`;
}

export function isDesktopCaptureFresh(
	capturedAt: string,
	now = Date.now(),
): boolean {
	const age = now - Date.parse(capturedAt);
	return Number.isFinite(age) && age >= 0 && age <= DESKTOP_CAPTURE_MAX_AGE_MS;
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("Desktop action cancelled.");
}

async function runOsaScript(
	script: string,
	signal: AbortSignal,
): Promise<string> {
	if (signal.aborted) throw abortError(signal);
	return await new Promise<string>((resolvePromise, reject) => {
		let settled = false;
		let child: ReturnType<typeof execFile>;
		const cleanup = () => signal.removeEventListener("abort", abort);
		const finish = (error?: Error, stdout = "") => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolvePromise(stdout);
		};
		const abort = () => {
			child?.kill("SIGTERM");
			finish(abortError(signal));
		};
		child = execFile(
			"/usr/bin/osascript",
			["-l", "JavaScript", "-e", script],
			{ timeout: 5_000, env: { PATH: "/usr/bin:/bin" } },
			(error, stdout) => finish(signal.aborted ? abortError(signal) : error ?? undefined, stdout),
		);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

async function readFrontmostProcess(
	signal: AbortSignal,
): Promise<DesktopForegroundProcess> {
	const output = await runOsaScript(
		'const se = Application("System Events"); const p = se.processes.whose({frontmost: true})()[0]; if (!p) throw new Error("No frontmost process"); JSON.stringify({ pid: p.unixId(), bundleId: p.bundleIdentifier() });',
		signal,
	);
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.trim());
	} catch {
		throw new Error("Could not verify the frontmost desktop process.");
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!Number.isInteger((parsed as { pid?: unknown }).pid) ||
		typeof (parsed as { bundleId?: unknown }).bundleId !== "string" ||
		!(parsed as { bundleId: string }).bundleId
	)
		throw new Error("Could not verify the frontmost desktop process.");
	return parsed as DesktopForegroundProcess;
}

async function restoreFrontmostProcess(
	process: DesktopForegroundProcess,
	signal: AbortSignal,
): Promise<void> {
	if (!Number.isInteger(process.pid) || process.pid < 1 || process.bundleId.length > 200)
		throw new Error("Captured frontmost process identity is invalid.");
	await runOsaScript(
		`const se = Application("System Events"); const matches = se.processes().filter((p) => p.unixId() === ${process.pid} && p.bundleIdentifier() === ${JSON.stringify(process.bundleId)}); if (matches.length !== 1) throw new Error("Captured frontmost process is unavailable"); matches[0].frontmost = true; delay(0.1); const front = se.processes.whose({frontmost: true})()[0]; if (!front || front.unixId() !== ${process.pid} || front.bundleIdentifier() !== ${JSON.stringify(process.bundleId)}) throw new Error("Captured frontmost process could not be restored");`,
		signal,
	);
}

export const MAX_BROWSER_DOWNLOAD_RECORDS = 200;

export function retainRecentBrowserDownloads(
	downloads: BrowserDownload[],
): void {
	if (downloads.length <= MAX_BROWSER_DOWNLOAD_RECORDS) return;
	const active = downloads.filter(
		(download) => download.status === "progressing",
	);
	const retained = new Set<BrowserDownload>(
		active.slice(-MAX_BROWSER_DOWNLOAD_RECORDS),
	);
	const terminalSlots = Math.max(
		0,
		MAX_BROWSER_DOWNLOAD_RECORDS - retained.size,
	);
	for (const download of downloads
		.filter((candidate) => candidate.status !== "progressing")
		.slice(-terminalSlots))
		retained.add(download);
	for (let index = downloads.length - 1; index >= 0; index -= 1) {
		if (!retained.has(downloads[index]!)) downloads.splice(index, 1);
	}
}

export function isolatedBrowserShouldCancelRequest(
	value: string,
	allowedOrigins: ReadonlySet<string>,
): boolean {
	try {
		const url = new URL(value);
		if (url.protocol === "about:" && url.pathname === "blank") return false;
		if (
			url.protocol === "data:" ||
			url.protocol === "javascript:" ||
			url.protocol === "file:" ||
			url.protocol === "about:"
		)
			return true;
		if (url.protocol === "blob:") {
			const origin = url.origin === "null" ? undefined : url.origin;
			return origin === undefined || !allowedOrigins.has(origin);
		}
		const origin = url.origin;
		return !origin || origin === "null" || !allowedOrigins.has(origin);
	} catch {
		return true;
	}
}

export async function waitForBrowserPostClickFrame(
	executeFrame: () => Promise<unknown>,
	signal: AbortSignal,
	maximumWaitMs = 250,
): Promise<"frame" | "context_changed" | "bounded_wait"> {
	if (signal.aborted) throw signal.reason;
	if (!Number.isFinite(maximumWaitMs) || maximumWaitMs < 1)
		throw new Error("Browser post-click wait must be positive and finite.");
	let timeout: NodeJS.Timeout | undefined;
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([
			executeFrame().then(
				() => "frame" as const,
				() => "context_changed" as const,
			),
			new Promise<"bounded_wait">((resolvePromise) => {
				timeout = setTimeout(
					() => resolvePromise("bounded_wait"),
					maximumWaitMs,
				);
			}),
			new Promise<never>((_resolvePromise, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (abort) signal.removeEventListener("abort", abort);
	}
}

export class ElectronBrowserService {
	private readonly sessions = new Map<string, BrowserRecord>();
	private readonly elementRefs = new Map<string, Map<string, number>>();
	private computerUseEnabled = false;
	private lastDesktopCapture: DesktopCaptureRecord | undefined;

	setComputerUseEnabled(enabled: boolean): void {
		this.computerUseEnabled = enabled;
		if (!enabled) this.lastDesktopCapture = undefined;
	}

	isComputerUseEnabled(): boolean {
		return this.computerUseEnabled;
	}

	async handle(
		request: AutomationBrowserBackendWireRequest,
		signal: AbortSignal,
	): Promise<unknown> {
		if (request.operation === "create")
			return this.create(request.allowedOrigins);
		if (request.operation === "navigate")
			return this.navigate(request.sessionId, request.url, signal);
		if (request.operation === "act")
			return this.act(request.sessionId, request.action, signal);
		if (request.operation === "snapshot")
			return this.snapshot(request.sessionId, signal);
		if (request.operation === "screenshot")
			return this.screenshot(request.sessionId, signal);
		if (request.operation === "viewport")
			return this.setViewport(
				request.sessionId,
				{
					name: request.viewport.name,
					width: request.viewport.width,
					height: request.viewport.height,
					...(request.viewport.deviceScaleFactor !== undefined
						? { deviceScaleFactor: request.viewport.deviceScaleFactor }
						: {}),
				},
				signal,
			);
		if (request.operation === "diagnostics")
			return this.diagnostics(request.sessionId, signal);
		if (request.operation === "auth-handoff")
			return this.authHandoff(request.sessionId, request.visible, signal);
		if (request.operation === "upload")
			return this.upload(
				request.sessionId,
				request.selector,
				request.paths,
				signal,
			);
		if (request.operation === "downloads")
			return this.downloads(request.sessionId, signal);
		if (request.operation === "desktop-screenshot")
			return this.desktopScreenshot(signal);
		if (request.operation === "desktop-act")
			return this.desktopAct(request.action, signal);
		if (request.operation === "close") return this.close(request.sessionId);
		const unsupported: never = request;
		throw new Error(`Unsupported browser operation: ${String(unsupported)}`);
	}

	async closeAll(): Promise<void> {
		for (const id of [...this.sessions.keys()]) await this.close(id);
	}

	private async create(allowedOrigins: string[]): Promise<string> {
		const id = `electron-browser-${randomUUID()}`;
		const partitionName = `kestrel-isolated-${randomUUID()}`;
		const partition = electronSession.fromPartition(partitionName, {
			cache: false,
		});
		const origins = normalizeIsolatedBrowserOrigins(allowedOrigins);
		const allowed = new Set(origins);
		const diagnostics: BrowserDiagnostic[] = [];
		const downloads: BrowserDownload[] = [];
		const downloadDirectory = join(
			app.getPath("userData"),
			"browser-downloads",
			id,
		);
		mkdirSync(downloadDirectory, { recursive: true, mode: 0o700 });
		const recordDiagnostic = (diagnostic: BrowserDiagnostic) => {
			diagnostics.push(diagnostic);
			if (diagnostics.length > 2_000)
				diagnostics.splice(0, diagnostics.length - 2_000);
		};
		partition.setPermissionRequestHandler((_contents, _permission, callback) =>
			callback(false),
		);
		partition.setPermissionCheckHandler(() => false);
		partition.webRequest.onBeforeRequest((details, callback) => {
			callback({
				cancel: isolatedBrowserShouldCancelRequest(details.url, allowed),
			});
		});
		partition.webRequest.onErrorOccurred((details) =>
			recordDiagnostic({
				kind: "network",
				level: "error",
				message: `${details.error} (${details.resourceType})`.slice(0, 2_000),
				url: details.url.slice(0, 4_000),
				timestamp: new Date().toISOString(),
			}),
		);
		partition.on("will-download", (_event, item) => {
			const id = `download-${randomUUID()}`;
			const occupied = new Set(downloads.map((download) => download.filename));
			let filename = uniqueIsolatedDownloadFilename(
				item.getFilename(),
				occupied,
				id,
			);
			let destination = join(downloadDirectory, filename);
			while (existsSync(destination)) {
				occupied.add(filename);
				filename = uniqueIsolatedDownloadFilename(
					item.getFilename(),
					occupied,
					id,
				);
				destination = join(downloadDirectory, filename);
			}
			const record: BrowserDownload = {
				id,
				filename,
				bytes: 0,
				status: "progressing",
				createdAt: new Date().toISOString(),
			};
			downloads.push(record);
			retainRecentBrowserDownloads(downloads);
			item.setSavePath(destination);
			item.on("updated", () => {
				record.bytes = item.getReceivedBytes();
				if (item.getTotalBytes() > 100_000_000 || record.bytes > 100_000_000)
					item.cancel();
			});
			item.once("done", (_doneEvent, state) => {
				record.bytes = item.getReceivedBytes();
				record.status =
					state === "completed"
						? "completed"
						: state === "cancelled"
							? "cancelled"
							: "failed";
				if (record.status === "completed" && statSync(destination).isFile())
					record.sha256 = createHash("sha256")
						.update(readFileSync(destination))
						.digest("hex");
			});
		});
		const window = new BrowserWindow({
			width: 1280,
			height: 800,
			show: false,
			webPreferences: {
				partition: partitionName,
				// Agent sessions stay hidden but still require deterministic layout,
				// animation-frame, and CDP input processing while work is active.
				backgroundThrottling: false,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webSecurity: true,
				javascript: true,
				devTools: false,
			},
		});
		window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		const preventDisallowedNavigation = (
			event: { preventDefault: () => void },
			url: string,
		) => {
			if (isolatedBrowserShouldCancelRequest(url, allowed)) event.preventDefault();
		};
		window.webContents.on("will-navigate", preventDisallowedNavigation);
		window.webContents.on("will-redirect", preventDisallowedNavigation);
		window.webContents.on("did-navigate", () => {
			this.elementRefs.delete(id);
		});
		window.webContents.on("did-navigate-in-page", () => {
			this.elementRefs.delete(id);
		});
		window.webContents.on(
			"console-message",
			(_event, level, message, _line, sourceId) => {
				if (level < 2) return;
				recordDiagnostic({
					kind: "console",
					level: level >= 3 ? "error" : "warning",
					message: String(message).slice(0, 2_000),
					...(sourceId ? { url: String(sourceId).slice(0, 4_000) } : {}),
					timestamp: new Date().toISOString(),
				});
			},
		);
		this.sessions.set(id, {
			window,
			partition,
			allowedOrigins: allowed,
			diagnostics,
			downloads,
			downloadDirectory,
		});
		return id;
	}

	private require(id: string): BrowserRecord {
		const record = this.sessions.get(id);
		if (!record || record.window.isDestroyed())
			throw new Error("Electron browser session is unavailable.");
		return record;
	}

	private async navigate(
		id: string,
		url: string,
		signal: AbortSignal,
	): Promise<void> {
		const { window, allowedOrigins } = this.require(id);
		let requested: URL;
		try {
			requested = new URL(url);
		} catch {
			throw new Error(
				"Electron browser navigation is outside the origin allowlist.",
			);
		}
		if (!allowedOrigins.has(requested.origin))
			throw new Error(
				"Electron browser navigation is outside the origin allowlist.",
			);
		this.elementRefs.delete(id);
		const abort = () => window.webContents.stop();
		signal.addEventListener("abort", abort, { once: true });
		try {
			await window.loadURL(url);
			if (signal.aborted) throw signal.reason;
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}

	private async targetPoint(
		sessionId: string,
		window: BrowserWindow,
		selector: string,
		signal: AbortSignal,
		focus = false,
		rejectSensitive = false,
	): Promise<{ x: number; y: number }> {
		if (!selector || selector.length > 2_000)
			throw new Error("Browser selector is invalid.");
		const ref = normalizeBrowserElementRef(selector);
		if (ref) {
			const backendNodeId = this.elementRefs.get(sessionId)?.get(ref);
			if (backendNodeId === undefined)
				throw new Error("Browser target ref is stale. Take a new snapshot.");
			return targetPointFromBackendNode(
				window.webContents,
				backendNodeId,
				focus,
				signal,
				rejectSensitive,
			);
		}
		const result = (await window.webContents.executeJavaScript(
			`(async () => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof Element)) throw new Error("Browser target was not found.");
      node.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
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
      ) throw new Error("Browser target is not visible.");
      if (node.matches(":disabled") || node.getAttribute("aria-disabled") === "true") {
        throw new Error("Browser target is disabled.");
      }
      const secretHint = [
        node.tagName,
        node.getAttribute("type"),
        node.getAttribute("autocomplete"),
        node.getAttribute("name"),
        node.id,
        node.getAttribute("aria-label"),
        node.getAttribute("placeholder"),
        node.labels?.[0]?.innerText,
      ].filter(Boolean).join(" ").toLowerCase();
      const isSensitive =
        (node instanceof HTMLInputElement && node.type === "password") ||
        /(?:\\b(?:new|current|old|confirm(?:ation)?|repeat)?\\s*password\\b|\\bone[-_\\s]*time[-_\\s]*(?:code|passcode|token)\\b|\\botp\\b|\\b(?:recovery|verification|security)\\s*(?:code|passcode|pin)\\b|\\b(?:cvv|cvc|cc[-_\\s]*csc)\\b|\\bapi[-_\\s]*(?:key|token)\\b|\\baccess[-_\\s]*token\\b|\\bprivate[-_\\s]*key\\b)/i.test(secretHint);
      if (${rejectSensitive} && isSensitive) {
        throw new Error("Kestrel will not type into a sensitive browser field. Ask the user to enter that value directly.");
      }
      const left = Math.max(0, box.left);
      const top = Math.max(0, box.top);
      const right = Math.min(viewportWidth, box.right);
      const bottom = Math.min(viewportHeight, box.bottom);
      if (right <= left || bottom <= top) throw new Error("Browser target is outside the viewport.");
      const x = left + (right - left) / 2;
      const y = top + (bottom - top) / 2;
      const hit = document.elementFromPoint(x, y);
      if (!(hit instanceof Element) || (hit !== node && !node.contains(hit))) {
        throw new Error("Browser target is obscured or cannot receive pointer input.");
      }
      ${focus ? 'if (typeof node.focus === "function") node.focus({ preventScroll: true });' : ""}
      return { x, y };
    })()`,
			true,
		)) as { x: number; y: number };
		if (!Number.isFinite(result.x) || !Number.isFinite(result.y))
			throw new Error("Browser target bounds are invalid.");
		return result;
	}

	private async act(
		id: string,
		action: BrowserAction,
		signal: AbortSignal,
	): Promise<void> {
		const { window } = this.require(id);
		if (signal.aborted) throw signal.reason;
		if (action.type === "click") {
			const point = await this.targetPoint(
				id,
				window,
				action.target,
				signal,
			);
			if (signal.aborted) throw signal.reason;
			// BrowserWindow sessions stay hidden, so Electron's window-level input
			// dispatch can be dropped by a headless runner. Bounded CDP dispatch keeps
			// real pointer semantics without showing the user's desktop window.
			await dispatchBrowserMouseClick(window.webContents, point, signal);
			// Let the renderer process the click handler before the verified action
			// returns. Generic clicks are never retried here because activation may
			// be consequential and the browser service cannot infer idempotency.
			await waitForBrowserPostClickFrame(
				() =>
					window.webContents.executeJavaScript(
						"new Promise((resolve) => requestAnimationFrame(resolve))",
						true,
					),
				signal,
			);
		} else if (action.type === "type") {
			await this.targetPoint(id, window, action.target, signal, true, true);
			if (signal.aborted) throw signal.reason;
			window.webContents.insertText(action.text);
		} else if (action.type === "select") {
			await selectBrowserOption(
				window.webContents,
				action.target,
				action.value,
				this.elementRefs.get(id),
				signal,
			);
		} else if (action.type === "key") {
			if (
				!/^[A-Za-z0-9]{1,20}$/.test(action.key) &&
				![
					"Enter",
					"Escape",
					"Tab",
					"Backspace",
					"ArrowUp",
					"ArrowDown",
					"ArrowLeft",
					"ArrowRight",
				].includes(action.key)
			)
				throw new Error("Browser key is not allowed.");
			await dispatchBrowserKey(window.webContents, action.key, signal);
		} else {
			window.webContents.sendInputEvent({
				type: "mouseWheel",
				x: 0,
				y: 0,
				deltaX: Math.trunc(action.x),
				deltaY: Math.trunc(action.y),
				canScroll: true,
			});
		}
		if (signal.aborted) throw signal.reason;
	}

	private async snapshot(
		id: string,
		signal: AbortSignal,
	): Promise<BrowserSnapshot> {
		const { window } = this.require(id);
		if (signal.aborted) throw signal.reason;
		if (!window.webContents.debugger.isAttached())
			window.webContents.debugger.attach("1.3");
		const result = (await window.webContents.debugger.sendCommand(
			"Accessibility.getFullAXTree",
		)) as { nodes?: unknown[] };
		const nodes = result.nodes ?? [];
		const annotated = annotateAccessibilityTree({
			nodes: nodes.slice(0, MAX_AX_SNAPSHOT_NODES),
		});
		const interactive = annotated.interactive.slice(0, MAX_INTERACTIVE_REFS);
		const accessibilityTree = sanitizeUntrustedBrowserValue(
			annotated.accessibilityTree,
		);
		if (
			Buffer.byteLength(JSON.stringify(accessibilityTree), "utf8") >
			MAX_AX_SNAPSHOT_BYTES
		) {
			this.elementRefs.set(id, new Map());
			throw new Error("Isolated browser accessibility snapshot exceeds 1.5 MB.");
		}
		this.elementRefs.set(id, rememberElementRefs(interactive));
		return {
			url:
				sanitizeBrowserUrl(window.webContents.getURL()) ||
				"https://invalid.local/",
			title: redactUntrustedBrowserText(window.webContents.getTitle(), 500),
			accessibilityTree,
			interactive: publicInteractiveRefs(interactive),
			truncated:
				nodes.length > MAX_AX_SNAPSHOT_NODES ||
				annotated.interactive.length > MAX_INTERACTIVE_REFS,
		};
	}

	private async screenshot(
		id: string,
		signal: AbortSignal,
	): Promise<ScreenshotFrame> {
		const { window } = this.require(id);
		if (signal.aborted) throw signal.reason;
		const snapshot = await this.snapshot(id, signal);
		if (
			snapshot.interactive?.some(
				(item) =>
					item.name === "Sensitive field" ||
					/(?:\b(?:new|current|old|confirm(?:ation)?|repeat)?\s*password\b|\b(?:one\s*time|recovery|verification|security)\s*(?:code|passcode|pin)\b|\botp\b|\b(?:cvv|cvc)\b|\bapi\s*(?:key|token)\b|\baccess\s*token\b|\bprivate\s*key\b)/i.test(
						item.name ?? "",
					),
			)
		)
			throw new Error(
				"Kestrel does not share browser screenshots from pages with sensitive input fields.",
			);
		const image = await window.webContents.capturePage();
		const { width, height } = image.getSize();
		const bgra = image.toBitmap();
		const rgba = new Uint8Array(bgra.byteLength);
		for (let offset = 0; offset < bgra.length; offset += 4) {
			rgba[offset] = bgra[offset + 2]!;
			rgba[offset + 1] = bgra[offset + 1]!;
			rgba[offset + 2] = bgra[offset]!;
			rgba[offset + 3] = bgra[offset + 3]!;
		}
		return { width, height, rgba, png: image.toPNG() };
	}

	private async setViewport(
		id: string,
		viewport: BrowserViewport,
		signal: AbortSignal,
	): Promise<void> {
		const { window } = this.require(id);
		if (signal.aborted) throw signal.reason;
		window.setContentSize(viewport.width, viewport.height, false);
		if (!window.webContents.debugger.isAttached())
			window.webContents.debugger.attach("1.3");
		await window.webContents.debugger.sendCommand(
			"Emulation.setDeviceMetricsOverride",
			{
				width: viewport.width,
				height: viewport.height,
				deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
				mobile: viewport.width < 768,
			},
		);
	}

	private diagnostics(id: string, signal: AbortSignal): BrowserDiagnostic[] {
		const record = this.require(id);
		if (signal.aborted) throw signal.reason;
		return record.diagnostics.map((item) => ({ ...item }));
	}

	private authHandoff(id: string, visible: boolean, signal: AbortSignal): void {
		const { window } = this.require(id);
		if (signal.aborted) throw signal.reason;
		if (visible) {
			window.show();
			window.focus();
		} else window.hide();
	}

	private async upload(
		id: string,
		selector: string,
		paths: string[],
		signal: AbortSignal,
	): Promise<void> {
		const { window } = this.require(id);
		if (signal.aborted) throw signal.reason;
		if (!window.webContents.debugger.isAttached())
			window.webContents.debugger.attach("1.3");
		const document = (await window.webContents.debugger.sendCommand(
			"DOM.getDocument",
			{ depth: 0 },
		)) as { root: { nodeId: number } };
		const selected = (await window.webContents.debugger.sendCommand(
			"DOM.querySelector",
			{ nodeId: document.root.nodeId, selector },
		)) as { nodeId: number };
		if (!selected.nodeId)
			throw new Error("Browser upload target was not found.");
		await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", {
			nodeId: selected.nodeId,
			files: paths,
		});
	}

	private downloads(id: string, signal: AbortSignal): BrowserDownload[] {
		const record = this.require(id);
		if (signal.aborted) throw signal.reason;
		return record.downloads.map((download) => ({ ...download }));
	}

	private async desktopScreenshot(
		signal: AbortSignal,
	): Promise<ScreenshotFrame> {
		this.lastDesktopCapture = undefined;
		this.assertComputerUseEnabled();
		if (signal.aborted) throw signal.reason;
		if (process.platform !== "darwin")
			throw new Error(
				"Whole-desktop computer use is available only on macOS.",
			);
		if (systemPreferences.getMediaAccessStatus("screen") !== "granted")
			throw new Error(
				"macOS Screen Recording permission is required for whole-desktop capture.",
			);
		let foreground: DesktopForegroundProcess;
		try {
			foreground = await readFrontmostProcess(signal);
		} catch (error) {
			throw new Error(
				`Could not record the frontmost desktop app before capture: ${error instanceof Error ? error.message : "unknown error"}`,
			);
		}
		const primary = screen.getPrimaryDisplay();
		const bounds = {
			x: primary.bounds.x,
			y: primary.bounds.y,
			width: primary.bounds.width,
			height: primary.bounds.height,
		};
		// A failed or cancelled recapture must never leave an older image
		// authorized for a later desktop action.
		const displays = await desktopCapturer.getSources({
			types: ["screen"],
			thumbnailSize: { width: bounds.width, height: bounds.height },
			fetchWindowIcons: false,
		});
		if (signal.aborted) throw signal.reason;
		const foregroundAfter = await readFrontmostProcess(signal);
		if (
			foregroundAfter.pid !== foreground.pid ||
			foregroundAfter.bundleId !== foreground.bundleId
		)
			throw new Error("The frontmost desktop app changed during capture. Try again.");
		const source = displays.find(
			(candidate) => candidate.display_id === String(primary.id),
		);
		if (!source)
			throw new Error("The primary desktop display is unavailable for capture.");
		const image = source.thumbnail;
		const normalizedImage =
			image.getSize().width === bounds.width &&
			image.getSize().height === bounds.height
				? image
				: image.resize({ width: bounds.width, height: bounds.height });
		const { width, height } = normalizedImage.getSize();
		const bgra = normalizedImage.toBitmap();
		const rgba = new Uint8Array(bgra.byteLength);
		for (let offset = 0; offset < bgra.length; offset += 4) {
			rgba[offset] = bgra[offset + 2]!;
			rgba[offset + 1] = bgra[offset + 1]!;
			rgba[offset + 2] = bgra[offset]!;
			rgba[offset + 3] = bgra[offset + 3]!;
		}
		const desktop = {
			captureId: randomUUID(),
			displayId: String(primary.id),
			bounds,
			capturedAt: new Date().toISOString(),
		};
		this.lastDesktopCapture = { metadata: desktop, foreground };
		return { width, height, rgba, png: normalizedImage.toPNG(), desktop };
	}

	private async desktopAct(
		action: DesktopAction,
		signal: AbortSignal,
	): Promise<void> {
		this.assertComputerUseEnabled();
		if (signal.aborted) throw signal.reason;
		if (process.platform !== "darwin")
			throw new Error(
				"Whole-desktop computer use is available only on macOS.",
			);
		if (!systemPreferences.isTrustedAccessibilityClient(false))
			throw new Error(
				"macOS Accessibility permission is required for whole-desktop control.",
			);
		if (systemPreferences.getMediaAccessStatus("screen") !== "granted")
			throw new Error(
				"macOS Screen Recording permission is required for whole-desktop capture.",
			);
		const capture = this.lastDesktopCapture;
		if (!capture)
			throw new Error("Take a fresh desktop screenshot before acting.");
		if (action.captureId !== capture.metadata.captureId)
			throw new Error("Desktop action does not match the latest screenshot.");
		// Consume only after provenance matches. A stale or unrelated task must
		// not burn the current task's one-action authorization.
		this.lastDesktopCapture = undefined;
		if (!isDesktopCaptureFresh(capture.metadata.capturedAt))
			throw new Error("The desktop screenshot is stale. Take a fresh screenshot.");
		const primary = screen.getPrimaryDisplay();
		if (
			String(primary.id) !== capture.metadata.displayId ||
			primary.bounds.x !== capture.metadata.bounds.x ||
			primary.bounds.y !== capture.metadata.bounds.y ||
			primary.bounds.width !== capture.metadata.bounds.width ||
			primary.bounds.height !== capture.metadata.bounds.height
		)
			throw new Error("The primary desktop display changed. Take a fresh screenshot.");
		const keyCodes: Record<string, number> = {
			Enter: 36,
			Escape: 53,
			Tab: 48,
			Backspace: 51,
			ArrowUp: 126,
			ArrowDown: 125,
			ArrowLeft: 123,
			ArrowRight: 124,
			Space: 49,
			Delete: 117,
			Home: 115,
			End: 119,
			PageUp: 116,
			PageDown: 121,
		};
		const inputScript =
			action.type === "click"
				? (() => {
					const point = mapDesktopScreenshotPoint(
						action.x,
						action.y,
						capture.metadata.bounds,
					);
					return `tell application "System Events" to click at {${point.x}, ${point.y}}`;
				})()
				: action.type === "type"
					? 'tell application "System Events" to keystroke (system attribute "KESTREL_COMPUTER_TEXT")'
					: buildDesktopKeyScript(
						keyCodes[action.key as string] ?? (action.key as string),
						action.modifiers,
					);
		await restoreFrontmostProcess(capture.foreground, signal);
		signal.throwIfAborted();
		this.assertComputerUseEnabled();
		if (!systemPreferences.isTrustedAccessibilityClient(false) ||
			systemPreferences.getMediaAccessStatus("screen") !== "granted")
			throw new Error("Desktop permissions changed before input. Check Screen Recording and Accessibility.");
		const script = `tell application "System Events"\nset activeProcess to first application process whose frontmost is true\nif unix id of activeProcess is not ${capture.foreground.pid} then error "The desktop app changed before input."\nif bundle identifier of activeProcess is not ${JSON.stringify(capture.foreground.bundleId)} then error "The desktop app changed before input."\nend tell\n${inputScript}`;
		await new Promise<void>((resolvePromise, reject) => {
			let settled = false;
			const cleanup = () => {
				signal.removeEventListener("abort", abort);
				child.removeListener("exit", onExit);
			};
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolvePromise();
			};
			const abort = () => {
				child.kill("SIGTERM");
				finish(signal.reason instanceof Error ? signal.reason : new Error("Desktop action cancelled."));
			};
			const onExit = () => cleanup();
			const child = execFile(
				"/usr/bin/osascript",
				["-e", script],
				{
					timeout: 30_000,
					env: {
						PATH: "/usr/bin:/bin",
						...(action.type === "type"
							? { KESTREL_COMPUTER_TEXT: action.text }
							: {}),
					},
				},
				(error) => finish(signal.aborted ? abortError(signal) : error ?? undefined),
			);
			signal.addEventListener("abort", abort, { once: true });
			child.once("exit", onExit);
			if (signal.aborted) abort();
		});
	}

	private assertComputerUseEnabled(): void {
		if (!this.computerUseEnabled)
			throw new Error(
				"Whole-desktop computer use is disabled. Enable it in Settings → Agent → Permissions & sandbox.",
			);
	}

	private async close(id: string): Promise<void> {
		const record = this.sessions.get(id);
		if (!record) return;
		this.sessions.delete(id);
		this.elementRefs.delete(id);
		if (record.window.webContents.debugger.isAttached())
			record.window.webContents.debugger.detach();
		if (!record.window.isDestroyed()) record.window.destroy();
		await record.partition.clearStorageData();
		await record.partition.clearCache();
	}
}
