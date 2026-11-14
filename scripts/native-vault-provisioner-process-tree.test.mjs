import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { withProvisionedNativeVault } from "../apps/desktop/src/main/native-vault-provisioner";

// Actual signed Mach-O/process-group fixture, with no crypto or key response.
// Both processes ignore TERM to exercise owned-group KILL escalation. The
// production hardware/encryption canary is separate.
const nativeIt = process.platform === "darwin" ? it : it.skip;
let root, executable, companion, parent, ownedGroup;
function processes() {
	return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,comm="], { encoding: "utf8", timeout: 5000 }).split(/\r?\n/)
		.map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
		.map(match => ({ pid: +match[1], ppid: +match[2], group: +match[3], command: match[4] }));
}
beforeAll(async () => {
	if (process.platform !== "darwin") return;
	root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-provisioner-tree-test-")));
	const macos = join(root, "Kestrel.app/Contents/MacOS"), source = join(root, "process-fixture.cc");
	await mkdir(macos, { recursive: true, mode: 0o700 });
	for (const path of [join(root, "Kestrel.app"), join(root, "Kestrel.app/Contents"), macos]) await chmod(path, 0o700);
	executable = join(macos, "Kestrel Vault Provisioner"); companion = join(macos, "Kestrel Vault");
	await writeFile(source, "#include <signal.h>\n#include <unistd.h>\nint main(){signal(SIGTERM,SIG_IGN);if(fork()<0)return 1;for(;;)pause();}\n");
	execFileSync("/usr/bin/xcrun", ["clang++", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", executable], { timeout: 30000, stdio: "pipe" });
	await copyFile(executable, companion);
	for (const path of [executable, companion]) execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", path], { timeout: 10000, stdio: "pipe" });
	parent = join(root, "private-parent"); await mkdir(parent, { mode: 0o700 });
}, 60000);
afterAll(async () => {
	if (!root) return;
	if (ownedGroup && processes().some(item => item.group === ownedGroup && item.command === executable)) {
		try { process.kill(-ownedGroup, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
	}
	await vi.waitFor(() => assert(!processes().some(item => [executable, companion].includes(item.command))), { timeout: 5000 });
	await rm(root, { recursive: true, force: true });
});
nativeIt.each([false, true])("confirms a TERM-resistant provisioner and descendant exit (transient probe EPERM: %s)", async transientProbe => {
	const controller = new AbortController(); let called = false;
	ownedGroup = undefined;
	const originalKill = process.kill.bind(process); let killed = false, injected = false;
	const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		if (pid === -ownedGroup && signal === "SIGKILL") killed = true;
		if (transientProbe && killed && !injected && pid === -ownedGroup && signal === 0) {
			injected = true; throw Object.assign(new Error("Generated transient process-group probe failure"), { code: "EPERM" });
		}
		return originalKill(pid, signal);
	});
	const pending = withProvisionedNativeVault({ parent, executable, signal: controller.signal }, () => { called = true; });
	const outcome = pending.then(() => { throw new Error("A stalled fixture unexpectedly provisioned a vault."); }, error => error);
	try { await vi.waitFor(() => {
		const rows = processes().filter(item => item.command === executable);
		const direct = rows.find(item => item.ppid === process.pid);
		assert(direct && direct.group === direct.pid && rows.some(item => item.ppid === direct.pid && item.group === direct.pid));
		ownedGroup = direct.pid;
	}, { timeout: 5000 }); }
	finally { controller.abort(); await outcome; spy.mockRestore(); }
	const result = await outcome;
	assert.notEqual(result.name, "NativeVaultProvisioningCleanupError", `Unconfirmed fixture cleanup code: ${result.cleanupCode}`);
	expect(result.message).toContain("cancelled");
	assert.equal(injected, transientProbe);
	assert.equal(called, false); assert(!processes().some(item => item.group === ownedGroup));
}, 15000);
