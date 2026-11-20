import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
	chromiumExtensionLoadPaths,
	chromiumUnpackedExtensionId,
	createFileChromiumExtensionHostPort,
} from "./file-chromium-extension-host-port";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("file Chromium extension host port", () => {
	it("persists verified unpack paths for the native --load-extension lane", async () => {
		const profile = mkdtempSync(join(tmpdir(), "kestrel-chromium-ext-port-"));
		directories.push(profile);
		const extensionDir = join(profile, "extension");
		mkdirSync(extensionDir, { recursive: true });
		writeFileSync(
			join(extensionDir, "manifest.json"),
			JSON.stringify({
				name: "Probe",
				version: "1.2.3",
				manifest_version: 3,
				background: { service_worker: "worker.js" },
			}),
		);
		const port = createFileChromiumExtensionHostPort({ profileRoot: profile });
		const loaded = await port.loadExtension(extensionDir, {
			allowFileAccess: false,
		});
		expect(loaded.id).toEqual(chromiumUnpackedExtensionId(extensionDir));
		expect(loaded.ready).toBe("not_checked");
		expect(chromiumExtensionLoadPaths(profile)).toEqual([realpathSync(extensionDir)]);
		expect(await port.getExtension(loaded.id)).toMatchObject({
			id: loaded.id,
			path: realpathSync(extensionDir),
			version: "1.2.3",
		});
		const reopened = createFileChromiumExtensionHostPort({ profileRoot: profile });
		expect((await reopened.loadExtension(extensionDir, { allowFileAccess: false })).ready).toBe("not_checked");
		await expect(reopened.startServiceWorker(loaded.id)).rejects.toThrow(/cannot verify service-worker startup/);
		await port.removeExtension(loaded.id);
		expect(chromiumExtensionLoadPaths(profile)).toEqual([]);
	});

	it("preserves a keyed extension identity when its unpack directory changes", async () => {
		const profile = mkdtempSync(join(tmpdir(), "kestrel-chromium-ext-key-"));
		directories.push(profile);
		const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const key = publicKey.export({ format: "der", type: "spki" }).toString("base64");
		const port = createFileChromiumExtensionHostPort({ profileRoot: profile });
		const loaded = [];
		for (const name of ["original", "updated"]) {
			const path = join(profile, name);
			mkdirSync(path);
			writeFileSync(join(path, "manifest.json"), JSON.stringify({
				name: "Keyed probe", version: "1.0.0", manifest_version: 3, key,
			}));
			loaded.push(await port.loadExtension(path, { allowFileAccess: false }));
		}
		expect(loaded[1]?.id).toBe(loaded[0]?.id);
		expect(chromiumExtensionLoadPaths(profile)).toEqual([realpathSync(join(profile, "updated"))]);
	});

	it.each(["invalid.base64", 123])("rejects an invalid manifest key before registering it (%s)", async (key) => {
		const profile = mkdtempSync(join(tmpdir(), "kestrel-chromium-ext-bad-key-"));
		directories.push(profile);
		writeFileSync(join(profile, "manifest.json"), JSON.stringify({
			name: "Invalid key", version: "1.0.0", manifest_version: 3, key,
		}));
		const port = createFileChromiumExtensionHostPort({ profileRoot: profile });
		await expect(port.loadExtension(profile, { allowFileAccess: false })).rejects.toThrow(/manifest key/);
		expect(chromiumExtensionLoadPaths(profile)).toEqual([]);
	});

	it("keeps one Chromium identity when an unpacked directory is reached through an alias", async () => {
		const profile = mkdtempSync(join(tmpdir(), "kestrel-chromium-ext-alias-"));
		directories.push(profile);
		const extensionDir = join(profile, "extension");
		mkdirSync(extensionDir);
		writeFileSync(join(extensionDir, "manifest.json"), JSON.stringify({
			name: "Alias probe", version: "1.0.0", manifest_version: 3,
		}));
		const alias = join(profile, "alias");
		symlinkSync(extensionDir, alias, "dir");
		const port = createFileChromiumExtensionHostPort({ profileRoot: profile });
		const loaded = await port.loadExtension(alias, { allowFileAccess: false });
		expect(loaded.id).toBe(chromiumUnpackedExtensionId(extensionDir));
		expect(loaded.extension.path).toBe(realpathSync(extensionDir));
		expect(chromiumExtensionLoadPaths(profile)).toEqual([realpathSync(extensionDir)]);
	});
});
