import type {
	RuntimeMessage,
	RuntimeToolExecution,
} from "@kestrel/shared-types";
import type { ReactNode } from "react";

export type TranscriptGroup =
	| { kind: "message"; message: RuntimeMessage }
	| { kind: "thinking"; id: string; messages: RuntimeMessage[] };

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function toolResultEnvelope(
	message: Pick<RuntimeMessage, "content">,
): Record<string, unknown> | undefined {
	if (!message.content.trimStart().startsWith("{")) return undefined;
	try {
		return objectValue(JSON.parse(message.content));
	} catch {
		return undefined;
	}
}

function referencedExecutions(
	message: Pick<RuntimeMessage, "toolExecutionId" | "sourceToolExecutionIds">,
	executions: readonly RuntimeToolExecution[],
): RuntimeToolExecution[] {
	const ids = new Set([
		...(message.toolExecutionId ? [message.toolExecutionId] : []),
		...(message.sourceToolExecutionIds ?? []),
	]);
	return ids.size > 0
		? executions.filter((execution) => ids.has(execution.id))
		: [];
}

export function toolMessageNeedsAttention(
	message: Pick<
		RuntimeMessage,
		"content" | "toolExecutionId" | "sourceToolExecutionIds"
	>,
	executions: readonly RuntimeToolExecution[],
): boolean {
	if (
		referencedExecutions(message, executions).some(
			(execution) =>
				execution.outcomeUncertain === true ||
				["failed", "blocked", "cancelled"].includes(execution.status),
		)
	)
		return true;

	const envelope = toolResultEnvelope(message);
	if (!envelope) return /^\s*(error|failed|failure|blocked|cancelled)\b[:\s]/i.test(message.content);
	if (["failed", "blocked", "cancelled"].includes(String(envelope.status)))
		return true;
	if (typeof envelope.error === "string" && envelope.error.trim()) return true;
	const output = objectValue(envelope.output);
	return (
		typeof output?.exitCode === "number" &&
		Number.isFinite(output.exitCode) &&
		output.exitCode !== 0
	);
}

export function toolAttentionCopy(
	message: Pick<
		RuntimeMessage,
		| "content"
		| "toolName"
		| "toolExecutionId"
		| "sourceToolExecutionIds"
	>,
	executions: readonly RuntimeToolExecution[] = [],
): { title: string; detail: string } {
	const envelope = toolResultEnvelope(message);
	const output = objectValue(envelope?.output);
	const execution = referencedExecutions(message, executions).find(
		(item) =>
			item.outcomeUncertain === true ||
			["failed", "blocked", "cancelled"].includes(item.status),
	);
	const executionOutput = objectValue(execution?.output);
	const status = execution?.status ?? String(envelope?.status ?? "");
	const plainError = !envelope && toolMessageNeedsAttention(message, executions) ? message.content.trim() : "";
	const error =
		plainError || execution?.error?.trim() ||
		(typeof envelope?.error === "string" ? envelope.error.trim() : "");
	const exitCode =
		typeof output?.exitCode === "number" && Number.isFinite(output.exitCode)
			? output.exitCode
			: undefined;
	const approvalRequired =
		status === "blocked" &&
		(executionOutput?.approvalRequired === true || output?.approvalRequired === true);
	const title = approvalRequired
		? "Approval required"
		: status === "cancelled"
			? "Action cancelled"
			: status === "blocked"
				? "Action blocked"
				: "Action failed";
	const fallback = exitCode !== undefined && exitCode !== 0
		? `Command exited with code ${exitCode}.`
		: `${message.toolName ?? "This action"} needs attention.`;
	return { title, detail: error || fallback };
}

export function isIntermediateTranscriptMessage(
	message: RuntimeMessage,
	executions: readonly RuntimeToolExecution[],
	hasPresentation = false,
): boolean {
	if (message.role === "assistant") return Boolean(message.modelToolCalls?.length);
	return (
		message.role === "tool" &&
		!message.toolName?.startsWith("agent.config.") &&
		!hasPresentation &&
		!toolMessageNeedsAttention(message, executions) &&
		(referencedExecutions(message, executions).some((execution) => execution.status === "verified") ||
		 ["verified", "completed", "success", "succeeded"].includes(String(toolResultEnvelope(message)?.status)))
	);
}

export function groupTranscriptMessages(
	messages: readonly RuntimeMessage[],
	shouldCollapse: (message: RuntimeMessage) => boolean,
): TranscriptGroup[] {
	const groups: TranscriptGroup[] = [];
	for (const message of messages) {
		if (!shouldCollapse(message)) {
			groups.push({ kind: "message", message });
			continue;
		}
		const previous = groups.at(-1);
		if (previous?.kind === "thinking") previous.messages.push(message);
		else
			groups.push({
				kind: "thinking",
				id: `thinking-${message.id}`,
				messages: [message],
			});
	}
	return groups;
}

export function ThinkingDisclosure({
	children,
	active = false,
	className = "",
}: {
	children: ReactNode;
	active?: boolean;
	className?: string;
}) {
	return (
		<details
			className={`thinking-disclosure${active ? " is-active" : ""}${className ? ` ${className}` : ""}`}
		>
			<summary>
				<span>Thinking</span>
				<span className="thinking-disclosure-chevron" aria-hidden="true" />
			</summary>
			<div className="thinking-disclosure-content">{children}</div>
		</details>
	);
}
