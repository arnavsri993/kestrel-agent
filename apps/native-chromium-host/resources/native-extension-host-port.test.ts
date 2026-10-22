import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeExtensionHostPort, type NativeExtensionRequest } from "./native-extension-host-port";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
	.export({ type: "spki", format: "der" }) as Buffer;
const id = createHash("sha256").update(key).digest("hex").slice(0, 32)
	.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));

function setup() {
	const profileRoot = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-native-port-")));
	directories.push(profileRoot);
	const path = join(profileRoot, "browser-extensions", id);
	mkdirSync(path, { recursive: true });
	const manifest = { name: "Trusted package", version: "1.2.3", manifest_version: 3, key: key.toString("base64") };
	writeFileSync(join(path, "manifest.json"), JSON.stringify(manifest));
	const ack = { id, name: "Untrusted host display name", version: manifest.version, path, enabled: true, fileAccess: false, ready: "passed" };
	const request = vi.fn<NativeExtensionRequest>(async (operation) => operation === "load" || operation === "get" ? ack : {});
	return { profileRoot, path, manifest, ack, request, host: createNativeExtensionHostPort({ profileRoot, request }) };
}

describe("private native extension host port", () => {
	it("validates the live load acknowledgement and uses bounded trusted package metadata", async () => {
		const { host, path, manifest, request } = setup();
		const loaded = await host.loadExtension(path, { allowFileAccess: false });
		expect(loaded).toEqual({ id, ready: "passed", extension: { id, path, name: manifest.name, version: manifest.version, manifest } });
		expect(request).toHaveBeenCalledWith("load", { id, path, allowFileAccess: false });
		expect(await host.getExtension(id)).toEqual(loaded.extension);
		expect(request).toHaveBeenLastCalledWith("get", { id });
	});

	it("keeps disable separate from permanent uninstall and worker activation", async () => {
		const { host, request } = setup();
		await host.removeExtension(id);
		await host.uninstallExtension!(id);
		await host.startServiceWorker(id);
		expect(request.mock.calls).toEqual([["disable", { id }], ["uninstall", { id }], ["start-worker", { id }]]);
	});

	it("preserves uncertainty and never invents passed readiness", async () => {
		const { host, path, ack } = setup();
		ack.ready = "not_checked";
		expect(await host.loadExtension(path, { allowFileAccess: false })).toMatchObject({ ready: "not_checked" });
	});

	it.each([
		{ id: "a".repeat(32) },
		{ version: "9.9.9" },
		{ path: "/private/some-other-package" },
		{ fileAccess: true },
		{ ready: undefined },
		{ ready: "startup-path-saved" },
	])("rejects a mismatched or unverified native acknowledgement %j", async (override) => {
		const { host, path, ack } = setup();
		Object.assign(ack, override);
		await expect(host.loadExtension(path, { allowFileAccess: false })).rejects.toThrow("did not confirm");
		await expect(host.getExtension(id)).rejects.toThrow("did not confirm");
	});

	it("does not turn an absent extension into a ready registry entry", async () => {
		const { host, request } = setup();
		request.mockResolvedValue(null);
		expect(await host.getExtension(id)).toBeNull();
		request.mockResolvedValue({ absent: true });
		expect(await host.getExtension(id)).toBeNull();
		request.mockResolvedValue({ absent: true, id: "a".repeat(32) });
		await expect(host.getExtension(id)).rejects.toThrow("did not confirm");
	});

	it("treats a disabled native installation as absent only after validating its identity and file permissions", async () => {
		const { host, path, ack } = setup();
		ack.enabled = false;
		await expect(host.loadExtension(path, { allowFileAccess: false })).rejects.toThrow("did not confirm");
		expect(await host.getExtension(id)).toBeNull();
		ack.fileAccess = true;
		await expect(host.getExtension(id)).rejects.toThrow("did not confirm");
		ack.fileAccess = false;
		ack.version = "wrong-version";
		await expect(host.getExtension(id)).rejects.toThrow("did not confirm");
	});

	it("rejects non-owned paths, file grants, and malformed IDs before native RPC", async () => {
		const { host, path, profileRoot, request } = setup();
		const externalPath = join(profileRoot, "other", id);
		mkdirSync(externalPath, { recursive: true });
		writeFileSync(join(externalPath, "manifest.json"), readFileSync(join(path, "manifest.json")));
		await expect(host.loadExtension(externalPath, { allowFileAccess: false })).rejects.toThrow("could not be verified");
		await expect(host.loadExtension(path, { allowFileAccess: true })).rejects.toThrow("could not be verified");
		await expect(host.removeExtension("../../other")).rejects.toThrow("could not be verified");
		await expect(host.getExtension("a".repeat(31))).rejects.toThrow("could not be verified");
		expect(request).not.toHaveBeenCalled();
	});

	it.each(["package", "manifest", "parent"])("rejects a symlink escape through the %s", async (surface) => {
		const { host, path, profileRoot, request } = setup();
		if (surface === "package") {
			const target = join(profileRoot, "outside-package");
			renameSync(path, target);
			symlinkSync(target, path);
		} else if (surface === "manifest") {
			const target = join(profileRoot, "outside-manifest.json");
			renameSync(join(path, "manifest.json"), target);
			symlinkSync(target, join(path, "manifest.json"));
		} else {
			const target = join(profileRoot, "outside-store");
			renameSync(join(profileRoot, "browser-extensions"), target);
			symlinkSync(target, join(profileRoot, "browser-extensions"));
		}
		await expect(host.loadExtension(path, { allowFileAccess: false })).rejects.toThrow("could not be verified");
		expect(request).not.toHaveBeenCalled();
	});

	it.each(["oversize", "invalid-json", "wrong-key", "missing-key"])("rejects an invalid bounded manifest: %s", async (failure) => {
		const { host, path, manifest, request } = setup();
		const contents = failure === "oversize" ? " ".repeat(1024 * 1024 + 1)
			: failure === "invalid-json" ? "{broken"
			: JSON.stringify({ ...manifest, key: failure === "missing-key" ? undefined : Buffer.from("not a public key").toString("base64") });
		writeFileSync(join(path, "manifest.json"), contents);
		await expect(host.loadExtension(path, { allowFileAccess: false })).rejects.toThrow("could not be verified");
		expect(request).not.toHaveBeenCalled();
	});

	it("rejects a valid public key with a different signed identity", async () => {
		const { host, path, manifest, request } = setup();
		const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" });
		writeFileSync(join(path, "manifest.json"), JSON.stringify({ ...manifest, key: otherKey.toString("base64") }));
		await expect(host.loadExtension(path, { allowFileAccess: false })).rejects.toThrow("could not be verified");
		expect(request).not.toHaveBeenCalled();
	});

	it.each(["disable", "uninstall", "start-worker"] as const)("does not swallow %s acknowledgement failures", async (operation) => {
		const { host, request } = setup();
		request.mockResolvedValue({ ok: false, error: "native failed" });
		const invoke = operation === "disable" ? host.removeExtension : operation === "uninstall" ? host.uninstallExtension! : host.startServiceWorker;
		await expect(invoke(id)).rejects.toThrow("did not confirm");
	});
});
