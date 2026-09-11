import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoreSupervisor } from "../apps/core-service/src/core-supervisor";
import type { CoreProcess } from "../apps/core-service/src/core-process";
import { nodeCoreProcess } from "../apps/core-service/src/node-core-process";

// Uses the real built core with a disposable profile, no provider credentials,
// and no Electron process or mocked transport.
const entryPath = resolve("apps/core-service/out/index.js");
const previousDirectory = process.cwd();
const root = await mkdtemp(join(tmpdir(), "kestrel-node-core-"));
process.chdir(root);
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
			entryPath,
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
	// A missing executable emits ChildProcess.error rather than exit. It must
	// reject startup without crashing the host or waiting for its timeout.
	const unavailable = new CoreSupervisor(undefined, undefined, {
		processFactory: () => nodeCoreProcess({ executable: join(root, "missing-node"), entryPath, env: {} }),
	});
	await assert.rejects(unavailable.start({
		databasePath: join(root, "unavailable.sqlite"), encryptionKeyBase64: randomBytes(32).toString("base64"),
		workspaceRoots: [], configuredWorkspaceRoots: [], pluginRoots: [], managedPluginRoots: [],
		learnedSkillRoot: join(root, "skills"), secureEnvironment: {},
	}), /stopped before becoming ready/);
	await unavailable.stop();
	await supervisor.start({
		databasePath: join(root, "core.sqlite"),
		encryptionKeyBase64: randomBytes(32).toString("base64"),
		workspaceRoots: [root], configuredWorkspaceRoots: [root],
		pluginRoots: [], managedPluginRoots: [],
		learnedSkillRoot: join(root, "skills"),
		secureEnvironment: {}, providerAccounts: [],
	});
	await snapshot();
	const created = await supervisor.request({ type: "runtime-create-session", title: "Durable Node session", kind: "conversation" });
	assert.ok(created.ok && created.session);
	const sessionId = created.session.id;
	const recovered = once(supervisor, "recovered", { signal: recoveryTimeout.signal });
	child!.kill();
	await recovered;
	assert.equal(launches, 2);
	await snapshot();
	const restored = await supervisor.request({ type: "runtime-list-sessions" });
	assert.ok(restored.ok && restored.sessions?.some((session) => session.id === sessionId));
	console.log("Node Agent Core: missing-executable containment, bootstrap, snapshot, crash recovery, durable session restoration and recovered snapshot passed.");
} finally {
	clearTimeout(watchdog);
	await supervisor.stop();
	process.chdir(previousDirectory);
	await rm(root, { recursive: true, force: true });
}
