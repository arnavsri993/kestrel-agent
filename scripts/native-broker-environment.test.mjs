import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe.skipIf(process.platform !== "darwin")("native broker environment boundary", () => {
	let temporary, executable;
	beforeAll(() => {
		const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-broker-environment-")));
		executable = join(temporary, "broker-environment-fixture");
		const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 5_000 }).trim();
		execFileSync("/usr/bin/xcrun", [
			"clang++", "-std=c++20", "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
			"-mmacosx-version-min=13.0", "-isysroot", sdk,
			"-I", join(repository, "apps/native-chromium-host/src"),
			join(repository, "apps/native-chromium-host/tests/native_broker_environment_fixture.mm"),
			"-framework", "Foundation", "-o", executable,
		], { timeout: 30_000, stdio: "pipe" });
	}, 40_000);

	afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

	it.each([
		["whitelist", "forwards exactly six allowed keys and excludes ambient credentials"],
		["normal", "preserves the normal four-field environment with discovery opt-outs unset"],
		["invalid-flags", "accepts only string 1 opt-outs and normalizes accepted values"],
		["invalid-base", "omits non-string runtime fields"],
	])("%s: %s", mode => {
		const result = spawnSync(executable, [mode], { encoding: "utf8", timeout: 5_000 });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});
});
