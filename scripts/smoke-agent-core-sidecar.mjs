import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CoreSupervisor } from "../apps/core-service/src/core-supervisor.ts";
import { nodeCoreProcess } from "../apps/core-service/src/node-core-process.ts";

const require = createRequire(import.meta.url);
const sidecar = require("../apps/desktop/build/agent-core-sidecar.cjs");
const root = resolve(".tmp/agent-core-sidecar");
const node = join(root, "node", "bin", "node");
const entryPath = join(root, "service", "index.js");

sidecar.assertNoSymlinks(root);
sidecar.assertStandaloneNode(node);

const profile = await mkdtemp(join(tmpdir(), "kestrel-agent-core-sidecar-"));
let child;
let launches = 0;
const recoveryTimeout = new AbortController();
const watchdog = setTimeout(() => recoveryTimeout.abort(), 30_000);
const supervisor = new CoreSupervisor(undefined, undefined, {
	processFactory: () => {
		launches += 1;
		child = nodeCoreProcess({
			executable: node,
			entryPath,
			env: { HOME: profile, PATH: process.env.PATH, KESTREL_DATA_DIR: profile },
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
		databasePath: join(profile, "core.sqlite"),
		encryptionKeyBase64: randomBytes(32).toString("base64"),
		workspaceRoots: [profile],
		configuredWorkspaceRoots: [profile],
		pluginRoots: [],
		managedPluginRoots: [],
		learnedSkillRoot: join(profile, "skills"),
		secureEnvironment: {},
		providerAccounts: [],
	});
	await snapshot();
	const recovered = once(supervisor, "recovered", { signal: recoveryTimeout.signal });
	child.kill();
	await recovered;
	assert.equal(launches, 2);
	await snapshot();
	console.log(
		"Standalone Agent Core sidecar: Node-only bootstrap, snapshot, crash recovery and recovered snapshot passed.",
	);
} finally {
	clearTimeout(watchdog);
	await supervisor.stop();
	await rm(profile, { recursive: true, force: true });
}
