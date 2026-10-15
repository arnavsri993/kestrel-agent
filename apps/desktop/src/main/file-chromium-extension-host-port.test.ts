import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
		expect(chromiumExtensionLoadPaths(profile)).toEqual([extensionDir]);
		expect(await port.getExtension(loaded.id)).toMatchObject({
			id: loaded.id,
			path: extensionDir,
			version: "1.2.3",
		});
		await port.removeExtension(loaded.id);
		expect(chromiumExtensionLoadPaths(profile)).toEqual([]);
	});
});
