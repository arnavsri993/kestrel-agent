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
} | null {
	if (execution.toolName !== "browser.create" && execution.toolName !== "browser.navigate") return null;
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
