import { describe, expect, it } from "vitest";
import { withDesktopAgentCoreEnv } from "./desktop-agent-core-env.mjs";

describe("withDesktopAgentCoreEnv", () => {
	it("preserves an explicit Node executable path", () => {
		expect(
			withDesktopAgentCoreEnv({
				FOO: "1",
				KESTREL_NODE_EXEC_PATH: "/custom/node",
			}),
		).toEqual({
			FOO: "1",
			KESTREL_NODE_EXEC_PATH: "/custom/node",
		});
	});

	it("defaults to the current Node executable when unset", () => {
		expect(withDesktopAgentCoreEnv({ FOO: "1" })).toEqual({
			FOO: "1",
			KESTREL_NODE_EXEC_PATH: process.execPath,
		});
	});
});
