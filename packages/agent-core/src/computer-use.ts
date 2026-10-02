import { randomUUID } from "node:crypto";
import {
	ComputerUseAXValueSchema,
	ComputerUseActionSchema,
	ComputerUseElementSelectorSchema,
	ComputerForegroundActionSchema,
	ComputerForegroundTargetSchema,
	ComputerUsePostconditionSchema,
	ComputerUseRequestSchema,
	ComputerUseResponseSchema,
	type ComputerUseRequest,
	type ComputerUseResponse,
} from "@kestrel/shared-types";
import { z } from "zod";
import type { AgentRuntime } from "./runtime";

/** Main-process service boundary used by the Agent Core utility process. */
export interface ComputerUseBackend {
	request(request: ComputerUseRequest, signal: AbortSignal): Promise<ComputerUseResponse>;
}

export const COMPUTER_USE_TOOL_NAMES = [
	"computer_list_applications",
	"computer_list_windows",
	"computer_observe_window",
	"computer_inspect_window",
	"computer_read_element",
	"computer_act_on_element",
	"computer_set_element_value",
	"computer_foreground_act",
	"computer_get_status",
	"computer_get_invariant",
	"computer_probe_targeted_events",
	"computer_stop",
] as const;

const COMPUTER_USE_REDACTION_REASON = "computer-use-input";
const COMPUTER_USE_OUTPUT_REDACTION_REASON = "computer-use-output";
const COMPUTER_USE_SCREENSHOT_REDACTION_REASON = "computer-use-screenshot";
const COMPUTER_USE_TREE_REDACTION_REASON = "computer-use-accessibility-tree";
const COMPUTER_USE_VALUE_REDACTION_REASON = "computer-use-accessibility-value";
const COMPUTER_USE_INVARIANT_REDACTION_REASON = "computer-use-invariant";

function redactedComputerUseValue() {
	return { redacted: true, reason: COMPUTER_USE_REDACTION_REASON } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Computer-use values are needed by the native action, but are not useful
 * provenance for a durable execution record. Keep selectors and action shape
 * for review/idempotency while replacing entered and expected values.
 */
export function redactComputerUseInput(
	toolName: string,
	input: Record<string, unknown>,
): Record<string, unknown> {
	const redacted = { ...input };
	if (toolName === "computer_set_element_value") {
		if ("value" in redacted) redacted.value = redactedComputerUseValue();
		if ("expectedValue" in redacted)
			redacted.expectedValue = redactedComputerUseValue();
	}
	if (toolName === "computer_act_on_element") {
		if ("expectedValue" in redacted)
			redacted.expectedValue = redactedComputerUseValue();
		if (isRecord(redacted.postcondition) && "expectedValue" in redacted.postcondition)
			redacted.postcondition = {
				...redacted.postcondition,
				expectedValue: redactedComputerUseValue(),
			};
	}
	if (toolName === "computer_foreground_act" && isRecord(redacted.action) && redacted.action.type === "type")
		redacted.action = { type: "type", text: redactedComputerUseValue() };
	return redacted;
}

function safeNonnegativeInteger(value: unknown, maximum: number): number | undefined {
	return typeof value === "number" && Number.isInteger(value) &&
		value >= 0 && value <= maximum ? value : undefined;
}

function boundedSafeString(value: unknown, maximum = 300): string | undefined {
	return typeof value === "string" && value.length <= maximum ? value : undefined;
}

function copyReceipt(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const fields = [
		"actionId",
		"requestId",
		"targetBundleId",
		"targetPid",
		"targetWindowId",
		"elementFingerprint",
		"requestedAction",
		"backend",
		"policyDecision",
		"approvalReference",
		"startedAt",
		"completedAt",
		"postcondition",
		"cursorInvariant",
		"foregroundInvariant",
		"outcome",
	] as const;
	const result: Record<string, unknown> = {};
	for (const field of fields) {
		const entry = value[field];
		if (
			typeof entry === "string" ||
			typeof entry === "number" ||
			typeof entry === "boolean"
		)
			result[field] = entry;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function redactedOutput(
	reason: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { ...extra, redacted: true, reason };
}

/**
 * Durable runtime records must not retain pixels, AX trees, invariant samples,
 * or values read from another application. The first call still returns the
 * original output to the model; AgentRuntime applies this boundary only while
 * journaling and storing idempotent results.
 */
export function redactComputerUseOutput(
	toolName: string,
	output: Record<string, unknown>,
): Record<string, unknown> {
	if (toolName === "computer_observe_window")
		return redactedOutput(COMPUTER_USE_SCREENSHOT_REDACTION_REASON, {
			...(safeNonnegativeInteger(output.windowId, 2_147_483_647) !== undefined
				? { windowId: safeNonnegativeInteger(output.windowId, 2_147_483_647) }
				: {}),
			...(safeNonnegativeInteger(output.width, 3_840) !== undefined
				? { width: safeNonnegativeInteger(output.width, 3_840) }
				: {}),
			...(safeNonnegativeInteger(output.height, 2_160) !== undefined
				? { height: safeNonnegativeInteger(output.height, 2_160) }
				: {}),
			trust: boundedSafeString(output.trust, 100),
		});

	if (toolName === "computer_inspect_window") {
		const tree = isRecord(output.tree) ? output.tree : {};
		const nodes = Array.isArray(tree.nodes) ? tree.nodes.length : undefined;
		return redactedOutput(COMPUTER_USE_TREE_REDACTION_REASON, {
			pid: safeNonnegativeInteger(tree.pid, 10_000_000),
			windowId: safeNonnegativeInteger(tree.windowId, 2_147_483_647),
			nodeCount: nodes === undefined ? undefined : Math.min(nodes, 800),
			truncated: typeof tree.truncated === "boolean" ? tree.truncated : undefined,
		});
	}

	if (toolName === "computer_read_element")
		return redactedOutput(COMPUTER_USE_VALUE_REDACTION_REASON, {
			redacted: true,
		});

	if (toolName === "computer_get_invariant")
		return redactedOutput(COMPUTER_USE_INVARIANT_REDACTION_REASON);

	if (toolName === "computer_list_applications")
		return redactedOutput(COMPUTER_USE_OUTPUT_REDACTION_REASON, {
			applicationCount: Array.isArray(output.applications)
				? Math.min(output.applications.length, 800)
				: undefined,
		});

	if (toolName === "computer_list_windows")
		return redactedOutput(COMPUTER_USE_OUTPUT_REDACTION_REASON, {
			windowCount: Array.isArray(output.windows)
				? Math.min(output.windows.length, 800)
				: undefined,
		});

	if (toolName === "computer_probe_targeted_events") {
		const result: Record<string, unknown> = {};
		for (const field of ["state", "eventClass", "reason"] as const) {
			const entry = output[field];
			if (typeof entry === "string") result[field] = entry.slice(0, 500);
		}
		if (typeof output.backgroundSafe === "boolean")
			result.backgroundSafe = output.backgroundSafe;
		return result;
	}
	if (toolName === "computer_foreground_act") {
		const receipt = copyReceipt(output.receipt);
		return {
			outcome: boundedSafeString(output.outcome, 30),
			delivery: boundedSafeString(output.delivery, 30),
			targetState: boundedSafeString(output.targetState, 30),
			eventsPosted: safeNonnegativeInteger(output.eventsPosted, 10_000),
			...(receipt ? { receipt } : {}),
		};
	}

	if (toolName === "computer_get_status") {
		const safe: Record<string, unknown> = {};
		if (isRecord(output.status)) {
			const source = output.status;
			const status: Record<string, unknown> = {};
			for (const field of ["enabled", "foregroundEnabled", "foregroundReady", "postEventAccess", "foregroundInputBackend", "screenRecording", "accessibility", "nativeBackend", "captureReady", "controlReady"] as const) {
				const entry = source[field];
				if (typeof entry === "string" || typeof entry === "boolean") status[field] = entry;
			}
			safe.status = status;
		}
		for (const name of ["health", "capabilities"] as const) {
			const source = isRecord(output[name]) ? output[name] : undefined;
			if (!source) continue;
			const copy: Record<string, unknown> = {};
			for (const field of [
				"status",
				"protocolVersion",
				"platform",
				"architecture",
				"bridge",
				"publicAPIs",
				"accessibility",
				"screenCaptureKit",
				"screenRecordingPermission",
				"targetedEvents",
				"backgroundSafeOnly",
				"maxTreeNodes",
				"maxCaptureWidth",
				"maxCaptureHeight",
			] as const) {
				const entry = source[field];
				if (
					typeof entry === "string" ||
					typeof entry === "number" ||
					typeof entry === "boolean"
				)
					copy[field] = entry;
			}
			safe[name] = copy;
		}
		return safe;
	}

	if (
		toolName === "computer_act_on_element" ||
		toolName === "computer_set_element_value"
	) {
		const safe: Record<string, unknown> = {};
		for (const field of [
			"performed",
			"set",
			"redacted",
			"backend",
			"targetBundleId",
			"action",
			"postcondition",
		] as const) {
			const entry = output[field];
			if (
				typeof entry === "string" ||
				typeof entry === "number" ||
				typeof entry === "boolean"
			)
				safe[field] = entry;
		}
		const receipt = copyReceipt(output.receipt);
		if (receipt) safe.receipt = receipt;
		return Object.keys(safe).length > 0
			? safe
			: redactedOutput(COMPUTER_USE_OUTPUT_REDACTION_REASON);
	}

	if (toolName === "computer_stop")
		return {
			...(typeof output.cancelled === "boolean"
				? { cancelled: output.cancelled }
				: {}),
			...(safeNonnegativeInteger(output.stoppedOperations, 32) !== undefined
				? { stoppedOperations: safeNonnegativeInteger(output.stoppedOperations, 32) }
				: {}),
		};

	return redactedOutput(COMPUTER_USE_OUTPUT_REDACTION_REASON);
}

const targetInput = {
	pid: { type: "integer", minimum: 1, maximum: 10_000_000 },
	windowId: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
};
const selectorInput = {
	type: "object",
	properties: {
		elementId: { type: "string", minLength: 1, maxLength: 200 },
		fingerprint: { type: "string", minLength: 1, maxLength: 200 },
		role: { type: "string", maxLength: 200 },
		subrole: { type: "string", maxLength: 200 },
		identifier: { type: "string", maxLength: 500 },
		title: { type: "string", maxLength: 1_000 },
		description: { type: "string", maxLength: 1_000 },
		frame: {
			type: "object",
			properties: {
				x: { type: "number" },
				y: { type: "number" },
				width: { type: "number", minimum: 0, maximum: 20_000 },
				height: { type: "number", minimum: 0, maximum: 20_000 },
			},
			required: ["x", "y", "width", "height"],
			additionalProperties: false,
		},
		ancestry: {
			type: "array",
			items: { type: "string", maxLength: 200 },
			maxItems: 16,
		},
	},
	minProperties: 1,
	maxProperties: 8,
	additionalProperties: false,
};
const actionInput = {
	type: "object",
	oneOf: [
		...[
			"press",
			"confirm",
			"cancel",
			"showMenu",
			"pick",
			"select",
			"increment",
			"decrement",
			"expand",
			"collapse",
		].map((type) => ({
				properties: { type: { const: type } },
				required: ["type"],
				additionalProperties: false,
			})),
		{
			properties: {
				type: { const: "scroll" },
				direction: { enum: ["up", "down", "left", "right"] },
				amount: { type: "integer", minimum: 1, maximum: 10 },
			},
			required: ["type", "direction", "amount"],
			additionalProperties: false,
		},
	],
};

const valueInput = {
	oneOf: [
		{ type: "string", maxLength: 20_000 },
		{ type: "number" },
		{ type: "boolean" },
		{ type: "null" },
		{
			type: "object",
			properties: {
				redacted: { const: true },
				reason: { type: "string", maxLength: 100 },
			},
			required: ["redacted", "reason"],
			additionalProperties: false,
		},
	],
};
const postconditionInput = {
	type: "object",
	properties: {
		selector: selectorInput,
		expectedValue: valueInput,
	},
	required: ["selector", "expectedValue"],
	additionalProperties: false,
};

const targetParser = z
	.object({
		pid: z.number().int().positive().max(10_000_000),
		windowId: z.number().int().positive().max(2_147_483_647).optional(),
	})
	.strict();

const captureParser = z.object({
	windowId: z.number().int().positive().max(2_147_483_647),
	maxWidth: z.number().int().gte(1).lte(3_840).optional(),
	maxHeight: z.number().int().gte(1).lte(2_160).optional(),
}).strict();

const selectorParser = z.object({ selector: ComputerUseElementSelectorSchema }).strict();
const invariantParser = z.object({
	targetPid: z.number().int().gte(0).lte(10_000_000).optional(),
}).strict();
const targetedEventsParser = targetParser.extend({
	eventClass: z.enum(["mouse", "keyboard", "scroll"]),
	bundleId: z.string().max(300).optional(),
});

function requestId(executionId: string, operation: string): string {
	return `computer-${executionId}-${operation}-${randomUUID()}`.slice(0, 200);
}

function baseRequest(
	executionId: string,
	operation: ComputerUseRequest["operation"],
): Record<string, unknown> {
	return {
		protocolVersion: 1,
		requestId: requestId(executionId, operation),
		deadlineMs: 30_000,
		operation,
	};
}

async function invoke(
	backend: ComputerUseBackend,
	request: ComputerUseRequest,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	const response = ComputerUseResponseSchema.parse(await backend.request(request, signal));
	if (!response.ok) {
		const error = new Error(
			`Computer Use ${response.error.code}: ${response.error.message}`,
		) as Error & { code: string };
		error.code = response.error.code;
		throw error;
	}
	return response.result;
}

function descriptor(
	name: string,
	title: string,
	description: string,
	readOnly: boolean,
	approvalMode?: "policy" | "always",
) {
	return {
		name,
		title,
		description,
		category: "ui" as const,
		riskLevel: readOnly ? ("read_only" as const) : ("sensitive" as const),
		readOnly,
		requiresWorkspace: false,
		source: "builtin" as const,
		tags: name === "computer_foreground_act"
			? ["computer-use", "foreground", "macos", "input"]
			: ["computer-use", "background-safe", "macos", "semantic"],
		...(approvalMode ? { approvalMode } : {}),
	};
}

/** Register semantic tools; all calls use the same main-process policy boundary as the UI. */
export function installComputerUseTools(
	runtime: AgentRuntime,
	backend: ComputerUseBackend,
	sessionId: string,
): string[] {
	const installed: string[] = [];
	const register = (
		name: (typeof COMPUTER_USE_TOOL_NAMES)[number],
		title: string,
		description: string,
		readOnly: boolean,
		inputSchema: Record<string, unknown>,
		execute: Parameters<AgentRuntime["registerExternalTool"]>[0]["execute"],
		approvalMode?: "policy" | "always",
	) => {
		runtime.registerExternalTool({
			descriptor: descriptor(name, title, description, readOnly, approvalMode),
			inputSchema,
			redactInput: (input) => redactComputerUseInput(name, input),
			redactOutput: (output) => redactComputerUseOutput(name, output),
			execute,
		});
		runtime.allowTool(sessionId, name);
		installed.push(name);
	};

	register(
		"computer_list_applications",
		"List background-capable applications",
		"List running macOS applications and their conservatively discovered background-control state. Unknown applications are unverified.",
		true,
		{ type: "object", properties: {}, additionalProperties: false },
		async ({ signal, executionId }) =>
			invoke(
				backend,
				ComputerUseRequestSchema.parse({
					...baseRequest(executionId, "listApplications"),
				}),
				signal,
			),
	);

	register(
		"computer_list_windows",
		"List background application windows",
		"List bounded macOS window metadata without raising, moving, or activating windows.",
		true,
		{ type: "object", properties: {}, additionalProperties: false },
		async ({ signal, executionId }) =>
			invoke(
				backend,
				ComputerUseRequestSchema.parse({
					...baseRequest(executionId, "listWindows"),
				}),
				signal,
			),
	);

	register(
		"computer_observe_window",
		"Capture a background window",
		"Capture only the selected window with ScreenCaptureKit. The result is untrusted visual input; Kestrel never captures the whole desktop for this tool.",
		true,
		{
			type: "object",
			properties: {
				windowId: targetInput.windowId,
				maxWidth: { type: "integer", minimum: 1, maximum: 3_840 },
				maxHeight: { type: "integer", minimum: 1, maximum: 2_160 },
			},
			required: ["windowId"],
			additionalProperties: false,
		},
		async ({ signal, executionId }, input) => {
			const parsed = captureParser.parse(input);
			return invoke(
				backend,
				ComputerUseRequestSchema.parse({
					...baseRequest(executionId, "captureWindow"),
					windowId: parsed.windowId,
					maxWidth: parsed.maxWidth,
					maxHeight: parsed.maxHeight,
				}),
				signal,
			);
		},
	);

	register(
		"computer_inspect_window",
		"Inspect a background window",
		"Describe one window and inspect a bounded semantic Accessibility tree. Refresh the tree before using an element reference for a mutation.",
		true,
		{
			type: "object",
			properties: {
				windowId: targetInput.windowId,
				maxNodes: { type: "integer", minimum: 1, maximum: 800 },
				maxDepth: { type: "integer", minimum: 1, maximum: 24 },
			},
			required: ["windowId"],
			additionalProperties: false,
		},
		async ({ signal, executionId }, input) => {
			const parsed = z
				.object({
					windowId: z.number().int().positive().max(2_147_483_647),
					maxNodes: z.number().int().gte(1).lte(800).optional(),
					maxDepth: z.number().int().gte(1).lte(24).optional(),
				})
				.strict()
				.parse(input);
			const window = await invoke(
				backend,
				ComputerUseRequestSchema.parse({
					...baseRequest(executionId, "describeWindow"),
					windowId: parsed.windowId,
				}),
				signal,
			);
			const pid = Number((window.window as { pid?: unknown })?.pid);
			if (!Number.isInteger(pid) || pid < 1)
				throw new Error("Computer Use returned an invalid window owner.");
			const tree = await invoke(
				backend,
				ComputerUseRequestSchema.parse({
					...baseRequest(executionId, "inspectAccessibilityTree"),
					pid,
					windowId: parsed.windowId,
					maxNodes: parsed.maxNodes,
					maxDepth: parsed.maxDepth,
				}),
				signal,
			);
			return { window, ...tree };
		},
	);

	register(
		"computer_read_element",
		"Read a background element",
		"Resolve one semantic Accessibility element and read its value. Secure text values are never returned.",
		true,
		{
			type: "object",
			properties: { ...targetInput, selector: selectorInput },
			required: ["pid", "selector"],
			additionalProperties: false,
		},
		async ({ signal, executionId }, input) => {
			const parsed = targetParser.merge(selectorParser).parse(input);
			return invoke(
				backend,
				ComputerUseRequestSchema.parse({
					...baseRequest(executionId, "readAccessibilityValue"),
					...parsed,
				}),
				signal,
			);
		},
	);

	register(
		"computer_act_on_element",
		"Act on a background element",
		"Perform one semantic Accessibility action such as press, confirm, menu, pick, increment, decrement, expand, collapse, or a supported scroll. No physical pointer or global keyboard input is used.",
		false,
		{
			type: "object",
			properties: {
				...targetInput,
				selector: selectorInput,
				action: actionInput,
				expectedValue: valueInput,
				postcondition: postconditionInput,
			},
			required: ["pid", "selector", "action"],
			additionalProperties: false,
		},
		async ({ signal, executionId }, input) => {
			const parsed = targetParser
				.merge(selectorParser)
				.extend({
					action: ComputerUseActionSchema,
					expectedValue: ComputerUseAXValueSchema.optional(),
					postcondition: ComputerUsePostconditionSchema.optional(),
				})
				.parse(input);
			return invoke(
				backend,
				ComputerUseRequestSchema.parse({
					...baseRequest(executionId, "performAccessibilityAction"),
					...parsed,
				}),
				signal,
			);
		},
	);

	register(
		"computer_set_element_value",
		"Set a background element value",
		"Set a text or control value through a settable Accessibility attribute. Values are never typed into the foreground application or copied through the clipboard.",
		false,
		{
			type: "object",
			properties: {
				...targetInput,
				selector: selectorInput,
				value: { type: "string", maxLength: 20_000 },
				secret: { type: "boolean" },
				expectedValue: valueInput,
			},
			required: ["pid", "selector", "value"],
			additionalProperties: false,
		},
		async ({ signal, executionId }, input) => {
			const parsed = targetParser
				.merge(selectorParser)
				.extend({
					value: z.string().max(20_000),
					secret: z.boolean().optional(),
					expectedValue: ComputerUseAXValueSchema.optional(),
				})
				.parse(input);
			return invoke(
				backend,
				ComputerUseRequestSchema.parse({
					...baseRequest(executionId, "setAccessibilityValue"),
					...parsed,
				}),
				signal,
			);
		},
	);

	register(
		"computer_foreground_act",
		"Control the foreground Mac window",
		"Activate or send one click, drag, scroll, text, or modified key action to the exact app and window observed with computer_list_windows. All actions except activate require that window to be frontmost. Coordinates are absolute macOS screen points. Foreground control must be separately enabled; each action needs approval. Input delivery is unverified until separately observed.",
		false,
		{
			type: "object",
			properties: {
				target: {
					type: "object",
					properties: {
						pid: { type: "integer", minimum: 1, maximum: 10_000_000 },
						windowId: { type: "integer", minimum: 1 },
						bundleId: { type: "string", minLength: 1, maxLength: 255 },
						bounds: { type: "object", properties: {
							x: { type: "number" }, y: { type: "number" },
							width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 },
						}, required: ["x", "y", "width", "height"], additionalProperties: false },
					},
					required: ["pid", "windowId", "bundleId", "bounds"], additionalProperties: false,
				},
				action: { oneOf: [
					{ type: "object", properties: { type: { const: "activate" } }, required: ["type"], additionalProperties: false },
					{ type: "object", properties: { type: { const: "click" }, point: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] }, button: { enum: ["left", "right", "middle"] }, clickCount: { type: "integer", minimum: 1, maximum: 3 } }, required: ["type", "point"] },
					{ type: "object", properties: { type: { const: "drag" }, from: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] }, to: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] }, button: { enum: ["left", "right", "middle"] }, durationMs: { type: "integer", minimum: 0, maximum: 10_000 } }, required: ["type", "from", "to"] },
					{ type: "object", properties: { type: { const: "scroll" }, deltaX: { type: "integer" }, deltaY: { type: "integer" }, point: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false } }, required: ["type", "deltaX", "deltaY"], additionalProperties: false },
					{ type: "object", properties: { type: { const: "type" }, text: { type: "string", minLength: 1, maxLength: 4_096 } }, required: ["type", "text"] },
					{ type: "object", properties: { type: { const: "key" }, key: { type: "string", pattern: "^[A-Za-z0-9]{1,20}$" }, modifiers: { type: "array", items: { enum: ["command", "control", "option", "shift", "function"] }, maxItems: 5 } }, required: ["type", "key"] },
				] },
			},
			required: ["target", "action"], additionalProperties: false,
		},
		async ({ signal, executionId }, input) => {
			const target = ComputerForegroundTargetSchema.parse(input.target);
			const action = ComputerForegroundActionSchema.parse(input.action);
			return invoke(backend, ComputerUseRequestSchema.parse({
				...baseRequest(executionId, "performForegroundInput"), target, action,
			}), signal);
		},
		"always",
	);

	register(
		"computer_get_status",
		"Get Mac computer-use status",
		"Report current opt-in settings, macOS permissions, native bridge health, and foreground input readiness.",
		true,
		{ type: "object", properties: {}, additionalProperties: false },
		async ({ signal, executionId }) => {
			const status = await invoke(
				backend,
				ComputerUseRequestSchema.parse({ ...baseRequest(executionId, "status") }),
				signal,
			);
			const health = await invoke(
				backend,
				ComputerUseRequestSchema.parse({ ...baseRequest(executionId, "health") }),
				signal,
			);
			const capabilities = await invoke(
				backend,
				ComputerUseRequestSchema.parse({ ...baseRequest(executionId, "capabilities") }),
				signal,
			);
			return { ...status, health, capabilities };
		},
	);

	register(
		"computer_get_invariant",
		"Read background isolation state",
		"Sample the cursor, frontmost application, and coarse user-activity state without recording input contents or mouse paths.",
		true,
		{
			type: "object",
			properties: { targetPid: targetInput.pid },
			additionalProperties: false,
		},
		async ({ signal, executionId }, input) => {
			const parsed = invariantParser.parse(input);
			return invoke(
				backend,
				ComputerUseRequestSchema.parse({
					...baseRequest(executionId, "getInvariantState"),
					...(parsed.targetPid !== undefined ? { targetPid: parsed.targetPid } : {}),
				}),
				signal,
			);
		},
	);

	register(
		"computer_probe_targeted_events",
		"Check targeted-event compatibility",
		"Report whether an application-specific process-targeted event class has been proven safe. Unknown applications remain unverified and are never used as a fallback.",
		true,
		{
			type: "object",
			properties: {
				...targetInput,
				eventClass: { enum: ["mouse", "keyboard", "scroll"] },
				bundleId: { type: "string", maxLength: 300 },
			},
			required: ["pid", "eventClass"],
			additionalProperties: false,
		},
		async ({ signal, executionId }, input) => {
			const parsed = targetedEventsParser.parse(input);
			return invoke(
				backend,
				ComputerUseRequestSchema.parse({
					...baseRequest(executionId, "probeTargetedEventSupport"),
					...parsed,
				}),
				signal,
			);
		},
	);

	register(
		"computer_stop",
		"Stop background computer use",
		"Cancel all current background computer-use operations. This never repairs focus by activating another application.",
		true,
		{ type: "object", properties: {}, additionalProperties: false },
		async ({ signal, executionId }) =>
			invoke(
				backend,
				ComputerUseRequestSchema.parse({
					...baseRequest(executionId, "cancel"),
					cancelRequestId: "*",
				}),
				signal,
			),
	);

	return installed;
}

export function browserTargetUsesBrowserBackend(target: {
	kind: "kestrel-browser" | "macos-window";
}): "browser" | "macos-accessibility" {
	return target.kind === "kestrel-browser" ? "browser" : "macos-accessibility";
}
