import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openNativeCoreProfile } from "./native-core-profile.mjs";
import { CoreSupervisor, nodeCoreProcess, CoreRequestSchema, RendererRequestSchema, OLLAMA_REMOTE_MODEL_ERROR, nativeSystemReadiness, NATIVE_READINESS_REQUEST_TYPES, NativeComputerUseManager, NativeProviderHost, NATIVE_WORKSPACE_REQUEST_TYPES, NativeWorkspaceHost, NATIVE_PROVIDER_REQUEST_TYPES, NativePluginHost, NATIVE_PLUGIN_REQUEST_TYPES, NativeContextAttachmentHost, NATIVE_CONTEXT_ATTACHMENT_REQUEST_TYPES, NativeMemoryRecoveryHost, NATIVE_MEMORY_RECOVERY_REQUEST_TYPES, isNativeMemoryRecoveryInternalRequest } from "./agent-core/service/native-desktop-runtime.mjs";
import { createNativeCoreConfiguration } from "./native-core-configuration.mjs";
import { dispatchNativeComputerHostRequest } from "./native-computer-host-routing.mjs";

const resources = dirname(fileURLToPath(import.meta.url));
const index = process.argv.indexOf("--profile-root");
if (index < 0 || !process.argv[index + 1]) throw new Error("Native Core requires its owning browser profile.");
const durable = process.argv.includes("--durable-profile");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function requestProtectedProfileKey() {
	if (!durable) return undefined;
	const requestId = "native-core-profile-key-v1";
	return new Promise((resolveKey, rejectKey) => {
		const finish = (error, value) => {
			clearTimeout(timer);
			input.off("line", onLine);
			input.off("close", onClose);
			if (error) rejectKey(error); else resolveKey(value);
		};
		const onClose = () => finish(new Error("Trusted host disconnected before providing the native profile key."));
		const onLine = line => {
			if (Buffer.byteLength(line, "utf8") > 1024 * 1024) return finish(new Error("Trusted host key response exceeded its limit."));
			let message;
			try { message = JSON.parse(line); } catch { return finish(new Error("Trusted host key response was invalid.")); }
			if (message?.kind !== "native-core-profile-key-response" || message.requestId !== requestId || message.ok !== true || typeof message.keyBase64 !== "string")
				return finish(new Error("Trusted host could not unlock the native profile key."));
			finish(undefined, message.keyBase64);
		};
		// Keychain authorization can require a human security prompt. Keep the
		// private request alive long enough for that prompt while bounding hangs.
		const timer = setTimeout(() => finish(new Error("Trusted host did not provide the native profile key.")), 5 * 60_000);
		input.on("line", onLine);
		input.once("close", onClose);
		process.stdout.write(JSON.stringify({ kind: "native-core-profile-key-request", requestId }) + "\n");
	});
}
const protectedKeyBase64 = await requestProtectedProfileKey();
const profile = await openNativeCoreProfile(resolve(process.argv[index + 1]), {
	durable,
	protectedKeyBase64,
});
const MAX_FRAME = 1024 * 1024;
const pendingBrowser = new Map();
const pendingNativeComputer = new Map();
const pending = new Set();
const hostRequests = new Map();
const activeCoreRequests = new Set();
let backgroundJobsRunning = false;
let sequence = 0;
let stopping = false;
let outputClosed = false;
let browserReset;
let folderDialog;
let dialogSequence = 0;

function write(message) {
	if (outputClosed) return;
	let line = JSON.stringify(message);
	if (Buffer.byteLength(line) > MAX_FRAME) {
		if (message.type !== "response") return;
		line = JSON.stringify({ type: "response", id: message.id, response: { ok: false, error: "The Core response exceeds the native transport limit." } });
	}
	if (process.stdout.writableLength + Buffer.byteLength(line) > 2 * MAX_FRAME) { void shutdown(1); return; }
	process.stdout.write(line + "\n");
}

function nativeComputerHostRequest(request, signal) {
	if (stopping || pendingNativeComputer.size >= 4 || signal.aborted) return Promise.reject(new Error("The native desktop request is unavailable."));
	if (pendingNativeComputer.size >= 4) return Promise.reject(new Error("Native desktop access is busy."));
	const requestId = `native-computer-${++sequence}`;
	return new Promise((resolveRequest, rejectRequest) => {
		const fail = (error) => {
			if (!pendingNativeComputer.delete(requestId)) return;
			clearTimeout(timer); signal.removeEventListener("abort", abort);
			write({ type: "native-computer-cancel", requestId });
			rejectRequest(error);
		};
		const abort = () => fail(new Error("The native desktop request was interrupted. Check its outcome before retrying."));
		const timer = setTimeout(() => fail(new Error("The native desktop request timed out. Check its outcome before retrying.")), 30_000);
		pendingNativeComputer.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer, signal, abort });
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) { abort(); return; }
		write({ type: "native-computer-request", requestId, request });
	});
}

function nativeHostBackendRequest(request, signal) {
	if (stopping || pendingBrowser.size >= 16 || signal.aborted) return Promise.reject(new Error("The native browser connection is unavailable."));
	const requestId = `native-browser-${++sequence}`;
	return new Promise((resolveRequest, rejectRequest) => {
		const fail = error => { if (!pendingBrowser.delete(requestId)) return; clearTimeout(timer); signal.removeEventListener("abort", abort); write({ type: "browser-backend-cancel", requestId }); rejectRequest(error); };
		const abort = () => fail(new Error("The native browser request was interrupted."));
		const timer = setTimeout(() => fail(new Error("The native browser request timed out.")), 30_000);
		pendingBrowser.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer, signal, abort });
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) { abort(); return; }
		write({ type: "browser-backend-request", requestId, request });
	});
}

const computerUse = new NativeComputerUseManager(join(profile.root, "computer-use.json"), {
	permissions: async () => nativeComputerHostRequest({ operation: "native-computer-permissions" }, AbortSignal.timeout(30_000)),
	capture: signal => nativeComputerHostRequest({ operation: "native-computer-capture" }, signal),
	currentIdentity: signal => nativeComputerHostRequest({ operation: "native-computer-context" }, signal),
	act: (action, capture, signal) => nativeComputerHostRequest({
		operation: "native-computer-act", action, captureId: capture.captureId,
		enabled: true, enablementGeneration: capture.enablementGeneration,
		capturedAt: capture.capturedAt, width: capture.width, height: capture.height,
		identity: {
			displayId: capture.displayId, logicalBounds: capture.logicalBounds,
			foregroundProcessId: capture.foregroundProcessId,
			frontmostWindowId: capture.frontmostWindowId,
			frontmostWindowBounds: capture.frontmostWindowBounds,
		},
	}, signal),
	openSettings: surface => nativeComputerHostRequest({ operation: "native-computer-open-settings", surface }, AbortSignal.timeout(30_000)),
});

async function browserRequest(request, signal) {
	if (request?.operation === "desktop-screenshot" || request?.operation === "desktop-act")
		return computerUse.handleBackendRequest(request, signal);
	return nativeHostBackendRequest(request, signal);
}

function cancelBrowsers() {
	computerUse.invalidate();
	for (const [requestId, request] of pendingBrowser) {
		clearTimeout(request.timer); request.signal.removeEventListener("abort", request.abort);
		write({ type: "browser-backend-cancel", requestId });
		request.reject(new Error("Core stopped during the browser request. Check its outcome before retrying."));
	}
	pendingBrowser.clear();
	for (const [requestId, request] of pendingNativeComputer) {
		clearTimeout(request.timer); request.signal.removeEventListener("abort", request.abort);
		write({ type: "native-computer-cancel", requestId });
		request.reject(new Error("The native desktop owner stopped during a request. Check its outcome before retrying."));
	}
	pendingNativeComputer.clear();
}

function resetBrowsers() {
	cancelBrowsers();
	if (stopping || outputClosed) return Promise.resolve();
	if (browserReset) return browserReset.promise;
	const requestId = `native-browser-reset-${++sequence}`;
	let resolveReset, rejectReset;
	const promise = new Promise((resolve, reject) => { resolveReset = resolve; rejectReset = reject; });
	const timer = setTimeout(() => {
		if (browserReset?.requestId !== requestId) return;
		browserReset = undefined;
		rejectReset(new Error("Isolated browser cleanup was not acknowledged. Restart Kestrel before creating another session."));
	}, 11_000);
	browserReset = { requestId, promise, timer, resolve: resolveReset, reject: rejectReset };
	write({ type: "browser-backend-reset", requestId });
	return promise;
}

function cancelFolderDialog() {
	if (!folderDialog) return;
	const dialog = folderDialog; folderDialog = undefined; clearTimeout(dialog.timer);
	dialog.detachAbort?.();
	write({ type: "native-dialog-cancel", requestId: dialog.requestId });
	dialog.resolve(null);
}
function selectNativeDialog(operation, workspaceRoot, signal) {
	if (signal?.aborted) return Promise.reject(signal.reason);
	if (stopping || folderDialog || dialogSequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error("The native file or folder picker is unavailable."));
	const requestId = `native-dialog-${++dialogSequence}`;
	let resolveDialog, rejectDialog;
	const promise = new Promise((resolve, reject) => { resolveDialog = resolve; rejectDialog = reject; });
	const timer = setTimeout(() => {
		if (folderDialog?.requestId !== requestId) return;
		folderDialog = undefined;
		signal?.removeEventListener("abort", abort);
		write({ type: "native-dialog-cancel", requestId });
		rejectDialog(new Error("The native file or folder picker timed out."));
	}, 600_000);
	const abort = () => { if (folderDialog?.requestId === requestId) cancelFolderDialog(); };
	folderDialog = { requestId, timer, operation, resolve: resolveDialog, reject: rejectDialog, detachAbort: () => signal?.removeEventListener("abort", abort) };
	signal?.addEventListener("abort", abort, { once: true });
	write({ type: "native-dialog-request", requestId, operation, ...(operation === "select-context-files" ? { workspaceRoot } : {}) });
	return promise;
}
function selectWorkspaceFolder() { return selectNativeDialog("select-workspace-folder"); }

const core = new CoreSupervisor(browserRequest, resetBrowsers, {
	processFactory: () => nodeCoreProcess({
		executable: process.execPath, entryPath: join(resources, "agent-core/service/index.js"), stdout: "ignore",
		env: { HOME: profile.root, LANG: process.env.LANG ?? "en_US.UTF-8", PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir(),
			KESTREL_DATA_DIR: profile.root, ...(!durable ? { KESTREL_NATIVE_EPHEMERAL_PROFILE: "1" } : {}),
		},
	}),
});
for (const channel of ["runtime-event", "agent-stream", "background-jobs"])
	core.on(channel, event => {
		if (channel === "background-jobs") backgroundJobsRunning = event.jobs.some(job => ["running", "waiting_approval"].includes(job.status));
		write({ type: "event", channel, event });
	});
const publishSnapshot = async () => {
	const response = await core.request({ type: "snapshot" });
	if (response.ok && response.snapshot) write({ type: "event", channel: "snapshot", event: response.snapshot });
};
const providers = new NativeProviderHost({ root: profile.root, encryptionKeyBase64: profile.encryptionKeyBase64,
	homeDirectory: homedir(), environment: process.env, reconfigure: (mutation, rollback, validate, shouldRestoreCore) => configuration.reconfigure(mutation, rollback, validate, shouldRestoreCore),
	onLocalRuntimeProgress: event => write({ type: "event", channel: "local-runtime-progress", event }),
	openAuthUrl: async (url, signal) => {
		await browserRequest({ operation: "visible-create", input: url }, signal);
	},
});
const workspaces = new NativeWorkspaceHost({ root: profile.root, selectFolder: selectWorkspaceFolder,
	reconfigure: mutation => configuration.reconfigure(mutation),
});
const attachments = new NativeContextAttachmentHost({ root: profile.root,
	workspaceRoots: async () => (await workspaces.runtimeConfiguration()).workspaceRoots,
	selectFiles: (workspaceRoot, signal) => selectNativeDialog("select-context-files", workspaceRoot, signal),
});
const memoryRecovery = new NativeMemoryRecoveryHost({
	coreRequest: request => core.request(request),
	selectFile: (operation, signal) => selectNativeDialog(operation === "save" ? "save-memory-recovery-file" : "open-memory-recovery-file", undefined, signal),
});
const plugins = new NativePluginHost({ root: profile.root,
	selectBundle: signal => selectNativeDialog("select-plugin-bundle", undefined, signal),
	selectPublisher: async signal => (await selectNativeDialog("select-plugin-publisher", undefined, signal))?.[0] ?? null,
	reconfigure: (mutation, rollback, validate, shouldRestoreCore) => configuration.reconfigure(mutation, rollback, validate, shouldRestoreCore),
	listPlugins: async () => { const response = await core.request({ type: "plugin-list" }); if (!response.ok) throw new Error("Plugin discovery failed."); return response.plugins ?? []; },
});
const configuration = createNativeCoreConfiguration({ core,
	isBusy: () => activeCoreRequests.size > 0 || backgroundJobsRunning,
	configuration: async () => ({ databasePath: profile.databasePath, encryptionKeyBase64: profile.encryptionKeyBase64,
		...await workspaces.runtimeConfiguration(), ...await plugins.runtimeConfiguration(),
		learnedSkillRoot: join(profile.root, "learned-skills"), ...await providers.runtimeConfiguration(),
	}),
	changed: publishSnapshot,
});
core.on("crash", () => { computerUse.invalidate(); process.stderr.write("KESTREL_NATIVE_CORE_INTERRUPTED\n"); });
core.on("recovery-failed", () => process.stderr.write("KESTREL_NATIVE_CORE_RECOVERY_FAILED\n"));
core.on("recovered", () => {
	process.stderr.write("KESTREL_NATIVE_CORE_RECOVERED\n");
	void publishSnapshot().catch(() => {});
});

async function shutdown(code = 0) {
	if (stopping) return; stopping = true;
	cancelFolderDialog();
	if (browserReset) { clearTimeout(browserReset.timer); browserReset.reject(new Error("The browser owner is shutting down.")); browserReset = undefined; }
	cancelBrowsers();
	await memoryRecovery.close();
	await workspaces.close();
	await plugins.close();
	await providers.close();
	await core.stop();
	// Core may still be reading a just-approved paste when Quit arrives. Stop
	// that owner before removing this launch's temporary attachment files.
	try { await attachments.close(); }
	catch { process.stderr.write("KESTREL_NATIVE_ATTACHMENT_CLEANUP_INCOMPLETE\n"); code = code || 1; }
	await profile.close();
	process.exit(code);
}
process.stdout.on("error", () => { outputClosed = true; void shutdown(); });
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
input.once("close", () => void shutdown());
input.on("line", line => {
	if (stopping) return;
	if (Buffer.byteLength(line) > MAX_FRAME) { void shutdown(1); return; }
	let message;
	try { message = JSON.parse(line); } catch { void shutdown(1); return; }
	if (message?.type === "shutdown") { void shutdown(); return; }
	if (message?.type === "host-cancel") { hostRequests.get(message.id)?.abort(new Error("The native host request was interrupted.")); return; }
	if (message?.type === "native-dialog-response") {
		const dialog = folderDialog;
		if (!dialog || message.requestId !== dialog.requestId) return;
		folderDialog = undefined; clearTimeout(dialog.timer); dialog.detachAbort?.();
		const response = message.response;
		const validPath = path => typeof path === "string" && path.startsWith("/") && path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(path);
		if (response?.ok === true && response.cancelled === true) dialog.resolve(null);
		else if (["select-workspace-folder", "select-plugin-bundle"].includes(dialog.operation) && response?.ok === true && validPath(response.selectedWorkspacePath)) dialog.resolve(response.selectedWorkspacePath);
		else if (["save-memory-recovery-file", "open-memory-recovery-file"].includes(dialog.operation) && response?.ok === true && validPath(response.selectedRecoveryPath)) dialog.resolve(response.selectedRecoveryPath);
		else if (["select-context-files", "select-plugin-publisher"].includes(dialog.operation) && response?.ok === true && Array.isArray(response.selectedContextPaths) && response.selectedContextPaths.length >= 1 && response.selectedContextPaths.length <= (dialog.operation === "select-plugin-publisher" ? 1 : 8) && response.selectedContextPaths.every(validPath) && new Set(response.selectedContextPaths).size === response.selectedContextPaths.length) dialog.resolve(response.selectedContextPaths);
		else dialog.reject(new Error("The native file or folder picker did not return a valid selection."));
		return;
	}
	if (message?.type === "browser-backend-reset-response") {
		const reset = browserReset;
		if (!reset || message.requestId !== reset.requestId) return;
		browserReset = undefined; clearTimeout(reset.timer);
		if (message.ok === true) reset.resolve();
		else reset.reject(new Error("Isolated browser cleanup failed. Restart Kestrel before creating another session."));
		return;
	}
	if (message?.type === "browser-backend-response") {
		const request = pendingBrowser.get(message.requestId); if (!request) return;
		pendingBrowser.delete(message.requestId); clearTimeout(request.timer); request.signal.removeEventListener("abort", request.abort);
		if (message.ok === true) request.resolve(message.result);
		else request.reject(new Error(typeof message.error === "string" ? message.error.slice(0, 500) : "The native browser request failed."));
		return;
	}
	if (message?.type === "native-computer-response") {
		const request = pendingNativeComputer.get(message.requestId); if (!request) return;
		pendingNativeComputer.delete(message.requestId); clearTimeout(request.timer); request.signal.removeEventListener("abort", request.abort);
		if (message.ok === true) request.resolve(message.result);
		else request.reject(new Error(typeof message.error === "string" ? message.error.slice(0, 500) : "The native desktop request failed."));
		return;
	}
	if (!["request", "host-request"].includes(message?.type) || typeof message.id !== "string" || !message.id || message.id.length > 100 || pending.has(message.id) || pending.size >= 64) { void shutdown(1); return; }
	const isHost = message.type === "host-request";
	const parsed = (isHost ? RendererRequestSchema : CoreRequestSchema).safeParse(message.request);
	if (!parsed.success || (isHost && !NATIVE_READINESS_REQUEST_TYPES.has(parsed.data.type) && !NATIVE_PROVIDER_REQUEST_TYPES.has(parsed.data.type) && !NATIVE_PLUGIN_REQUEST_TYPES.has(parsed.data.type) && !NATIVE_WORKSPACE_REQUEST_TYPES.has(parsed.data.type) && !NATIVE_CONTEXT_ATTACHMENT_REQUEST_TYPES.has(parsed.data.type) && !NATIVE_MEMORY_RECOVERY_REQUEST_TYPES.has(parsed.data.type))) { write({ type: "response", id: message.id, response: { ok: false, error: "Invalid native Core request." } }); return; }
	if (!isHost && isNativeMemoryRecoveryInternalRequest(parsed.data.type)) { write({ type: "response", id: message.id, response: { ok: false, error: "Invalid native Core request." } }); return; }
	if ((!isHost || NATIVE_MEMORY_RECOVERY_REQUEST_TYPES.has(parsed.data.type)) && configuration.changing) { write({ type: "response", id: message.id, response: { ok: false, error: "Settings are being applied. Wait for Agent Core to restart." } }); return; }
	pending.add(message.id);
	const hostController = isHost && (NATIVE_PLUGIN_REQUEST_TYPES.has(parsed.data.type) || NATIVE_MEMORY_RECOVERY_REQUEST_TYPES.has(parsed.data.type)) ? new AbortController() : undefined;
	const hostTimer = hostController ? setTimeout(() => hostController.abort(new Error("The native host request timed out.")), 9 * 60_000 + 50_000) : undefined;
	if (hostController) hostRequests.set(message.id, hostController);
	if (!isHost || NATIVE_MEMORY_RECOVERY_REQUEST_TYPES.has(parsed.data.type)) activeCoreRequests.add(message.id);
	void Promise.resolve().then(async () => {
		if (isHost) {
			if (parsed.data.type === "system-readiness") return { ok: true, systemReadiness: await nativeSystemReadiness({
				coreRequest: request => core.request(request), workspaceConfiguration: () => workspaces.runtimeConfiguration(),
				localStatus: () => providers.handle({ type: "local-model-status" }), computerUseStatus: () => computerUse.status(),
			}) };
			if (NATIVE_READINESS_REQUEST_TYPES.has(parsed.data.type) && parsed.data.type.startsWith("computer-use-")) return dispatchNativeComputerHostRequest(computerUse, parsed.data);
			if (NATIVE_WORKSPACE_REQUEST_TYPES.has(parsed.data.type)) return workspaces.handle(parsed.data);
			if (NATIVE_PLUGIN_REQUEST_TYPES.has(parsed.data.type)) return plugins.handle(parsed.data, hostController.signal);
			if (NATIVE_CONTEXT_ATTACHMENT_REQUEST_TYPES.has(parsed.data.type)) return attachments.handle(parsed.data);
			if (NATIVE_MEMORY_RECOVERY_REQUEST_TYPES.has(parsed.data.type)) return memoryRecovery.handle(parsed.data, hostController.signal);
			return providers.handle(parsed.data);
		}
		if (parsed.data.type === "runtime-run-agent") await attachments.assertRequestAttachments(parsed.data);
		return core.request(parsed.data);
	})
		.then(response => {
			write({ type: "response", id: message.id, response });
			if (isHost && NATIVE_WORKSPACE_REQUEST_TYPES.has(parsed.data.type) && parsed.data.type !== "get-workspace-grants" && response.ok && !response.cancelled && Array.isArray(response.projects))
				write({ type: "event", channel: "workspace-projects", event: response.projects });
		})
		.catch(error => write({ type: "response", id: message.id, response: { ok: false, error: isHost ? ["local-runtime-bootstrap", "local-model-pull"].includes(parsed.data.type) && error instanceof Error && [OLLAMA_REMOTE_MODEL_ERROR, "Choose an installed model with confirmed tool support for Kestrel tasks.", "Start Ollama or use guided local setup before downloading a model.", "The local runtime checksum did not match the pinned release manifest.", "Local model setup was cancelled. Partial downloads may remain in Ollama.", "Local model setup timed out. Partial downloads may remain in Ollama."].includes(error.message) ? error.message : "Kestrel settings could not be applied. Finish or cancel active tasks and check the native profile before retrying." : error instanceof Error ? error.message.slice(0, 500) : "Core could not complete the request." } }))
		.finally(() => { pending.delete(message.id); activeCoreRequests.delete(message.id); hostRequests.delete(message.id); if (hostTimer) clearTimeout(hostTimer); });
});
try {
	try { await providers.startManagedIfInstalled(); }
	catch { process.stderr.write("KESTREL_NATIVE_MANAGED_RUNTIME_UNAVAILABLE\n"); }
	if (!stopping) await configuration.start();
	if (!stopping) { const { projects } = await workspaces.runtimeConfiguration(); write({ type: "ready", workspaceGrants: projects, projects }); }
} catch {
	write({ type: "start-error", error: "Kestrel Core could not open the native profile. Existing data was preserved." });
	await shutdown(1);
}
