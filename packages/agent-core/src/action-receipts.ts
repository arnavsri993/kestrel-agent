import type {
	ActionReceipt,
	RuntimeToolDescriptor,
	RuntimeToolExecution,
} from "@kestrel/shared-types";
import { ActionReceiptSchema } from "@kestrel/shared-types";

export type ActionReceiptApprovalContext = ActionReceipt["approval"];

type ReceiptDescriptor = Pick<
	RuntimeToolDescriptor,
	"name" | "title" | "description" | "category" | "riskLevel" | "readOnly"
>;

const SENSITIVE_URL_PARAMETER =
	/(?:access_?token|api_?key|auth(?:entication|orization)?(?:_?token|_?code)?|body|code|content|credential|email|jwt|message|password|phone|prompt|q|query|refresh_?token|search|secret|session(?:_?id|_?token)?|sig(?:nature)?|text|ticket|token)/i;
const UNCERTAIN_OUTCOME =
	/(?:outcome (?:is )?uncertain|may already have (?:completed|started)|could not confirm whether|lost the terminal journal|stopped before it could confirm)/i;

function bounded(value: unknown, maximum = 2_000): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maximum);
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function safeIdentifier(value: unknown): string | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const candidate = bounded(value, 500);
	return candidate && !/[\r\n]/.test(candidate) ? candidate : undefined;
}

function safeUrl(value: unknown, originOnly = false): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.username = "";
		url.password = "";
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) {
			if (SENSITIVE_URL_PARAMETER.test(key)) url.searchParams.delete(key);
		}
		return (originOnly ? url.origin : url.toString()).slice(0, 2_000);
	} catch {
		return undefined;
	}
}

function inferredDescriptor(execution: RuntimeToolExecution): ReceiptDescriptor {
	const prefix = execution.toolName.split(".")[0] ?? "extension";
	const category =
		prefix === "workspace"
			? "workspace"
			: prefix === "browser"
				? "browser"
				: prefix === "google" || prefix === "channel" || prefix === "github"
					? "connector"
					: prefix === "git" || prefix === "process"
						? "execution"
						: prefix === "agent"
							? "configuration"
							: "extension";
	const title = execution.toolName
		.split(/[._-]/)
		.filter(Boolean)
		.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join(" ");
	return {
		name: execution.toolName,
		title: title || execution.toolName,
		description: `Perform ${title || execution.toolName} through Kestrel's scoped tool runtime.`,
		category,
		riskLevel: execution.riskLevel,
		readOnly: execution.riskLevel === "read_only",
	};
}

function receiptRunId(execution: RuntimeToolExecution): string | undefined {
	const prefix = execution.idempotencyKey?.split(":", 1)[0];
	return prefix?.startsWith("run-") ? prefix.slice(0, 200) : undefined;
}

function workspaceDestination(execution: RuntimeToolExecution): string {
	const output = record(execution.output);
	const input = execution.input;
	const from = safeIdentifier(output.from ?? input.from);
	const to = safeIdentifier(output.to ?? input.to ?? output.destinationPath);
	if (from && to) return `${from} → ${to}`;
	const path = safeIdentifier(output.path ?? input.path);
	return path ? `Granted workspace · ${path}` : "Granted workspace";
}

function browserDestination(execution: RuntimeToolExecution): string {
	const output = record(execution.output);
	const observation = record(output.observation);
	const after = record(observation.after);
	const url = safeUrl(after.url ?? output.url, true);
	if (url) return url;
	return execution.toolName.startsWith("browser.visible")
		? "Visible Kestrel browser tab"
		: "Isolated Kestrel browser session";
}

function connectorDestination(execution: RuntimeToolExecution): string {
	if (execution.toolName.startsWith("google.calendar."))
		return "Google Calendar · primary calendar";
	if (execution.toolName.startsWith("channel.")) {
		const channel = safeIdentifier(execution.input.channelId);
		const conversation = safeIdentifier(execution.input.conversationId);
		return channel && conversation
			? `Channel ${channel} · conversation ${conversation}`
			: "Configured communication channel";
	}
	const output = record(execution.output);
	const url = safeUrl(output.url);
	if (url) return url;
	return "Connected external service";
}

function executionDestination(execution: RuntimeToolExecution): string {
	if (execution.toolName.startsWith("git.")) {
		const output = record(execution.output);
		const remote = safeIdentifier(output.remote ?? execution.input.remote);
		const branch = safeIdentifier(output.branch ?? execution.input.branch);
		if (remote && branch) return `Git remote ${remote} · branch ${branch}`;
		if (branch) return `Git repository · branch ${branch}`;
		return "Granted Git workspace";
	}
	return "Local Kestrel execution environment";
}

function destinationFor(
	execution: RuntimeToolExecution,
	descriptor: ReceiptDescriptor,
): string {
	if (descriptor.category === "workspace") return workspaceDestination(execution);
	if (descriptor.category === "browser") return browserDestination(execution);
	if (descriptor.category === "connector") return connectorDestination(execution);
	if (descriptor.category === "configuration") return "Kestrel agent configuration";
	if (descriptor.category === "execution") return executionDestination(execution);
	if (descriptor.category === "automation") return "Kestrel automation schedule";
	if (descriptor.category === "memory") return "Local Kestrel memory";
	if (descriptor.category === "media") return "Local Kestrel media workspace";
	if (descriptor.category === "session") return "Current Kestrel task";
	if (descriptor.category === "web") return "Public web resource";
	return "Installed Kestrel extension";
}

function resultFor(execution: RuntimeToolExecution): string | undefined {
	const output = record(execution.output);
	const result = record(output.result);
	const version = record(result.version);
	const proposal = record(result.proposal);
	const undo = record(result.undo);
	const observation = record(output.observation);
	const after = record(observation.after);
	const parts: string[] = [];
	const add = (label: string, value: unknown) => {
		const identifier = safeIdentifier(value);
		if (identifier) parts.push(`${label}: ${identifier}`);
	};
	const from = safeIdentifier(output.from);
	const to = safeIdentifier(output.to);
	if (from && to) parts.push(`Changed: ${from} → ${to}`);
	else add("Path", output.path);
	add("Operation", output.operation);
	add("Mutation", output.mutationId);
	add("Bytes", output.bytes);
	add("Replacements", output.replacements);
	add("Event", output.eventId);
	add("Message", output.messageId);
	add("Process", output.processId);
	add("Commit", output.commitId);
	add("Remote commit", output.remoteSha);
	add("Branch", output.branch);
	add("Pull request", output.number);
	add("Version", version.id ?? output.versionId);
	add("Proposal", proposal.id ?? output.proposalId);
	add("Undo target", undo.targetVersionId);
	const url = safeUrl(
		output.url ?? after.url,
		execution.toolName.startsWith("browser."),
	);
	if (url) parts.push(`Destination: ${url}`);
	if (observation.added !== undefined || observation.removed !== undefined)
		parts.push(
			`Observed page changes: ${Array.isArray(observation.added) ? observation.added.length : 0} added, ${Array.isArray(observation.removed) ? observation.removed.length : 0} removed, ${Array.isArray(observation.changed) ? observation.changed.length : 0} changed`,
		);
	return parts.length > 0 ? bounded(parts.join(" · ")) : undefined;
}

function hasUncertainEffect(execution: RuntimeToolExecution): boolean {
	return (
		execution.status === "failed" &&
		(Boolean(execution.idempotencyKey) ||
			UNCERTAIN_OUTCOME.test(execution.error ?? ""))
	);
}

function rollbackFor(execution: RuntimeToolExecution): ActionReceipt["rollback"] {
	if (hasUncertainEffect(execution))
		return {
			status: "unavailable",
			reason:
				"The outcome is uncertain. Inspect the destination before attempting a compensating action; Kestrel will not guess or repeat it.",
		};
	if (execution.status !== "verified")
		return {
			status: "not_applicable",
			reason: "No verified change was recorded, so there is nothing safe to undo.",
		};
	const output = record(execution.output);
	const mutationId = safeIdentifier(output.mutationId);
	if (
		mutationId &&
		execution.toolName.startsWith("workspace.") &&
		execution.toolName !== "workspace.undo"
	)
		return {
			status: "available",
			method: "workspace.undo",
			referenceId: mutationId,
			reason:
				"Kestrel retained an encrypted mutation record and can attempt a conflict-safe workspace undo.",
		};
	const result = record(output.result);
	const undo = record(result.undo);
	const targetVersionId = safeIdentifier(undo.targetVersionId);
	if (
		targetVersionId &&
		(execution.toolName === "agent.config.apply" ||
			execution.toolName === "agent.config.rollback")
	)
		return {
			status: "available",
			method: "agent.config.rollback-preview",
			referenceId: targetVersionId,
			reason:
				"A known-good configuration version is available. Kestrel must preview it and obtain a fresh one-time approval before restoring it.",
		};
	if (
		execution.toolName === "agent.config.plan" ||
		execution.toolName === "browser.create"
	)
		return {
			status: "not_applicable",
			reason: "This action prepared local state but did not finalize a consequential external change.",
		};
	return {
		status: "unavailable",
		reason:
			"This tool has no registered and tested inverse. Kestrel will not claim that the action can be undone.",
	};
}

function inferredApproval(execution: RuntimeToolExecution): ActionReceipt["approval"] {
	const approvalRequired = execution.output?.approvalRequired === true;
	if (execution.status === "blocked")
		return {
			required: approvalRequired,
			result: approvalRequired ? "pending" : "denied",
		};
	if (execution.riskLevel === "read_only" || execution.riskLevel === "low")
		return { required: false, result: "not_required" };
	return { required: true, result: "unknown" };
}

function outcomeFor(execution: RuntimeToolExecution): ActionReceipt["outcome"] {
	if (execution.status === "running") return "in_progress";
	if (execution.status === "verified") return "verified";
	if (execution.status === "cancelled") return "cancelled";
	if (execution.status === "blocked")
		return execution.output?.approvalRequired === true
			? "waiting_approval"
			: "blocked";
	return hasUncertainEffect(execution) ? "uncertain" : "failed";
}

function preconditionFor(
	execution: RuntimeToolExecution,
	approval: ActionReceipt["approval"],
): ActionReceipt["precondition"] {
	if (execution.status === "cancelled")
		return approval.result === "pending"
			? {
					status: "blocked",
					summary:
						"The pending approval was invalidated before the action could run.",
				}
			: execution.error === "The approved one-time grant was consumed."
				? {
						status: "satisfied",
						summary:
							"The one-time approval checkpoint was consumed by its recorded follow-up execution.",
					}
				: {
						status: "unknown",
						summary:
							"The action was cancelled before Kestrel recorded a verified change.",
					};
	if (approval.result === "pending")
		return {
			status: "waiting",
			summary: "Kestrel stopped before execution and is waiting for the required approval.",
		};
	if (approval.result === "denied" || execution.status === "blocked")
		return {
			status: "blocked",
			summary:
				"Kestrel's approval policy or a pre-action check blocked the action before a verified change. Raw tool error text is not copied into receipts.",
		};
	return {
		status: "satisfied",
		summary:
			"Kestrel checked session scope, tool policy, and the recorded approval boundary before starting the action.",
	};
}

function observedStateFor(
	execution: RuntimeToolExecution,
	result: string | undefined,
): string {
	if (hasUncertainEffect(execution))
		return "The effect may have started, but Kestrel could not independently confirm the terminal state. It will not repeat the action automatically.";
	if (execution.verification)
		return bounded(
			`Read-back verification passed via ${execution.verification.method}.${result ? ` ${result}` : ""}`,
		);
	if (execution.status === "running")
		return "The action has started; no terminal result or independent verification is recorded yet.";
	if (execution.status === "blocked" && execution.output?.approvalRequired === true)
		return "No action ran. Kestrel is waiting at the approval boundary.";
	if (execution.status === "blocked")
		return "No action ran because a policy or precondition blocked it.";
	if (execution.status === "cancelled")
		return execution.error === "The approved one-time grant was consumed."
			? execution.error
			: "The action was cancelled without a verified result.";
	return "The action failed without independent completion evidence. Raw tool error text is not copied into receipts.";
}

export function buildActionReceipt(input: {
	execution: RuntimeToolExecution;
	descriptor?: ReceiptDescriptor;
	approval?: ActionReceiptApprovalContext;
}): ActionReceipt | undefined {
	const descriptor = input.descriptor ?? inferredDescriptor(input.execution);
	if (descriptor.readOnly || input.execution.riskLevel === "read_only") return undefined;
	const approval = input.approval ?? inferredApproval(input.execution);
	const outcome = outcomeFor(input.execution);
	const result = outcome === "uncertain" ? undefined : resultFor(input.execution);
	const runId = receiptRunId(input.execution);
	return ActionReceiptSchema.parse({
		id: `action-receipt-${input.execution.id.replace(/^tool-/, "")}`,
		sessionId: input.execution.sessionId,
		...(runId ? { runId } : {}),
		toolExecutionId: input.execution.id,
		toolName: input.execution.toolName,
		action: {
			title: bounded(descriptor.title, 500),
			category: descriptor.category,
			riskLevel: input.execution.riskLevel,
			summary: bounded(descriptor.description),
		},
		destination: {
			kind: descriptor.category,
			label: destinationFor(input.execution, descriptor),
		},
		approval,
		precondition: preconditionFor(input.execution, approval),
		expectedState: bounded(descriptor.description),
		observedState: observedStateFor(input.execution, result),
		outcome,
		...(result ? { result } : {}),
		...(outcome === "verified" && input.execution.verification
			? { verification: input.execution.verification }
			: {}),
		rollback: rollbackFor(input.execution),
		startedAt: input.execution.startedAt,
		...(input.execution.completedAt
			? { completedAt: input.execution.completedAt }
			: {}),
		trust: "local_encrypted_bounded",
	});
}
