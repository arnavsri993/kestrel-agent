import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialBroker } from "./credential-broker";
import {
	DEFAULT_EXTERNAL_SECRET_CONFIGURATION,
	ExternalSecretManager,
	preservePrivateManagedBitwardenDirectoryIfIncomplete,
	publishPrivateManagedBitwardenDirectory,
	safeExternalSecretArchiveEntries,
} from "./external-secret-manager";

const roots: string[] = [];
const protection = {
	isEncryptionAvailable: () => true,
	encryptString: async (value: string) =>
		Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
	decryptString: async (value: Buffer) =>
		Buffer.from(value.toString().slice("sealed:".length), "base64").toString(),
};

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "workstrand-external-secrets-"));
	roots.push(root);
	const paths = {
		op: join(root, "op"),
		bws: join(root, "bws"),
		helper: join(root, "helper"),
	};
	for (const path of Object.values(paths)) {
		writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		chmodSync(path, 0o700);
	}
	return { root, paths, broker: new CredentialBroker(root, protection) };
}

describe("external secret manager", () => {
	it("publishes a private managed CLI directory with the readiness manifest written last", async () => {
		const root = mkdtempSync(join(tmpdir(), "workstrand-bws-publish-"));
		roots.push(root);
		const parent = join(root, "managed-tools", "bws");
		const stage = join(root, "private-stage");
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		mkdirSync(stage, { mode: 0o700 });
		const sourceBinary = join(stage, "bws");
		writeFileSync(sourceBinary, "fixture-binary", { mode: 0o700 });
		chmodSync(sourceBinary, 0o700);
		const finalDirectory = join(parent, "2.0.0");

		await publishPrivateManagedBitwardenDirectory({
			sourceBinary,
			finalDirectory,
			marker: { tool: "bws", version: "2.0.0", sha256: "archive-hash" },
		});

		expect(readdirSync(finalDirectory).sort()).toEqual(["bws", "workstrand-install.json"]);
		expect(statSync(finalDirectory).mode & 0o777).toBe(0o700);
		expect(statSync(join(finalDirectory, "bws")).mode & 0o777).toBe(0o700);
		expect(statSync(join(finalDirectory, "workstrand-install.json")).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(join(finalDirectory, "workstrand-install.json"), "utf8"))).toMatchObject({
			tool: "bws", version: "2.0.0", sha256: "archive-hash", binaryBytes: Buffer.byteLength("fixture-binary"),
		});
	});

	it("refuses existing empty or populated managed directories without changing their contents", async () => {
		for (const populated of [false, true]) {
			const root = mkdtempSync(join(tmpdir(), "workstrand-bws-existing-"));
			roots.push(root);
			const parent = join(root, "managed-tools", "bws");
			const stage = join(root, "private-stage");
			mkdirSync(parent, { recursive: true, mode: 0o700 });
			mkdirSync(stage, { mode: 0o700 });
			const sourceBinary = join(stage, "bws");
			writeFileSync(sourceBinary, "fixture-binary", { mode: 0o700 });
			const finalDirectory = join(parent, "2.0.0");
			mkdirSync(finalDirectory, { mode: 0o700 });
			const sentinel = join(finalDirectory, "user-file");
			if (populated) writeFileSync(sentinel, "preserve-me", { mode: 0o600 });
			await expect(publishPrivateManagedBitwardenDirectory({
				sourceBinary, finalDirectory, marker: { version: "2.0.0" },
			})).rejects.toThrow();
			expect(existsSync(finalDirectory)).toBe(true);
			expect(readdirSync(finalDirectory)).toEqual(populated ? ["user-file"] : []);
			if (populated) expect(readFileSync(sentinel, "utf8")).toBe("preserve-me");
		}
	});

	it("explicit repair preserves an incomplete private install before publishing a new verified one", async () => {
		const root = mkdtempSync(join(tmpdir(), "workstrand-bws-repair-"));
		roots.push(root);
		const parent = join(root, "managed-tools", "bws");
		const stage = join(root, "private-stage");
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		mkdirSync(stage, { mode: 0o700 });
		const sourceBinary = join(stage, "bws");
		writeFileSync(sourceBinary, "replacement-binary", { mode: 0o700 });
		chmodSync(sourceBinary, 0o700);
		const finalDirectory = join(parent, "2.0.0");
		mkdirSync(finalDirectory, { mode: 0o700 });
		const staleBytes = "incomplete prior install";
		writeFileSync(join(finalDirectory, "partial-download"), staleBytes, { mode: 0o600 });
		const marker = { tool: "bws", version: "2.0.0", sha256: "pinned-archive-hash" };

		await publishPrivateManagedBitwardenDirectory({
			sourceBinary, finalDirectory, marker, preserveExisting: true,
		});

		const preservedNames = readdirSync(parent).filter((name) => name.startsWith(".bws-preserved-"));
		expect(preservedNames).toHaveLength(1);
		const previous = join(parent, preservedNames[0]!, "previous");
		expect(readFileSync(join(previous, "partial-download"), "utf8")).toBe(staleBytes);
		expect(readFileSync(join(finalDirectory, "bws"), "utf8")).toBe("replacement-binary");
		expect(JSON.parse(readFileSync(join(finalDirectory, "workstrand-install.json"), "utf8"))).toMatchObject({
			...marker,
			binaryBytes: Buffer.byteLength("replacement-binary"),
		});
	});

	it("keeps a preserved install recoverable across a publication failure gap", async () => {
		const root = mkdtempSync(join(tmpdir(), "workstrand-bws-repair-gap-"));
		roots.push(root);
		const parent = join(root, "managed-tools", "bws");
		const stage = join(root, "private-stage");
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		mkdirSync(stage, { mode: 0o700 });
		const sourceBinary = join(stage, "bws");
		writeFileSync(sourceBinary, "replacement-binary", { mode: 0o700 });
		chmodSync(sourceBinary, 0o700);
		const finalDirectory = join(parent, "2.0.0");
		mkdirSync(finalDirectory, { mode: 0o700 });
		writeFileSync(join(finalDirectory, "partial"), "keep this", { mode: 0o600 });
		const marker = { version: "2.0.0", sha256: "pinned-archive-hash" };

		const reservation = await preservePrivateManagedBitwardenDirectoryIfIncomplete({
			finalDirectory, expectedMarker: marker,
		});
		expect(reservation).toBeDefined();
		// The final directory is now absent, as if a crash interrupted repair.
		await publishPrivateManagedBitwardenDirectory({ sourceBinary, finalDirectory, marker });
		expect(readFileSync(join(reservation!, "previous", "partial"), "utf8")).toBe("keep this");
		expect(readFileSync(join(finalDirectory, "bws"), "utf8")).toBe("replacement-binary");
	});

	it("refuses to preserve symlinked or non-private existing paths without touching targets", async () => {
		for (const kind of ["symlink", "non-private"] as const) {
			const root = mkdtempSync(join(tmpdir(), "workstrand-bws-repair-unsafe-"));
			roots.push(root);
			const parent = join(root, "managed-tools", "bws");
			mkdirSync(parent, { recursive: true, mode: 0o700 });
			const finalDirectory = join(parent, "2.0.0");
			const target = join(root, "untouched-target");
			if (kind === "symlink") {
				writeFileSync(target, "preserve target", { mode: 0o600 });
				symlinkSync(target, finalDirectory);
			} else {
				mkdirSync(finalDirectory, { mode: 0o755 });
				chmodSync(finalDirectory, 0o755);
				writeFileSync(join(finalDirectory, "sentinel"), "preserve content", { mode: 0o600 });
			}
			await expect(preservePrivateManagedBitwardenDirectoryIfIncomplete({
				finalDirectory, expectedMarker: { version: "2.0.0", sha256: "pinned" },
			})).rejects.toThrow();
			if (kind === "symlink") expect(readFileSync(target, "utf8")).toBe("preserve target");
			else expect(readFileSync(join(finalDirectory, "sentinel"), "utf8")).toBe("preserve content");
			expect(readdirSync(parent).filter((name) => name.startsWith(".bws-preserved-"))).toEqual([]);
		}
	});

	it("refuses a replaced destination parent and leaves its target untouched", async () => {
		const root = mkdtempSync(join(tmpdir(), "workstrand-bws-parent-change-"));
		roots.push(root);
		const realParent = join(root, "real-managed-tools", "bws");
		mkdirSync(realParent, { recursive: true, mode: 0o700 });
		const finalDirectory = join(realParent, "2.0.0");
		mkdirSync(finalDirectory, { mode: 0o700 });
		writeFileSync(join(finalDirectory, "sentinel"), "preserve", { mode: 0o600 });
		const linkParent = join(root, "managed-tools", "bws");
		mkdirSync(join(root, "managed-tools"), { mode: 0o700 });
		symlinkSync(realParent, linkParent);

		await expect(preservePrivateManagedBitwardenDirectoryIfIncomplete({
			finalDirectory: join(linkParent, "2.0.0"),
			expectedMarker: { version: "2.0.0", sha256: "pinned" },
		})).rejects.toThrow();
		expect(readFileSync(join(finalDirectory, "sentinel"), "utf8")).toBe("preserve");
		expect(readdirSync(realParent)).toEqual(["2.0.0"]);
	});

	it("preserves linked staged binaries and leaves failed publication without a readiness marker", async () => {
		for (const linkType of ["symlink", "hardlink"] as const) {
			const root = mkdtempSync(join(tmpdir(), "workstrand-bws-linked-"));
			roots.push(root);
			const parent = join(root, "managed-tools", "bws");
			const stage = join(root, "private-stage");
			mkdirSync(parent, { recursive: true, mode: 0o700 });
			mkdirSync(stage, { mode: 0o700 });
			const target = join(root, "preserved-binary");
			const sourceBinary = join(stage, "bws");
			writeFileSync(target, "user-binary", { mode: 0o700 });
			if (linkType === "symlink") symlinkSync(target, sourceBinary);
			else linkSync(target, sourceBinary);
			const finalDirectory = join(parent, "2.0.0");
			await expect(publishPrivateManagedBitwardenDirectory({
				sourceBinary, finalDirectory, marker: { version: "2.0.0" },
			})).rejects.toThrow();
			expect(readFileSync(target, "utf8")).toBe("user-binary");
			expect(existsSync(join(finalDirectory, "workstrand-install.json"))).toBe(false);
		}
	});

	it("treats malformed, oversized, linked, and symlinked verification files as unverified without touching their targets", async () => {
		const cases = ["malformed", "oversized", "symlink", "hardlink"] as const;
		for (const kind of cases) {
			const item = fixture();
			const configuration = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
			configuration.command = {
				enabled: true,
				executablePath: item.paths.helper,
				arguments: [],
				timeoutMs: 1_500,
				overrideStored: false,
			};
			const manager = new ExternalSecretManager(item.root, item.broker);
			await manager.save(configuration);
			const secure = join(item.root, "secure");
			const statusPath = join(secure, "external-secret-status.json");
			const target = join(item.root, `verification-${kind}-target.json`);
			const targetBytes = Buffer.from('{"command":{"state":"verified"}}');
			writeFileSync(target, targetBytes, { mode: 0o600 });
			unlinkSync(statusPath);
			switch (kind) {
				case "malformed":
					writeFileSync(statusPath, '{"command":{"detail":"sk-provider-secret"}', { mode: 0o600 });
					break;
				case "oversized":
					writeFileSync(statusPath, Buffer.alloc(65 * 1024, 0x20), { mode: 0o600 });
					break;
				case "symlink":
					symlinkSync(target, statusPath);
					break;
				case "hardlink":
					linkSync(target, statusPath);
					break;
			}
			const status = await manager.status();
			expect(status.sources.find((source) => source.id === "command")?.state).toBe("ready");
			expect(JSON.stringify(status)).not.toContain("sk-provider-secret");
			expect(readFileSync(target)).toEqual(targetBytes);
			if (kind === "symlink") expect(existsSync(statusPath)).toBe(true);
			if (kind === "hardlink") expect(readFileSync(statusPath)).toEqual(targetBytes);
		}
	});

	it("does not overwrite a predictable temporary path and writes only a private status file", async () => {
		const item = fixture();
		const configuration = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
		configuration.command = {
			enabled: true,
			executablePath: item.paths.helper,
			arguments: [],
			timeoutMs: 1_500,
			overrideStored: false,
		};
		const manager = new ExternalSecretManager(item.root, item.broker, {
			execute: async () => ({ stdout: "GITHUB_TOKEN=generated-github-token\n" }),
		});
		await manager.save(configuration);
		const temporaryPath = join(item.root, "secure", "external-secret-status.json.new");
		writeFileSync(temporaryPath, "preserve-this-user-file", { mode: 0o600 });
		await manager.resolveEnabled();
		expect(readFileSync(temporaryPath, "utf8")).toBe("preserve-this-user-file");
		const statusPath = join(item.root, "secure", "external-secret-status.json");
		expect(statSync(statusPath).mode & 0o777).toBe(0o600);
	});

	it("refuses to write through a replaced secure parent directory", async () => {
		const item = fixture();
		const configuration = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
		configuration.command = {
			enabled: true,
			executablePath: item.paths.helper,
			arguments: [],
			timeoutMs: 1_500,
			overrideStored: false,
		};
		const manager = new ExternalSecretManager(item.root, item.broker, {
			execute: async () => ({ stdout: "GITHUB_TOKEN=generated-github-token\n" }),
		});
		await manager.save(configuration);
		const secure = join(item.root, "secure");
		const preservedSecure = join(item.root, "secure-preserved");
		const replacement = join(item.root, "replacement-secure");
		const marker = join(replacement, "marker");
		renameSync(secure, preservedSecure);
		mkdirSync(replacement, { mode: 0o700 });
		renameSync(join(preservedSecure, "credentials"), join(replacement, "credentials"));
		writeFileSync(marker, "preserve-replacement", { mode: 0o600 });
		symlinkSync(replacement, secure);

		await expect(manager.resolveEnabled()).rejects.toThrow("verification storage is unsafe");
		expect(readFileSync(marker, "utf8")).toBe("preserve-replacement");
		expect(existsSync(join(replacement, "external-secret-status.json"))).toBe(false);
	});

	it("never persists provider diagnostics and does not mark empty or unknown-only helper output verified", async () => {
		const item = fixture();
		const configuration = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
		configuration.command = {
			enabled: true,
			executablePath: item.paths.helper,
			arguments: [],
			timeoutMs: 1_500,
			overrideStored: false,
		};
		let output = "UNRELATED_SECRET=not-a-provider-credential\n";
		const manager = new ExternalSecretManager(item.root, item.broker, {
			execute: async () => ({ stdout: output }),
		});
		await manager.save(configuration);
		await manager.resolveEnabled();
		let commandStatus = (await manager.status()).sources.find((source) => source.id === "command");
		expect(commandStatus).toMatchObject({ state: "error", resolvedCredentialIds: [] });
		output = "GITHUB_TOKEN=\n";
		await manager.resolveEnabled();
		commandStatus = (await manager.status()).sources.find((source) => source.id === "command");
		expect(commandStatus).toMatchObject({ state: "error", resolvedCredentialIds: [] });

		const rawFailure = new ExternalSecretManager(item.root, item.broker, {
			execute: async () => { throw new Error("fake-provider-secret-do-not-persist"); },
		});
		await rawFailure.resolveEnabled();
		const status = await rawFailure.status();
		const stored = readFileSync(join(item.root, "secure", "external-secret-status.json"), "utf8");
		expect(JSON.stringify(status)).not.toContain("fake-provider-secret-do-not-persist");
		expect(stored).not.toContain("fake-provider-secret-do-not-persist");
		expect(status.sources.find((source) => source.id === "command")?.detail).toBe(
			"Secret source could not be verified.",
		);
	});

	it("invalidates provider verification after source configuration or bootstrap-token changes", async () => {
		const item = fixture();
		const configuration = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
		configuration.onepassword = {
			enabled: true,
			binaryPath: item.paths.op,
			account: "team.1password.com",
			mappings: { openai: "op://Private/OpenAI/api-key" },
			overrideStored: true,
		};
		const manager = new ExternalSecretManager(item.root, item.broker, {
			execute: async () => ({ stdout: "onepassword-openai-secret" }),
		});
		await manager.save(configuration, { onePasswordToken: "first-service-token" });
		await manager.sync("onepassword");
		expect((await manager.status()).sources.find((source) => source.id === "onepassword")?.state).toBe("verified");

		const changedConfiguration = structuredClone(configuration);
		changedConfiguration.onepassword.account = "other.1password.com";
		await manager.save(changedConfiguration);
		expect((await manager.status()).sources.find((source) => source.id === "onepassword")?.state).toBe("ready");
		await manager.sync("onepassword");
		expect((await manager.status()).sources.find((source) => source.id === "onepassword")?.state).toBe("verified");

		await manager.save(changedConfiguration, { onePasswordToken: "second-service-token" });
		expect((await manager.status()).sources.find((source) => source.id === "onepassword")?.state).toBe("ready");
		await manager.sync("onepassword");
		expect((await manager.status()).sources.find((source) => source.id === "onepassword")?.state).toBe("verified");
	});

	it("resolves all three sources through an allowlist and applies explicit precedence without persisting values", async () => {
		const item = fixture();
		await item.broker.setCredential("openai", "stored-openai-secret");
		await item.broker.setCredential("github", "stored-github-secret");
		const configuration = structuredClone(
			DEFAULT_EXTERNAL_SECRET_CONFIGURATION,
		);
		configuration.onepassword = {
			enabled: true,
			binaryPath: item.paths.op,
			account: "team.1password.com",
			mappings: { openai: "op://Private/OpenAI/api-key" },
			overrideStored: true,
		};
		configuration.bitwarden = {
			enabled: true,
			binaryPath: item.paths.bws,
			projectId: "11111111-2222-4333-8444-555555555555",
			serverUrl: "https://vault.bitwarden.eu",
			autoInstall: false,
			overrideStored: true,
		};
		configuration.command = {
			enabled: true,
			executablePath: item.paths.helper,
			arguments: ["--workstrand"],
			timeoutMs: 1_500,
			overrideStored: false,
		};
		const calls: Array<{
			file: string;
			args: string[];
			env: NodeJS.ProcessEnv;
		}> = [];
		const manager = new ExternalSecretManager(item.root, item.broker, {
			now: () => new Date("2026-07-23T08:00:00.000Z"),
			execute: async (file, args, options) => {
				calls.push({ file, args, env: options.env });
				if (file.endsWith("/op"))
					return { stdout: "onepassword-openai-secret" };
				if (file.endsWith("/bws"))
					return {
						stdout: JSON.stringify([
							{ key: "ANTHROPIC_API_KEY", value: "bitwarden-anthropic-secret" },
							{ key: "UNRELATED_PRIVATE_VALUE", value: "must-not-cross" },
						]),
					};
				return {
					stdout:
						"GITHUB_TOKEN=command-github-secret\nUNRELATED_SECRET=must-not-cross\n",
				};
			},
		});
		await manager.save(configuration, {
			onePasswordToken: "ops_service_account_token",
			bitwardenToken: "0.machine-account-token",
		});
		const resolved = await manager.resolveEnabled();
		expect(resolved).toEqual({
			values: {
				openai: "onepassword-openai-secret",
				anthropic: "bitwarden-anthropic-secret",
				github: "command-github-secret",
			},
			overrideStoredIds: ["openai", "anthropic"],
		});
		expect(await item.broker.providerEnvironment({}, resolved)).toMatchObject({
			OPENAI_API_KEY: "onepassword-openai-secret",
			ANTHROPIC_API_KEY: "bitwarden-anthropic-secret",
			GITHUB_TOKEN: "stored-github-secret",
		});
		const opCall = calls.find((c) => c.file.endsWith("/op"));
		const bwsCall = calls.find((c) => c.file.endsWith("/bws"));
		const helperCall = calls.find((c) => c.file.endsWith("/helper"));
		expect(opCall).toMatchObject({
			file: expect.stringMatching(/\/op$/),
			args: [
				"read",
				"op://Private/OpenAI/api-key",
				"--no-newline",
				"--account",
				"team.1password.com",
			],
		});
		expect(opCall!.env.OP_SERVICE_ACCOUNT_TOKEN).toBe(
			"ops_service_account_token",
		);
		expect(bwsCall!.env.BWS_ACCESS_TOKEN).toBe("0.machine-account-token");
		expect(bwsCall!.env.BWS_SERVER_URL).toBe("https://vault.bitwarden.eu");
		expect(helperCall!.env).not.toHaveProperty("OPENAI_API_KEY");
		const status = await manager.status();
		expect(status.sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "onepassword",
					state: "verified",
					resolvedCredentialIds: ["openai"],
				}),
				expect.objectContaining({
					id: "bitwarden",
					state: "verified",
					resolvedCredentialIds: ["anthropic"],
				}),
				expect.objectContaining({
					id: "command",
					state: "verified",
					resolvedCredentialIds: ["github"],
				}),
			]),
		);
		const credentialRoot = join(item.root, "secure", "credentials");
		for (const file of [
			"opaque-external-secret-configuration.bin",
			"opaque-external-secret-onepassword-token.bin",
			"opaque-external-secret-bitwarden-token.bin",
		]) {
			const stored = readFileSync(join(credentialRoot, file), "utf8");
			expect(stored).not.toContain("onepassword-openai-secret");
			expect(stored).not.toContain("ops_service_account_token");
			expect(stored).not.toContain("0.machine-account-token");
		}
		expect(
			readFileSync(
				join(item.root, "secure", "external-secret-status.json"),
				"utf8",
			),
		).not.toContain("secret");
	});

	it("records only a safe failure and preserves startup fallback when a provider process leaks diagnostics", async () => {
		const item = fixture();
		const configuration = structuredClone(
			DEFAULT_EXTERNAL_SECRET_CONFIGURATION,
		);
		configuration.onepassword = {
			enabled: true,
			binaryPath: item.paths.op,
			account: "",
			mappings: { openai: "op://Private/OpenAI/api-key" },
			overrideStored: true,
		};
		const manager = new ExternalSecretManager(item.root, item.broker, {
			execute: async () => {
				throw new Error("stderr accidentally contained sk-live-do-not-log");
			},
		});
		await manager.save(configuration);
		expect(await manager.resolveEnabled()).toEqual({
			values: {},
			overrideStoredIds: [],
		});
		const source = (await manager.status()).sources.find(
			(item) => item.id === "onepassword",
		);
		expect(source).toMatchObject({
			state: "error",
			detail: "Secret source could not be verified.",
		});
		expect(JSON.stringify(source)).not.toContain("sk-live-do-not-log");
	});

	it("rejects unsafe references, non-absolute helpers, and unexpected archive entries", async () => {
		const item = fixture();
		const manager = new ExternalSecretManager(item.root, item.broker);
		const badReference = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
		badReference.onepassword.mappings.openai = "--account=attacker";
		await expect(manager.save(badReference)).rejects.toThrow(
			"op://vault/item/field",
		);
		const badCommand = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
		badCommand.command.executablePath = "helper.sh";
		await expect(manager.save(badCommand)).rejects.toThrow("must be absolute");
		const badServer = structuredClone(DEFAULT_EXTERNAL_SECRET_CONFIGURATION);
		badServer.bitwarden.serverUrl = "not a URL";
		await expect(manager.save(badServer)).rejects.toThrow(
			"credential-free HTTPS URL",
		);
		expect(() => safeExternalSecretArchiveEntries("../bws\n")).toThrow(
			"unexpected file list",
		);
		expect(() => safeExternalSecretArchiveEntries("bws\nextra\n")).toThrow(
			"unexpected file list",
		);
		expect(safeExternalSecretArchiveEntries("bws\n")).toEqual(["bws"]);
	});

	it("rejects malformed managed Bitwarden redirect URLs", async () => {
		const item = fixture();
		const manager = new ExternalSecretManager(item.root, item.broker, {
			platform: "darwin",
			architecture: "arm64",
			fetch: async () => {
				const response = new Response("archive", { status: 200 });
				Object.defineProperty(response, "url", { value: "not a URL" });
				return response;
			},
		});

		await expect(manager.installBitwarden()).rejects.toThrow(
			"could not be installed safely",
		);
	});

	it("removes provider configuration and its encrypted bootstrap token without touching other sources", async () => {
		const item = fixture();
		const configuration = structuredClone(
			DEFAULT_EXTERNAL_SECRET_CONFIGURATION,
		);
		configuration.bitwarden = {
			enabled: true,
			binaryPath: item.paths.bws,
			projectId: "11111111-2222-4333-8444-555555555555",
			serverUrl: "",
			autoInstall: false,
			overrideStored: true,
		};
		const manager = new ExternalSecretManager(item.root, item.broker);
		await manager.save(configuration, {
			bitwardenToken: "0.machine-account-token",
		});
		await manager.remove("bitwarden");
		expect((await manager.configuration()).bitwarden).toEqual(
			DEFAULT_EXTERNAL_SECRET_CONFIGURATION.bitwarden,
		);
		expect(
			await item.broker.getOpaqueSecret("external-secret-bitwarden-token"),
		).toBeUndefined();
	});

	it("preserves verification records when separate managers sync providers concurrently", async () => {
		const item = fixture();
		const configuration = structuredClone(
			DEFAULT_EXTERNAL_SECRET_CONFIGURATION,
		);
		configuration.onepassword = {
			enabled: true,
			binaryPath: item.paths.op,
			account: "",
			mappings: { openai: "op://Private/OpenAI/api-key" },
			overrideStored: true,
		};
		configuration.command = {
			enabled: true,
			executablePath: item.paths.helper,
			arguments: [],
			timeoutMs: 3_000,
			overrideStored: false,
		};
		await new ExternalSecretManager(item.root, item.broker).save(configuration);
		const execute = async (file: string) => ({
			stdout: file.endsWith("/op")
				? "onepassword-secret"
				: "GITHUB_TOKEN=command-secret\n",
		});
		const first = new ExternalSecretManager(item.root, item.broker, {
			execute,
		});
		const second = new ExternalSecretManager(item.root, item.broker, {
			execute,
		});

		await Promise.all([first.sync("onepassword"), second.sync("command")]);

		expect((await first.status()).sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "onepassword", state: "verified" }),
				expect.objectContaining({ id: "command", state: "verified" }),
			]),
		);
	});
});
