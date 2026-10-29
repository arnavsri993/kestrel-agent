import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openNativeCoreProfile } from "./native-core-profile.mjs";
import { CoreSupervisor, nodeCoreProcess, CoreRequestSchema, RendererRequestSchema, NativeProviderHost, NATIVE_WORKSPACE_REQUEST_TYPES, NativeWorkspaceHost, NATIVE_PROVIDER_REQUEST_TYPES } from "./agent-core/service/native-desktop-runtime.mjs";
import { createNativeCoreConfiguration } from "./native-core-configuration.mjs";

const resources = dirname(fileURLToPath(import.meta.url));
const index = process.argv.indexOf("--profile-root");
if (index < 0 || !process.argv[index + 1]) throw new Error("Native Core requires its owning browser profile.");
const durable = process.argv.includes("--durable-profile");
const profile = await openNativeCoreProfile(resolve(process.argv[index + 1]), { durable });
const MAX_FRAME = 1024 * 1024;
const pendingBrowser = new Map();
const pending = new Set();
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

function browserRequest(request, signal) {
	if (stopping || pendingBrowser.size >= 16 || signal.aborted) return Promise.reject(new Error("The native browser connection is unavailable."));
	const requestId = `native-browser-${++sequence}`;
	return new Promise((resolveRequest, rejectRequest) => {
		const fail = (error) => {
			if (!pendingBrowser.delete(requestId)) return;
			clearTimeout(timer); signal.removeEventListener("abort", abort);
			write({ type: "browser-backend-cancel", requestId });
			rejectRequest(error);
		};
		const abort = () => fail(new Error("The browser request was interrupted. Check its outcome before retrying."));
		const timer = setTimeout(() => fail(new Error("The browser request timed out. Check its outcome before retrying.")), 30_000);
		pendingBrowser.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer, signal, abort });
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) { abort(); return; }
		write({ type: "browser-backend-request", requestId, request });
	});
}

function cancelBrowsers() {
	for (const [requestId, request] of pendingBrowser) {
		clearTimeout(request.timer); request.signal.removeEventListener("abort", request.abort);
		write({ type: "browser-backend-cancel", requestId });
		request.reject(new Error("Core stopped during the browser request. Check its outcome before retrying."));
	}
	pendingBrowser.clear();
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
	write({ type: "native-dialog-cancel", requestId: dialog.requestId });
	dialog.resolve(null);
}
function selectWorkspaceFolder() {
	if (stopping || folderDialog || dialogSequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error("The native folder picker is unavailable."));
	const requestId = `native-dialog-${++dialogSequence}`;
	let resolveDialog, rejectDialog;
	const promise = new Promise((resolve, reject) => { resolveDialog = resolve; rejectDialog = reject; });
	const timer = setTimeout(() => {
		if (folderDialog?.requestId !== requestId) return;
		folderDialog = undefined;
		write({ type: "native-dialog-cancel", requestId });
		rejectDialog(new Error("The native folder picker timed out."));
	}, 600_000);
	folderDialog = { requestId, timer, resolve: resolveDialog, reject: rejectDialog };
	write({ type: "native-dialog-request", requestId, operation: "select-workspace-folder" });
	return promise;
}

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
	homeDirectory: homedir(), environment: process.env, reconfigure: mutation => configuration.reconfigure(mutation),
	openAuthUrl: async (url, signal) => {
		await browserRequest({ operation: "visible-create", input: url }, signal);
	},
});
const workspaces = new NativeWorkspaceHost({ root: profile.root, selectFolder: selectWorkspaceFolder,
	reconfigure: mutation => configuration.reconfigure(mutation),
});
const configuration = createNativeCoreConfiguration({ core,
	isBusy: () => activeCoreRequests.size > 0 || backgroundJobsRunning,
	configuration: async () => ({ databasePath: profile.databasePath, encryptionKeyBase64: profile.encryptionKeyBase64,
		...await workspaces.runtimeConfiguration(), pluginRoots: [], managedPluginRoots: [],
		learnedSkillRoot: join(profile.root, "learned-skills"), ...await providers.runtimeConfiguration(),
	}),
	changed: publishSnapshot,
});
core.on("crash", () => process.stderr.write("KESTREL_NATIVE_CORE_INTERRUPTED\n"));
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
	await workspaces.close();
	await providers.close();
	await core.stop();
	await profile.close();
	process.exit(code);
}
process.stdout.on("error", () => { outputClosed = true; void shutdown(); });
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.once("close", () => void shutdown());
input.on("line", line => {
	if (stopping) return;
	if (Buffer.byteLength(line) > MAX_FRAME) { void shutdown(1); return; }
	let message;
	try { message = JSON.parse(line); } catch { void shutdown(1); return; }
	if (message?.type === "shutdown") { void shutdown(); return; }
	if (message?.type === "native-dialog-response") {
		const dialog = folderDialog;
		if (!dialog || message.requestId !== dialog.requestId) return;
		folderDialog = undefined; clearTimeout(dialog.timer);
		const response = message.response;
		if (response?.ok === true && response.cancelled === true) dialog.resolve(null);
		else if (response?.ok === true && typeof response.selectedWorkspacePath === "string" && response.selectedWorkspacePath.startsWith("/") && response.selectedWorkspacePath.length <= 4096 && !response.selectedWorkspacePath.includes("\0")) dialog.resolve(response.selectedWorkspacePath);
		else dialog.reject(new Error("The native folder picker did not return a valid selection."));
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
	if (!["request", "host-request"].includes(message?.type) || typeof message.id !== "string" || !message.id || message.id.length > 100 || pending.has(message.id) || pending.size >= 64) { void shutdown(1); return; }
	const isHost = message.type === "host-request";
	const parsed = (isHost ? RendererRequestSchema : CoreRequestSchema).safeParse(message.request);
	if (!parsed.success || (isHost && !NATIVE_PROVIDER_REQUEST_TYPES.has(parsed.data.type) && !NATIVE_WORKSPACE_REQUEST_TYPES.has(parsed.data.type))) { write({ type: "response", id: message.id, response: { ok: false, error: "Invalid native Core request." } }); return; }
	if (!isHost && configuration.changing) { write({ type: "response", id: message.id, response: { ok: false, error: "Settings are being applied. Wait for Agent Core to restart." } }); return; }
	pending.add(message.id);
	if (!isHost) activeCoreRequests.add(message.id);
	void Promise.resolve().then(() => isHost ? NATIVE_WORKSPACE_REQUEST_TYPES.has(parsed.data.type) ? workspaces.handle(parsed.data) : providers.handle(parsed.data) : core.request(parsed.data))
		.then(response => {
			write({ type: "response", id: message.id, response });
			if (isHost && NATIVE_WORKSPACE_REQUEST_TYPES.has(parsed.data.type) && parsed.data.type !== "get-workspace-grants" && response.ok && !response.cancelled && Array.isArray(response.projects))
				write({ type: "event", channel: "workspace-projects", event: response.projects });
		})
		.catch(error => write({ type: "response", id: message.id, response: { ok: false, error: isHost ? parsed.data.type === "local-runtime-bootstrap" && error instanceof Error && error.message === "Choose an installed model with confirmed tool support for Kestrel tasks." ? error.message : "Kestrel settings could not be applied. Finish or cancel active tasks and check the native profile before retrying." : error instanceof Error ? error.message.slice(0, 500) : "Core could not complete the request." } }))
		.finally(() => { pending.delete(message.id); activeCoreRequests.delete(message.id); });
});
try {
	await configuration.start();
	if (!stopping) { const { projects } = await workspaces.runtimeConfiguration(); write({ type: "ready", workspaceGrants: projects, projects }); }
} catch {
	write({ type: "start-error", error: "Kestrel Core could not open the native profile. Existing data was preserved." });
	await shutdown(1);
}
