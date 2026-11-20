import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

describe.skipIf(process.platform === "win32")("desktop runtime installer routing", () => {
	let temporary;

	beforeAll(async () => {
		temporary = await mkdtemp(join(tmpdir(), "kestrel-install-runtime-"));
		await writeFile(
			join(temporary, "corepack"),
			"#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.KESTREL_TEST_ARGUMENT_RECORD, JSON.stringify(process.argv.slice(2))); process.exit(37);\n",
			{ mode: 0o700 },
		);
	});

	afterAll(async () => {
		if (temporary) await rm(temporary, { recursive: true, force: true });
	});

	async function run({ argv = [], runtime, accepted = "" } = {}) {
		const record = join(temporary, `${randomUUID()}.json`);
		const args = [resolve("scripts/install-desktop-runtime.mjs"), ...argv];
		const env = {
			...process.env,
			PATH: `${temporary}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			KESTREL_INSTALL_NATIVE_CANONICAL: accepted,
			KESTREL_NATIVE_VAULT_CEF_RUNTIME: "/reviewed/environment-engine",
			KESTREL_TEST_ARGUMENT_RECORD: record,
		};
		if (runtime === undefined) delete env.KESTREL_DESKTOP_RUNTIME;
		else env.KESTREL_DESKTOP_RUNTIME = runtime;
		const result = spawnSync(process.execPath, args, {
			encoding: "utf8",
			timeout: 10000,
			env,
		});
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		const corepackArgs = await readFile(record, "utf8")
			.then(JSON.parse)
			.catch(error => {
				if (error.code !== "ENOENT") throw error;
			});
		return { result, corepackArgs };
	}

	it("keeps Electron as the default and ignores native-only settings", async () => {
		const { result, corepackArgs } = await run();
		expect(corepackArgs).toEqual(["pnpm", "install:mac:dev"]);
		expect(result.status).toBe(37);
	});

	it("refuses native replacement before starting any subprocess without explicit acceptance", async () => {
		const { result, corepackArgs } = await run({ runtime: "chromium" });
		expect(corepackArgs).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("KESTREL_INSTALL_NATIVE_CANONICAL=1");
	});

	it("forwards the exact reviewed candidate without rebuilding it", async () => {
		const candidate = join(temporary, "reviewed candidate.app");
		const { result, corepackArgs } = await run({
			runtime: "native",
			accepted: "1",
			argv: [candidate],
		});
		expect(corepackArgs).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`Native Chromium package missing at ${candidate}`);
	});

	it("rejects build flags and multiple candidate paths before invoking the installer", async () => {
		for (const argv of [["--vault-cef-runtime"], ["/candidate-one.app", "/candidate-two.app"]]) {
			const { result, corepackArgs } = await run({ runtime: "chromium", accepted: "1", argv });
			expect(corepackArgs).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("one existing candidate .app path");
		}
	});

	it("rejects unknown runtimes instead of falling through to Electron", async () => {
		const { result, corepackArgs } = await run({ runtime: "chromuim" });
		expect(corepackArgs).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Unknown KESTREL_DESKTOP_RUNTIME");
	});
});
