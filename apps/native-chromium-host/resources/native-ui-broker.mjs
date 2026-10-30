import { spawn, execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createNativeBrowserRelay } from "./native-browser-relay.mjs";
import { createNativeAutomationRelay } from "./native-automation-relay.mjs";
import { createNativeDialogRelay } from "./native-dialog-relay.mjs";

const resources = dirname(fileURLToPath(import.meta.url));
const argument = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const profile = await realpath(argument("--profile-root"));
const browserPid = Number(argument("--browser-pid"));
if (!Number.isSafeInteger(browserPid) || browserPid !== process.ppid) throw new Error("Native broker requires its owning browser.");
const peerInspector = createRequire(import.meta.url)(join(resources, "native-peer.node"));
const { RendererRequestSchema, CoreRequestSchema, BrowserBackendWireRequestSchema, isUserBrowserBackendWireRequest, nativeRequestTimeoutMs, NATIVE_PROVIDER_REQUEST_TYPES, NATIVE_WORKSPACE_REQUEST_TYPES, NATIVE_CONTEXT_ATTACHMENT_REQUEST_TYPES } = await import("./native-ui-contracts.mjs");
const MAX_FRAME = 1024 * 1024;
const MAX_PENDING = 64;
const key = randomBytes(32);
const extensionRoot = join(profile, "kestrel-ui-bundle");
let existingUi;
try { existingUi = await lstat(extensionRoot); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (existingUi) {
	const stat = existingUi;
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
		await readFile(join(extensionRoot, ".kestrel-generated"), "utf8") !== "kestrel-ui-v1\n")
		throw new Error("Refusing to replace an unowned UI directory.");
	await rm(extensionRoot, { recursive: true });
}
await cp(join(resources, "kestrel-ui"), extensionRoot, { recursive: true, dereference: false, errorOnExist: true, force: false });
await chmod(extensionRoot, 0o700);
async function rejectLinks(root) {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) throw new Error("Bundled UI must not contain symbolic links.");
		if (entry.isDirectory()) await rejectLinks(join(root, entry.name));
	}
}
await rejectLinks(extensionRoot);
await writeFile(join(extensionRoot, ".kestrel-generated"), "kestrel-ui-v1\n", { mode: 0o600 });
// Keep the launch key out of the worker's persistent module cache. The worker
// reads this private, non-web-accessible document anew for each challenge.
const configName = "launch-config.json";
await writeFile(join(extensionRoot, configName), JSON.stringify({ version: 1, browserPid, key: key.toString("base64") }), { mode: 0o600 });
// Chromium's unpacked ID is derived from this absolute path. Authentication
// additionally requires a fresh secret and kernel-authenticated native host.
const extensionId = [...createHash("sha256").update(extensionRoot).digest("hex").slice(0, 32)].map((digit) => "abcdefghijklmnop"[parseInt(digit, 16)]).join("");
const expectedOrigin = `chrome-extension://${extensionId}/`;
const hostExecutable = await realpath(join(resources, "..", "MacOS", "Kestrel Native Bridge"));
const socketDirectory = join(execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim(), `kestrel-native-${browserPid}`);
await mkdir(socketDirectory, { mode: 0o700 }); // Existing/stale paths fail closed.
const socketPath = join(socketDirectory, "bridge.sock");
const pending = new Map();
const sockets = new Set();
const reportedUnsupported = new Set();
let active;
let coreReady = false;
let sequence = 0;
let stopping = false;
let shuttingDown = false;
function signalReady() {
	if (!active || !coreReady) return;
	send(active, { kind: "ready" });
	process.stdout.write(JSON.stringify({ kind: "ui-ready" }) + "\n");
}
const core = spawn(process.execPath, [join(resources, "native-desktop-core.mjs"), "--profile-root", profile,
	...(process.argv.includes("--durable-profile") ? ["--durable-profile"] : [])], {
	stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, KESTREL_NATIVE_LIVE_EXTENSIONS: "0" },
});
function send(socket, message) {
	if (socket.destroyed) return;
	const bytes = Buffer.from(JSON.stringify(message));
	if (bytes.length > MAX_FRAME || socket.writableLength + bytes.length > 2 * MAX_FRAME) { socket.destroy(); return; }
	const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
	socket.write(Buffer.concat([header, bytes]));
}
function failPending(socket) {
	for (const [id, request] of pending) if (request.socket === socket) { clearTimeout(request.timeout); pending.delete(id); }
	browserRelay.disconnect(socket);
}
function writeCore(message) {
	if (stopping) return;
	const line = JSON.stringify(message);
	if (Buffer.byteLength(line, "utf8") + 1 > MAX_FRAME || core.stdin.destroyed || !core.stdin.writable || core.stdin.writableLength >= MAX_FRAME) { void shutdown(1); return; }
	core.stdin.write(line + "\n");
}
const browserRelay = createNativeBrowserRelay({
	validate: (request) => {
		const parsed = BrowserBackendWireRequestSchema.safeParse(request);
		return parsed.success && isUserBrowserBackendWireRequest(parsed.data) ? parsed : { success: false };
	},
	writeCore, send, currentOwner: () => active && !active.destroyed ? active : undefined,
});
function writeOwner(line) {
	if (stopping || process.stdout.destroyed || !process.stdout.writable || process.stdout.writableLength + Buffer.byteLength(line, "utf8") + 1 > MAX_FRAME) return false;
	try { process.stdout.write(line + "\n"); return true; } catch { return false; }
}
const automationRelay = createNativeAutomationRelay({
	validate: (request) => BrowserBackendWireRequestSchema.safeParse(request),
	isUserRequest: isUserBrowserBackendWireRequest,
	writeCore, writeOwner,
});
const dialogRelay = createNativeDialogRelay({ writeCore, writeOwner });
createInterface({ input: core.stdout }).on("line", (line) => {
	if (line.length > 8 * MAX_FRAME) { void shutdown(1); return; }
	let message; try { message = JSON.parse(line); } catch { void shutdown(1); return; }
	if (message.type === "ready") { coreReady = true; signalReady(); }
	else if (message.type === "response") {
		const request = pending.get(message.id); if (!request) return;
		pending.delete(message.id); clearTimeout(request.timeout);
		send(request.socket, { kind: "response", id: request.uiId, response: message.response });
	} else if (message.type === "event" && active) send(active, { kind: "event", channel: message.channel, event: message.event });
	else if (message.type === "browser-backend-request") {
		const parsed = BrowserBackendWireRequestSchema.safeParse(message.request);
		if (parsed.success && isUserBrowserBackendWireRequest(parsed.data)) browserRelay.request(message);
		else automationRelay.request(message);
	} else if (message.type === "browser-backend-cancel") {
		browserRelay.cancel(message.requestId); automationRelay.cancel(message.requestId);
	} else if (message.type === "native-dialog-request") dialogRelay.request(message);
	else if (message.type === "native-dialog-cancel") dialogRelay.cancel(message.requestId);
	else if (message.type === "browser-backend-reset" && typeof message.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 200) {
		const requestId = message.requestId;
		void automationRelay.reset().then(
			() => writeCore({ type: "browser-backend-reset-response", requestId, ok: true }),
			() => writeCore({ type: "browser-backend-reset-response", requestId, ok: false, error: "Native automation reset failed." }),
		);
	}
});
core.on("error", () => void shutdown(1));
core.stdin.on("error", () => void shutdown(1));
core.on("exit", () => { if (!stopping) void shutdown(1); });
const server = createServer((socket) => {
	try {
		const peer = peerInspector.inspect(socket._handle.fd);
		if (peer.uid !== process.getuid() || peer.parentPid !== browserPid || peer.executable !== hostExecutable || sockets.size >= 4)
			throw new Error("Untrusted native messaging process.");
	} catch { socket.destroy(); return; }
	sockets.add(socket);
	let state = "hello";
	let buffer = Buffer.alloc(0);
	let nonce;
	const deadline = setTimeout(() => socket.destroy(), 10_000);
	socket.on("error", () => socket.destroy());
	socket.on("close", () => { clearTimeout(deadline); sockets.delete(socket); failPending(socket); if (active === socket) active = undefined; });
	socket.on("data", (chunk) => {
		if (buffer.length + chunk.length > 2 * MAX_FRAME) { socket.destroy(); return; }
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4) {
			const length = buffer.readUInt32LE(0);
			if (!length || length > MAX_FRAME) { socket.destroy(); return; }
			if (buffer.length < length + 4) return;
			let message; try { message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")); } catch { socket.destroy(); return; }
			buffer = buffer.subarray(length + 4);
			if (state === "hello") {
				if (message.kind !== "native-host" || message.origin !== expectedOrigin) { socket.destroy(); return; }
				nonce = randomBytes(32).toString("hex"); state = "challenge";
				send(socket, { kind: "challenge", nonce, browserPid });
			} else if (state === "challenge") {
				const expected = createHmac("sha256", key).update(nonce).digest();
				const received = typeof message.mac === "string" && /^[a-f0-9]{64}$/.test(message.mac) ? Buffer.from(message.mac, "hex") : Buffer.alloc(0);
				if (message.kind !== "authenticate" || received.length !== expected.length || !timingSafeEqual(received, expected) || active) {
					process.stderr.write("KESTREL_NATIVE_AUTH_REJECTED\n"); socket.destroy(); return;
				}
				state = "authenticated"; clearTimeout(deadline); active = socket;
				signalReady();
			} else {
				if (message.kind === "browser-backend-response") { browserRelay.response(socket, message); continue; }
				if (message.kind !== "request" || typeof message.id !== "string" || message.id.length > 100 || pending.size >= MAX_PENDING) { socket.destroy(); return; }
				const parsed = RendererRequestSchema.safeParse(message.request);
				if (!parsed.success) { send(socket, { kind: "response", id: message.id, response: { ok: false, error: "Invalid Kestrel request." } }); continue; }
				if (["get-system-state", "get-default-browser-status"].includes(parsed.data.type)) {
					const id = `host-${++sequence}`;
					const timeout = setTimeout(() => { pending.delete(id); send(socket, { kind: "response", id: message.id, response: { ok: false, error: "The native desktop did not respond." } }); }, 30_000);
					pending.set(id, { socket, uiId: message.id, timeout });
					process.stdout.write(JSON.stringify({ kind: "host-request", id, request: parsed.data }) + "\n"); continue;
				}
				const hostRequest = NATIVE_PROVIDER_REQUEST_TYPES.has(parsed.data.type) || NATIVE_WORKSPACE_REQUEST_TYPES.has(parsed.data.type) || NATIVE_CONTEXT_ATTACHMENT_REQUEST_TYPES.has(parsed.data.type);
				if (!hostRequest && !CoreRequestSchema.safeParse(parsed.data).success) {
					if (!reportedUnsupported.has(parsed.data.type)) {
						reportedUnsupported.add(parsed.data.type);
						process.stderr.write("KESTREL_NATIVE_UNSUPPORTED_REQUEST " + parsed.data.type + "\n");
					}
					send(socket, { kind: "response", id: message.id, response: { ok: false, error: "This native desktop operation is not connected yet." } }); continue;
				}
				if (!coreReady || core.stdin.writableLength > MAX_FRAME) { socket.destroy(); return; }
				const id = `ui-${++sequence}`;
				const timeout = setTimeout(() => { pending.delete(id); send(socket, { kind: "response", id: message.id, response: { ok: false, error: "Kestrel Core response timed out. Check the task before retrying." } }); }, ["select-workspace-folder", "select-context-files"].includes(parsed.data.type) ? 10 * 60_000 + 30_000 : nativeRequestTimeoutMs(parsed.data, "broker"));
				pending.set(id, { socket, uiId: message.id, timeout });
				core.stdin.write(JSON.stringify({ type: hostRequest ? "host-request" : "request", id, request: parsed.data }) + "\n");
			}
		}
	});
});
async function shutdown(code = 0) {
	if (stopping || shuttingDown) return;
	shuttingDown = true;
	automationRelay.close();
	dialogRelay.close();
	stopping = true;
	for (const socket of sockets) socket.destroy();
	server.close();
	if (!core.stdin.destroyed) core.stdin.end(JSON.stringify({ type: "shutdown" }) + "\n");
	const timer = setTimeout(() => core.kill("SIGTERM"), 2_000);
	await new Promise((done) => { if (core.exitCode !== null) done(); else { core.once("exit", done); setTimeout(done, 4_000); } });
	clearTimeout(timer);
	await rm(socketDirectory, { recursive: true, force: true });
	// Destroy the launch secret, preserving browser/profile state.
	await rm(join(extensionRoot, configName), { force: true });
	key.fill(0);
	process.exit(code);
}
process.stdout.on("error", () => void shutdown(1));
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
const ownerInput = createInterface({ input: process.stdin, crlfDelay: Infinity });
ownerInput.once("close", () => void shutdown());
ownerInput.on("line", (line) => {
	if (Buffer.byteLength(line, "utf8") + 1 > MAX_FRAME) { void shutdown(1); return; }
	let message; try { message = JSON.parse(line); } catch { void shutdown(1); return; }
	if (message?.kind === "automation-response") { automationRelay.response(message); return; }
	if (message?.kind === "automation-reset-response") { automationRelay.resetResponse(message); return; }
	if (dialogRelay.response(message)) return;
	if (message.kind !== "host-response" || typeof message.id !== "string" || !message.id.startsWith("host-")) return;
	const request = pending.get(message.id); if (!request) return;
	pending.delete(message.id); clearTimeout(request.timeout);
	send(request.socket, { kind: "response", id: request.uiId, response: message.response });
});
await new Promise((done, reject) => { server.once("error", reject); server.listen(socketPath, done); });
await chmod(socketPath, 0o600);
process.stdout.write(JSON.stringify({ extensionRoot, extensionId }) + "\n");
