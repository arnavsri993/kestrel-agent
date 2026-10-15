import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ChromiumExtensionHostPort } from "./chromium-extension-host-port";
import type { ExtensionRuntimeExtension } from "./extension-runtime";

type StoredExtension = {
	id: string;
	path: string;
	allowFileAccess: boolean;
	name: string;
	version: string;
	manifest: unknown;
};

type StoreFile = {
	version: 1;
	extensions: StoredExtension[];
};

/**
 * Chromium derives unpacked extension IDs from a path hash when no public key
 * is present. Map the first 128 SHA-256 bits onto the a-p alphabet Chrome uses.
 */
export function chromiumUnpackedExtensionId(extensionPath: string): string {
	const normalized = resolve(extensionPath);
	const digest = createHash("sha256").update(normalized, "utf8").digest();
	let id = "";
	for (let index = 0; index < 16; index += 1) {
		const value = digest[index] ?? 0;
		id += String.fromCharCode(97 + ((value >> 4) & 0xf));
		id += String.fromCharCode(97 + (value & 0xf));
	}
	return id;
}

function readManifest(extensionPath: string): {
	name: string;
	version: string;
	manifest: Record<string, unknown>;
} {
	const manifestPath = join(extensionPath, "manifest.json");
	if (!existsSync(manifestPath))
		throw new Error("Missing manifest.json in extension directory.");
	const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
		string,
		unknown
	>;
	return {
		name: typeof parsed.name === "string" ? parsed.name : "Extension",
		version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
		manifest: parsed,
	};
}

function loadStore(storePath: string): StoreFile {
	if (!existsSync(storePath)) return { version: 1, extensions: [] };
	try {
		const parsed = JSON.parse(readFileSync(storePath, "utf8")) as StoreFile;
		if (parsed?.version !== 1 || !Array.isArray(parsed.extensions))
			return { version: 1, extensions: [] };
		return parsed;
	} catch {
		return { version: 1, extensions: [] };
	}
}

function saveStore(storePath: string, store: StoreFile): void {
	mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
	writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

/**
 * File-backed host port used by the native Chromium desktop lane. The CEF host
 * reads `load-paths.json` during command-line setup and appends Chromium's
 * `--load-extension` switch for the user-browser profile.
 */
export function createFileChromiumExtensionHostPort(options: {
	profileRoot: string;
}): ChromiumExtensionHostPort {
	const storePath = join(
		options.profileRoot,
		"browser-extensions",
		"chromium-load-paths.json",
	);
	const loadedAtStartup = new Set<string>();

	const syncStartupIds = () => {
		for (const entry of loadStore(storePath).extensions)
			loadedAtStartup.add(entry.id);
	};
	syncStartupIds();

	return {
		async loadExtension(path, loadOptions) {
			const extensionPath = resolve(path);
			const { name, version, manifest } = readManifest(extensionPath);
			const id = chromiumUnpackedExtensionId(extensionPath);
			const store = loadStore(storePath);
			const next: StoredExtension = {
				id,
				path: extensionPath,
				allowFileAccess: loadOptions.allowFileAccess,
				name,
				version,
				manifest,
			};
			store.extensions = [
				...store.extensions.filter((entry) => entry.id !== id),
				next,
			];
			saveStore(storePath, store);
			const extension: ExtensionRuntimeExtension = {
				id,
				name,
				version,
				path: extensionPath,
				manifest,
			};
			const ready = loadedAtStartup.has(id) ? "passed" : "not_checked";
			loadedAtStartup.add(id);
			return { id, ready, extension };
		},
		async removeExtension(id) {
			const store = loadStore(storePath);
			store.extensions = store.extensions.filter((entry) => entry.id !== id);
			saveStore(storePath, store);
			loadedAtStartup.delete(id);
			if (store.extensions.length === 0 && existsSync(storePath))
				rmSync(storePath, { force: true });
		},
		async getExtension(id) {
			const entry = loadStore(storePath).extensions.find((item) => item.id === id);
			if (!entry) return null;
			return {
				id: entry.id,
				name: entry.name,
				version: entry.version,
				path: entry.path,
				manifest: entry.manifest,
			};
		},
		async startServiceWorker(_extensionId) {
			// CEF 152 has no programmatic service-worker wake API. Persistence and
			// content-script evidence come from the native smokes instead.
		},
	};
}

export function chromiumExtensionLoadPaths(profileRoot: string): string[] {
	const storePath = join(
		profileRoot,
		"browser-extensions",
		"chromium-load-paths.json",
	);
	return loadStore(storePath)
		.extensions.map((entry) => entry.path)
		.filter((path) => existsSync(join(path, "manifest.json")));
}
