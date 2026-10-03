import type { RuntimeMessage } from "@kestrel/shared-types";
import { memo } from "react";
import { Icon } from "./Icon";
import "./runtime-tool-message.css";

const titles: Record<string, string> = {
	"browser.open-tab": "Open tab",
	"browser.create": "Create browser session",
	"browser.navigate": "Open page",
	"browser.navigate-tab": "Open page",
	"browser.snapshot": "Read page",
	"browser.visible-snapshot": "Read page",
	"browser.current-context": "Read page",
	"browser.screenshot": "Capture page",
	"browser.visible-screenshot": "Capture page",
	"browser.act": "Use page",
	"browser.visible-act": "Use page",
	"browser.tabs": "Read tabs",
	"browser.search-history": "Search history",
	"workspace.read": "Read file",
	"workspace.list": "Browse files",
	"workspace.search": "Find in files",
	"workspace.write": "Update file",
	"execution.run": "Run command",
	"execution.run-with-secrets": "Run protected command",
	"agent.config.propose": "Draft configuration change",
	"agent.config.apply": "Apply configuration change",
	"agent.config.rollback": "Restore configuration version",
	"memory.search": "Search Memory",
	"memory.remember": "Save to Memory",
	"tools.search": "Find a tool",
	"tools.activate": "Load a tool",
};

export function runtimeToolTitle(toolName: string, fallback = "Tool result"): string {
	return titles[toolName] ?? fallback;
}

const statuses = {
	verified: "Done",
	failed: "Failed",
	blocked: "Blocked",
	cancelled: "Cancelled",
	running: "In progress",
	unknown: "Result received",
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function runtimeToolMessagePresentation(message: Pick<RuntimeMessage, "toolName" | "content">) {
	if (!message.content.trimStart().startsWith("{")) return null;
	let envelope: Record<string, unknown> | undefined;
	try { envelope = record(JSON.parse(message.content)); } catch { /* Keep malformed results available in Details. */ }
	const output = record(envelope?.output);
	const status = typeof envelope?.status === "string" && Object.hasOwn(statuses, envelope.status)
		? envelope.status as keyof typeof statuses
		: "unknown";
	const commandFailed = status === "verified" && typeof output?.exitCode === "number" && output.exitCode !== 0;
	const effectiveStatus = commandFailed ? "failed" : status;
	const approvalRequired = effectiveStatus === "blocked" && output?.approvalRequired === true;
	let context = "";
	if (typeof output?.url === "string") {
		try { context = new URL(output.url).hostname; } catch { /* No URL is needed for a result row. */ }
	}
	const error = commandFailed
		? `Command exited with code ${output?.exitCode}.`
		: typeof envelope?.error === "string" ? envelope.error.slice(0, 1_000) : "";
	return {
		title: runtimeToolTitle(message.toolName ?? ""),
		status: effectiveStatus,
		label: approvalRequired ? "Needs approval" : statuses[effectiveStatus],
		context,
		error,
		withheld: output?.outputWithheld === true,
	};
}

export const RuntimeToolMessage = memo(function RuntimeToolMessage({ message }: { message: Pick<RuntimeMessage, "id" | "toolName" | "content"> }) {
	const result = runtimeToolMessagePresentation(message);
	if (!result) return (
		<div className="work-summary" data-runtime-message-id={message.id} tabIndex={-1}>
			<Icon name="arrow" />
			<span>{message.content}</span>
		</div>
	);
	return (
		<div className={`runtime-tool-message runtime-tool-message-${result.status}`} data-runtime-message-id={message.id} tabIndex={-1}>
			<details>
				<summary>
					<Icon name={result.status === "verified" ? "check" : result.status === "failed" ? "warning" : "arrow"} />
					<span className="runtime-tool-copy"><strong>{result.title}</strong>{result.context && <small>{result.context}</small>}</span>
					<span className="runtime-tool-status">{result.label}</span>
					<span className="runtime-tool-disclosure">Details <Icon name="chevron" /></span>
				</summary>
				<pre tabIndex={0}>{message.toolName ? `${message.toolName}\n` : ""}{message.content}</pre>
			</details>
			{result.error && <p className="runtime-tool-error">{result.error}</p>}
			{result.withheld && <p className="runtime-tool-note">Output withheld by the protected execution boundary.</p>}
		</div>
	);
});
