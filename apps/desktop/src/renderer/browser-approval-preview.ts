import type { RuntimeToolExecution } from "@kestrel/shared-types";

export function approvalPreviewText(execution: RuntimeToolExecution): string {
	return typeof execution.output?.preview === "string"
		? execution.output.preview
		: JSON.stringify(execution.input, null, 2);
}

export function browserApprovalPreview(execution: RuntimeToolExecution): {
	description: string;
	label: string;
	values: string[];
	showArguments?: boolean;
} | null {
	if (!["browser.create", "browser.navigate", "browser.act"].includes(execution.toolName)) return null;
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
	if (execution.toolName === "browser.act") {
		if (Object.keys(input).length !== 2 || typeof input.browserSessionId !== "string" || !input.browserSessionId ||
			!input.action || typeof input.action !== "object" || Array.isArray(input.action)) return null;
		const action = input.action as Record<string, unknown>;
		const keys = Object.keys(action);
		const target = typeof action.target === "string" && /^e\d+$/.test(action.target) ? action.target : null;
		const summary = (description: string, label: string, values: string[]) => ({
			description: `${description} in the isolated browser session.`, label, values, showArguments: true,
		});
		if (action.type === "click" && keys.length === 2 && target)
			return summary("Click an observed page element", "Element reference", [target]);
		if (action.type === "type" && keys.length === 3 && target && typeof action.text === "string")
			return summary("Enter text into an observed page element", "Element reference and text", [target, action.text]);
		if (action.type === "select" && keys.length === 3 && target && typeof action.value === "string")
			return summary("Select an option in an observed page element", "Element reference and option", [target, action.value]);
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
