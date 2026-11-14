import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeChromiumBuildModeCompileFlag } from "./build-native-chromium-host.mjs";

describe.skipIf(process.platform !== "darwin")("native Chromium Keychain policy compile matrix", () => {
	let temporary;
	let compiler;
	let sdk;
	const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const fixture = join(repository, "apps/native-chromium-host/tests/native_keychain_policy_fixture.cc");

	beforeAll(() => {
		temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-keychain-policy-")));
		compiler = execFileSync("/usr/bin/xcrun", ["--find", "clang++"], {
			encoding: "utf8",
			timeout: 10_000,
		}).trim();
		sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], {
			encoding: "utf8",
			timeout: 10_000,
		}).trim();
		for (const releaseBuild of [false, true]) {
			const executable = join(temporary, releaseBuild ? "release-policy" : "development-policy");
			execFileSync(compiler, [
				"-std=c++20",
				"-Wall",
				"-Wextra",
				"-Werror",
				"-mmacosx-version-min=13.0",
				"-isysroot",
				sdk,
				nativeChromiumBuildModeCompileFlag(releaseBuild),
				fixture,
				"-o",
				executable,
			], { timeout: 30_000, stdio: "pipe" });
			execFileSync(executable, [], { timeout: 5_000, stdio: "pipe" });
		}
	}, 45_000);

	afterAll(() => {
		if (temporary) rmSync(temporary, { recursive: true, force: true });
	});

	it("uses the builder's explicit 0/1 release-mode compile flags", () => {
		expect(nativeChromiumBuildModeCompileFlag(false)).toBe("-DKESTREL_NATIVE_RELEASE_BUILD=0");
		expect(nativeChromiumBuildModeCompileFlag(true)).toBe("-DKESTREL_NATIVE_RELEASE_BUILD=1");
	});

	it.each([undefined, "-DKESTREL_NATIVE_RELEASE_BUILD=2"])("refuses an unspecified or invalid compile policy (%s)", flag => {
		expect(() => execFileSync(compiler, [
			"-std=c++20", "-isysroot", sdk, "-fsyntax-only",
			...(flag ? [flag] : []), fixture,
		], { timeout: 10_000, stdio: "pipe" })).toThrow();
	});
});
