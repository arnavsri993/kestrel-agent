import type { RuntimeToolExecution } from "@kestrel/shared-types";

export function approvalPreviewText(execution: RuntimeToolExecution): string {
	return typeof execution.output?.preview === "string"
		? execution.output.preview
		: JSON.stringify(execution.input, null, 2);
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function observedBrowserTarget(
	execution: RuntimeToolExecution,
	input: Record<string, unknown>,
	action: Record<string, unknown>,
): { label: string; role: string; url: string; target: string } | null {
	const context = record(execution.output?.approvalContext);
	const target = record(context?.browserTarget);
	if (!target || target.trust !== "untrusted_browser" || target.target !== action.target ||
		typeof target.target !== "string" || typeof target.role !== "string" ||
		typeof target.observedLabel !== "string" || !target.observedLabel ||
		typeof target.url !== "string") return null;
	if (target.target.length > 100 || target.role.length > 100 ||
		target.observedLabel.length > 500 || target.url.length > 2_048) return null;
	const label = target.observedLabel.trim();
	const role = target.role.trim();
	if (!label || !role) return null;
	if (execution.toolName === "browser.act") {
		if (target.surface !== "isolated" || target.browserSessionId !== input.browserSessionId) return null;
	} else if (execution.toolName === "browser.visible-act") {
		if (target.surface !== "visible" || target.tabId !== input.tabId) return null;
	} else return null;
	return { label, role, url: target.url, target: target.target };
}

export function browserApprovalPreview(execution: RuntimeToolExecution): {
	description: string;
	label: string;
	values: string[];
	showArguments?: boolean;
} | null {
	if (!["browser.create", "browser.navigate", "browser.act", "browser.visible-act"].includes(execution.toolName)) return null;
	// The core's protected preview takes precedence over invocation arguments.
	// Unknown fields and incomplete previews retain their full existing display.
	let input: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(approvalPreviewText(execution));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		input = parsed as Record<string, unknown>;
	} catch {
		return null;
	}
	if (execution.toolName === "browser.act" || execution.toolName === "browser.visible-act") {
		const scopeKey = execution.toolName === "browser.act" ? "browserSessionId" : "tabId";
		if (Object.keys(input).length !== 2 || typeof input[scopeKey] !== "string" || !input[scopeKey] ||
			!input.action || typeof input.action !== "object" || Array.isArray(input.action)) return null;
		const action = input.action as Record<string, unknown>;
		const keys = Object.keys(action);
		const target = typeof action.target === "string" && /^e\d+$/.test(action.target) ? action.target : null;
		const observed = observedBrowserTarget(execution, input, action);
		const targetValues = observed
			? [`${observed.label} (${observed.role})`, `Reference: ${observed.target}`, `Page: ${observed.url}`]
			: target ? [target] : [];
		const summary = (description: string, label: string, values: string[]) => ({
			description: `${description} in the ${execution.toolName === "browser.act" ? "isolated browser session" : "user-visible browser"}.`, label, values, showArguments: true,
		});
		if (action.type === "click" && keys.length === 2 && target)
			return summary("Click an observed page element", observed ? "Observed target" : "Element reference", targetValues);
		if (action.type === "type" && keys.length === 3 && target && typeof action.text === "string")
			return summary("Enter text into an observed page element", observed ? "Observed target and text" : "Element reference and text", [...targetValues, action.text]);
		if (action.type === "select" && keys.length === 3 && target && typeof action.value === "string")
			return summary("Select an option in an observed page element", observed ? "Observed target and option" : "Element reference and option", [...targetValues, action.value]);
		if (action.type === "key" && keys.length === 2 && typeof action.key === "string" && action.key)
			return summary("Press a key", "Key", [action.key]);
		if (action.type === "scroll" && keys.length === 3 && typeof action.x === "number" && Number.isFinite(action.x) &&
			typeof action.y === "number" && Number.isFinite(action.y))
			return summary("Scroll the page", "Scroll distance in pixels", [`Horizontal: ${action.x}`, `Vertical: ${action.y}`]);
		return null;
	}
	if (execution.toolName === "browser.create") {
		if (Object.keys(input).length !== 1 || !Array.isArray(input.allowedOrigins) || input.allowedOrigins.length === 0 ||
			!input.allowedOrigins.every((value): value is string => typeof value === "string" && value.length > 0)) return null;
		return {
			description: "Create an isolated browser session.",
			label: "Allowed sites",
			values: input.allowedOrigins,
		};
	}
	if (Object.keys(input).length !== 2 || typeof input.browserSessionId !== "string" || !input.browserSessionId ||
		typeof input.url !== "string" || !input.url) return null;
	return {
		description: "Open this page in the isolated browser session.",
		label: "Page URL",
		values: [input.url],
	};
}
