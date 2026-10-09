import assert from "node:assert/strict";
import { withDesktopAgentCoreEnv } from "./desktop-agent-core-env.mjs";

const withExisting = withDesktopAgentCoreEnv({
	FOO: "1",
	KESTREL_NODE_EXEC_PATH: "/custom/node",
});
assert.equal(withExisting.FOO, "1");
assert.equal(withExisting.KESTREL_NODE_EXEC_PATH, "/custom/node");

const without = withDesktopAgentCoreEnv({ FOO: "1" });
assert.equal(without.FOO, "1");
assert.equal(without.KESTREL_NODE_EXEC_PATH, process.execPath);

console.log("desktop-agent-core-env: ok");
