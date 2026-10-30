import { createHash, createPublicKey } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ChromiumExtensionHostPort } from "../../desktop/src/main/chromium-extension-host-port";
import type { ExtensionRuntimeExtension } from "../../desktop/src/main/extension-runtime";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const PACKAGE_ERROR = "The native extension package could not be verified.";
const ACK_ERROR = "The native browser did not confirm the requested extension state.";

type NativeExtensionRpc = {
	load: { id: string; path: string; allowFileAccess: false };
	disable: { id: string };
	uninstall: { id: string };
	get: { id: string };
	"start-worker": { id: string };
};

export type NativeExtensionRequest = <Operation extends keyof NativeExtensionRpc>(
	operation: Operation,
	fields: NativeExtensionRpc[Operation],
) => Promise<unknown>;

function extensionId(id: string): void {
	if (!/^[a-p]{32}$/.test(id)) throw new Error(PACKAGE_ERROR);
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Private, bounded native RPC adapter; no renderer paths or CDP commands. */
export function createNativeExtensionHostPort({
	profileRoot,
	request,
}: {
	profileRoot: string;
	request: NativeExtensionRequest;
}): ChromiumExtensionHostPort {
	function readPackage(id: string, requestedPath?: string): ExtensionRuntimeExtension {
		extensionId(id);
		let descriptor: number | undefined;
		try {
			const canonicalProfile = realpathSync(profileRoot);
			const path = join(canonicalProfile, "browser-extensions", id);
			// Exact canonical location rejects both directory and ancestor links.
			if (realpathSync(path) !== path) throw new Error(PACKAGE_ERROR);
			if (requestedPath !== undefined && realpathSync(resolve(requestedPath)) !== path)
				throw new Error(PACKAGE_ERROR);
			const manifestPath = join(path, "manifest.json");
			if (realpathSync(manifestPath) !== manifestPath) throw new Error(PACKAGE_ERROR);
			descriptor = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
			const stat = fstatSync(descriptor);
			if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MANIFEST_BYTES)
				throw new Error(PACKAGE_ERROR);
			// Bound the actual read even if another process grows the file after stat.
			const contents = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
			let bytes = 0;
			while (bytes < contents.length) {
				const count = readSync(descriptor, contents, bytes, contents.length - bytes, null);
				if (!count) break;
				bytes += count;
			}
			if (bytes > MAX_MANIFEST_BYTES) throw new Error(PACKAGE_ERROR);
			const manifest: unknown = JSON.parse(contents.subarray(0, bytes).toString("utf8"));
			if (
				!record(manifest) ||
				typeof manifest.name !== "string" || !manifest.name || manifest.name.length > 4096 ||
				typeof manifest.version !== "string" || !manifest.version || manifest.version.length > 128 ||
				typeof manifest.key !== "string" ||
				(manifest.manifest_version !== 2 && manifest.manifest_version !== 3)
			) throw new Error(PACKAGE_ERROR);
			const key = manifest.key.replace(/\s/g, "");
			const der = Buffer.from(key, "base64");
			if (!der.length || der.toString("base64").replace(/=+$/, "") !== key.replace(/=+$/, ""))
				throw new Error(PACKAGE_ERROR);
			createPublicKey({ key: der, format: "der", type: "spki" });
			const derivedId = createHash("sha256").update(der).digest("hex").slice(0, 32)
				.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
			if (derivedId !== id) throw new Error(PACKAGE_ERROR);
			return { id, path, name: manifest.name, version: manifest.version, manifest };
		} catch {
			throw new Error(PACKAGE_ERROR);
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	}

	function validatePackageAcknowledgement(value: unknown, extension: ExtensionRuntimeExtension) {
		if (
			!record(value) || value.id !== extension.id || value.version !== extension.version ||
			value.path !== extension.path || value.fileAccess !== false
		) throw new Error(ACK_ERROR);
		return value;
	}

	function validateLoaded(value: unknown, extension: ExtensionRuntimeExtension) {
		const acknowledgement = validatePackageAcknowledgement(value, extension);
		if (
			acknowledgement.enabled !== true ||
			(acknowledgement.ready !== "passed" && acknowledgement.ready !== "not_checked" && acknowledgement.ready !== "not_applicable")
		) throw new Error(ACK_ERROR);
		return acknowledgement.ready;
	}

	async function control(operation: "disable" | "uninstall" | "start-worker", id: string) {
		extensionId(id);
		const acknowledgement = await request(operation, { id });
		if (!record(acknowledgement) || acknowledgement.ok === false || "error" in acknowledgement)
			throw new Error(ACK_ERROR);
	}

	return {
		async loadExtension(path, options) {
			if (options.allowFileAccess !== false) throw new Error(PACKAGE_ERROR);
			const extension = readPackage(basename(resolve(path)), path);
			const acknowledgement = await request("load", {
				id: extension.id, path: extension.path, allowFileAccess: false,
			});
			const ready = validateLoaded(acknowledgement, extension);
			return { id: extension.id, ready, extension };
		},
		async removeExtension(id) {
			await control("disable", id);
		},
		async uninstallExtension(id) {
			await control("uninstall", id);
		},
		async getExtension(id) {
			extensionId(id);
			const acknowledgement = await request("get", { id });
			if (acknowledgement === null) return null;
			if (record(acknowledgement) && acknowledgement.absent === true) {
				if (acknowledgement.id !== undefined && acknowledgement.id !== id)
					throw new Error(ACK_ERROR);
				return null;
			}
			const extension = readPackage(id);
			if (validatePackageAcknowledgement(acknowledgement, extension).enabled === false)
				return null;
			validateLoaded(acknowledgement, extension);
			return extension;
		},
		async startServiceWorker(id) {
			await control("start-worker", id);
		},
	};
}
