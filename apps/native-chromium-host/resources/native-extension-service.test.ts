import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChromiumExtensionHostPort } from "../../desktop/src/main/chromium-extension-host-port";
import type { ExtensionRuntimeExtension } from "../../desktop/src/main/extension-runtime";
import { createNativeExtensionService } from "./native-extension-service";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function extensionId(bytes: Buffer): string {
	return Array.from(bytes, (byte) =>
		byte
			.toString(16)
			.padStart(2, "0")
			.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))),
	).join("");
}

function varint(value: number): Buffer {
	const values: number[] = [];
	while (value > 0x7f) {
		values.push((value & 0x7f) | 0x80);
		value >>>= 7;
	}
	values.push(value);
	return Buffer.from(values);
}

function bytesField(field: number, value: Buffer): Buffer {
	return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}

function storedZip(files: Record<string, string>): Buffer {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, contents] of Object.entries(files)) {
		const filename = Buffer.from(name);
		const data = Buffer.from(contents);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt16LE(filename.length, 26);
		locals.push(local, filename, data);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt32LE(data.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(filename.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, filename);
		offset += local.length + filename.length + data.length;
	}
	const centralBuffer = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(centralBuffer.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBuffer, end]);
}

function signedCrx3(
	files: Record<string, string> = {
		"manifest.json": '{"name":"Verified extension","version":"1.0.0"}',
	},
) {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
	const id = extensionId(createHash("sha256").update(publicDer).digest().subarray(0, 16));
	const idBytes = Buffer.from(id.match(/../g)!.map((pair) => Number.parseInt(pair.replace(/[a-p]/g, (letter) => (letter.charCodeAt(0) - 97).toString(16)), 16)));
	const signedHeader = bytesField(1, idBytes);
	const archive = storedZip(files);
	const signedHeaderLength = Buffer.alloc(4);
	signedHeaderLength.writeUInt32LE(signedHeader.length, 0);
	const signature = sign(
		"sha256",
		Buffer.concat([
			Buffer.from("CRX3 SignedData\0"),
			signedHeaderLength,
			signedHeader,
			archive,
		]),
		privateKey,
	);
	const proof = Buffer.concat([bytesField(1, publicDer), bytesField(2, signature)]);
	const header = Buffer.concat([bytesField(2, proof), bytesField(10_000, signedHeader)]);
	const prefix = Buffer.alloc(12);
	prefix.write("Cr24", 0, "utf8");
	prefix.writeUInt32LE(3, 4);
	prefix.writeUInt32LE(header.length, 8);
	return { archive, crx: Buffer.concat([prefix, header, archive]), id, publicDer };
}


// Packages below are actually CRX3 signed and pass the production verifier.
// The only fake is the host transport; these tests make no live CEF claim.
const fixture = signedCrx3({
  "manifest.json": JSON.stringify({ name: "Reviewed native extension", version: "1.0.0", manifest_version: 3 }),
});

function setup(profileRoot = mkdtempSync(join(tmpdir(), "kestrel-native-extension-service-"))) {
  if (!directories.includes(profileRoot)) directories.push(profileRoot);
  const loaded = new Map<string, ExtensionRuntimeExtension>();
  const host: ChromiumExtensionHostPort = {
    loadExtension: vi.fn<ChromiumExtensionHostPort["loadExtension"]>(async (path, options) => {
      expect(options).toEqual({ allowFileAccess: false });
      const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
      const extension = { id: fixture.id, name: manifest.name, version: manifest.version, path, manifest };
      loaded.set(extension.id, extension);
      return { id: extension.id, ready: "passed", extension };
    }),
    removeExtension: vi.fn(async (id) => { loaded.delete(id); }),
    getExtension: vi.fn(async (id) => loaded.get(id) ?? null),
    startServiceWorker: vi.fn(async () => undefined),
  };
  const fetchMock = vi.fn(async () => new Response(new Uint8Array(fixture.crx)));
  vi.stubGlobal("fetch", fetchMock);
  return { service: createNativeExtensionService({ profileRoot, host }), host, profileRoot, fetchMock };
}

async function install(service: ReturnType<typeof createNativeExtensionService>) {
  const inspection = await service.handle({ type: "browser-inspect-extension-url", urlOrId: fixture.id });
  expect(inspection).toMatchObject({ ok: true, extensionInspection: { id: fixture.id } });
  if (!("extensionInspection" in inspection) || !inspection.extensionInspection) throw new Error("Inspection failed");
  const inspectionId = inspection.extensionInspection.inspectionId;
  const installed = await service.handle({ type: "browser-install-extension-url", inspectionId });
  expect(installed).toMatchObject({ ok: true, extension: { id: fixture.id, enabled: true } });
  return inspectionId;
}

describe("Node native extension service", () => {
  it("initializes once without fabricating native readiness for an empty profile", async () => {
    const { service, host } = setup();
    expect(service.initialize()).toBe(service.initialize());
    expect(await service.initialize()).toEqual({ ok: true, extensions: [] });
    expect(await service.handle({ type: "browser-list-extensions" })).toEqual({ ok: true, extensions: [] });
    expect(host.loadExtension).not.toHaveBeenCalled();
  });

  it("rejects non-extension operations, local paths, malformed IDs, and extra authority fields", async () => {
    const { service, host, fetchMock } = setup();
    for (const request of [
      null,
      { type: "browser-install-extension", path: "/private/extension" },
      { type: "browser-install-extension-url", inspectionId: "/private/extension" },
      { type: "browser-install-extension-url", inspectionId: randomUUID(), path: "/private/extension" },
      { type: "browser-toggle-extension", extensionId: "../../private", enabled: true },
      { type: "browser-toggle-extension", extensionId: fixture.id, enabled: "yes" },
      { type: "browser-list-extensions", profileRoot: "/other/profile" },
      { type: "get-system-state" },
    ]) expect(await service.handle(request)).toEqual({ ok: false, error: "This browser extension request is not supported." });
    expect(await service.handle({ type: "browser-inspect-extension-url", urlOrId: "file:///private/extension" })).toEqual({ ok: false, error: "Open a Chrome Web Store extension listing and try again." });
    expect(host.loadExtension).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a manager-owned review UUID and consumes it once", async () => {
    const { service, host } = setup();
    const unreviewed = await service.handle({ type: "browser-install-extension-url", inspectionId: randomUUID() });
    expect(unreviewed).toEqual({ ok: false, error: "That extension review expired. Review the package again before installing it." });
    expect(host.loadExtension).not.toHaveBeenCalled();
    const inspectionId = await install(service);
    expect(await service.handle({ type: "browser-install-extension-url", inspectionId })).toEqual(unreviewed);
    expect(host.loadExtension).toHaveBeenCalledTimes(1);
  });

  it("dispatches disable, enable, reload, list, uninstall and restores only managed packages", async () => {
    const { service, host, profileRoot } = setup();
    await install(service);
    expect(await service.handle({ type: "browser-toggle-extension", extensionId: fixture.id, enabled: false })).toMatchObject({ ok: true, extension: { enabled: false } });
    expect(await service.handle({ type: "browser-reload-extension", extensionId: fixture.id })).toEqual({ ok: false, error: "Enable this extension before reloading it." });
    expect(await service.handle({ type: "browser-toggle-extension", extensionId: fixture.id, enabled: true })).toMatchObject({ ok: true, extension: { enabled: true } });
    expect(await service.handle({ type: "browser-reload-extension", extensionId: fixture.id })).toMatchObject({ ok: true, extension: { enabled: true } });
    expect(host.loadExtension).toHaveBeenCalledTimes(3);
    expect(host.removeExtension).toHaveBeenCalledTimes(2);
    const restarted = setup(profileRoot);
    expect(await restarted.service.initialize()).toMatchObject({ ok: true, extensions: [{ id: fixture.id, enabled: true, compatibility: { runtime: { persistedAcrossRestart: "passed" } } }] });
    expect(restarted.host.loadExtension).toHaveBeenCalledOnce();
    const listed = await restarted.service.handle({ type: "browser-list-extensions" });
    expect(JSON.stringify(listed)).not.toContain(profileRoot);
    expect(await restarted.service.handle({ type: "browser-uninstall-extension", extensionId: fixture.id })).toEqual({ ok: true });
    expect(await restarted.service.handle({ type: "browser-list-extensions" })).toEqual({ ok: true, extensions: [] });
    expect(restarted.host.removeExtension).toHaveBeenCalledWith(fixture.id);
  });

  it("does not consider a pending startup load ready and reports swallowed restore failures", async () => {
    const { service, profileRoot } = setup();
    await install(service);
    const pending = setup(profileRoot);
    vi.mocked(pending.host.loadExtension).mockImplementation(async (path) => ({
      id: fixture.id, ready: "not_checked", extension: { id: fixture.id, name: "Extension", version: "1.0.0", path, manifest: {} },
    }));
    expect(await pending.service.initialize()).toMatchObject({ ok: false, error: expect.stringContaining("could not restore") });
    const failed = setup(profileRoot);
    vi.mocked(failed.host.loadExtension).mockRejectedValue(new Error("CEF load failed /private/internal-profile"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await failed.service.initialize()).toMatchObject({ ok: false, extensions: [{ enabled: false }] });
    expect(JSON.stringify(await failed.service.initialize())).not.toContain("/private/internal-profile");
    expect(await failed.service.handle({ type: "browser-list-extensions" })).toMatchObject({ ok: true, extensions: [{ enabled: false }] });
  });

  it("sanitizes native errors even when they imitate the shared error mapping's allowed prefixes", async () => {
    const { service, host } = setup();
    vi.mocked(host.loadExtension).mockRejectedValue(new Error("Kestrel could not install this extension /private/hidden-cause"));
    const inspection = await service.handle({ type: "browser-inspect-extension-url", urlOrId: fixture.id });
    if (!("extensionInspection" in inspection) || !inspection.extensionInspection) throw new Error("Inspection failed");
    const result = await service.handle({ type: "browser-install-extension-url", inspectionId: inspection.extensionInspection.inspectionId });
    expect(result).toEqual({ ok: false, error: "Kestrel could not install this extension. It may rely on Chrome features that are unavailable here." });
    expect(JSON.stringify(result)).not.toContain("/private");
  });

  it("does not restore a registry record redirected to an arbitrary unpacked directory", async () => {
    const { service, profileRoot } = setup();
    await install(service);
    const registryPath = join(profileRoot, "browser-extensions", "extensions.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    registry[0].path = profileRoot;
    writeFileSync(registryPath, JSON.stringify(registry));
    const restarted = setup(profileRoot);
    expect(await restarted.service.initialize()).toEqual({ ok: true, extensions: [] });
    expect(restarted.host.loadExtension).not.toHaveBeenCalled();
  });
});
