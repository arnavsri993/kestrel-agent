import type {
	RuntimeToolDescriptor,
	RuntimeToolExecution,
} from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import { buildActionReceipt } from "./action-receipts";

const descriptor: RuntimeToolDescriptor = {
	name: "workspace.write",
	title: "Write workspace file",
	description: "Write one bounded file and verify its contents.",
	category: "workspace",
	riskLevel: "low",
	readOnly: false,
	requiresWorkspace: true,
	source: "builtin",
	tags: ["workspace"],
};

function execution(
	overrides: Partial<RuntimeToolExecution> = {},
): RuntimeToolExecution {
	return {
		id: "tool-11111111-1111-4111-8111-111111111111",
		sessionId: "session-receipt",
		toolName: "workspace.write",
		status: "verified",
		riskLevel: "low",
		input: {
			path: "notes/today.md",
			content: "do not copy this private body",
			apiKey: "sk-private-value",
		},
		output: {
			path: "notes/today.md",
			mutationId: "mutation-one",
			operation: "update",
			bytes: 24,
		},
		verification: {
			method: "filesystem-content-readback",
			evidenceSha256: "a".repeat(64),
			verifiedAt: "2026-08-27T20:00:01.000Z",
		},
		idempotencyKey: "run-receipt:call-write",
		startedAt: "2026-08-27T20:00:00.000Z",
		completedAt: "2026-08-27T20:00:01.000Z",
		...overrides,
	};
}

describe("action receipts", () => {
	it("summarizes a verified mutation without copying raw input and exposes only a tested undo", () => {
		const receipt = buildActionReceipt({
			descriptor,
			execution: execution(),
			approval: { required: false, result: "not_required" },
		});
		expect(receipt).toMatchObject({
			runId: "run-receipt",
			action: { title: "Write workspace file", riskLevel: "low" },
			destination: { label: "Granted workspace · notes/today.md" },
			approval: { required: false, result: "not_required" },
			precondition: { status: "satisfied" },
			outcome: "verified",
			verification: { method: "filesystem-content-readback" },
			rollback: {
				status: "available",
				method: "workspace.undo",
				referenceId: "mutation-one",
			},
		});
		const serialized = JSON.stringify(receipt);
		expect(serialized).not.toContain("do not copy this private body");
		expect(serialized).not.toContain("sk-private-value");
	});

	it("records an approval stop before execution", () => {
		const receipt = buildActionReceipt({
			descriptor: { ...descriptor, riskLevel: "sensitive" },
			execution: execution({
				status: "blocked",
				riskLevel: "sensitive",
				output: { approvalRequired: true, preview: "private diff" },
				verification: undefined,
				error: "Approval required.",
				completedAt: "2026-08-27T20:00:00.000Z",
			}),
			approval: { required: true, result: "pending" },
		});
		expect(receipt).toMatchObject({
			outcome: "waiting_approval",
			precondition: { status: "waiting" },
			rollback: { status: "not_applicable" },
		});
		expect(JSON.stringify(receipt)).not.toContain("private diff");
	});

	it("never claims rollback or completion for an uncertain external outcome", () => {
		const receipt = buildActionReceipt({
			descriptor: {
				...descriptor,
				name: "channel.send",
				title: "Send channel message",
				description: "Send one approved message.",
				category: "connector",
				riskLevel: "external",
				readOnly: false,
			},
			execution: execution({
				toolName: "channel.send",
				status: "failed",
				riskLevel: "external",
				input: {
					channelId: "email",
					conversationId: "thread-42",
					text: "private message body",
				},
				output: undefined,
				verification: undefined,
				error:
					"Kestrel could not confirm whether it completed. token=secret-value raw-error-body-sentinel",
			}),
			approval: { required: true, result: "approved_once" },
		});
		expect(receipt).toMatchObject({
			outcome: "uncertain",
			destination: {
				label: "Channel email · conversation thread-42",
			},
			rollback: { status: "unavailable" },
		});
		const serialized = JSON.stringify(receipt);
		expect(serialized).not.toContain("private message body");
		expect(serialized).not.toContain("secret-value");
		expect(serialized).not.toContain("raw-error-body-sentinel");
	});

	it("suppresses result and verification claims when a later failure leaves the action uncertain", () => {
		const receipt = buildActionReceipt({
			descriptor: {
				...descriptor,
				name: "channel.send",
				title: "Send channel message",
				description: "Send one approved message.",
				category: "connector",
				riskLevel: "external",
			},
			execution: execution({
				toolName: "channel.send",
				status: "failed",
				riskLevel: "external",
				output: { messageId: "message-must-not-imply-completion" },
				error: "A post-action hook failed.",
			}),
			approval: { required: true, result: "approved_once" },
		});
		expect(receipt).toMatchObject({
			outcome: "uncertain",
			observedState: expect.stringContaining("could not independently confirm"),
			rollback: { status: "unavailable" },
		});
		expect(receipt).not.toHaveProperty("verification");
		expect(receipt).not.toHaveProperty("result");
		expect(JSON.stringify(receipt)).not.toContain(
			"message-must-not-imply-completion",
		);
	});

	it("strips typed text and credentials from browser destination URLs", () => {
		const receipt = buildActionReceipt({
			descriptor: {
				...descriptor,
				name: "browser.navigate",
				title: "Navigate browser",
				description: "Navigate an isolated browser session.",
				category: "browser",
			},
			execution: execution({
				toolName: "browser.navigate",
				input: { url: "https://example.test/ignored" },
				output: {
					url: "https://user:password@example.test/results/private-typed-path?q=private+typed+text&token=secret&view=compact#private-fragment",
				},
			}),
		});
		expect(receipt?.destination.label).toBe("https://example.test");
		const serialized = JSON.stringify(receipt);
		expect(serialized).not.toContain("private+typed+text");
		expect(serialized).not.toContain("private-typed-path");
		expect(serialized).not.toContain("password");
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("private-fragment");
	});

	it("does not create noisy receipts for read-only tools", () => {
		expect(
			buildActionReceipt({
				descriptor: { ...descriptor, readOnly: true, riskLevel: "read_only" },
				execution: execution({ riskLevel: "read_only" }),
			}),
		).toBeUndefined();
	});
});
