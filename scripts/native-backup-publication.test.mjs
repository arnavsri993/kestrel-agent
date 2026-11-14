import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

describe.skipIf(process.platform !== "darwin")("native backup directory publication", () => {
	let temporary;
	let executable;
	let repository;
	beforeAll(() => {
		repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-backup-publication-")));
		const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 10_000 }).trim();
		const compiler = execFileSync("/usr/bin/xcrun", ["--find", "clang++"], { encoding: "utf8", timeout: 10_000 }).trim();
		executable = join(temporary, "backup-publication-fixture");
		execFileSync(compiler, ["-std=c++20", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-isysroot", sdk,
			"-I", join(repository, "apps/native-chromium-host/src"),
			join(repository, "apps/native-chromium-host/src/kestrel_backup_publication.cc"),
			join(repository, "apps/native-chromium-host/tests/native_backup_publication_fixture.cc"),
			"-o", executable], { timeout: 30_000, stdio: "pipe" });
	}, 40_000);
	afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
	function run(scenario) {
		const root = join(temporary, randomUUID());
		mkdirSync(root, { mode: 0o700 }); chmodSync(root, 0o700);
		const result = spawnSync(executable, [root, scenario], { encoding: "utf8", timeout: 5_000 });
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		return { root, ...JSON.parse(result.stdout) };
	}
	it("publishes the generated directory with matching parent/staging identities and intact file bytes", () => {
		const result = run("success");
		expect(result).toMatchObject({ result: "published", finalExists: true, fixturePreserved: true, identityPreserved: true, stageExists: false });
	});
	it.each(["existing-empty", "existing-nonempty"])("refuses to overwrite a pre-existing %s target", scenario => {
		const result = run(scenario);
		expect(result).toMatchObject({ result: "exists", finalExists: true, fixturePreserved: false, stageExists: true, existingContentPreserved: true });
	});
	it.each(["parent-identity", "staging-identity"])("rejects a %s mismatch", scenario => {
		expect(run(scenario)).toMatchObject({ result: "changed", finalExists: false, stageExists: true });
	});
	it.each(["staging-symlink", "staging-mode"])("rejects a substituted or unsafe %s", scenario => {
		expect(run(scenario)).toMatchObject({ result: "changed", finalExists: false });
	});
	it.each(["forged-nonce", "forged-path"])("rejects a forged publication %s", scenario => {
		expect(run(scenario)).toMatchObject({ result: "invalid", finalExists: false, stageExists: true });
	});
	it("preserves files and reports uncertainty when directory sync fails after the atomic rename", () => {
		expect(run("sync-failure")).toMatchObject({ result: "committedSyncUncertain", finalExists: true, fixturePreserved: true, identityPreserved: true, stageExists: false });
	});
});
