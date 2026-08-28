import { randomUUID } from "node:crypto";
import type {
	BrowserActivityEvent,
	RuntimeToolExecution,
} from "@kestrel/shared-types";
import { BrowserActivityEventSchema } from "@kestrel/shared-types";

const LEDGER_TOOLS = new Set(["browser.act", "browser.visible-act"]);
const MAX_URL = 2_048;
const MAX_TITLE = 500;
const SENSITIVE_URL_PARAMETER =
	/(?:access_?token|api_?key|auth(?:entication|orization)?(?:_?token|_?code)?|code|credential|jwt|password|refresh_?token|secret|session(?:_?id|_?token)?|sig(?:nature)?|ticket|token)/i;

function redactUrl(value: unknown): string {
	const candidate = String(value ?? "").slice(0, MAX_URL);
	try {
		const url = new URL(candidate);
		url.username = "";
		url.password = "";
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			if (SENSITIVE_URL_PARAMETER.test(key)) url.searchParams.delete(key);
		}
		return url.toString().slice(0, MAX_URL);
	} catch {
		return candidate
			.replace(/#.*$/, "")
			.replace(/\/\/[^/?#]*@/, "//")
			.slice(0, MAX_URL);
	}
}

function redactTitle(value: unknown): string {
	return String(value ?? "").slice(0, MAX_TITLE);
}

function outcomeFor(
	status: RuntimeToolExecution["status"],
): BrowserActivityEvent["outcome"] | undefined {
	if (status === "verified") return "performed";
	if (status === "blocked") return "blocked";
	if (status === "failed") return "failed";
	if (status === "cancelled") return "cancelled";
	return undefined;
}

function approvalFor(
	execution: RuntimeToolExecution,
): BrowserActivityEvent["approval"] {
	const output =
		execution.output && typeof execution.output === "object"
			? (execution.output as Record<string, unknown>)
			: {};
	const required = output.approvalRequired === true;
	if (execution.status === "blocked")
		return {
			required: true,
			result: required ? "pending" : "denied",
		};
	if (execution.status === "verified")
		return {
			required: true,
			result: "approved",
		};
	return { required, result: "not_required" };
}

function intentFor(
	input: Record<string, unknown>,
): BrowserActivityEvent["intent"] | undefined {
	const action =
		input.action && typeof input.action === "object"
			? (input.action as Record<string, unknown>)
			: undefined;
	if (!action || typeof action.type !== "string") return undefined;
	if (
		action.type !== "click" &&
		action.type !== "type" &&
		action.type !== "select" &&
		action.type !== "key" &&
		action.type !== "scroll"
	)
		return undefined;
	const intent: BrowserActivityEvent["intent"] = {
		type: action.type,
	};
	if (typeof action.target === "string" && action.target)
		intent.target = action.target.slice(0, 2_000);
	if (typeof action.key === "string" && action.key)
		intent.key = action.key.slice(0, 40);
	if (action.type === "scroll") {
		if (typeof action.x === "number" && Number.isFinite(action.x))
			intent.dx = action.x;
		if (typeof action.y === "number" && Number.isFinite(action.y))
			intent.dy = action.y;
	}
	if (action.type === "type" && typeof action.text === "string")
		intent.textChars = Math.min(action.text.length, 20_000);
	return intent;
}

function observationFor(
	output: unknown,
): BrowserActivityEvent["observation"] | undefined {
	if (!output || typeof output !== "object") return undefined;
	const observation = (output as { observation?: unknown }).observation;
	if (!observation || typeof observation !== "object") return undefined;
	const record = observation as Record<string, unknown>;
	const before =
		record.before && typeof record.before === "object"
			? (record.before as Record<string, unknown>)
			: {};
	const after =
		record.after && typeof record.after === "object"
			? (record.after as Record<string, unknown>)
			: {};
	const added = Array.isArray(record.added) ? record.added.length : 0;
	const removed = Array.isArray(record.removed) ? record.removed.length : 0;
	const changed = Array.isArray(record.changed) ? record.changed.length : 0;
	return {
		before: {
			url: redactUrl(before.url),
			title: redactTitle(before.title),
		},
		after: {
			url: redactUrl(after.url),
			title: redactTitle(after.title),
		},
		added,
		removed,
		changed,
		truncated: record.truncated === true,
		trust: "untrusted_browser",
	};
}

export function summarizeBrowserActivity(
	execution: RuntimeToolExecution,
): BrowserActivityEvent | undefined {
	if (!LEDGER_TOOLS.has(execution.toolName)) return undefined;
	const outcome = outcomeFor(execution.status);
	if (!outcome) return undefined;
	const input = execution.input ?? {};
	const intent = intentFor(input);
	if (!intent) return undefined;
	const visible = execution.toolName === "browser.visible-act";
	const tabId = typeof input.tabId === "string" ? input.tabId : undefined;
	const browserSessionId =
		typeof input.browserSessionId === "string"
			? input.browserSessionId
			: undefined;
	if (visible && !tabId) return undefined;
	if (!visible && !browserSessionId) return undefined;
	const observation =
		execution.status === "verified"
			? observationFor(execution.output)
			: undefined;
	const completedAt = execution.completedAt ?? execution.startedAt;
	const executionUuid = execution.id.replace(/^tool-/, "");
	const id = /^[a-f0-9-]{36}$/.test(executionUuid)
		? `browser-activity-${executionUuid}`
		: `browser-activity-${randomUUID()}`;
	return BrowserActivityEventSchema.parse({
		id,
		ownerSessionId: execution.sessionId,
		surface: visible ? "visible" : "autonomous",
		toolName: visible ? "browser.visible-act" : "browser.act",
		toolExecutionId: execution.id,
		target: visible
			? { kind: "tab", tabId }
			: { kind: "session", browserSessionId },
		intent,
		approval: approvalFor(execution),
		...(observation ? { observation } : {}),
		outcome,
		...(execution.error ? { error: execution.error.slice(0, 500) } : {}),
		createdAt: execution.startedAt,
		completedAt,
		trust: "untrusted_browser",
	});
}
