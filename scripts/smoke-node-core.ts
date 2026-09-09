import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoreSupervisor } from "../apps/desktop/src/main/core-supervisor";
import type { CoreProcess } from "../apps/desktop/src/main/core-process";
import { nodeCoreProcess } from "../apps/desktop/src/main/node-core-process";

// Uses the real built core with a disposable profile, no provider credentials,
// and no Electron process or mocked transport.
const root = await mkdtemp(join(tmpdir(), "kestrel-node-core-"));
let child: CoreProcess;
let launches = 0;
const recoveryTimeout = new AbortController();
// Keep the standalone runner alive while the supervisor waits on its unref timer.
const watchdog = setTimeout(() => recoveryTimeout.abort(), 30_000);
const supervisor = new CoreSupervisor(undefined, undefined, {
	processFactory: () => {
		launches++;
		child = nodeCoreProcess({
			executable: process.execPath,
			entryPath: resolve("apps/desktop/out/main/utility.js"),
			env: { HOME: root, PATH: process.env.PATH, KESTREL_DATA_DIR: root },
		});
		return child;
	},
	restartDelaysMs: [10],
});
async function snapshot() {
	const response = await supervisor.request({ type: "snapshot" });
	assert.equal(response.ok, true);
	assert.ok(response.ok && response.snapshot);
}
try {
	await supervisor.start({
		databasePath: join(root, "core.sqlite"),
		encryptionKeyBase64: randomBytes(32).toString("base64"),
		workspaceRoots: [root], configuredWorkspaceRoots: [root],
		pluginRoots: [], managedPluginRoots: [],
		learnedSkillRoot: join(root, "skills"),
		secureEnvironment: {}, providerAccounts: [],
	});
	await snapshot();
	const recovered = once(supervisor, "recovered", { signal: recoveryTimeout.signal });
	child!.kill();
	await recovered;
	assert.equal(launches, 2);
	await snapshot();
	console.log("Node Agent Core: bootstrap, snapshot, crash recovery and recovered snapshot passed.");
} finally {
	clearTimeout(watchdog);
	await supervisor.stop();
	await rm(root, { recursive: true, force: true });
}
