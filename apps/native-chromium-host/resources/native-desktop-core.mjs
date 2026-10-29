import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openNativeCoreProfile } from "./native-core-profile.mjs";
import { CoreSupervisor, nodeCoreProcess, CoreRequestSchema } from "./agent-core/service/native-desktop-runtime.mjs";

const resources = dirname(fileURLToPath(import.meta.url));
const index = process.argv.indexOf("--profile-root");
if (index < 0 || !process.argv[index + 1]) throw new Error("Native Core requires its owning browser profile.");
const durable = process.argv.includes("--durable-profile");
const profile = await openNativeCoreProfile(resolve(process.argv[index + 1]), { durable });
const MAX_FRAME = 1024 * 1024;
const pendingBrowser = new Map();
const pending = new Set();
let sequence = 0;
let stopping = false;
let outputClosed = false;

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

const core = new CoreSupervisor(browserRequest, async () => cancelBrowsers(), {
	processFactory: () => nodeCoreProcess({
		executable: process.execPath, entryPath: join(resources, "agent-core/service/index.js"), stdout: "ignore",
		env: { HOME: profile.root, LANG: process.env.LANG ?? "en_US.UTF-8", PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir(),
			KESTREL_DATA_DIR: profile.root, ...(!durable ? { KESTREL_NATIVE_EPHEMERAL_PROFILE: "1" } : {}),
		},
	}),
});
for (const channel of ["runtime-event", "agent-stream", "background-jobs"])
	core.on(channel, event => write({ type: "event", channel, event }));
core.on("crash", () => process.stderr.write("KESTREL_NATIVE_CORE_INTERRUPTED\n"));
core.on("recovery-failed", () => process.stderr.write("KESTREL_NATIVE_CORE_RECOVERY_FAILED\n"));
core.on("recovered", () => {
	process.stderr.write("KESTREL_NATIVE_CORE_RECOVERED\n");
	void core.request({ type: "snapshot" }).then(response => {
		if (response.ok && response.snapshot) write({ type: "event", channel: "snapshot", event: response.snapshot });
	}).catch(() => {});
});

async function shutdown(code = 0) {
	if (stopping) return; stopping = true;
	cancelBrowsers();
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
	if (message?.type === "browser-backend-response") {
		const request = pendingBrowser.get(message.requestId); if (!request) return;
		pendingBrowser.delete(message.requestId); clearTimeout(request.timer); request.signal.removeEventListener("abort", request.abort);
		if (message.ok === true) request.resolve(message.result);
		else request.reject(new Error(typeof message.error === "string" ? message.error.slice(0, 500) : "The native browser request failed."));
		return;
	}
	if (message?.type !== "request" || typeof message.id !== "string" || !message.id || message.id.length > 100 || pending.has(message.id) || pending.size >= 64) { void shutdown(1); return; }
	const parsed = CoreRequestSchema.safeParse(message.request);
	if (!parsed.success) { write({ type: "response", id: message.id, response: { ok: false, error: "Invalid Core request." } }); return; }
	pending.add(message.id);
	void core.request(parsed.data).then(response => write({ type: "response", id: message.id, response }))
		.catch(error => write({ type: "response", id: message.id, response: { ok: false, error: error instanceof Error ? error.message.slice(0, 500) : "Core could not complete the request." } }))
		.finally(() => pending.delete(message.id));
});
try {
	await core.start({ databasePath: profile.databasePath, encryptionKeyBase64: profile.encryptionKeyBase64,
		workspaceRoots: [], configuredWorkspaceRoots: [], projects: [], pluginRoots: [], managedPluginRoots: [],
		learnedSkillRoot: join(profile.root, "learned-skills"), secureEnvironment: {}, providerAccounts: [],
	});
	if (!stopping) write({ type: "ready", workspaceGrants: [], projects: [] });
} catch {
	write({ type: "start-error", error: "Kestrel Core could not open the native profile. Existing data was preserved." });
	await shutdown(1);
}
