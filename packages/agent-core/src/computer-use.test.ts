import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import {
	browserTargetUsesBrowserBackend,
	COMPUTER_USE_TOOL_NAMES,
	installComputerUseTools,
	redactComputerUseInput,
	redactComputerUseOutput,
} from "./computer-use";
import { AgentRuntime } from "./runtime";

function responseFor(request: {
	requestId: string;
	operation: string;
}) {
	return {
		protocolVersion: 1 as const,
		requestId: request.requestId,
		ok: true as const,
		result:
			request.operation === "setAccessibilityValue"
				? { set: true, redacted: false }
				: {},
		evidence: {
			operation: request.operation,
			durationMs: 1,
			backend:
				request.operation === "setAccessibilityValue"
					? ("macos-accessibility" as const)
					: ("none" as const),
			cursorInvariant: "held" as const,
			foregroundInvariant: "held" as const,
			postcondition:
				request.operation === "setAccessibilityValue"
					? ("verified" as const)
					: ("not_checked" as const),
			activationAttempted: false as const,
		},
	};
}

describe("background computer-use Agent Core tools", () => {
	it("registers the complete typed tool set and keeps browser routing separate", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const runtime = new AgentRuntime(database);
		const session = runtime.createSession({ title: "Computer Use" });
		const backend = { request: async (request: any) => responseFor(request) };

		try {
			expect(installComputerUseTools(runtime, backend, session.id)).toEqual(
				COMPUTER_USE_TOOL_NAMES,
			);
			expect(
				runtime
					.discoverTools(session.id)
					.filter((tool) => tool.name.startsWith("computer_"))
					.map((tool) => tool.name),
			).toEqual([...COMPUTER_USE_TOOL_NAMES].sort());
			expect(
				browserTargetUsesBrowserBackend({ kind: "kestrel-browser" }),
			).toBe("browser");
			expect(
				browserTargetUsesBrowserBackend({ kind: "macos-window" }),
			).toBe("macos-accessibility");
		} finally {
			database.close();
		}
	});

	it("captures a window using its ID alone and preserves accurate safe metadata", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const runtime = new AgentRuntime(database);
		const session = runtime.createSession({ title: "Window capture" });
		const requests: Array<Record<string, unknown>> = [];
		installComputerUseTools(runtime, { request: async (request: any) => {
			requests.push(request);
			return {
				...responseFor(request),
				result: { windowId: 54_321, width: 1_920, height: 1_080,
					pngBase64: "private-pixels", trust: "untrusted_background_window" },
			};
		} }, session.id);
		try {
			const execution = await runtime.callTool(session.id, "computer_observe_window",
				{ windowId: 54_321, maxWidth: 1_920 });
			expect(execution.status).toBe("verified");
			expect(requests[0]).toMatchObject({ operation: "captureWindow", windowId: 54_321,
				maxWidth: 1_920 });
			const stored = database.getToolExecution(execution.id);
			expect(stored?.output).toMatchObject({ windowId: 54_321, width: 1_920,
				height: 1_080, redacted: true });
			expect(JSON.stringify(stored)).not.toContain("private-pixels");
		} finally { database.close(); }
	});

	it("redacts entered and expected values before persistence", () => {
		const redacted = redactComputerUseInput("computer_set_element_value", {
			pid: 42,
			selector: { identifier: "target-text" },
			value: "secret-value",
			expectedValue: "secret-value",
		});

		expect(JSON.stringify(redacted)).not.toContain("secret-value");
		expect(redacted).toMatchObject({
			value: { redacted: true, reason: "computer-use-input" },
			expectedValue: { redacted: true, reason: "computer-use-input" },
		});
	});

	it("redacts foreground typing and requires approval for every input action", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const runtime = new AgentRuntime(database);
		const session = runtime.createSession({ title: "Foreground control" });
		const requests: Array<Record<string, unknown>> = [];
		installComputerUseTools(runtime, { request: async (request: any) => {
			requests.push(request);
			return responseFor(request);
		} }, session.id);
		const input = { target: { pid: 42, windowId: 7, bundleId: "com.example.target",
			bounds: { x: 0, y: 0, width: 100, height: 100 } },
			action: { type: "type", text: "private foreground text" } };
		try {
			const blocked = await runtime.callTool(session.id, "computer_foreground_act", input,
				{ idempotencyKey: "foreground-blocked" });
			expect(blocked.status).toBe("blocked");
			expect(requests).toHaveLength(0);
			expect(JSON.stringify(blocked)).not.toContain("private foreground text");
			const stored = database.getToolExecution(blocked.id)!;
			expect(runtime.approvalInput(stored)).toEqual(input);
			const approved = await runtime.callTool(session.id, "computer_foreground_act",
				runtime.approvalInput(stored),
				{ approvalStatus: "approved", approvalGrantExecutionId: stored.id,
					idempotencyKey: "foreground-type" });
			expect(approved.status).toBe("verified");
			expect(requests[0]).toMatchObject({ operation: "performForegroundInput", action: { text: "private foreground text" } });
			expect(JSON.stringify(database.listToolExecutions(session.id))).not.toContain("private foreground text");
			await expect(runtime.callTool(session.id, "computer_foreground_act",
				{ ...input, action: { type: "type", text: "different private text" } },
				{ idempotencyKey: "foreground-type" })).rejects.toThrow("private action already used");
		} finally { database.close(); }
	});

	it("keeps private observations transient while journaling bounded summaries", () => {
		const screenshot = redactComputerUseOutput("computer_observe_window", {
			windowId: 7,
			width: 640,
			height: 480,
			pngBase64: "iVBORw0KGgo-secret-pixels",
			trust: "untrusted_background_window",
		});
		const tree = redactComputerUseOutput("computer_inspect_window", {
			window: { title: "Private document title" },
			tree: {
				pid: 42,
				windowId: 7,
				nodes: [{ value: "private text" }],
				truncated: false,
			},
		});
		const value = redactComputerUseOutput("computer_read_element", {
			value: "private text",
			redacted: false,
		});

		expect(JSON.stringify(screenshot)).not.toContain("iVBOR");
		expect(JSON.stringify(tree)).not.toContain("Private document title");
		expect(JSON.stringify(tree)).not.toContain("private text");
		expect(JSON.stringify(value)).not.toContain("private text");
		expect(screenshot).toMatchObject({
			redacted: true,
			reason: "computer-use-screenshot",
			windowId: 7,
		});
		expect(tree).toMatchObject({
			redacted: true,
			reason: "computer-use-accessibility-tree",
			nodeCount: 1,
		});
	});

	it("never persists computer-use pixels, trees, invariant samples, or values", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const runtime = new AgentRuntime(database);
		const session = runtime.createSession({ title: "Computer Use privacy" });
		const secretPixels = "iVBORw0KGgo-private-pixels";
		const privateTreeText = "private accessibility text";
		const privateValue = "private value";
		const privateBundle = "com.private.foreground";
		const outputs: Record<string, Record<string, unknown>> = {
			computer_observe_window: {
				windowId: 7,
				width: 640,
				height: 480,
				pngBase64: secretPixels,
			},
			computer_inspect_window: {
				window: { title: privateTreeText },
				tree: {
					pid: 42,
					windowId: 7,
					nodes: [{ value: privateTreeText }],
					truncated: false,
				},
			},
			computer_get_invariant: {
				sample: { frontmostBundleId: privateBundle, cursorX: 10, cursorY: 20 },
			},
			computer_read_element: { value: privateValue, redacted: false },
		};
		const names = Object.keys(outputs);
		for (const name of names) {
			runtime.registerExternalTool({
				descriptor: {
					name,
					title: name,
					description: "Private computer-use observation fixture.",
					category: "ui",
					riskLevel: "read_only",
					readOnly: true,
					requiresWorkspace: false,
					source: "builtin",
					tags: ["computer-use"],
				},
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
				redactOutput: (output) => redactComputerUseOutput(name, output),
				execute: async () => outputs[name]!,
			});
			runtime.allowTool(session.id, name);
		}
		try {
			for (const name of names) {
				const execution = await runtime.callTool(session.id, name, {});
				expect(execution.output).toBeDefined();
				const persisted = database.getToolExecution(execution.id);
				expect(persisted).toBeDefined();
				expect(JSON.stringify(persisted)).not.toContain(secretPixels);
				expect(JSON.stringify(persisted)).not.toContain(privateTreeText);
				expect(JSON.stringify(persisted)).not.toContain(privateValue);
				expect(JSON.stringify(persisted)).not.toContain(privateBundle);
			}
		} finally {
			database.close();
		}
	});

	it("requires approval, executes with the raw value, and compares redacted idempotent input", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const runtime = new AgentRuntime(database);
		const session = runtime.createSession({ title: "Computer Use mutation" });
		const requests: Array<Record<string, unknown>> = [];
		const backend = {
			request: async (request: Record<string, unknown>) => {
				requests.push(request);
				return responseFor(request as { requestId: string; operation: string });
			},
		};
		installComputerUseTools(runtime, backend, session.id);

		const input = {
			pid: 42,
			selector: { identifier: "target-text" },
			value: "secret-value",
		};
		try {
			const blocked = await runtime.callTool(
				session.id,
				"computer_set_element_value",
				input,
				{ idempotencyKey: "blocked" },
			);
			expect(blocked.status).toBe("blocked");
			expect(JSON.stringify(blocked.input)).not.toContain("secret-value");
			expect(requests).toHaveLength(0);

			const approved = await runtime.callTool(
				session.id,
				"computer_set_element_value",
				input,
				{
					approvalStatus: "approved",
					idempotencyKey: "approved",
				},
			);
			expect(approved.status).toBe("verified");
			expect(requests).toHaveLength(1);
			expect(requests[0]?.value).toBe("secret-value");
			expect(
				JSON.stringify(database.listToolExecutions(session.id)),
			).not.toContain("secret-value");

			await expect(
				runtime.callTool(
					session.id,
					"computer_set_element_value",
					{
						...input,
						selector: { identifier: "different-target" },
					},
					{ approvalStatus: "approved", idempotencyKey: "approved" },
				),
			).rejects.toThrow("already used with different input");
		} finally {
			database.close();
		}
	});
});
