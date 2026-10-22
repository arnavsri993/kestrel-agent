import { fork } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openNativeCoreProfile } from "./native-core-profile.mjs";

const resourceRoot = dirname(fileURLToPath(import.meta.url));
const profileArgument = process.argv.indexOf("--profile-root");
const profileRoot =
	profileArgument === -1 ? undefined : process.argv[profileArgument + 1];
if (!profileRoot) {
	process.stderr.write("Kestrel native Core relay requires an explicit isolated profile root.\n");
	process.exit(1);
}

const smokeBrowserBackend = process.env.KESTREL_SMOKE_BROWSER_BACKEND === "1";
const smokeIsolatedAutomation =
	process.env.KESTREL_SMOKE_ISOLATED_AUTOMATION === "1";
const smokeBrowserBackendUrl =
	typeof process.env.KESTREL_SMOKE_BROWSER_BACKEND_URL === "string"
		? process.env.KESTREL_SMOKE_BROWSER_BACKEND_URL
		: "";
const smokeIsolatedAutomationUrl =
	typeof process.env.KESTREL_SMOKE_ISOLATED_AUTOMATION_URL === "string"
		? process.env.KESTREL_SMOKE_ISOLATED_AUTOMATION_URL
		: smokeBrowserBackendUrl;
const smokeUploadPath =
	typeof process.env.KESTREL_SMOKE_UPLOAD_PATH === "string"
		? process.env.KESTREL_SMOKE_UPLOAD_PATH
		: "";

// Durable mode retains only the explicitly selected native profile. No
// Electron database, Keychain item or provider-owned login is imported.
const durableProfile = process.argv.includes("--durable-profile");
const coreProfile = await openNativeCoreProfile(resolve(profileRoot), { durable: durableProfile });
const stateRoot = coreProfile.root;
const coreEntry = join(resourceRoot, "agent-core", "service", "index.js");
const core = fork(coreEntry, [], {
	execPath: process.execPath,
	execArgv: [],
	env: {
		HOME: stateRoot,
		LANG: process.env.LANG ?? "en_US.UTF-8",
		PATH: process.env.PATH ?? "",
		TMPDIR: process.env.TMPDIR ?? tmpdir(),
		KESTREL_DATA_DIR: stateRoot,
		...(!durableProfile ? { KESTREL_NATIVE_EPHEMERAL_PROFILE: "1" } : {}),
	},
	serialization: "json",
	stdio: ["ignore", "ignore", "inherit", "ipc"],
});

let coreReady = false;
let stopping = false;
let outputClosed = false;
let nextRequest = 0;
const pending = new Map();
const extensionRequests = new Map();
let nextExtensionRequest = 0;
const liveExtensions = process.env.KESTREL_NATIVE_LIVE_EXTENSIONS === "1";
const extensionRequestTypes = new Set([
	"browser-list-extensions", "browser-inspect-extension-url",
	"browser-install-extension-url", "browser-toggle-extension",
	"browser-reload-extension", "browser-uninstall-extension",
]);
let extensionService;
let extensionServicePromise;

function requestExtensionRuntime(operation, fields) {
	if (stopping || extensionRequests.size >= 32)
		return Promise.reject(new Error("Native extension runtime is unavailable."));
	return new Promise((resolveRequest, rejectRequest) => {
		const requestId = "native-extension-" + ++nextExtensionRequest;
		const timeout = setTimeout(() => {
			extensionRequests.delete(requestId);
			rejectRequest(new Error("Native extension runtime timed out."));
		}, 30_000);
		extensionRequests.set(requestId, { resolveRequest, rejectRequest, timeout });
		write({ type: "extension-runtime-request", requestId, request: { operation, ...fields } });
	});
}

function getExtensionService() {
	extensionServicePromise ??= (async () => {
		const { createNativeExtensionService, createNativeExtensionHostPort } =
			await import("./native-extension-service.mjs");
		extensionService = createNativeExtensionService({
			profileRoot: resolve(profileRoot),
			chromiumVersion: process.env.KESTREL_NATIVE_CHROMIUM_VERSION,
			host: createNativeExtensionHostPort({
				profileRoot: resolve(profileRoot), request: requestExtensionRuntime,
			}),
		});
		const restored = await extensionService.initialize();
		write({ type: "extension-runtime-status", ok: restored.ok });
		return extensionService;
	})();
	return extensionServicePromise;
}
/** @type {Map<string, "core" | "smoke">} */
const pendingBrowserBackend = new Map();
/** @type {string | undefined} */
let smokeIsolatedSessionId;
let smokeSecondIsolatedSessionId;
/** @type {string | undefined} */
let smokeVisibleTabId;

function write(message) {
	if (outputClosed) return;
	process.stdout.write(JSON.stringify(message) + "\n");
}

process.stdout.on("error", (error) => {
	// The native window can close its pipe while a Core response is queued.
	// Stop the owned Core instead of crashing the relay with an unhandled EPIPE.
	outputClosed = true;
	void shutdown(error.code === "EPIPE" ? 0 : 1);
});

function failPending(error) {
	for (const request of extensionRequests.values()) {
		clearTimeout(request.timeout);
		request.rejectRequest(new Error(error));
	}
	extensionRequests.clear();
	for (const id of pending.values()) {
		write({ type: "response", id, response: { ok: false, error } });
	}
	pending.clear();
	for (const [requestId, destination] of pendingBrowserBackend) {
		if (destination === "core" && core.connected) {
			core.send({
				type: "browser-backend-response",
				requestId,
				ok: false,
				error,
			});
		}
	}
	pendingBrowserBackend.clear();
}

function forwardBrowserBackendRequest(requestId, request, destination) {
	pendingBrowserBackend.set(requestId, destination);
	write({
		type: "browser-backend-request",
		requestId,
		request,
	});
}

function beginSmokeBrowserBackend() {
	if (smokeIsolatedAutomation) {
		forwardBrowserBackendRequest(
			"smoke-isolated-user-seed",
			{ operation: "visible-create", input: smokeIsolatedAutomationUrl + "?storage-role=user" },
			"smoke",
		);
		return;
	}
	if (!smokeBrowserBackend) return;
	const createId = "smoke-browser-backend-create";
	forwardBrowserBackendRequest(
		createId,
		{
			operation: "visible-create",
			...(smokeBrowserBackendUrl ? { input: smokeBrowserBackendUrl } : {}),
		},
		"smoke",
	);
}

async function shutdown(exitCode = 0) {
	if (stopping) return;
	stopping = true;
	failPending("Kestrel native Core relay stopped.");
	try {
		if (core.connected) core.send({ type: "shutdown" });
	} catch {
		// The process is torn down below if IPC has already closed.
	}
	const exited = new Promise((resolveExit) => {
		core.once("exit", resolveExit);
		setTimeout(resolveExit, 2_000).unref();
	});
	await exited;
	if (core.exitCode === null) core.kill();
	await coreProfile.close();
	process.exit(exitCode);
}

core.on("message", (message) => {
	if (!message || typeof message !== "object" || Array.isArray(message)) return;
	if (message.type === "ready") {
		coreReady = true;
		write({ type: "ready" });
		if (liveExtensions) void getExtensionService().catch(() => {
			write({ type: "extension-runtime-status", ok: false });
		});
		beginSmokeBrowserBackend();
		return;
	}
	if (message.type === "start-error") {
		write({
			type: "start-error",
			error:
				typeof message.error === "string"
					? message.error
					: "Kestrel Core could not start.",
		});
		void shutdown(1);
		return;
	}
	if (message.type === "browser-backend-request" && message.requestId) {
		// Forward to the native CEF host. The host owns visible tabs and answers
		// through stdin; unsupported operations fail at the host, not here.
		forwardBrowserBackendRequest(
			message.requestId,
			message.request,
			"core",
		);
		return;
	}
	if (message.type === "runtime-event" || message.type === "agent-stream") {
		write({ type: "event", channel: message.type, event: message.event });
		return;
	}
	if (typeof message.requestId === "string" && "response" in message) {
		const id = pending.get(message.requestId);
		if (!id) return;
		pending.delete(message.requestId);
		write({ type: "response", id, response: message.response });
	}
});

core.once("exit", (code) => {
	if (stopping) return;
	const error =
		"Kestrel native Core exited unexpectedly" +
		(code === null ? "." : " (" + code + ").");
	write({ type: "core-exit", error });
	failPending(error);
	void shutdown(1);
});

core.send({
	type: "bootstrap",
	config: {
		databasePath: coreProfile.databasePath,
		encryptionKeyBase64: coreProfile.encryptionKeyBase64,
		workspaceRoots: [],
		configuredWorkspaceRoots: [],
		projects: [],
		pluginRoots: [],
		managedPluginRoots: [],
		learnedSkillRoot: join(stateRoot, "learned-skills"),
		secureEnvironment: {},
		providerAccounts: [],
	},
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.once("close", () => void shutdown(0));
lines.on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		write({ type: "protocol-error", error: "Kestrel native relay received invalid JSON." });
		return;
	}
	if (message?.type === "shutdown") {
		void shutdown(0);
		return;
	}
	if (message?.type === "extension-runtime-response" &&
		typeof message.requestId === "string") {
		const pendingExtension = extensionRequests.get(message.requestId);
		if (!pendingExtension) return;
		extensionRequests.delete(message.requestId);
		clearTimeout(pendingExtension.timeout);
		if (message.ok === true) pendingExtension.resolveRequest(message.result);
		else pendingExtension.rejectRequest(new Error("Native extension operation failed."));
		return;
	}
	if (
		message?.type === "browser-backend-response" &&
		typeof message.requestId === "string"
	) {
		const destination = pendingBrowserBackend.get(message.requestId);
		pendingBrowserBackend.delete(message.requestId);
		if (!destination) return;
		if (destination === "core") {
			if (!core.connected) return;
			core.send({
				type: "browser-backend-response",
				requestId: message.requestId,
				ok: message.ok === true,
				...(message.ok === true
					? { result: message.result }
					: {
							error:
								typeof message.error === "string"
									? message.error
									: "Native Chromium browser backend failed.",
						}),
			});
			return;
		}
		if (message.ok !== true) {
			write({
				type: "smoke-event",
				name: smokeIsolatedAutomation
					? "isolated-automation-failed"
					: "browser-backend-failed",
				error:
					typeof message.error === "string"
						? message.error
						: "Native Chromium browser backend smoke failed.",
			});
			return;
		}
		if (message.requestId === "smoke-browser-backend-create") {
			smokeVisibleTabId =
				message.result &&
				typeof message.result === "object" &&
				typeof message.result.tabId === "string"
					? message.result.tabId
					: undefined;
			if (!smokeVisibleTabId) {
				write({
					type: "smoke-event",
					name: "browser-backend-failed",
					error: "Visible create did not return a tab id.",
				});
				return;
			}
			forwardBrowserBackendRequest(
				"smoke-browser-backend-context",
				{ operation: "visible-context", tabId: smokeVisibleTabId },
				"smoke",
			);
			return;
		}
		if (message.requestId === "smoke-browser-backend-context") {
			const context = message.result;
			const checks = {
				trust: context?.trust === "untrusted_browser",
				tab: context?.tabId === smokeVisibleTabId,
				headings: Array.isArray(context?.headings) && context.headings.includes("Native page context"),
				text: context?.visibleText?.includes("Readable fixture content"),
				forms: Array.isArray(context?.forms) && context.forms.some((field) => field.type === "sensitive"),
				redaction: !JSON.stringify(context ?? null).includes("fixture-sensitive-value"),
			};
			const failed = Object.keys(checks).filter((key) => !checks[key]);
			if (failed.length) {
				write({ type: "smoke-event", name: "browser-backend-failed", error: "Visible context failed checks: " + failed.join(", ") });
				return;
			}
			forwardBrowserBackendRequest("smoke-browser-backend-snapshot",
				{ operation: "visible-snapshot", tabId: smokeVisibleTabId }, "smoke");
			return;
		}
		if (message.requestId === "smoke-browser-backend-snapshot") {
			const snapshot =
				message.result && typeof message.result === "object"
					? message.result
					: {};
			if (snapshot.trust !== "untrusted_browser" || JSON.stringify(snapshot).includes("fixture-sensitive-value")) {
				write({
					type: "smoke-event",
					name: "browser-backend-failed",
					error: "Visible snapshot trust was invalid.",
				});
				return;
			}
			const interactive = Array.isArray(snapshot.interactive)
				? snapshot.interactive
				: [];
			const button = interactive.find(
				(item) =>
					item &&
					typeof item === "object" &&
					item.role === "button" &&
					typeof item.ref === "string",
			);
			if (!button || !smokeVisibleTabId) {
				write({
					type: "smoke-event",
					name: "browser-backend-failed",
					error: "Visible snapshot had no button ref to act on.",
				});
				return;
			}
			forwardBrowserBackendRequest(
				"smoke-browser-backend-act",
				{
					operation: "visible-act",
					tabId: smokeVisibleTabId,
					action: { type: "click", target: button.ref },
				},
				"smoke",
			);
			return;
		}
		if (message.requestId === "smoke-browser-backend-act") {
			if (
				!message.result ||
				typeof message.result !== "object" ||
				message.result.performed !== true ||
				!smokeVisibleTabId
			) {
				write({
					type: "smoke-event",
					name: "browser-backend-failed",
					error: "Visible act did not report performed=true.",
				});
				return;
			}
			forwardBrowserBackendRequest(
				"smoke-browser-backend-screenshot",
				{ operation: "visible-screenshot", tabId: smokeVisibleTabId },
				"smoke",
			);
			return;
		}
		if (message.requestId === "smoke-browser-backend-screenshot") {
			const frame =
				message.result && typeof message.result === "object"
					? message.result
					: {};
			const width = Number(frame.width);
			const height = Number(frame.height);
			const pngTag =
				frame.png && typeof frame.png === "object"
					? frame.png.__kestrel_binary_base64__
					: undefined;
			if (
				!Number.isInteger(width) ||
				!Number.isInteger(height) ||
				width < 1 ||
				height < 1 ||
				frame.trust !== "untrusted_browser" ||
				typeof pngTag !== "string" ||
				!pngTag.startsWith("iVBOR")
			) {
				write({
					type: "smoke-event",
					name: "browser-backend-failed",
					error: "Visible screenshot frame was invalid.",
				});
				return;
			}
			forwardBrowserBackendRequest(
				"smoke-browser-backend-tabs",
				{ operation: "visible-tabs" },
				"smoke",
			);
			return;
		}
		if (message.requestId === "smoke-browser-backend-tabs") {
			const tabs = Array.isArray(message.result) ? message.result : [];
			write({
				type: "smoke-event",
				name: "browser-backend-ok",
				tabCount: tabs.length,
			});
			return;
		}
		if (message.requestId === "smoke-isolated-create") {
			smokeIsolatedSessionId =
				typeof message.result === "string" ? message.result : undefined;
			if (!smokeIsolatedSessionId || !smokeIsolatedAutomationUrl) {
				write({
					type: "smoke-event",
					name: "isolated-automation-failed",
					error: "Isolated automation create did not return a session id.",
				});
				return;
			}
			forwardBrowserBackendRequest(
				"smoke-isolated-navigate",
				{
					operation: "navigate",
					sessionId: smokeIsolatedSessionId,
					url: smokeIsolatedAutomationUrl,
				},
				"smoke",
			);
			return;
		}
		if (message.requestId === "smoke-isolated-user-seed") {
			forwardBrowserBackendRequest("smoke-isolated-user-ready",
				{ operation: "visible-context", tabId: message.result?.tabId }, "smoke");
			return;
		}
		if (message.requestId === "smoke-isolated-user-ready") {
			forwardBrowserBackendRequest("smoke-isolated-create",
				{ operation: "create", allowedOrigins: [new URL(smokeIsolatedAutomationUrl).origin] }, "smoke");
			return;
		}
		if (message.requestId === "smoke-isolated-navigate") {
			if (!smokeIsolatedSessionId) {
				write({
					type: "smoke-event",
					name: "isolated-automation-failed",
					error: "Isolated automation session id was lost before viewport.",
				});
				return;
			}
			forwardBrowserBackendRequest(
				"smoke-isolated-viewport",
				{
					operation: "viewport",
					sessionId: smokeIsolatedSessionId,
					viewport: {
						name: "smoke",
						width: 800,
						height: 600,
						deviceScaleFactor: 1,
					},
				},
				"smoke",
			);
			return;
		}
		if (message.requestId === "smoke-isolated-viewport") {
			if (!smokeIsolatedSessionId) {
				write({
					type: "smoke-event",
					name: "isolated-automation-failed",
					error: "Isolated automation session id was lost before upload.",
				});
				return;
			}
			if (!smokeUploadPath) {
				write({
					type: "smoke-event",
					name: "isolated-automation-failed",
					error: "Isolated automation upload path was not configured.",
				});
				return;
			}
			forwardBrowserBackendRequest(
				"smoke-isolated-upload",
				{
					operation: "upload",
					sessionId: smokeIsolatedSessionId,
					selector: "#smoke-upload",
					paths: [smokeUploadPath],
				},
				"smoke",
			);
			return;
		}
		if (message.requestId === "smoke-isolated-upload") {
			if (!smokeIsolatedSessionId) {
				write({
					type: "smoke-event",
					name: "isolated-automation-failed",
					error: "Isolated automation session id was lost before snapshot.",
				});
				return;
			}
			forwardBrowserBackendRequest(
				"smoke-isolated-snapshot",
				{ operation: "snapshot", sessionId: smokeIsolatedSessionId },
				"smoke",
			);
			return;
		}
		if (message.requestId === "smoke-isolated-snapshot") {
			const snapshot =
				message.result && typeof message.result === "object"
					? message.result
					: {};
			if (typeof snapshot.url !== "string" || !snapshot.url) {
				write({
					type: "smoke-event",
					name: "isolated-automation-failed",
					error: "Isolated automation snapshot was missing a URL.",
				});
				return;
			}
			const interactive = Array.isArray(snapshot.interactive)
				? snapshot.interactive
				: [];
			const button = interactive.find(
				(item) =>
					item &&
					typeof item === "object" &&
					item.role === "button" &&
					typeof item.ref === "string",
			);
			if (!button) {
				write({
					type: "smoke-event",
					name: "isolated-automation-failed",
					error: "Isolated automation snapshot had no button ref to act on.",
				});
				return;
			}
			forwardBrowserBackendRequest(
				"smoke-isolated-act",
				{
					operation: "act",
					sessionId: smokeIsolatedSessionId,
					action: { type: "click", target: button.ref },
				},
				"smoke",
			);
			return;
		}
		if (message.requestId === "smoke-isolated-act") {
			if (!smokeIsolatedSessionId) {
				write({
					type: "smoke-event",
					name: "isolated-automation-failed",
					error: "Isolated automation session id was lost before screenshot.",
				});
				return;
			}
			forwardBrowserBackendRequest(
				"smoke-isolated-screenshot",
				{ operation: "screenshot", sessionId: smokeIsolatedSessionId },
				"smoke",
			);
			return;
		}
		if (message.requestId === "smoke-isolated-screenshot") {
			const frame =
				message.result && typeof message.result === "object"
					? message.result
					: {};
			const width = Number(frame.width);
			const height = Number(frame.height);
			const pngTag =
				frame.png && typeof frame.png === "object"
					? frame.png.__kestrel_binary_base64__
					: undefined;
			const rgbaTag =
				frame.rgba && typeof frame.rgba === "object"
					? frame.rgba.__kestrel_binary_base64__
					: undefined;
			if (
				!Number.isInteger(width) ||
				!Number.isInteger(height) ||
				width !== 800 ||
				height !== 600 ||
				typeof pngTag !== "string" ||
				!pngTag.startsWith("iVBOR") ||
				typeof rgbaTag !== "string" ||
				rgbaTag.length < 8
			) {
				write({
					type: "smoke-event",
					name: "isolated-automation-failed",
					error:
						"Isolated automation screenshot frame was invalid or did not match the 800x600 viewport.",
				});
				return;
			}
			if (!smokeIsolatedSessionId) {
				write({
					type: "smoke-event",
					name: "isolated-automation-failed",
					error: "Isolated automation session id was lost before close.",
				});
				return;
			}
			forwardBrowserBackendRequest(
				"smoke-isolated-second-create",
				{ operation: "create", allowedOrigins: [new URL(smokeIsolatedAutomationUrl).origin] },
				"smoke",
			);
			return;
		}
		if (message.requestId === "smoke-isolated-second-create") {
			smokeSecondIsolatedSessionId = message.result;
			forwardBrowserBackendRequest("smoke-isolated-second-navigate", {
				operation: "navigate", sessionId: smokeSecondIsolatedSessionId,
				url: smokeIsolatedAutomationUrl + "?storage-role=second",
			}, "smoke");
			return;
		}
		if (message.requestId === "smoke-isolated-second-navigate") {
			forwardBrowserBackendRequest("smoke-isolated-second-close",
				{ operation: "close", sessionId: smokeSecondIsolatedSessionId }, "smoke");
			return;
		}
		if (message.requestId === "smoke-isolated-second-close") {
			forwardBrowserBackendRequest("smoke-isolated-close",
				{ operation: "close", sessionId: smokeIsolatedSessionId }, "smoke");
			return;
		}
		if (message.requestId === "smoke-isolated-close") {
			write({ type: "smoke-event", name: "isolated-automation-ok" });
			return;
		}
		write({
			type: "smoke-event",
			name: "browser-backend-failed",
			error: "Unexpected native browser backend smoke step.",
		});
		return;
	}
	if (
		message?.type !== "request" ||
		typeof message.id !== "string" ||
		!message.request ||
		typeof message.request !== "object" ||
		Array.isArray(message.request)
	) {
		write({ type: "protocol-error", error: "Kestrel native relay request was invalid." });
		return;
	}
	if (!coreReady || stopping) {
		write({
			type: "response",
			id: message.id,
			response: { ok: false, error: "Kestrel native Core is not ready." },
		});
		return;
	}
	if (liveExtensions && extensionRequestTypes.has(message.request.type)) {
		void getExtensionService()
			.then((service) => service.handle(message.request))
			.then((response) => write({ type: "response", id: message.id, response }))
			.catch(() => write({ type: "response", id: message.id,
				response: { ok: false, error: "Kestrel could not complete this extension operation." } }));
		return;
	}
	const requestId = "native-relay-" + ++nextRequest;
	pending.set(requestId, message.id);
	try {
		core.send({ type: "request", requestId, request: message.request });
	} catch {
		pending.delete(requestId);
		write({
			type: "response",
			id: message.id,
			response: { ok: false, error: "Kestrel native Core could not receive the request." },
		});
	}
});

process.once("SIGTERM", () => void shutdown(0));
process.once("SIGINT", () => void shutdown(0));
