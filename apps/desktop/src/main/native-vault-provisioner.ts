import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type Duplex } from "node:stream";

const REQUEST_HEADER_BYTES = 40;
const RESPONSE_BYTES = 100;
const MAX_PARENT_PATH_BYTES = 4000;
const MAX_VAULT_BYTES = 16 * 1024;
const VAULT_NAME = ".kestrel-local-vault-v1";
const PROFILE_NAME = "profile";
const DEFAULT_TIMEOUT_MS = 40_000;
const GRACEFUL_STOP_MS = 1_000;
const REAP_TIMEOUT_MS = 3_000;
const HELPER_NAME = "Kestrel Vault Provisioner";
const VAULT_HELPER_NAME = "Kestrel Vault";
const MINIMAL_ENV = Object.freeze({ PATH: "/usr/bin:/bin" });

export type NativeVaultProvisioningRequest = {
	parent: string;
	executable: string;
	signal?: AbortSignal;
};

export type NativeVaultProvisionedProfile = {
	profile: string;
	key: Buffer;
	vaultSha256: string;
};
export class NativeVaultProvisioningCleanupError extends Error {
	readonly cleanupCode: string;
	constructor(reason?: unknown) {
		super("The native vault helper could not be reaped; preserve the generated output."); this.name = "NativeVaultProvisioningCleanupError";
		const code = reason && typeof reason === "object" && "code" in reason ? reason.code : undefined;
		this.cleanupCode = typeof code === "string" && /^E[A-Z0-9_]{1,63}$/.test(code) ? code : "UNCONFIRMED_EXIT";
	}
}

function fail(message = "Native vault provisioning failed; preserve the generated output for review."): never {
	throw new Error(message);
}

function assertActive(signal: AbortSignal | undefined, deadline: number): void {
	if (signal?.aborted) fail("Native vault provisioning was cancelled.");
	if (Date.now() >= deadline) fail("Native vault provisioning exceeded its time limit.");
}

function controlled<T>(promise: Promise<T>, signal: AbortSignal | undefined, deadline: number): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return Promise.reject(new Error("Native vault provisioning exceeded its time limit."));
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (error: unknown, value?: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			error ? reject(error) : resolve(value as T);
		};
		const abort = () => finish(new Error("Native vault provisioning was cancelled."));
		const timer = setTimeout(() => finish(new Error("Native vault provisioning exceeded its time limit.")), remaining);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		promise.then(value => finish(undefined, value), error => finish(error));
	});
}

async function stopAndReap(child: ReturnType<typeof spawn>, closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>): Promise<void> {
	child.kill("SIGTERM");
	try {
		await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("graceful-stop-timeout")), GRACEFUL_STOP_MS))]);
		return;
	} catch (error) {
		if ((error as Error)?.message !== "graceful-stop-timeout") return;
	}
	child.kill("SIGKILL");
	await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("reap-timeout")), REAP_TIMEOUT_MS))]);
}

function groupExists(pid: number): boolean {
	try { process.kill(-pid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		// EPERM establishes neither absence nor successful cleanup. Keep the
		// group present and wait within the existing deadline for ESRCH.
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		throw error;
	}
}
async function groupStopped(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (groupExists(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise<void>(resolve => setTimeout(resolve, 10));
	}
	return true;
}
async function stopProvisionerGroup(child: ReturnType<typeof spawn>, closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>): Promise<void> {
	if (!child.pid) { await stopAndReap(child, closed); return; }
	// detached:true gives this one-shot provisioner its own process group. Its
	// isolated crypto child inherits that group, so cancellation owns both.
	const signalGroup = (signal: NodeJS.Signals) => {
		try { process.kill(-child.pid!, signal); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
	};
	signalGroup("SIGTERM");
	if (!await groupStopped(child.pid, GRACEFUL_STOP_MS)) {
		signalGroup("SIGKILL");
		if (!await groupStopped(child.pid, REAP_TIMEOUT_MS)) throw new Error("The native vault helper group could not be reaped.");
	}
	await closed;
}

function safePath(value: string, label: string): void {
	if (typeof value !== "string" || !value || !value.startsWith("/") || value.includes("\0") || value.length > 4096)
		fail(`The ${label} path is invalid.`);
}
function currentUid(): bigint {
	if (typeof process.getuid !== "function") fail("Native vault provisioning requires a supported local host.");
	return BigInt(process.getuid());
}

function writeU64(buffer: Buffer, offset: number, value: bigint): void {
	if (value < 0n || value > 0xffffffffffffffffn) fail("The native vault directory identity is invalid.");
	buffer.writeBigUInt64BE(value, offset);
}

export function encodeNativeVaultProvisioningRequest(nonce: Buffer, parentDev: bigint, parentIno: bigint, parentPath: string): Buffer {
	if (!Buffer.isBuffer(nonce) || nonce.length !== 16) fail("The native vault request nonce is invalid.");
	const path = Buffer.from(parentPath, "utf8");
	if (!path.length || path.length > MAX_PARENT_PATH_BYTES || path.toString("utf8") !== parentPath || parentPath.includes("\0"))
		fail("The native vault parent path is invalid.");
	const request = Buffer.alloc(REQUEST_HEADER_BYTES + path.length);
	request.write("KVP1", 0, "ascii");
	nonce.copy(request, 4);
	writeU64(request, 20, parentDev);
	writeU64(request, 28, parentIno);
	request.writeUInt32BE(path.length, 36);
	path.copy(request, REQUEST_HEADER_BYTES);
	return request;
}

export function decodeNativeVaultProvisioningResponse(input: Buffer, expectedNonce: Buffer): {
	rootDev: bigint;
	rootIno: bigint;
	vaultSha256: string;
	key: Buffer;
} {
	if (!Buffer.isBuffer(input) || input.length !== RESPONSE_BYTES || !Buffer.isBuffer(expectedNonce) || expectedNonce.length !== 16 ||
		input.toString("ascii", 0, 4) !== "KVP2" || !timingSafeEqual(input.subarray(4, 20), expectedNonce))
		fail("The native vault helper returned an invalid response.");
	return {
		rootDev: input.readBigUInt64BE(20),
		rootIno: input.readBigUInt64BE(28),
		vaultSha256: input.subarray(36, 68).toString("hex"),
		key: Buffer.from(input.subarray(68, 100)),
	};
}

async function readResponse(channel: Duplex, signal: AbortSignal | undefined, deadline: number): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let length = 0, ended = false, settled = false;
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			channel.removeListener("data", onData);
			channel.removeListener("end", onEnd);
			channel.removeListener("error", onError);
			channel.removeListener("close", onClose);
		};
		const wipeChunks = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
		const failRead = (message: string) => {
			if (settled) return;
			settled = true; cleanup(); wipeChunks(); reject(new Error(message));
		};
		const onAbort = () => failRead("Native vault provisioning was cancelled.");
		const timer = setTimeout(() => failRead("Native vault provisioning exceeded its time limit."), Math.max(0, deadline - Date.now()));
		const onData = (value: Buffer | string) => {
			const chunk = Buffer.from(value);
			if (Buffer.isBuffer(value)) value.fill(0);
			length += chunk.length;
			if (length > RESPONSE_BYTES) { chunk.fill(0); failRead("The native vault helper returned too much data."); return; }
			chunks.push(chunk);
		};
		const onEnd = () => {
			ended = true;
			if (length !== RESPONSE_BYTES) { failRead("The native vault helper returned an incomplete response."); return; }
			settled = true; cleanup();
			const response = Buffer.concat(chunks, length);
			wipeChunks();
			resolve(response);
		};
		const onError = () => failRead("The native vault helper channel failed.");
		const onClose = () => { if (!ended) failRead("The native vault helper channel closed early."); };
		channel.on("data", onData);
		channel.once("end", onEnd);
		channel.once("error", onError);
		channel.once("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

function processClose(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		let failedToStart = false;
		child.once("error", () => { failedToStart = true; });
		child.once("close", (code, signal) => failedToStart
			? reject(new Error("A required native verification process could not start."))
			: resolve({ code, signal }));
	});
}

async function verifyCodesign(target: string, signal: AbortSignal | undefined, deadline: number): Promise<void> {
	assertActive(signal, deadline);
	const child = spawn("/usr/bin/codesign", ["--verify", "--strict", target], {
		cwd: dirname(target), env: MINIMAL_ENV, stdio: ["ignore", "ignore", "ignore"],
	});
	const closed = processClose(child);
	try {
		const result = await controlled(closed, signal, deadline);
		if (result.code !== 0 || result.signal !== null) fail("Native vault helper signature verification failed.");
	} catch (error) {
		await stopAndReap(child, closed).catch(() => {});
		throw error;
	}
}

type StatIdentity = { dev: bigint; ino: bigint; uid: bigint; mode: bigint; size: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint };
function identity(info: import("node:fs").BigIntStats): StatIdentity {
	return { dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode, size: info.size, nlink: info.nlink, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
}
function sameIdentity(a: StatIdentity, b: StatIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function verifyExecutable(executable: string, signal: AbortSignal | undefined, deadline: number): Promise<Array<{ path: string; identity: StatIdentity }>> {
	safePath(executable, "provisioner executable");
	if (await realpath(executable) !== executable || basename(executable) !== HELPER_NAME) fail("The native vault provisioner path is not canonical.");
	const macos = dirname(executable), contents = dirname(macos), bundle = dirname(contents);
	if (basename(macos) !== "MacOS" || basename(contents) !== "Contents" || !bundle.endsWith(".app"))
		fail("The native vault provisioner is outside its canonical app bundle.");
	const uid = currentUid();
	for (const path of [bundle, contents, macos]) {
		const info = await lstat(path, { bigint: true });
		if (!info.isDirectory() || ![0n, uid].includes(info.uid) || (info.mode & 0o022n) !== 0n || await realpath(path) !== path)
			fail("Native vault helper bundle permissions are unsafe.");
	}
	const companion = join(macos, VAULT_HELPER_NAME);
	const binaries = [executable, companion];
	const before: StatIdentity[] = [];
	for (const path of binaries) {
		if (await realpath(path) !== path) fail("A native vault helper path is not canonical.");
		const info = await lstat(path, { bigint: true });
		if (!info.isFile() || ![0n, uid].includes(info.uid) || info.nlink !== 1n || (info.mode & 0o022n) !== 0n || (info.mode & 0o111n) === 0n)
			fail("A native vault helper binary has unsafe ownership or permissions.");
		before.push(identity(info));
	}
	for (const path of binaries) await verifyCodesign(path, signal, deadline);
	for (let index = 0; index < binaries.length; index++) {
		const path = binaries[index]!;
		const info = await lstat(path, { bigint: true });
		if (!sameIdentity(before[index]!, identity(info))) fail("A native vault helper changed during signature verification.");
	}
	return binaries.map((path, index) => ({ path, identity: before[index]! }));
}

async function verifyParent(parent: string): Promise<{ handle: import("node:fs/promises").FileHandle; dev: bigint; ino: bigint }> {
	safePath(parent, "parent");
	if (await realpath(parent) !== parent) fail("The native vault parent path is not canonical.");
	const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const held = await handle.stat({ bigint: true }), named = await lstat(parent, { bigint: true });
		if (!held.isDirectory() || !named.isDirectory() || held.uid !== currentUid() || (held.mode & 0o777n) !== 0o700n ||
			held.dev !== named.dev || held.ino !== named.ino || held.uid !== named.uid || held.mode !== named.mode)
			fail("The native vault parent must be an owned private directory.");
		try { await lstat(join(parent, PROFILE_NAME)); fail("The native vault profile destination already exists."); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		return { handle, dev: held.dev, ino: held.ino };
	} catch (error) { await handle.close(); throw error; }
}

async function validateCreatedProfile(parent: string, parentHandle: import("node:fs/promises").FileHandle,
	parentDev: bigint, parentIno: bigint, response: ReturnType<typeof decodeNativeVaultProvisioningResponse>, fresh = true): Promise<string> {
	const heldParent = await parentHandle.stat({ bigint: true }), namedParent = await lstat(parent, { bigint: true });
	if (!heldParent.isDirectory() || !namedParent.isDirectory() || heldParent.uid !== currentUid() ||
		(heldParent.mode & 0o777n) !== 0o700n || heldParent.dev !== parentDev || heldParent.ino !== parentIno ||
		namedParent.dev !== parentDev || namedParent.ino !== parentIno || namedParent.uid !== heldParent.uid || namedParent.mode !== heldParent.mode)
		fail("The native vault parent changed during provisioning.");
	const profile = join(parent, PROFILE_NAME);
	if (await realpath(profile) !== profile) fail("The generated native vault profile path is not canonical.");
	const root = await open(profile, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const before = await root.stat({ bigint: true }), named = await lstat(profile, { bigint: true });
		if (!before.isDirectory() || !named.isDirectory() || before.uid !== currentUid() || (before.mode & 0o777n) !== 0o700n ||
			before.dev !== response.rootDev || before.ino !== response.rootIno || named.dev !== before.dev || named.ino !== before.ino || named.uid !== before.uid || named.mode !== before.mode)
			fail("The generated native vault profile identity is invalid.");
		const entries = await readdir(profile);
		if (fresh && (entries.length !== 1 || entries[0] !== VAULT_NAME)) fail("The generated native vault profile contains unexpected files.");
		const vaultPath = join(profile, VAULT_NAME);
		const vault = await open(vaultPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const vaultBefore = await vault.stat({ bigint: true }), vaultNamed = await lstat(vaultPath, { bigint: true });
			if (!vaultBefore.isFile() || vaultBefore.uid !== currentUid() || vaultBefore.nlink !== 1n ||
				(vaultBefore.mode & 0o777n) !== 0o600n || vaultBefore.size <= 0n || vaultBefore.size > BigInt(MAX_VAULT_BYTES) ||
				vaultNamed.dev !== vaultBefore.dev || vaultNamed.ino !== vaultBefore.ino || vaultNamed.nlink !== 1n || vaultNamed.mode !== vaultBefore.mode)
				fail("The generated native vault file identity is invalid.");
			const bytes = Buffer.alloc(Number(vaultBefore.size));
			try {
				let offset = 0;
				while (offset < bytes.length) {
					const result = await vault.read(bytes, offset, bytes.length - offset, offset);
					if (!result.bytesRead) fail("The generated native vault file was truncated.");
					offset += result.bytesRead;
				}
				const after = identity(await vault.stat({ bigint: true })), afterNamed = identity(await lstat(vaultPath, { bigint: true }));
				if (!sameIdentity(identity(vaultBefore), after) || !sameIdentity(identity(vaultBefore), afterNamed)) fail("The generated native vault file changed during validation.");
				const digest = createHash("sha256").update(bytes).digest();
				const expected = Buffer.from(response.vaultSha256, "hex");
				const matches = expected.length === digest.length && timingSafeEqual(expected, digest);
				expected.fill(0); digest.fill(0);
				if (!matches) fail("The generated native vault digest did not match the helper response.");
			} finally { bytes.fill(0); }
		} finally { await vault.close(); }
		const afterRoot = identity(await root.stat({ bigint: true })), afterNamedRoot = identity(await lstat(profile, { bigint: true }));
		if (!sameIdentity(identity(before), afterRoot) || !sameIdentity(identity(before), afterNamedRoot)) fail("The generated native vault profile changed during validation.");
		if (fresh && JSON.stringify((await readdir(profile)).sort()) !== JSON.stringify([VAULT_NAME])) fail("The generated native vault profile contains unexpected files.");
	} finally { await root.close(); }
	return profile;
}

/** One-shot native-vault provisioning. The caller owns the private parent and all generated output. */
export async function withProvisionedNativeVault<T>(request: NativeVaultProvisioningRequest,
	operation: (profile: NativeVaultProvisionedProfile) => T | PromiseLike<T>): Promise<T> {
	const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
	assertActive(request.signal, deadline);
	const executableWitness = await verifyExecutable(request.executable, request.signal, deadline);
	const parent = await verifyParent(request.parent);
	const nonce = randomBytes(16);
	let frame: Buffer | undefined, responseBytes: Buffer | undefined, child: ReturnType<typeof spawn> | undefined;
	let channel: Duplex | undefined, key: Buffer | undefined, groupReleased = false, cleanupError: Error | undefined, releasing = false;
	let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
	try {
		assertActive(request.signal, deadline);
		frame = encodeNativeVaultProvisioningRequest(nonce, parent.dev, parent.ino, request.parent);
		child = spawn(request.executable, [], {
			cwd: request.parent,
			env: MINIMAL_ENV,
			detached: true,
			stdio: ["ignore", "ignore", "ignore", "pipe", parent.handle.fd],
		});
		closed = processClose(child);
		channel = child.stdio[3] as Duplex | undefined;
		if (!channel || typeof channel.end !== "function") fail("The native vault helper channel was unavailable.");
		const responsePromise = readResponse(channel, request.signal, deadline).then(bytes => {
			if (releasing) bytes.fill(0);
			else responseBytes = bytes;
			return bytes;
		});
		channel.end(frame);
		const [, exit] = await Promise.all([responsePromise, controlled(closed, request.signal, deadline)]);
		if (exit.code !== 0 || exit.signal !== null) fail("The native vault helper did not exit cleanly.");
		if (child.pid && !await groupStopped(child.pid, GRACEFUL_STOP_MS)) fail("The native vault helper left a running descendant.");
		// Release the PID before a potentially long UI review. Never signal an
		// old process-group identifier after the owned group has disappeared.
		groupReleased = true;
		for (const witness of executableWitness) {
			if (await realpath(witness.path) !== witness.path || !sameIdentity(witness.identity, identity(await lstat(witness.path, { bigint: true }))))
				fail("A native vault helper changed during provisioning.");
		}
		if (!responseBytes) fail("The native vault helper returned no response.");
		const parsed = decodeNativeVaultProvisioningResponse(responseBytes, nonce);
		key = parsed.key;
		const profile = await validateCreatedProfile(request.parent, parent.handle, parent.dev, parent.ino, parsed);
		assertActive(request.signal, deadline);
		const result = await operation({ profile, key, vaultSha256: parsed.vaultSha256 });
		if (request.signal?.aborted) fail("Native vault provisioning was cancelled.");
		await validateCreatedProfile(request.parent, parent.handle, parent.dev, parent.ino, parsed, false);
		return result;
	} finally {
		releasing = true;
		if (child && !groupReleased) {
			try { await stopProvisionerGroup(child, closed ?? processClose(child)); } catch (error) { cleanupError = new NativeVaultProvisioningCleanupError(error); }
		}
		try {
			channel?.destroy();
			key?.fill(0);
			responseBytes?.fill(0);
			frame?.fill(0);
			nonce.fill(0);
		} finally { await parent.handle.close(); }
		if (cleanupError) throw cleanupError;
	}
}
