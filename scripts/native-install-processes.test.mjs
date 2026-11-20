import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertNoRunningCanonicalKestrel } from "./native-install-processes.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-install-process-test-"))); roots.push(root);
	const target = join(root, "Applications", "Kestrel.app");
	await mkdir(join(target, "Contents", "MacOS"), { recursive: true });
	await writeFile(join(target, "Contents", "MacOS", "Kestrel"), "generated executable");
	return { root, target };
}
const inventory = stdout => ({ readProcesses: () => ({ status: 0, stdout }) });

it("refuses the canonical app and its helpers without issuing a process command", async () => {
	const { target } = await fixture();
	await expect(assertNoRunningCanonicalKestrel(target, inventory(`10 /sbin/launchd\n20 ${target}/Contents/MacOS/Kestrel\n21 ${target}/Contents/Frameworks/Kestrel Helper.app/Contents/MacOS/Kestrel Helper\n`)))
		.rejects.toThrow(/20, 21.*No process was stopped/);
});
it("recognizes an executable reached through a filesystem alias", async () => {
	const { root, target } = await fixture(); const alias = join(root, "alias.app"); await symlink(target, alias);
	await expect(assertNoRunningCanonicalKestrel(target, inventory(`20 ${alias}/Contents/MacOS/Kestrel\n`))).rejects.toThrow(/Quit the canonical/);
});
it("leaves a separate native development window alone", async () => {
	const { root, target } = await fixture();
	await expect(assertNoRunningCanonicalKestrel(target, inventory(`10 /sbin/launchd\n20 ${root}/.tmp/native-chromium-host/Kestrel.app/Contents/MacOS/Kestrel\n`))).resolves.toBeUndefined();
});
it.each([{ status: 1, stdout: "" }, { status: 0, stdout: "" }, { status: 0, stdout: "malformed process row" }, { status: 0, stdout: "20 Kestrel" }])("refuses an unavailable or ambiguous inventory: %j", async result => {
	const { target } = await fixture();
	await expect(assertNoRunningCanonicalKestrel(target, { readProcesses: () => result })).rejects.toThrow();
});
