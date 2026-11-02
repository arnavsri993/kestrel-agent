import { describe, expect, it } from "vitest";
import { createNativeRequestScope } from "./native-request-scope.mjs";

describe("renderer native request scopes", () => {
	it("aborts only the closing port's plugin and knowledge work and leaves agent and other-port work alive", () => {
		const firstPort = createNativeRequestScope();
		const secondPort = createNativeRequestScope();
		const firstPlugin = firstPort.begin({ type: "plugin-install-bundle" });
		const firstRecovery = firstPort.begin({ type: "memory-recovery-save-file" });
		const firstDiagnostic = firstPort.begin({ type: "export-diagnostic-report" });
		const firstAgent = firstPort.begin({ type: "runtime-run-agent" });
		const secondPlugin = secondPort.begin({ type: "plugin-remove-installed" });

		expect(firstPlugin.signal?.aborted).toBe(false);
		expect(firstRecovery.signal?.aborted).toBe(false);
		expect(firstAgent.signal).toBeUndefined();
		expect(secondPlugin.signal?.aborted).toBe(false);

		firstPort.close();

		expect(firstPlugin.signal?.aborted).toBe(true);
		expect(firstRecovery.signal?.aborted).toBe(true);
		expect(firstDiagnostic.signal?.aborted).toBe(true);
		expect(firstAgent.signal).toBeUndefined();
		expect(secondPlugin.signal?.aborted).toBe(false);
		secondPort.close();
		expect(secondPlugin.signal?.aborted).toBe(true);
	});

	it("immediately aborts cancellable work registered after its port has closed", () => {
		const port = createNativeRequestScope();
		port.close();

		const request = port.begin({ type: "memory-recovery-open-file" });

		expect(request.signal?.aborted).toBe(true);
	});
});

 it("retires completed requests without aborting them when the port closes", () => {
  const port = createNativeRequestScope();
  const completed = port.begin({ type: "memory-recovery-save-file" });
  const pending = port.begin({ type: "memory-recovery-open-file" });
  completed.done(); completed.done();
  port.close(); port.close();
  expect(completed.signal?.aborted).toBe(false);
  expect(pending.signal?.aborted).toBe(true);
 });
