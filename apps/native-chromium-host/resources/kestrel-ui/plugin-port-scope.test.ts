import { describe, expect, it } from "vitest";
import { createPluginPortScope } from "./plugin-port-scope.mjs";

describe("renderer plugin port scopes", () => {
	it("aborts only the closing port's plugin work and leaves agent and other-port work alive", () => {
		const firstPort = createPluginPortScope();
		const secondPort = createPluginPortScope();
		const firstPlugin = firstPort.begin({ type: "plugin-install-bundle" });
		const firstAgent = firstPort.begin({ type: "runtime-run-agent" });
		const secondPlugin = secondPort.begin({ type: "plugin-remove-installed" });

		expect(firstPlugin.signal?.aborted).toBe(false);
		expect(firstAgent.signal).toBeUndefined();
		expect(secondPlugin.signal?.aborted).toBe(false);

		firstPort.close();

		expect(firstPlugin.signal?.aborted).toBe(true);
		expect(firstAgent.signal).toBeUndefined();
		expect(secondPlugin.signal?.aborted).toBe(false);
		secondPort.close();
		expect(secondPlugin.signal?.aborted).toBe(true);
	});

	it("immediately aborts plugin work registered after its port has closed", () => {
		const port = createPluginPortScope();
		port.close();

		const request = port.begin({ type: "plugin-update-bundle" });

		expect(request.signal?.aborted).toBe(true);
	});
});
