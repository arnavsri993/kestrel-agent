import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawns: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
let helperMode: "success" | "stall" = "success";

vi.mock("node:child_process", () => ({
	spawn: (command: string, args: string[], options: Record<string, unknown>) => {
		spawns.push({ command, args, options });
		const child = new EventEmitter() as EventEmitter & { stdio: Array<unknown>; kill: (signal: string) => boolean };
		if (command === "/usr/bin/codesign") {
			child.stdio = [];
			child.kill = () => true;
			queueMicrotask(() => child.emit("close", 0, null));
			return child;
		}
		let channel!: Duplex;
		channel = new class extends Duplex {
			private chunks: Buffer[] = [];
			_read() {}
			_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { this.chunks.push(Buffer.from(chunk)); callback(); }
			_final(callback: (error?: Error | null) => void) {
				if (helperMode === "stall") { callback(); return; }
				try {
					const request = Buffer.concat(this.chunks), parent = String(options.cwd), profile = join(parent, "profile");
					expect(request.toString("ascii", 0, 4)).toBe("KVP1");
					const nonce = request.subarray(4, 20), parentDev = request.readBigUInt64BE(20), parentIno = request.readBigUInt64BE(28);
					const parentPathLength = request.readUInt32BE(36), parentPath = request.subarray(40).toString("utf8");
					expect(parentPathLength).toBe(Buffer.byteLength(parentPath));
					expect(parentDev).toBeGreaterThan(0n); expect(parentIno).toBeGreaterThan(0n);
					expect(parentPath).toBe(parent);
					mkdirSync(profile, { mode: 0o700 }); chmodSync(profile, 0o700);
					const vault = Buffer.from("generated encrypted local-vault fixture");
					writeFileSync(join(profile, ".kestrel-local-vault-v1"), vault, { mode: 0o600 });
					chmodSync(join(profile, ".kestrel-local-vault-v1"), 0o600);
					const info = statSync(profile, { bigint: true });
					const response = Buffer.alloc(100);
					response.write("KVP2", 0, "ascii"); nonce.copy(response, 4);
					response.writeBigUInt64BE(info.dev, 20); response.writeBigUInt64BE(info.ino, 28);
					createHash("sha256").update(vault).digest().copy(response, 36);
					Buffer.alloc(32, 41).copy(response, 68);
					this.push(response); this.push(null);
					callback();
					queueMicrotask(() => child.emit("close", 0, null));
				} catch (error) { callback(error as Error); }
			}
		}();
		child.stdio = [null, null, null, channel];
		child.kill = () => { channel.destroy(); queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
		return child;
	},
}));

import {
	decodeNativeVaultProvisioningResponse,
	encodeNativeVaultProvisioningRequest,
	withProvisionedNativeVault,
} from "./native-vault-provisioner";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "kestrel-native-vault-client-")); roots.push(root);
	const app = join(root, "Kestrel.app"), contents = join(app, "Contents"), macos = join(contents, "MacOS");
	mkdirSync(macos, { recursive: true, mode: 0o700 }); chmodSync(app, 0o700); chmodSync(contents, 0o700); chmodSync(macos, 0o700);
	const executable = join(macos, "Kestrel Vault Provisioner"), companion = join(macos, "Kestrel Vault");
	for (const path of [executable, companion]) { writeFileSync(path, "generated helper fixture"); chmodSync(path, 0o700); }
	const parent = join(root, "private-parent"); mkdirSync(parent, { mode: 0o700 }); chmodSync(parent, 0o700);
	return { root, app, executable, companion, parent };
}

afterEach(() => {
	helperMode = "success";
	spawns.splice(0);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native vault provisioner host protocol", () => {
	it("frames a UTF-8 parent path and decodes only an exact nonce-bound response", () => {
		const nonce = Buffer.alloc(16, 7), path = "/private/tmp/fixture-é";
		const request = encodeNativeVaultProvisioningRequest(nonce, 0x0102030405060708n, 99n, path);
		expect(request.length).toBe(40 + Buffer.byteLength(path));
		expect(request.toString("ascii", 0, 4)).toBe("KVP1");
		expect(request.subarray(4, 20)).toEqual(nonce);
		expect(request.readBigUInt64BE(20)).toBe(0x0102030405060708n);
		expect(request.readBigUInt64BE(28)).toBe(99n);
		expect(request.readUInt32BE(36)).toBe(Buffer.byteLength(path));
		expect(request.subarray(40).toString("utf8")).toBe(path);

		const response = Buffer.alloc(100); response.write("KVP2", 0, "ascii"); nonce.copy(response, 4);
		response.writeBigUInt64BE(12n, 20); response.writeBigUInt64BE(34n, 28);
		Buffer.alloc(32, 5).copy(response, 36); Buffer.alloc(32, 9).copy(response, 68);
		const decoded = decodeNativeVaultProvisioningResponse(response, nonce);
		expect(decoded.rootDev).toBe(12n); expect(decoded.rootIno).toBe(34n);
		expect(decoded.vaultSha256).toBe(Buffer.alloc(32, 5).toString("hex"));
		expect(decoded.key).toEqual(Buffer.alloc(32, 9));
		for (const bad of [response.subarray(0, 99), Buffer.concat([response, Buffer.from([0])])])
			expect(() => decodeNativeVaultProvisioningResponse(bad, nonce)).toThrow();
		const wrongNonce = Buffer.from(nonce); wrongNonce[0] = wrongNonce[0]! ^ 1;
		expect(() => decodeNativeVaultProvisioningResponse(response, wrongNonce)).toThrow();
	});

	it("launches only after strict helper checks, validates the generated vault, and wipes the callback key", async () => {
		const { executable, parent } = fixture();
		let callbackKey: Buffer | undefined, copySeen: Buffer | undefined;
		const result = await withProvisionedNativeVault({ parent, executable }, ({ profile, key, vaultSha256 }) => {
			callbackKey = key;
			copySeen = Buffer.from(key);
			expect(profile).toBe(join(parent, "profile"));
			expect(vaultSha256).toMatch(/^[a-f0-9]{64}$/);
			return "callback-result";
		});
		expect(result).toBe("callback-result");
		expect(copySeen).toEqual(Buffer.alloc(32, 41));
		expect(callbackKey).toEqual(Buffer.alloc(32));
		expect(spawns.filter(call => call.command === "/usr/bin/codesign")).toHaveLength(2);
		const helper = spawns.find(call => call.command === executable);
		expect(helper?.args).toEqual([]);
		expect((helper?.options.env as NodeJS.ProcessEnv)).toEqual({ PATH: "/usr/bin:/bin" });
		expect((helper?.options.stdio as unknown[])[3]).toBe("pipe");
		expect((helper?.options.stdio as unknown[])[4]).toEqual(expect.any(Number));
		expect(readFileSync(join(parent, "profile", ".kestrel-local-vault-v1"), "utf8")).toBe("generated encrypted local-vault fixture");
	});

	it("cancels and reaps a stalled owned helper without invoking the callback", async () => {
		const { executable, parent } = fixture();
		helperMode = "stall";
		const controller = new AbortController();
		let callbackCalled = false;
		const pending = withProvisionedNativeVault({ parent, executable, signal: controller.signal }, () => { callbackCalled = true; });
		await new Promise(resolve => setTimeout(resolve, 10));
		controller.abort();
		await expect(pending).rejects.toThrow("cancelled");
		expect(callbackCalled).toBe(false);
		const helper = spawns.find(call => call.command === executable);
		expect(helper).toBeDefined();
		expect(existsProfile(parent)).toBe(false);
	});

	it("allows authenticated callers to add Core data while still checking the vault after the callback", async () => {
		const { executable, parent } = fixture();
		await expect(withProvisionedNativeVault({ parent, executable }, ({ profile }) => {
			mkdirSync(join(profile, "native-core"), { mode: 0o700 });
			return "prepared";
		})).resolves.toBe("prepared");
	});

	it.each(["replace", "permissions", "contents"])("refuses vault %s changes during the callback and wipes the borrowed key", async mode => {
		const { executable, parent } = fixture();
		let borrowed: Buffer | undefined;
		await expect(withProvisionedNativeVault({ parent, executable }, ({ profile, key }) => {
			borrowed = key;
			const vault = join(profile, ".kestrel-local-vault-v1");
			if (mode === "replace") { rmSync(vault); writeFileSync(vault, "replaced", { mode: 0o600 }); }
			else if (mode === "permissions") chmodSync(vault, 0o644);
			else writeFileSync(vault, "tampered");
		})).rejects.toThrow();
		expect(borrowed).toEqual(Buffer.alloc(32));
	});

	it("wipes the borrowed key when the callback fails or cancels", async () => {
		for (const cancel of [false, true]) {
			const { executable, parent } = fixture(), controller = new AbortController();
			let borrowed: Buffer | undefined;
			await expect(withProvisionedNativeVault({ parent, executable, signal: controller.signal }, ({ key }) => {
				borrowed = key;
				if (cancel) controller.abort(); else throw new Error("generated callback failure");
			})).rejects.toThrow();
			expect(borrowed).toEqual(Buffer.alloc(32));
		}
	});
});

function existsProfile(parent: string): boolean {
	try { readFileSync(join(parent, "profile", ".kestrel-local-vault-v1")); return true; }
	catch { return false; }
}
