import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RendererRequestSchema } from "@kestrel/shared-types";
import {
	BrowserExtensionManager,
	extractCrxOrZip,
	readExtensionManifest,
	validateChromeWebStoreCrx,
} from "./browser-extension-manager";

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
		const session = {
			extensions: { loadExtension: vi.fn(), removeExtension: vi.fn() },
		};
		expect(manager.list()).toEqual([]);
		await manager.loadAll(session as never);
		expect(session.extensions.loadExtension).not.toHaveBeenCalled();
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
		const session = {
			extensions: {
				loadExtension: vi.fn(async () => ({ id })),
				removeExtension: vi.fn(),
			},
		};
		await expect(
			manager.installFromChromeWebStore(id, session as never),
		).resolves.toMatchObject({ id, source: "chrome_web_store" });
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
		const session = {
			extensions: {
				loadExtension: vi.fn(async () => ({ id })),
				removeExtension: vi.fn(),
			},
		};
		const installed = await manager.installFromChromeWebStore(id, session as never);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("acceptformat=crx3"),
			expect.objectContaining({ redirect: "follow", signal: expect.any(AbortSignal) }),
		);
		expect(session.extensions.loadExtension).toHaveBeenCalledWith(
			join(directory, "browser-extensions", id),
			{ allowFileAccess: false },
		);
		expect(installed.source).toBe("chrome_web_store");
		const manifest = JSON.parse(
			readFileSync(join(directory, "browser-extensions", id, "manifest.json"), "utf8"),
		) as { key?: string };
		expect(manifest.key).toBe(publicDer.toString("base64"));
		expect(manager.list()).toEqual([installed]);
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
		const startWorkerForScope = vi.fn(async () => ({}));
		const manager = new BrowserExtensionManager(directory);
		const session = {
			extensions: {
				loadExtension: vi.fn(async () => ({ id })),
				removeExtension: vi.fn(),
			},
			serviceWorkers: { startWorkerForScope },
		};

		await expect(
			manager.installFromChromeWebStore(id, session as never),
		).resolves.toMatchObject({ id });
		expect(startWorkerForScope).toHaveBeenCalledWith(`chrome-extension://${id}/`);
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
		const session = {
			extensions: {
				loadExtension: vi.fn(async () => ({ id })),
				removeExtension,
			},
			serviceWorkers: {
				startWorkerForScope: vi.fn(async () => {
					throw new Error("unsupported chrome API");
				}),
			},
		};

		await expect(
			manager.installFromChromeWebStore(id, session as never),
		).rejects.toThrow(/does not support/i);
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
			const session = {
				extensions: {
					loadExtension: vi.fn(async () => ({ id })),
					removeExtension,
				},
				serviceWorkers: {
					startWorkerForScope: vi.fn(() => new Promise(() => undefined)),
				},
			};

			const install = manager.installFromChromeWebStore(id, session as never);
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
		const session = {
			extensions: {
				loadExtension: vi.fn(async () => {
					throw new Error("Electron refused extension");
				}),
				removeExtension: vi.fn(),
			},
		};
		await expect(manager.installFromChromeWebStore(id, session as never)).rejects.toThrow(/Electron refused/i);
		expect(manager.list()).toEqual([]);
		expect(existsSync(join(directory, "browser-extensions", id))).toBe(false);
		expect(existsSync(join(directory, "browser-extensions", "extensions.json"))).toBe(false);
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
		const session = {
			extensions: {
				loadExtension: vi.fn(async () => {
					throw new Error("Electron refused replacement");
				}),
				removeExtension: vi.fn(),
			},
		};

		await expect(
			manager.installFromChromeWebStore(id, session as never),
		).rejects.toThrow(/refused replacement/i);
		expect(readFileSync(join(extensionPath, "manifest.json"), "utf8")).toBe(
			legacyManifest,
		);
		expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual([legacy]);
		expect(manager.list()).toEqual([]);
	});

	it("removes the local extension IPC request from the release contract", () => {
		expect(RendererRequestSchema.safeParse({ type: "browser-install-extension-file" }).success).toBe(false);
	});
});
