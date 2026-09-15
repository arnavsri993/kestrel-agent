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

function write(message) {
	process.stdout.write(JSON.stringify(message) + "\n");
}

function failPending(error) {
	for (const id of pending.values()) {
		write({ type: "response", id, response: { ok: false, error } });
	}
	pending.clear();
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
		// Browser automation remains deliberately fail-closed until CEF's
		// dedicated Chromium browser runtime owns this backend.
		core.send({
			type: "browser-backend-response",
			requestId: message.requestId,
			ok: false,
			error:
				"Native Chromium browser automation is not migrated yet.",
		});
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
