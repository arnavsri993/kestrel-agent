import { compileNativeLocalVaultCrypto, nativeLocalVaultLinkFlags } from "./build-native-local-vault.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe.skipIf(process.platform !== "darwin")("native Core profile key lookup", () => {
	let temporary, executable;
	beforeAll(() => {
		const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-keychain-fixture-")));
		executable = join(temporary, "keychain-fixture");
		const crypto = compileNativeLocalVaultCrypto(join(temporary, "vault.o"));
		const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 5000 }).trim();
		execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-isysroot", sdk,
			"-I", join(repository, "apps/native-chromium-host/src"),
			crypto, ...nativeLocalVaultLinkFlags(),
			... ["kestrel_local_vault.mm", "kestrel_local_vault_crypto_process.mm"].map(file => join(repository, "apps/native-chromium-host/src", file)),
			join(repository, "apps/native-chromium-host/src/kestrel_native_core_keychain.mm"),
			join(repository, "apps/native-chromium-host/tests/native_core_keychain_test.mm"),
			"-framework", "Foundation", "-framework", "Security", "-o", executable], { timeout: 30000, stdio: "pipe" });
	}, 40000);
	afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
	it("verifies lookup and creation against the in-memory Keychain backend", () => {
		const result = spawnSync(executable, [], { encoding: "utf8", timeout: 10000 });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
});
