import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("does not accept retirement from an environment flag without a concrete candidate", () => {
	const result = spawnSync(process.execPath, [resolve("scripts/check-electron-retirement-gates.mjs")], {
		encoding: "utf8",
		timeout: 10_000,
		env: { ...process.env, KESTREL_ACCEPT_ELECTRON_RETIREMENT: "1" },
	});
	expect(result.status).toBe(1);
	expect(result.stderr).toMatch(/explicit built Kestrel.app candidate/);
	expect(result.stdout).not.toMatch(/Retirement acceptance recorded/);
});
