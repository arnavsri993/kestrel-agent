import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// This relay is intentionally an ephemeral no-credential bootstrap. It proves
// that the native Chromium renderer is talking to Kestrel's real standalone
// Node Core without opening the Electron profile or consulting Keychain.
const ephemeralRoot = await mkdtemp(join(resolve(profileRoot), "native-core-"));
const coreEntry = join(resourceRoot, "agent-core", "service", "index.js");
const core = fork(coreEntry, [], {
	execPath: process.execPath,
	execArgv: [],
	env: {
		HOME: ephemeralRoot,
		LANG: process.env.LANG ?? "en_US.UTF-8",
		PATH: process.env.PATH ?? "",
		TMPDIR: process.env.TMPDIR ?? tmpdir(),
		KESTREL_DATA_DIR: ephemeralRoot,
		KESTREL_NATIVE_EPHEMERAL_PROFILE: "1",
	},
	serialization: "json",
	stdio: ["ignore", "ignore", "inherit", "ipc"],
});

let coreReady = false;
let stopping = false;
let nextRequest = 0;
const pending = new Map();
/** @type {Map<string, "core" | "smoke">} */
const pendingBrowserBackend = new Map();
/** @type {string | undefined} */
let smokeIsolatedSessionId;

function write(message) {
	process.stdout.write(JSON.stringify(message) + "\n");
}

function failPending(error) {
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
		let origin = "https://example.com";
		try {
			if (smokeIsolatedAutomationUrl) {
				origin = new URL(smokeIsolatedAutomationUrl).origin;
			}
		} catch {
			origin = "https://example.com";
		}
		forwardBrowserBackendRequest(
			"smoke-isolated-create",
			{ operation: "create", allowedOrigins: [origin] },
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
	await rm(ephemeralRoot, { recursive: true, force: true });
	process.exit(exitCode);
}

core.on("message", (message) => {
	if (!message || typeof message !== "object" || Array.isArray(message)) return;
	if (message.type === "ready") {
		coreReady = true;
		write({ type: "ready" });
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
		databasePath: join(ephemeralRoot, "database", "kestrel.sqlite"),
		encryptionKeyBase64: randomBytes(32).toString("base64"),
		workspaceRoots: [],
		configuredWorkspaceRoots: [],
		projects: [],
		pluginRoots: [],
		managedPluginRoots: [],
		learnedSkillRoot: join(ephemeralRoot, "learned-skills"),
		secureEnvironment: {},
		providerAccounts: [],
	},
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
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
				"smoke-isolated-close",
				{ operation: "close", sessionId: smokeIsolatedSessionId },
				"smoke",
			);
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
