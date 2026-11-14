import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RendererRequestSchema } from "@kestrel/shared-types";
import {
	BrowserExtensionManager,
	extractCrxOrZip,
	readExtensionManifest,
	validateChromeWebStoreCrx,
} from "./browser-extension-manager";
import type { ExtensionRuntime } from "./extension-runtime";

const directories: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
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
	keys = generateKeyPairSync("rsa", { modulusLength: 2048 }),
) {
	const { privateKey, publicKey } = keys;
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
	return { archive, crx: Buffer.concat([prefix, header, archive]), id, publicDer, keys };
}

function extensionRuntime(
	id: string,
	overrides: Partial<ExtensionRuntime> = {},
): ExtensionRuntime {
	let loadedPath = "";
	const loadExtension =
		overrides.loadExtension ??
		vi.fn(async (path: string) => {
			loadedPath = path;
			return { id, ready: "passed" as const };
		});
	const removeExtension = overrides.removeExtension ?? vi.fn();
	const startServiceWorker = overrides.startServiceWorker ?? vi.fn(async () => undefined);
	return {
		loadExtension,
		removeExtension,
		getExtension:
			overrides.getExtension ??
			vi.fn((extensionId: string) =>
				extensionId === id && loadedPath
					? {
						id,
						name: "Verified extension",
						version: "1.0.0",
						path: loadedPath,
						manifest: {},
					}
					: null,
			),
		startServiceWorker,
		...(overrides.uninstallExtension ? { uninstallExtension: overrides.uninstallExtension } : {}),
	};
}

async function inspectAndInstall(
	manager: BrowserExtensionManager,
	urlOrId: string,
	runtime: ExtensionRuntime,
) {
	const inspection = await manager.inspectChromeWebStore(urlOrId);
	return manager.installInspectedChromeWebStore(inspection.inspectionId, runtime);
}

describe("localized extension manifest metadata", () => {
	it("resolves Chrome manifest message tokens and falls back rather than exposing unresolved tokens", () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		mkdirSync(join(directory, "_locales", "en"), { recursive: true });
		writeFileSync(
			join(directory, "manifest.json"),
			JSON.stringify({
				name: "__MSG_extName__",
				description: "__MSG_extDescription__",
				version: "1.0.0",
				default_locale: "en",
			}),
		);
		writeFileSync(
			join(directory, "_locales", "en", "messages.json"),
			JSON.stringify({
				extName: { message: "Localized extension" },
				extDescription: { message: "Localized description" },
			}),
		);
		expect(readExtensionManifest(directory, "extension-id")).toMatchObject({
			name: "Localized extension",
			description: "Localized description",
		});
		rmSync(join(directory, "_locales"), { recursive: true, force: true });
		const fallback = readExtensionManifest(directory, "extension-id");
		expect(fallback.name).toBe("extension-id");
		expect(fallback).not.toHaveProperty("description");
	});
});

describe("extension uninstall acknowledgement", () => {
	it.each([true, false])("retains registry and package on runtime failure, using explicit uninstall when available (%s)", async (explicit) => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-uninstall-"));
		directories.push(directory);
		const { crx, id } = signedCrx3({
			"manifest.json": JSON.stringify({ name: "Removal fixture", version: "1.0.0", manifest_version: 3 }),
		});
		vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(crx))));
		const manager = new BrowserExtensionManager(directory);
		const remove = vi.fn(async () => undefined);
		const disable = vi.fn(async () => undefined);
		const runtime = extensionRuntime(id, {
			removeExtension: explicit ? disable : remove,
			...(explicit ? { uninstallExtension: remove } : {}),
		});
		await inspectAndInstall(manager, id, runtime);
		const registryPath = join(directory, "browser-extensions", "extensions.json");
		const packagePath = join(directory, "browser-extensions", id);
		const registryBefore = readFileSync(registryPath, "utf8");
		const installedBefore = manager.list();
		remove.mockRejectedValueOnce(new Error("Native uninstall did not complete"));
		await expect(manager.uninstall(id, runtime)).rejects.toThrow("did not complete");
		expect(() => manager.list()).toThrow(/uninstall recovery is required/);
		expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);
		expect(existsSync(join(packagePath, "manifest.json"))).toBe(true);
		await manager.uninstall(id, runtime);
		expect(manager.list()).toEqual([]);
		expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual([]);
		expect(existsSync(packagePath)).toBe(false);
		expect(remove).toHaveBeenCalledTimes(2);
		if (explicit) expect(disable).not.toHaveBeenCalled();
	});
	it("keeps uninstall intent gated when registry persistence fails, then retries", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-uninstall-"));
		directories.push(directory);
		const { crx, id } = signedCrx3();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(crx))));
		const manager = new BrowserExtensionManager(directory);
		const runtime = extensionRuntime(id);
		const installed = await inspectAndInstall(manager, id, runtime);
		vi.spyOn(manager as unknown as { saveRegistry(): void }, "saveRegistry")
			.mockImplementationOnce(() => { throw new Error("Registry persistence failed"); });
		await expect(manager.uninstall(id, runtime)).rejects.toThrow(/Registry persistence failed/);
		expect(() => manager.list()).toThrow(/uninstall recovery is required/);
		expect(existsSync(join(directory, "browser-extensions", id, "manifest.json"))).toBe(true);
		await manager.loadAll(runtime);
		expect(manager.list()).toEqual([]);
		expect(existsSync(join(directory, "browser-extensions", id))).toBe(false);
		expect(installed.id).toBe(id);
	});
	it("resumes an acknowledged runtime uninstall after a process crash before registry commit", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-uninstall-crash-"));
		directories.push(directory);
		const { crx, id } = signedCrx3();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(crx))));
		const manager = new BrowserExtensionManager(directory);
		const runtime = extensionRuntime(id);
		await inspectAndInstall(manager, id, runtime);
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
			const settings = JSON.parse(process.argv[1]);
			const { BrowserExtensionManager } = await import(settings.module);
			const manager = new BrowserExtensionManager(settings.directory);
			manager.saveRegistry = () => process.exit(86);
			await manager.uninstall(settings.id, { removeExtension: async () => {} });
		` , JSON.stringify({ directory, id, module: new URL("./browser-extension-manager.ts", import.meta.url).href })], { encoding: "utf8", timeout: 15_000 });
		expect(child.status).toBe(86);
		const extensionsDirectory = join(directory, "browser-extensions");
		const journalPath = join(extensionsDirectory, ".store-uninstall-journal.json");
		expect(JSON.parse(readFileSync(journalPath, "utf8"))).toEqual({ format: 1, id, source: "chrome_web_store" });
		const restarted = new BrowserExtensionManager(directory);
		expect(() => restarted.list()).toThrow(/uninstall recovery is required/);
		const uninstall = vi.fn(async () => undefined);
		await restarted.loadAll(extensionRuntime(id, { uninstallExtension: uninstall }));
		expect(uninstall).toHaveBeenCalledWith(id);
		expect(restarted.list()).toEqual([]);
		expect(existsSync(journalPath)).toBe(false);
		expect(existsSync(join(extensionsDirectory, id))).toBe(false);
	});
	it.each([
		["oversized", "x".repeat(1025)],
		["external path", JSON.stringify({ format: 1, id: "a".repeat(32), source: "chrome_web_store", path: "/tmp/user-data" })],
	])("rejects %s uninstall journal without touching its payload", (_caseName, payload) => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-uninstall-journal-"));
		directories.push(directory);
		const extensionsDirectory = join(directory, "browser-extensions");
		mkdirSync(extensionsDirectory, { recursive: true });
		const journalPath = join(extensionsDirectory, ".store-uninstall-journal.json");
		writeFileSync(journalPath, payload);
		const manager = new BrowserExtensionManager(directory);
		expect(() => manager.list()).toThrow(/journal could not be verified/);
		expect(readFileSync(journalPath, "utf8")).toBe(payload);
	});

});

describe("reviewed Chrome Web Store updates", () => {
	async function fixture(version = "1.0.0") {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-update-"));
		directories.push(directory);
		const original = signedCrx3({ "manifest.json": JSON.stringify({ name: "Update fixture", version, manifest_version: 3 }) });
		let download = original.crx;
		const fetchMock = vi.fn(async () => new Response(new Uint8Array(download)));
		vi.stubGlobal("fetch", fetchMock);
		const manager = new BrowserExtensionManager(directory);
		let active: ReturnType<ExtensionRuntime["getExtension"]> = null;
		const events: string[] = [];
		const load = vi.fn(async (path: string) => {
			const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
			events.push(`load:${manifest.version}`);
			active = { id: original.id, path, name: manifest.name, version: manifest.version, manifest };
			return { id: original.id, ready: "passed" as const };
		});
		const remove = vi.fn(async () => {
			events.push(`disable:${active?.version ?? "none"}`);
			active = null;
		});
		const uninstall = vi.fn(async () => { throw new Error("Updates must preserve runtime data"); });
		const runtime: ExtensionRuntime = {
			loadExtension: load, removeExtension: remove, uninstallExtension: uninstall,
			getExtension: () => active, startServiceWorker: vi.fn(async () => undefined),
		};
		const installed = await inspectAndInstall(manager, original.id, runtime);
		const packagePath = join(directory, "browser-extensions", original.id);
		const registryPath = join(directory, "browser-extensions", "extensions.json");
		const stage = (nextVersion: string, permissions: string[] = []) => {
			download = signedCrx3({ "manifest.json": JSON.stringify({ name: "Update fixture", version: nextVersion,
				manifest_version: 3, permissions }) }, original.keys).crx;
		};
		return { directory, id: original.id, manager, runtime, load, remove, uninstall, events, installed,
			packagePath, registryPath, stage, fetchMock, active: () => active,
			download: () => download,
			staging: () => readdirSync(join(directory, "browser-extensions")).filter(name => name.startsWith(".inspection-")),
		};
	}

	it.each(["journal", "old-rename", "candidate-swap", "before-registry", "after-registry"])(
		"recovers a real process interruption at %s before exposing or loading candidate bytes", async checkpoint => {
			const f = await fixture();
			f.stage("2.0", ["storage"]);
			const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
				import fs from "node:fs";
				import { syncBuiltinESMExports } from "node:module";
				const settings = JSON.parse(process.argv[1]);
				const { BrowserExtensionManager } = await import(settings.module);
				const stable = settings.directory + "/browser-extensions/" + settings.id;
				const rename = fs.renameSync;
				fs.renameSync = (source, target) => {
					const result = rename(source, target);
					if ((settings.checkpoint === "old-rename" && source === stable && target.endsWith(".backup")) ||
						(settings.checkpoint === "candidate-swap" && source.includes("/.inspection-") && target === stable)) process.exit(86);
					return result;
				};
				syncBuiltinESMExports();
				const manager = new BrowserExtensionManager(settings.directory);
				const writeJournal = manager.writeUpdateJournal.bind(manager);
				manager.writeUpdateJournal = journal => {
					writeJournal(journal);
					if (settings.checkpoint === "journal") process.exit(86);
				};
				const save = manager.saveRegistry.bind(manager);
				manager.saveRegistry = (...args) => {
					if (settings.checkpoint === "before-registry") process.exit(86);
					const result = save(...args);
					if (settings.checkpoint === "after-registry") process.exit(86);
					return result;
				};
				let active = null;
				const runtime = {
					loadExtension: async path => {
						const manifest = JSON.parse(fs.readFileSync(path + "/manifest.json", "utf8"));
						active = { id: settings.id, path, name: manifest.name, version: manifest.version, manifest };
						return { id: settings.id, ready: "passed" };
					},
					removeExtension: async () => { active = null; },
					getExtension: () => active,
					startServiceWorker: async () => {},
				};
				globalThis.fetch = async () => new Response(new Uint8Array(Buffer.from(settings.crx, "base64")));
				const inspection = await manager.inspectChromeWebStore(settings.id);
				await manager.installInspectedChromeWebStore(inspection.inspectionId, runtime);
				throw new Error("The interruption checkpoint was not reached");
			`, JSON.stringify({ directory: f.directory, id: f.id, checkpoint,
				module: new URL("./browser-extension-manager.ts", import.meta.url).href,
				crx: f.download().toString("base64") })], { encoding: "utf8", timeout: 15_000 });
			expect(child.stderr).toBe("");
			expect(child.status).toBe(86);
			const extensionsDirectory = join(f.directory, "browser-extensions");
			const journalPath = join(extensionsDirectory, ".store-update-journal.json");
			const journal = JSON.parse(readFileSync(journalPath, "utf8"));
			expect(journal.previousRecord.version).toBe("1.0.0");
			if (checkpoint === "old-rename") expect(existsSync(f.packagePath)).toBe(false);
			if (["candidate-swap", "before-registry", "after-registry"].includes(checkpoint))
				expect(JSON.parse(readFileSync(join(f.packagePath, "manifest.json"), "utf8")).version).toBe("2.0");
			expect(JSON.parse(readFileSync(f.registryPath, "utf8"))[0].version)
				.toBe(checkpoint === "after-registry" ? "2.0" : "1.0.0");
			const beforeConstructor = readdirSync(extensionsDirectory).sort();
			const restarted = new BrowserExtensionManager(f.directory);
			expect(readdirSync(extensionsDirectory).sort()).toEqual(beforeConstructor);
			expect(() => restarted.list()).toThrow(/recovery is required/);
			await expect(restarted.inspectChromeWebStore(f.id)).rejects.toThrow(/recovery is required/);
			await expect(restarted.uninstall(f.id, f.runtime)).rejects.toThrow(/recovery is required/);
			await expect(restarted.toggle(f.id, false, f.runtime)).rejects.toThrow(/recovery is required/);
			await expect(restarted.reload(f.id, f.runtime)).rejects.toThrow(/recovery is required/);
			await expect(restarted.installInspectedChromeWebStore("missing", f.runtime)).rejects.toThrow(/recovery is required/);
			f.events.length = 0;
			await restarted.loadAll(f.runtime);
			expect(f.events).toEqual(["disable:1.0.0", "load:1.0.0"]);
			expect(restarted.list()[0]).toMatchObject({ version: "1.0.0", installedAt: f.installed.installedAt });
			expect(restarted.list()[0]?.compatibility?.manifest.permissions).toEqual([]);
			expect(existsSync(journalPath)).toBe(false);
			expect(existsSync(join(extensionsDirectory, journal.candidateName, "manifest.json"))).toBe(true);
			expect(JSON.parse(readFileSync(join(extensionsDirectory, journal.candidateName, "manifest.json"), "utf8")).version).toBe("2.0");
			expect(f.uninstall).not.toHaveBeenCalled();
		}, 20_000,
	);

	it("keeps recovery pending across restart while runtime disable is unacknowledged", async () => {
		const f = await fixture();
		f.stage("2.0");
		const load = f.load.getMockImplementation()!;
		f.load.mockImplementationOnce(async path => { await load(path); throw new Error("Candidate failed"); });
		f.remove.mockImplementationOnce(async () => undefined);
		f.remove.mockRejectedValueOnce(new Error("Candidate still active"));
		await expect(inspectAndInstall(f.manager, f.id, f.runtime)).rejects.toThrow(/Runtime state is unresolved/);
		const journalPath = join(f.directory, "browser-extensions", ".store-update-journal.json");
		const before = readdirSync(join(f.directory, "browser-extensions")).sort();
		const restarted = new BrowserExtensionManager(f.directory);
		f.remove.mockRejectedValueOnce(new Error("Runtime unreachable"));
		await expect(restarted.loadAll(f.runtime)).rejects.toThrow(/Runtime unreachable/);
		expect(() => restarted.list()).toThrow(/recovery is required/);
		expect(readdirSync(join(f.directory, "browser-extensions")).sort()).toEqual(before);
		expect(existsSync(journalPath)).toBe(true);
		await restarted.loadAll(f.runtime);
		expect(restarted.list()[0]?.version).toBe("1.0.0");
		expect(existsSync(journalPath)).toBe(false);
	});

	it("requires a fresh exact-package review for new access and disables old runtime before replacing files", async () => {
		const f = await fixture();
		const oldReview = await f.manager.inspectChromeWebStore(f.id);
		await f.manager.installInspectedChromeWebStore(oldReview.inspectionId, f.runtime);
		f.stage("1.2.0", ["storage"]);
		const review = await f.manager.inspectChromeWebStore(f.id);
		expect(review.inspectionId).not.toBe(oldReview.inspectionId);
		expect(review.compatibility.manifest.permissions).toContain("storage");
		expect(f.manager.list()[0]?.version).toBe("1.0.0");
		await expect(f.manager.installInspectedChromeWebStore(oldReview.inspectionId, f.runtime)).rejects.toThrow(/expired/);
		// A different Store response cannot change the already reviewed bytes.
		f.stage("1.3.0", ["tabs"]);
		const installed = await f.manager.installInspectedChromeWebStore(review.inspectionId, f.runtime);
		expect(installed).toMatchObject({ version: "1.2.0", installedAt: f.installed.installedAt, enabled: true });
		expect(f.active()?.version).toBe("1.2.0");
		expect(f.events).toEqual(["load:1.0.0", "disable:1.0.0", "load:1.2.0"]);
		expect(f.uninstall).not.toHaveBeenCalled();
		expect(f.fetchMock).toHaveBeenCalledTimes(3);
		expect(f.staging()).toEqual([]);
	});

	it("cleans same-version staging and treats missing version components as zero", async () => {
		const f = await fixture("1");
		f.stage("1.0.0.0");
		const installed = await inspectAndInstall(f.manager, f.id, f.runtime);
		expect(installed).toEqual(f.installed);
		expect(f.load).toHaveBeenCalledTimes(1);
		expect(f.remove).not.toHaveBeenCalled();
		expect(f.staging()).toEqual([]);
	});

	it("rejects numeric downgrades without touching the installed package or runtime", async () => {
		const f = await fixture("1.10.0");
		f.stage("1.9.65535");
		await expect(inspectAndInstall(f.manager, f.id, f.runtime)).rejects.toThrow(/downgrade/);
		expect(f.manager.list()).toEqual([f.installed]);
		expect(JSON.parse(readFileSync(join(f.packagePath, "manifest.json"), "utf8")).version).toBe("1.10.0");
		expect(f.remove).not.toHaveBeenCalled();
		expect(f.staging()).toEqual([]);
	});

	it.each(["0", "0.0.0.0", "01.1", "1.00", "65536", "1.2.3.4.5", "1.beta"])("rejects invalid Chrome version %s during review", async (version) => {
		const f = await fixture();
		f.stage(version);
		await expect(f.manager.inspectChromeWebStore(f.id)).rejects.toThrow(/version is invalid/);
		expect(f.manager.list()).toEqual([f.installed]);
		expect(f.staging()).toEqual([]);
	});

	it("preserves a disabled extension and install date without loading the new version", async () => {
		const f = await fixture();
		await f.manager.toggle(f.id, false, f.runtime);
		f.stage("2.0");
		const installed = await inspectAndInstall(f.manager, f.id, f.runtime);
		expect(installed).toMatchObject({ version: "2.0", enabled: false, installedAt: f.installed.installedAt });
		expect(f.load).toHaveBeenCalledTimes(1);
		expect(f.active()).toBeNull();
		expect(f.uninstall).not.toHaveBeenCalled();
	});

	it("disables a partially loaded candidate before restoring and reactivating the old version", async () => {
		const f = await fixture();
		const registryBefore = readFileSync(f.registryPath, "utf8");
		f.stage("2.0");
		const originalLoad = f.load.getMockImplementation()!;
		f.load.mockImplementationOnce(async path => {
			await originalLoad(path);
			throw new Error("Candidate startup failed");
		});
		await expect(inspectAndInstall(f.manager, f.id, f.runtime)).rejects.toThrow(/Candidate startup failed/);
		expect(f.events).toEqual(["load:1.0.0", "disable:1.0.0", "load:2.0", "disable:2.0", "load:1.0.0"]);
		expect(f.manager.list()).toEqual([f.installed]);
		expect(JSON.parse(readFileSync(f.registryPath, "utf8"))).toEqual(JSON.parse(registryBefore));
		expect(f.active()?.version).toBe("1.0.0");
		expect(f.uninstall).not.toHaveBeenCalled();
	});

	it("restores the old registry and live package when persistence of an update fails", async () => {
		const f = await fixture();
		const registryBefore = readFileSync(f.registryPath, "utf8");
		f.stage("2.0");
		vi.spyOn(f.manager as unknown as { saveRegistry(): void }, "saveRegistry")
			.mockImplementationOnce(() => { throw new Error("Registry write failed"); });
		await expect(inspectAndInstall(f.manager, f.id, f.runtime)).rejects.toThrow(/Registry write failed/);
		expect(f.manager.list()).toEqual([f.installed]);
		expect(JSON.parse(readFileSync(f.registryPath, "utf8"))).toEqual(JSON.parse(registryBefore));
		expect(f.active()?.version).toBe("1.0.0");
		expect(f.events).toEqual(["load:1.0.0", "disable:1.0.0", "load:2.0", "disable:2.0", "load:1.0.0"]);
	});

	it("leaves old files and registry untouched when old-runtime disable is rejected", async () => {
		const f = await fixture();
		f.stage("2.0");
		f.remove.mockRejectedValueOnce(new Error("Old runtime disable failed"));
		await expect(inspectAndInstall(f.manager, f.id, f.runtime)).rejects.toThrow(/Old runtime disable failed/);
		expect(f.manager.list()).toEqual([f.installed]);
		expect(f.active()?.version).toBe("1.0.0");
		expect(JSON.parse(readFileSync(join(f.packagePath, "manifest.json"), "utf8")).version).toBe("1.0.0");
		expect(f.load).toHaveBeenCalledTimes(1);
		expect(f.staging()).toEqual([]);
	});

	it("rolls back when the candidate cannot acknowledge live readiness", async () => {
		const f = await fixture();
		f.stage("2.0");
		const originalLoad = f.load.getMockImplementation()!;
		f.runtime.loadExtension = vi.fn(async path => {
			const loaded = await originalLoad(path);
			return { ...loaded, ready: f.active()?.version === "2.0" ? "not_checked" as const : "passed" as const };
		});
		await expect(inspectAndInstall(f.manager, f.id, f.runtime)).rejects.toThrow(/live readiness acknowledgement/);
		expect(f.active()?.version).toBe("1.0.0");
		expect(f.manager.list()).toEqual([f.installed]);
	});

	it("rejects stale old-version runtime registration at the unchanged stable path", async () => {
		const f = await fixture();
		f.stage("2.0");
		f.runtime.getExtension = () => {
			const observed = f.active();
			return observed ? { ...observed, version: "1.0.0" } : null;
		};
		await expect(inspectAndInstall(f.manager, f.id, f.runtime)).rejects.toThrow(/did not register the verified package/);
		expect(f.manager.list()).toEqual([f.installed]);
		expect(f.active()?.version).toBe("1.0.0");
	});

	it("retains candidate files and the backup when candidate disable is not acknowledged", async () => {
		const f = await fixture();
		f.stage("2.0");
		const originalLoad = f.load.getMockImplementation()!;
		f.load.mockImplementationOnce(async path => { await originalLoad(path); throw new Error("Candidate failed"); });
		f.remove.mockImplementationOnce(async () => { f.events.push("disable:old"); });
		f.remove.mockRejectedValueOnce(new Error("Candidate disable failed"));
		await expect(inspectAndInstall(f.manager, f.id, f.runtime)).rejects.toThrow(/Runtime state is unresolved/);
		expect(f.active()?.version).toBe("2.0");
		expect(JSON.parse(readFileSync(join(f.packagePath, "manifest.json"), "utf8")).version).toBe("2.0");
		const backup = readdirSync(join(f.directory, "browser-extensions")).find(name => name.endsWith(".backup"));
		expect(backup).toBeDefined();
		expect(JSON.parse(readFileSync(join(f.directory, "browser-extensions", backup!, "manifest.json"), "utf8")).version).toBe("1.0.0");
		expect(() => f.manager.list()).toThrow(/recovery is required/);
		expect(f.uninstall).not.toHaveBeenCalled();
	});
});

describe("Chrome Web Store browser version", () => {
	it("advertises a validated explicit runtime version", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-version-"));
		directories.push(directory);
		const { crx, id } = signedCrx3();
		const fetchMock = vi.fn(async () => new Response(new Uint8Array(crx)));
		vi.stubGlobal("fetch", fetchMock);
		await new BrowserExtensionManager(directory, { chromiumVersion: "152.0.6.0" }).inspectChromeWebStore(id);
		expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("prodversion=152.0.6.0&"), expect.anything());
	});

	it.each(["152", "152.0.6", "01.0.0.0", "1.0.0.65536", "152.0.6.0&x=other", "0.0.0.0"])("rejects invalid browser version %s", version => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-version-"));
		directories.push(directory);
		expect(() => new BrowserExtensionManager(directory, { chromiumVersion: version })).toThrow(/version/);
	});
});

describe("Chrome Web Store CRX validation", () => {
	it("accepts a CRX3 whose signed identity and public key match the requested extension", () => {
		const { archive, crx, id } = signedCrx3();
		expect(validateChromeWebStoreCrx(crx, id)).toMatchObject({ archive });
	});

	it("rejects unverifiable archive input and mismatched identities", () => {
		const { archive, crx, id } = signedCrx3();
		expect(() => validateChromeWebStoreCrx(archive, id)).toThrow(/verifiable CRX3/i);
		expect(() => validateChromeWebStoreCrx(crx, "a".repeat(32))).toThrow(/identity/i);
		const tampered = Buffer.from(crx);
		const lastIndex = tampered.length - 1;
		const lastByte = tampered[lastIndex];
		if (lastByte === undefined) throw new Error("Expected a non-empty CRX");
		tampered[lastIndex] = lastByte ^ 1;
		expect(() => validateChromeWebStoreCrx(tampered, id)).toThrow(/signature/i);
	});

	it("rejects archive paths that could escape the managed extension directory", () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const destination = join(directory, "managed");
		mkdirSync(destination, { recursive: true });
		expect(() =>
			extractCrxOrZip(storedZip({ "../escaped.txt": "unsafe" }), destination),
		).toThrow(/path traversal/i);
		expect(existsSync(join(directory, "escaped.txt"))).toBe(false);
	});
});

describe("BrowserExtensionManager release gates", () => {
	it("hides and does not load legacy local registry entries without deleting their registry data", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const localPath = join(directory, "legacy-local");
		mkdirSync(localPath, { recursive: true });
		const registryPath = join(directory, "browser-extensions", "extensions.json");
		mkdirSync(join(directory, "browser-extensions"), { recursive: true });
		const legacy = [{
			id: "ext-local",
			name: "Legacy local extension",
			version: "1.0.0",
			enabled: true,
			source: "unpacked",
			path: localPath,
			installedAt: "2026-01-01T00:00:00.000Z",
		}];
		writeFileSync(registryPath, JSON.stringify(legacy));
		const manager = new BrowserExtensionManager(directory);
		const runtime = extensionRuntime("ext-local");
		expect(manager.list()).toEqual([]);
		await manager.loadAll(runtime);
		expect(runtime.loadExtension).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual(legacy);
		await expect(manager.installFromUnpacked(localPath)).rejects.toThrow(/development builds/i);
	});

	it("preserves an unverifiable legacy store record until a verified reinstall replaces it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const { crx, id } = signedCrx3();
		const extensionPath = join(directory, "browser-extensions", id);
		mkdirSync(extensionPath, { recursive: true });
		writeFileSync(
			join(extensionPath, "manifest.json"),
			JSON.stringify({ name: "Legacy store extension", version: "1.0.0" }),
		);
		const registryPath = join(directory, "browser-extensions", "extensions.json");
		const legacy = {
			id,
			name: "Legacy store extension",
			version: "1.0.0",
			enabled: true,
			source: "chrome_web_store",
			path: extensionPath,
			installedAt: "2026-01-01T00:00:00.000Z",
		};
		writeFileSync(registryPath, JSON.stringify([legacy]));
		const manager = new BrowserExtensionManager(directory);
		expect(manager.list()).toEqual([]);
		expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual([legacy]);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength),
			})),
		);
		const runtime = extensionRuntime(id);
		await expect(inspectAndInstall(manager, id, runtime)).resolves.toMatchObject({
			id,
			source: "chrome_web_store",
		});
		expect(JSON.parse(readFileSync(registryPath, "utf8"))).toHaveLength(1);
		expect(manager.list()).toHaveLength(1);
	});

	it("persists a store record only after Electron confirms the expected verified identity", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const { crx, id, publicDer } = signedCrx3();
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const manager = new BrowserExtensionManager(directory);
		const runtime = extensionRuntime(id);
		const installed = await inspectAndInstall(manager, id, runtime);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("acceptformat=crx3"),
			expect.objectContaining({ redirect: "follow", signal: expect.any(AbortSignal) }),
		);
		expect(runtime.loadExtension).toHaveBeenCalledWith(
			join(directory, "browser-extensions", id),
			{ allowFileAccess: false },
		);
		expect(installed.source).toBe("chrome_web_store");
		const manifest = JSON.parse(
			readFileSync(join(directory, "browser-extensions", id, "manifest.json"), "utf8"),
		) as { key?: string };
		expect(manifest.key).toBe(publicDer.toString("base64"));
		expect(manager.list()).toEqual([installed]);
		expect(installed).not.toHaveProperty("path");
	});

	it("keeps an inspected package temporary and consumes its reviewed token once", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const { crx, id } = signedCrx3({
			"manifest.json": JSON.stringify({
				name: "Reviewed extension",
				version: "1.0.0",
				manifest_version: 3,
			}),
		});
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () =>
				crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const manager = new BrowserExtensionManager(directory);
		const inspection = await manager.inspectChromeWebStore(id);

		expect(inspection).not.toHaveProperty("path");
		expect(manager.list()).toEqual([]);
		expect(existsSync(join(directory, "browser-extensions", id))).toBe(false);

		const installed = await manager.installInspectedChromeWebStore(
			inspection.inspectionId,
			extensionRuntime(id),
		);
		expect(installed).not.toHaveProperty("path");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await expect(
			manager.installInspectedChromeWebStore(
				inspection.inspectionId,
				extensionRuntime(id),
			),
		).rejects.toThrow(/review has expired/i);
	});

	it("blocks an explicitly unsupported reviewed package before runtime loading", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const { crx, id } = signedCrx3({
			"manifest.json": JSON.stringify({
				name: "Unsupported storage extension",
				version: "1.0.0",
				manifest_version: 3,
			}),
			"worker.js": "chrome.storage.sync.set({ enabled: true });",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength),
			})),
		);
		const manager = new BrowserExtensionManager(directory);
		const inspection = await manager.inspectChromeWebStore(id);
		const runtime = extensionRuntime(id);

		expect(inspection.compatibility.state).toBe("unsupported");
		await expect(
			manager.installInspectedChromeWebStore(inspection.inspectionId, runtime),
		).rejects.toThrow(/will not install/i);
		expect(runtime.loadExtension).not.toHaveBeenCalled();
		expect(manager.list()).toEqual([]);
	});

	it("preserves a saved extension when an older compatibility report cannot be parsed, then verifies persistence after a restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const { crx, id } = signedCrx3({
			"manifest.json": JSON.stringify({
				name: "Persistent extension",
				version: "1.0.0",
				manifest_version: 3,
			}),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength),
			})),
		);
		const initialManager = new BrowserExtensionManager(directory);
		await inspectAndInstall(initialManager, id, extensionRuntime(id));
		const registryPath = join(directory, "browser-extensions", "extensions.json");
		const persisted = JSON.parse(readFileSync(registryPath, "utf8")) as Array<{
			compatibility?: unknown;
		}>;
		persisted[0]!.compatibility = { state: "expected_compatible" };
		writeFileSync(registryPath, JSON.stringify(persisted));

		const restartedManager = new BrowserExtensionManager(directory);
		expect(restartedManager.list()).toHaveLength(1);
		expect(restartedManager.list()[0]?.compatibility?.state).toBe("unknown");

		await restartedManager.loadAll(extensionRuntime(id));
		const restored = restartedManager.list()[0];
		expect(restored).toBeDefined();
		expect(restored).not.toHaveProperty("path");
		// The malformed legacy report is not treated as proof. A future review
		// can replace it, while this restart still proves the package was loaded.
		expect(restored?.compatibility?.runtime.persistedAcrossRestart).toBe(
			"passed",
		);
	});

	it("marks a basic expected-compatible package Verified only after a new manager reloads it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const { crx, id } = signedCrx3({
			"manifest.json": JSON.stringify({
				name: "Restart verified extension",
				version: "1.0.0",
				manifest_version: 3,
			}),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength),
			})),
		);
		const initialManager = new BrowserExtensionManager(directory);
		const installed = await inspectAndInstall(
			initialManager,
			id,
			extensionRuntime(id),
		);
		expect(installed.compatibility?.state).toBe("expected_compatible");

		const restartedManager = new BrowserExtensionManager(directory);
		await restartedManager.loadAll(extensionRuntime(id));
		const restored = restartedManager.list()[0];
		expect(restored?.compatibility?.runtime.status).toBe("passed");
		expect(restored?.compatibility?.state).toBe("verified");
	});

	it("confirms a Manifest V3 background worker can start before persisting", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const { crx, id } = signedCrx3({
			"manifest.json": JSON.stringify({
				name: "Worker extension",
				version: "1.0.0",
				manifest_version: 3,
				background: { service_worker: "worker.js" },
			}),
			"worker.js": "void 0;",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength),
			})),
		);
		const startServiceWorker = vi.fn(async () => undefined);
		const manager = new BrowserExtensionManager(directory);
		const runtime = extensionRuntime(id, { startServiceWorker });

		await expect(inspectAndInstall(manager, id, runtime)).resolves.toMatchObject({
			id,
		});
		expect(startServiceWorker).toHaveBeenCalledWith(id);
		expect(manager.list()).toHaveLength(1);
	});

	it("rejects and cleans up a store extension whose background worker cannot start", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const { crx, id } = signedCrx3({
			"manifest.json": JSON.stringify({
				name: "Unsupported worker extension",
				version: "1.0.0",
				manifest_version: 3,
				background: { service_worker: "worker.js" },
			}),
			"worker.js": "void 0;",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength),
			})),
		);
		const removeExtension = vi.fn();
		const manager = new BrowserExtensionManager(directory);
		const runtime = extensionRuntime(id, {
			removeExtension,
			startServiceWorker: vi.fn(async () => {
					throw new Error("unsupported chrome API");
			}),
		});

		await expect(inspectAndInstall(manager, id, runtime)).rejects.toThrow(
			/does not support/i,
		);
		expect(removeExtension).toHaveBeenCalledWith(id);
		expect(manager.list()).toEqual([]);
		expect(existsSync(join(directory, "browser-extensions", id))).toBe(false);
	});

	it("times out and cleans up a background worker that never starts", async () => {
		vi.useFakeTimers();
		try {
			const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
			directories.push(directory);
			const { crx, id } = signedCrx3({
				"manifest.json": JSON.stringify({
					name: "Stalled worker extension",
					version: "1.0.0",
					manifest_version: 3,
					background: { service_worker: "worker.js" },
				}),
				"worker.js": "void 0;",
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({
					ok: true,
					status: 200,
					arrayBuffer: async () =>
						crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength),
				})),
			);
			const removeExtension = vi.fn();
			const manager = new BrowserExtensionManager(directory);
			const runtime = extensionRuntime(id, {
				removeExtension,
				startServiceWorker: vi.fn(() => new Promise<void>(() => undefined)),
			});

			const install = inspectAndInstall(manager, id, runtime);
			const rejection = expect(install).rejects.toThrow(/could not start/i);
			await vi.advanceTimersByTimeAsync(10_001);

			await rejection;
			expect(removeExtension).toHaveBeenCalledWith(id);
			expect(manager.list()).toEqual([]);
			expect(existsSync(join(directory, "browser-extensions", id))).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not persist a success record or leave managed files when Electron rejects a verified store install", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const { crx, id } = signedCrx3();
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength),
		})));
		const manager = new BrowserExtensionManager(directory);
		const runtime = extensionRuntime(id, {
			loadExtension: vi.fn(async () => {
					throw new Error("Electron refused extension");
				}),
		});
		await expect(inspectAndInstall(manager, id, runtime)).rejects.toThrow(
			/Electron refused/i,
		);
		expect(manager.list()).toEqual([]);
		expect(existsSync(join(directory, "browser-extensions", id))).toBe(false);
		expect(JSON.parse(readFileSync(join(directory, "browser-extensions", "extensions.json"), "utf8"))).toEqual([]);
	});

	it("restores a preserved legacy store directory when verified reinstall loading fails", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-"));
		directories.push(directory);
		const { crx, id } = signedCrx3();
		const extensionPath = join(directory, "browser-extensions", id);
		mkdirSync(extensionPath, { recursive: true });
		const legacyManifest = JSON.stringify({
			name: "Preserved legacy extension",
			version: "0.9.0",
		});
		writeFileSync(join(extensionPath, "manifest.json"), legacyManifest);
		const registryPath = join(directory, "browser-extensions", "extensions.json");
		const legacy = {
			id,
			name: "Preserved legacy extension",
			version: "0.9.0",
			enabled: true,
			source: "chrome_web_store",
			path: extensionPath,
			installedAt: "2026-01-01T00:00:00.000Z",
		};
		writeFileSync(registryPath, JSON.stringify([legacy]));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () =>
					crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.byteLength),
			})),
		);
		const manager = new BrowserExtensionManager(directory);
		const runtime = extensionRuntime(id, {
			loadExtension: vi.fn(async () => {
					throw new Error("Electron refused replacement");
				}),
		});

		await expect(inspectAndInstall(manager, id, runtime)).rejects.toThrow(
			/refused replacement/i,
		);
		expect(readFileSync(join(extensionPath, "manifest.json"), "utf8")).toBe(
			legacyManifest,
		);
		expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual([legacy]);
		expect(manager.list()).toEqual([]);
	});

	it("removes the local extension IPC request from the release contract", () => {
		expect(RendererRequestSchema.safeParse({ type: "browser-install-extension-file" }).success).toBe(false);
		expect(
			RendererRequestSchema.safeParse({
				type: "browser-install-extension-url",
				urlOrId: "a".repeat(32),
			}).success,
		).toBe(false);
		expect(
			RendererRequestSchema.safeParse({
				type: "browser-inspect-extension-url",
				urlOrId: "a".repeat(32),
			}).success,
		).toBe(true);
	});
});
