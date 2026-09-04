import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { KestrelDatabase } from "@kestrel/database";
import {
	GoalRecordSchema,
	AgentIdentitySchema,
	WorkingTaskSchema,
	type ModelCapability,
	type ModelTier,
	type RuntimeToolExecution,
	type AgentIdentity,
	type WorkingTask,
	ScheduledJobSummarySchema,
	type TaskOpportunity,
} from "@kestrel/shared-types";
import {
	type AgentLoop,
	type AgentLoopResult,
	SessionRunBusyError,
} from "./agent-loop";
import {
	type AdaptiveModelRouter,
	type ModelRegistry,
	TaskRequirementAnalyzer,
} from "./model-orchestration";
import {
	AGENT_GROUP_MEMORY_TOOL_NAMES,
	type AgentGroupMemoryManager,
} from "./group-memory";
import { type ProviderPool, textContent } from "./providers";
import type { AgentRuntime } from "./runtime";
import type { MemorySubstrate } from "./memory-substrate";

export interface DelegatedWorkerRoute {
	providerId: string;
	model: string;
	selectedModelId?: string;
	tier?: ModelTier;
	role?: "orchestrator" | "worker" | "reviewer" | "fallback";
	reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	fastMode?: boolean;
	local: boolean;
	confidence?: number;
	estimatedCost?: number;
	fallbackModelIds?: string[];
	traceId?: string;
	refusalRecovery?: boolean;
	verifiedAt: string;
	verificationLatencyMs: number;
	rationale: string;
}

export interface DelegatedTaskInput {
	parentSessionId: string;
	/** Supply this when a caller already has a durable root task. */
	parentTaskId?: string;
	/** Existing durable tasks that must complete before this child can run. */
	dependencyTaskIds?: string[];
	/** Used by durable graph callers that allocate task ids before execution. */
	taskId?: string;
	title: string;
	prompt: string;
	model: string;
	providerIds: string[];
	providerModels?: Record<string, string>;
	reasoningEffort?: DelegatedWorkerRoute["reasoningEffort"];
	allowedTools?: string[];
	instructions?: string;
	maximumTurns?: number;
	isolateWorktree?: boolean;
	role?: "orchestrator" | "worker" | "reviewer" | "fallback";
	requiredCapabilities?: Partial<Record<ModelCapability, number>>;
	delegationDepth?: number;
	signal?: AbortSignal;
}

export interface DelegatedTaskResult {
	taskId: string;
	sessionId: string;
	result: AgentLoopResult;
	route?: DelegatedWorkerRoute;
}

/** Tools that let a durable root session coordinate real child work. */
export const AGENT_COORDINATION_TOOL_NAMES = [
	"orchestration.delegate",
	"orchestration.delegate-team",
	"orchestration.handoff",
] as const;

export interface ScheduledAgentJob {
	id: string;
	title: string;
	sessionId: string;
	model: string;
	providerIds: string[];
	providerModels?: Record<string, string>;
	prompt: string;
	instructions?: string;
	schedule:
		| { kind: "once"; nextRunAt: string }
		| { kind: "interval"; nextRunAt: string; intervalMs: number }
		| { kind: "cron"; nextRunAt: string; expression: string };
	status:
		| "pending"
		| "running"
		| "waiting_approval"
		| "completed"
		| "failed"
		| "cancelled";
	lastRunId?: string;
	error?: string | undefined;
	createdAt: string;
	updatedAt: string;
}

const MIN_SCHEDULE_INTERVAL_MS = 60_000;
const MAX_SCHEDULE_INTERVAL_MS = 31_536_000_000;

function cronField(
	value: string,
	minimum: number,
	maximum: number,
): (candidate: number) => boolean {
	if (value === "*") return () => true;
	const step = value.match(/^\*\/(\d+)$/);
	if (step) {
		const amount = Number(step[1]);
		if (amount < 1 || amount > maximum - minimum + 1)
			throw new Error("Cron step is invalid.");
		return (candidate) => (candidate - minimum) % amount === 0;
	}
	const values = value.split(",").map(Number);
	if (
		values.some(
			(item) => !Number.isInteger(item) || item < minimum || item > maximum,
		)
	)
		throw new Error("Cron field is invalid.");
	return (candidate) => values.includes(candidate);
}

export function nextCronOccurrence(expression: string, after: Date): Date {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5)
		throw new Error("Cron expressions require five fields.");
	const [minute, hour, day, month, weekday] = fields as [
		string,
		string,
		string,
		string,
		string,
	];
	const matches = [
		cronField(minute, 0, 59),
		cronField(hour, 0, 23),
		cronField(day, 1, 31),
		cronField(month, 1, 12),
		cronField(weekday, 0, 6),
	];
	const candidate = new Date(after.getTime());
	candidate.setUTCSeconds(0, 0);
	candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
	for (
		let count = 0;
		count < 527_040;
		count += 1, candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
	) {
		if (
			matches[0]!(candidate.getUTCMinutes()) &&
			matches[1]!(candidate.getUTCHours()) &&
			matches[2]!(candidate.getUTCDate()) &&
			matches[3]!(candidate.getUTCMonth() + 1) &&
			matches[4]!(candidate.getUTCDay())
		)
			return new Date(candidate);
	}
	throw new Error("Cron expression has no occurrence within one year.");
}

export function parseScheduleExpression(
	expression: string,
	now = new Date(),
): ScheduledAgentJob["schedule"] {
	const value = expression.trim().toLowerCase();
	const every = value.match(
		/^every\s+(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days)$/,
	);
	if (every) {
		const unit = every[2]!.startsWith("second")
			? 1_000
			: every[2]!.startsWith("minute")
				? 60_000
				: every[2]!.startsWith("hour")
					? 3_600_000
					: 86_400_000;
		const intervalMs = Number(every[1]) * unit;
		if (
			intervalMs < MIN_SCHEDULE_INTERVAL_MS ||
			intervalMs > MAX_SCHEDULE_INTERVAL_MS
		)
			throw new Error("Natural-language interval is outside supported bounds.");
		return {
			kind: "interval",
			intervalMs,
			nextRunAt: new Date(now.getTime() + intervalMs).toISOString(),
		};
	}
	const tomorrow = value.match(
		/^tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/,
	);
	if (tomorrow) {
		let hour = Number(tomorrow[1]);
		const minute = Number(tomorrow[2] ?? 0);
		if (tomorrow[3]) {
			if (hour < 1 || hour > 12)
				throw new Error("Natural-language time is invalid.");
			hour %= 12;
			if (tomorrow[3] === "pm") hour += 12;
		}
		if (hour > 23 || minute > 59)
			throw new Error("Natural-language time is invalid.");
		const next = new Date(now);
		next.setUTCDate(next.getUTCDate() + 1);
		next.setUTCHours(hour, minute, 0, 0);
		return { kind: "once", nextRunAt: next.toISOString() };
	}
	if (value.split(/\s+/).length === 5)
		return {
			kind: "cron",
			expression: value,
			nextRunAt: nextCronOccurrence(value, now).toISOString(),
		};
	const instant = new Date(expression);
	if (!Number.isFinite(instant.getTime()) || instant <= now)
		throw new Error(
			"Schedule expression is not a future time, interval, or five-field cron.",
		);
	return { kind: "once", nextRunAt: instant.toISOString() };
}

export interface WorkflowStep {
	id: string;
	toolName: string;
	input: Record<string, unknown>;
	approvalStatus?: "pending" | "approved";
	when?: { reference: string; equals?: unknown; exists?: boolean };
	forEach?: unknown[];
}

export interface WorkflowRecord {
	id: string;
	sessionId: string;
	title: string;
	steps: WorkflowStep[];
	nextStep: number;
	status: "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
	results: Record<string, RuntimeToolExecution>;
	createdAt: string;
	updatedAt: string;
}

export interface GoalTask {
	id: string;
	title: string;
	status: "pending" | "in_progress" | "completed";
	assigneeSessionId?: string;
	dependsOn?: string[];
	dueAt?: string;
}
export interface GoalRecord {
	id: string;
	sessionId: string;
	title: string;
	objective: string;
	status: "active" | "completed" | "cancelled";
	tasks: GoalTask[];
	sourceOpportunityId?: string;
	deadline?: string;
	createdAt: string;
	updatedAt: string;
}
export interface TeamMessage {
	id: string;
	fromSessionId: string;
	toSessionId: string;
	text: string;
	createdAt: string;
}
export interface TeamRecord {
	id: string;
	parentSessionId: string;
	title: string;
	memberSessionIds: string[];
	sharedPlan: string[];
	messages: TeamMessage[];
	createdAt: string;
	updatedAt: string;
}

function parseStoredGoals(value: unknown): GoalRecord[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const parsed = GoalRecordSchema.safeParse(item);
		return parsed.success ? [parsed.data as GoalRecord] : [];
	});
}

function resolveReference(
	reference: string,
	results: Record<string, RuntimeToolExecution>,
): unknown {
	if (!reference.startsWith("$")) return reference;
	const [stepId, ...path] = reference.slice(1).split(".");
	let value: unknown = results[stepId ?? ""]?.output;
	for (const segment of path) {
		if (!value || typeof value !== "object") return undefined;
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
}

function resolveInput(
	value: unknown,
	results: Record<string, RuntimeToolExecution>,
): unknown {
	if (typeof value === "string") return resolveReference(value, results);
	if (Array.isArray(value))
		return value.map((item) => resolveInput(item, results));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				resolveInput(item, results),
			]),
		);
	return value;
}

function itemValue(reference: string, item: unknown): unknown {
	if (reference === "$item") return item;
	if (!reference.startsWith("$item.")) return reference;
	let value = item;
	for (const segment of reference.slice(6).split(".")) {
		if (!value || typeof value !== "object") return undefined;
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
}

function substituteItem(value: unknown, item: unknown): unknown {
	if (typeof value === "string") return itemValue(value, item);
	if (Array.isArray(value))
		return value.map((entry) => substituteItem(entry, item));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				substituteItem(entry, item),
			]),
		);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractArtifactIds(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap((item) => extractArtifactIds(item));
	if (!isRecord(value)) return [];
	const ids: string[] = [];
	for (const [key, nested] of Object.entries(value)) {
		if (
			(key === "artifactId" || key === "artifact_id") &&
			typeof nested === "string" &&
			nested.trim()
		)
			ids.push(nested.trim());
		else ids.push(...extractArtifactIds(nested));
	}
	return ids;
}

function isScheduledAgentJob(value: unknown): value is ScheduledAgentJob {
	if (!isRecord(value)) return false;
	const parsed = ScheduledJobSummarySchema.safeParse(value);
	if (
		!parsed.success ||
		!parsed.data.id ||
		parsed.data.providerIds.length === 0 ||
		typeof value.prompt !== "string"
	)
		return false;
	if (
		value.instructions !== undefined &&
		typeof value.instructions !== "string"
	)
		return false;
	if (
		value.providerModels !== undefined &&
		(!isRecord(value.providerModels) ||
			Object.values(value.providerModels).some(
				(model) => typeof model !== "string",
			))
	)
		return false;
	if (
		parsed.data.schedule.kind === "interval" &&
		(parsed.data.schedule.intervalMs < MIN_SCHEDULE_INTERVAL_MS ||
			parsed.data.schedule.intervalMs > MAX_SCHEDULE_INTERVAL_MS)
	)
		return false;
	if (parsed.data.schedule.kind === "cron") {
		try {
			const expected = nextCronOccurrence(
				parsed.data.schedule.expression,
				new Date(new Date(parsed.data.schedule.nextRunAt).getTime() - 60_000),
			);
			if (expected.toISOString() !== parsed.data.schedule.nextRunAt)
				return false;
		} catch {
			return false;
		}
	}
	return true;
}

function isWorkflowRecord(value: unknown): value is WorkflowRecord {
	if (!isRecord(value)) return false;
	const steps = value.steps;
	const results = value.results;
	const validSteps =
		Array.isArray(steps) &&
		steps.length <= 200 &&
		steps.every((step) => {
			if (
				!isRecord(step) ||
				typeof step.id !== "string" ||
				typeof step.toolName !== "string" ||
				!isRecord(step.input)
			)
				return false;
			if (
				step.approvalStatus !== undefined &&
				!["pending", "approved"].includes(String(step.approvalStatus))
			)
				return false;
			if (
				step.when !== undefined &&
				(!isRecord(step.when) || typeof step.when.reference !== "string")
			)
				return false;
			return (
				step.forEach === undefined ||
				(Array.isArray(step.forEach) && step.forEach.length <= 20)
			);
		});
	return (
		typeof value.id === "string" &&
		typeof value.sessionId === "string" &&
		typeof value.title === "string" &&
		validSteps &&
		Number.isInteger(value.nextStep) &&
		Number(value.nextStep) >= 0 &&
		Number(value.nextStep) <= steps.length &&
		[
			"running",
			"waiting_approval",
			"completed",
			"failed",
			"cancelled",
		].includes(String(value.status)) &&
		isRecord(results) &&
		Object.values(results).every(isRecord) &&
		typeof value.createdAt === "string" &&
		!Number.isNaN(Date.parse(value.createdAt)) &&
		typeof value.updatedAt === "string" &&
		!Number.isNaN(Date.parse(value.updatedAt))
	);
}

function workflowConditionMatches(
	condition: WorkflowStep["when"],
	results: Record<string, RuntimeToolExecution>,
): boolean {
	if (!condition) return true;
	if (!condition.reference.startsWith("$"))
		throw new Error("Workflow conditions require a result reference.");
	const value = resolveReference(condition.reference, results);
	if (
		condition.exists !== undefined &&
		condition.exists !== (value !== undefined)
	)
		return false;
	return (
		!("equals" in condition) ||
		JSON.stringify(value) === JSON.stringify(condition.equals)
	);
}

export class TaskOrchestrator {
	private readonly jobsKey = "orchestrator.scheduled-jobs";
	private readonly goalsKey = "orchestrator.goals";
	private readonly teamsKey = "orchestrator.teams";
	private readonly maximumStoredGoals = 200;
	private readonly activeDelegations = new Map<
		string,
		{ controller: AbortController; parentSessionId: string; sessionId?: string }
	>();

	constructor(
		private readonly database: KestrelDatabase,
		private readonly runtime: AgentRuntime,
		private readonly loop: AgentLoop,
		private readonly now: () => Date = () => new Date(),
		private readonly maximumWorkers = 4,
		private readonly providers?: ProviderPool,
		private readonly modelRouter?: AdaptiveModelRouter,
		private readonly modelRegistry?: ModelRegistry,
		private readonly requirementAnalyzer = new TaskRequirementAnalyzer(),
		private readonly configuredMaximumTurns: () => number = () => 12,
		private readonly groupMemory?: AgentGroupMemoryManager,
		private readonly memorySubstrate?: MemorySubstrate,
	) {
		this.reconcileInterruptedJobs();
	}

	private agentIdForSession(session: ReturnType<AgentRuntime["getSession"]>): string {
		if (this.memorySubstrate)
			return this.memorySubstrate.ensureAgentIdentity(session).id;
		const id = session.parentSessionId ? `agent-${session.id}` : "agent-main";
		if (this.database.getAgentIdentity(id)) return id;
		const parent = session.parentSessionId
			? this.runtime.getSession(session.parentSessionId)
			: undefined;
		const parentAgentId = parent ? this.agentIdForSession(parent) : undefined;
		const timestamp = this.now().toISOString();
		this.database.upsertAgentIdentity(
			AgentIdentitySchema.parse({
				id,
				kind: session.parentSessionId ? "subagent" : "main",
				...(parentAgentId ? { parentAgentId } : {}),
				sessionId: session.id,
				name: session.title,
				purpose: session.parentSessionId
					? "Persistent delegated Kestrel agent."
					: "Coordinate the user's Kestrel work.",
				specialization: session.parentSessionId
					? "Bounded delegated task"
					: "General Kestrel agent",
				memoryScope: "private",
				status: "active",
				createdAt: timestamp,
				updatedAt: timestamp,
			}),
		);
		return id;
	}

	private activeWorkingTaskForSession(sessionId: string): WorkingTask | undefined {
		return this.database
			.listWorkingTasks({ sessionId, includeCompleted: false, limit: 100 })
			.find((task) => task.status === "running" || task.status === "waiting");
	}

	private durableTask(
		input: Omit<WorkingTask, "createdAt" | "updatedAt"> &
			Partial<Pick<WorkingTask, "createdAt" | "updatedAt">>,
	): WorkingTask {
		if (this.memorySubstrate) return this.memorySubstrate.createWorkingTask(input);
		const timestamp = this.now().toISOString();
		const task = WorkingTaskSchema.parse({
			...input,
			dependencyTaskIds: input.dependencyTaskIds ?? [],
			sourceIds: input.sourceIds ?? [],
			projectIds: input.projectIds ?? [],
			personIds: input.personIds ?? [],
			entityIds: input.entityIds ?? [],
			plan: input.plan ?? [],
			evidence: input.evidence ?? [],
			artifacts: input.artifacts ?? [],
			failures: input.failures ?? [],
			unresolvedQuestions: input.unresolvedQuestions ?? [],
			subtaskIds: input.subtaskIds ?? [],
			startedAt: input.startedAt ?? timestamp,
			createdAt: input.createdAt ?? timestamp,
			updatedAt: input.updatedAt ?? timestamp,
		});
		this.database.upsertWorkingTask(task);
		return task;
	}

	private saveDurableTask(task: WorkingTask, agentId = task.agentId): WorkingTask {
		if (this.memorySubstrate)
			return this.memorySubstrate.recordTaskOutcome(task, agentId);
		const parsed = WorkingTaskSchema.parse({
			...task,
			updatedAt: task.updatedAt || this.now().toISOString(),
		});
		this.database.upsertWorkingTask(parsed);
		return parsed;
	}

	private attachSubtask(parent: WorkingTask | undefined, childId: string): void {
		if (!parent || parent.subtaskIds.includes(childId)) return;
		this.saveDurableTask({
			...parent,
			subtaskIds: [...parent.subtaskIds, childId].slice(0, 100),
			updatedAt: this.now().toISOString(),
		}, parent.agentId);
	}

	private validateTaskDependencies(
		taskId: string,
		parentTask: WorkingTask | undefined,
		dependencyTaskIds: readonly string[],
	): string[] {
		const dependencies = [...new Set(dependencyTaskIds.map((id) => id.trim()).filter(Boolean))];
		if (dependencies.length > 100)
			throw new Error("A delegated task can have at most 100 dependencies.");
		if (dependencies.includes(taskId))
			throw new Error("A task cannot depend on itself.");
		if (parentTask && dependencies.includes(parentTask.id))
			throw new Error("A child task cannot depend on its parent task.");
		for (const dependencyId of dependencies) {
			const dependency = this.database.getWorkingTask(dependencyId);
			if (!dependency) throw new Error(`Dependency task ${dependencyId} was not found.`);
			const visited = new Set<string>();
			let current: WorkingTask | undefined = dependency;
			while (current) {
				if (current.id === taskId)
					throw new Error("Task dependency graph contains a cycle.");
				if (visited.has(current.id)) break;
				visited.add(current.id);
				current = current.dependencyTaskIds
					.map((id) => this.database.getWorkingTask(id))
					.find((candidate): candidate is WorkingTask => Boolean(candidate));
			}
		}
		return dependencies;
	}

	private async waitForTaskDependencies(
		task: WorkingTask,
		signal: AbortSignal,
	): Promise<void> {
		if (task.dependencyTaskIds.length === 0) return;
		this.saveDurableTask({
			...task,
			status: "waiting",
			updatedAt: this.now().toISOString(),
		});
		while (true) {
			if (signal.aborted) throw signal.reason ?? new Error("Delegated task cancelled.");
			const dependencies = task.dependencyTaskIds.map((id) => this.database.getWorkingTask(id));
			if (dependencies.some((dependency) => !dependency))
				throw new Error("A delegated task dependency was removed before execution.");
			const failed = dependencies.find(
				(dependency) => dependency && ["failed", "cancelled"].includes(dependency.status),
			);
			if (failed)
				throw new Error(`Dependency task ${failed.id} did not complete.`);
			if (dependencies.every((dependency) => dependency?.status === "completed")) return;
			await new Promise<void>((resolvePromise, rejectPromise) => {
				const timer = setTimeout(resolvePromise, 100);
				const abort = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", abort);
					rejectPromise(signal.reason ?? new Error("Delegated task cancelled."));
				};
				signal.addEventListener("abort", abort, { once: true });
				timer.unref?.();
			});
		}
	}

	private taskEvidence(sessionId: string, task: WorkingTask): {
		evidence: WorkingTask["evidence"];
		artifacts: string[];
	} {
		const evidence: WorkingTask["evidence"] = [
			{ type: "session", id: sessionId, label: "Delegated session" },
		];
		const messages = this.runtime.listMessages(sessionId).slice(-40);
		for (const message of messages)
			evidence.push({
				type: "runtime_message",
				id: message.id,
				label: message.role,
			});
		const executions = this.database
			.listToolExecutions(sessionId)
			.filter((execution) => execution.startedAt >= task.createdAt)
			.slice(-80);
		for (const execution of executions)
			evidence.push({
				type: "tool_execution",
				id: execution.id,
				label: execution.toolName,
			});
		const artifacts = executions.flatMap((execution) =>
				extractArtifactIds(execution.output),
			);
		return {
			evidence: evidence.slice(0, 500),
			artifacts: [...new Set(artifacts)].slice(0, 500),
		};
	}

	private privateAgentContext(sessionId: string, query: string): string {
		if (!this.memorySubstrate) return "";
		try {
			return this.memorySubstrate.getRelevantContext({
				query,
				sessionId,
				agentId: this.agentIdForSession(this.runtime.getSession(sessionId)),
				includeSharedMemory: false,
				includeSensitive: false,
				includeRestricted: false,
				maximumCharacters: 12_000,
			}).prompt;
		} catch {
			// Memory is an observer and must not make a delegated run fail.
			return "";
		}
	}

	async delegate(input: DelegatedTaskInput): Promise<DelegatedTaskResult> {
		const parent = this.runtime.getSession(input.parentSessionId);
		const taskId = input.taskId ?? `task-${randomUUID()}`;
		const parentTask = input.parentTaskId
			? this.database.getWorkingTask(input.parentTaskId)
			: this.activeWorkingTaskForSession(parent.id);
		if (input.parentTaskId && !parentTask)
			throw new Error("The delegated task parent record was not found.");
		if (parentTask && parentTask.sessionId && parentTask.sessionId !== parent.id)
			throw new Error("The delegated task parent belongs to another session.");
		const dependencyTaskIds = this.validateTaskDependencies(
			taskId,
			parentTask,
			input.dependencyTaskIds ?? [],
		);
		const taskController = new AbortController();
		this.activeDelegations.set(taskId, {
			controller: taskController,
			parentSessionId: parent.id,
		});
		let workspaceRoot = parent.workspaceRoot;
		let session: ReturnType<AgentRuntime["createSession"]> | undefined;
		let workingTask: WorkingTask | undefined;
		let selected:
			| Awaited<ReturnType<TaskOrchestrator["selectWorker"]>>
			| undefined;
		try {
			if (input.isolateWorktree) {
				if (!parent.workspaceRoot)
					throw new Error(
						"Worktree isolation requires a workspace-backed parent session.",
					);
				const branch = `kestrel/${taskId.slice(-12)}`;
				const worktree = await this.runtime.callTool(
					parent.id,
					"git.worktree-create",
					{ branch, startPoint: "HEAD", createBranch: true },
					{
						approvalStatus: "approved",
						idempotencyKey: `delegate:${taskId}:worktree`,
						signal: taskController.signal,
					},
				);
				if (
					worktree.status !== "verified" ||
					typeof worktree.output?.path !== "string"
				)
					throw new Error(
						worktree.error ?? "Delegated worktree creation failed.",
					);
				workspaceRoot = resolve(parent.workspaceRoot, worktree.output.path);
			}
			const inheritedTools = input.allowedTools ?? parent.allowedTools;
			const groupMemoryAllowed =
				Boolean(this.groupMemory) &&
				parent.privacyMode !== "private" &&
				parent.privacyMode !== "incognito";
			const allowedTools = groupMemoryAllowed
				? [...new Set([...inheritedTools, ...AGENT_GROUP_MEMORY_TOOL_NAMES])]
				: inheritedTools.filter(
						(toolName) =>
							!AGENT_GROUP_MEMORY_TOOL_NAMES.some(
									(memoryToolName) => memoryToolName === toolName,
							),
						);
			session = this.runtime.createSession({
				title: input.title,
				kind: "subagent",
				parentSessionId: parent.id,
				...(workspaceRoot ? { workspaceRoot } : {}),
				...(parent.privacyMode ? { privacyMode: parent.privacyMode } : {}),
				allowedTools,
			});
			this.activeDelegations.set(taskId, {
				controller: taskController,
				parentSessionId: parent.id,
				sessionId: session.id,
			});
			const agentId = this.agentIdForSession(session);
			workingTask = this.durableTask({
				id: taskId,
				sessionId: session.id,
				...(parentTask ? { parentTaskId: parentTask.id } : {}),
				dependencyTaskIds,
				agentId,
				sourceIds: [`session:${session.id}`],
				projectIds: session.projectId ? [session.projectId] : [],
				personIds: [],
				entityIds: [],
				goal: input.prompt,
				plan: [
					`Delegated by ${parent.title}`,
					...(input.instructions ? [input.instructions] : []),
				],
				status: dependencyTaskIds.length > 0 ? "waiting" : "planned",
				evidence: [
					{ type: "session", id: session.id, label: "Delegated session" },
				],
				artifacts: [],
				failures: [],
				unresolvedQuestions: [],
				subtaskIds: [],
				startedAt: this.now().toISOString(),
			});
			this.attachSubtask(parentTask, workingTask.id);
			const executionSignal = AbortSignal.any([
				taskController.signal,
				...(input.signal ? [input.signal] : []),
				AbortSignal.timeout(
					this.modelRouter?.policy().maximumTaskDurationMs ?? 600_000,
				),
			]);
			await this.waitForTaskDependencies(workingTask, executionSignal);
			workingTask = this.saveDurableTask({
				...workingTask,
				status: "running",
				updatedAt: this.now().toISOString(),
			});
			selected =
				input.model === "auto" || input.providerIds.includes("auto")
					? await this.selectWorker(input, taskId, session.allowedTools)
					: undefined;
			const privateMemoryContext = this.privateAgentContext(
				session.id,
				input.prompt,
			);
			const result = await this.loop.run({
				sessionId: session.id,
				model: selected?.execution.model ?? input.model,
				providerIds: selected?.execution.providerIds ?? input.providerIds,
				...(input.providerModels || selected
					? {
							providerModels: {
								...selected?.execution.providerModels,
								...input.providerModels,
							},
						}
					: {}),
				...(selected?.route.reasoningEffort || input.reasoningEffort
					? {
							reasoningEffort:
								selected?.route.reasoningEffort ?? input.reasoningEffort,
						}
					: {}),
				...(selected
					? {
							serviceTier: selected.route.fastMode ? "priority" : "standard",
							maximumContextCharacters: selected.maximumContextCharacters,
							maximumOutputTokens: selected.maximumOutputTokens,
							temperature: selected.temperature,
						}
					: {}),
				userContent: textContent(input.prompt),
				...(input.instructions || selected?.instructions || this.groupMemory || privateMemoryContext
					? {
							instructions: [
								input.instructions,
								selected?.instructions,
								privateMemoryContext,
								this.groupMemory?.promptContext(session.id, input.prompt),
							]
								.filter(Boolean)
									.join("\n\n"),
						}
					: {}),
				maximumTurns: this.maximumTurnsForRun(input.maximumTurns),
				signal: executionSignal,
			});
			this.recordSelectedOutcome(selected, result);
			const route = selected?.route;
			if (workingTask) {
				const terminalStatus =
					result.run.status === "completed"
						? "completed"
						: result.run.status === "cancelled"
							? "cancelled"
							: result.run.status === "failed"
								? "failed"
								: "waiting";
				const evidence = this.taskEvidence(session.id, workingTask);
				workingTask = this.saveDurableTask(
					{
						...workingTask,
						status: terminalStatus,
						evidence: [
							...workingTask.evidence,
							{ type: "agent_run", id: result.run.id, label: result.run.status },
							...evidence.evidence,
						].slice(0, 500),
						artifacts: evidence.artifacts,
						...(result.assistantMessage
							? { outcomeSummary: result.assistantMessage.content.slice(0, 20_000) }
							: {}),
					...(terminalStatus === "completed" ||
						terminalStatus === "failed" ||
						terminalStatus === "cancelled"
						? { completedAt: this.now().toISOString() }
						: {}),
					failures:
						terminalStatus === "failed" && result.run.error
							? [...workingTask.failures, result.run.error].slice(-100)
							: workingTask.failures,
					updatedAt: this.now().toISOString(),
					},
					workingTask.agentId,
				);
			}
			return {
				taskId,
				sessionId: session.id,
				result,
				...(route ? { route } : {}),
			};
		} catch (error) {
			const terminalStatus =
				taskController.signal.aborted ||
				input.signal?.aborted ||
				session?.status === "cancelled"
					? "cancelled"
					: "failed";
			if (selected) {
				this.modelRegistry?.recordOutcome({
					modelId: selected.decision.selectedModelId,
					capabilities: selected.requirements.capabilities,
					succeeded: false,
					validationPassed: false,
					escalated: false,
					observedAt: this.now().toISOString(),
				});
				if (selected.decision.traceId)
					this.modelRouter?.completeTrace(selected.decision.traceId, {
						status: terminalStatus,
						escalated: false,
					});
			}
			if (workingTask) {
				const sessionId = session?.id;
				const evidence = sessionId ? this.taskEvidence(sessionId, workingTask) : undefined;
				workingTask = this.saveDurableTask(
					{
						...workingTask,
						status: terminalStatus,
						...(evidence ? { evidence: [...workingTask.evidence, ...evidence.evidence].slice(0, 500) } : {}),
						failures: [
							...workingTask.failures,
							error instanceof Error ? error.message : "Delegated task failed.",
						].slice(-100),
						...(terminalStatus === "failed" || terminalStatus === "cancelled"
							? { completedAt: this.now().toISOString() }
							: {}),
						updatedAt: this.now().toISOString(),
					},
					workingTask.agentId,
				);
			}
			throw error;
		} finally {
			this.activeDelegations.delete(taskId);
		}
	}

	/** Cancel all durable work owned by a runtime session tree. */
	cancelForSessions(
		sessionIds: readonly string[],
		reason = "Cancelled because the owning agent session was cancelled.",
	): WorkingTask[] {
		const ids = new Set(sessionIds);
		for (const active of this.activeDelegations.values()) {
			if (
				ids.has(active.parentSessionId) ||
				(active.sessionId !== undefined && ids.has(active.sessionId))
			)
				active.controller.abort(new Error(reason));
		}
		const cancelled: WorkingTask[] = [];
		for (const task of this.database.listWorkingTasks({
			includeCompleted: true,
			limit: 500,
		})) {
			if (!task.sessionId || !ids.has(task.sessionId)) continue;
			if (["completed", "failed", "cancelled"].includes(task.status)) continue;
			cancelled.push(
				this.saveDurableTask(
					{
						...task,
						status: "cancelled",
						failures: [...task.failures, reason].slice(-100),
						completedAt: this.now().toISOString(),
						updatedAt: this.now().toISOString(),
					},
					task.agentId,
				),
			);
		}
		return cancelled;
	}

	private async selectWorker(
		input: DelegatedTaskInput,
		taskId: string,
		effectiveAllowedTools?: string[],
	): Promise<{
		route: DelegatedWorkerRoute & { fastMode: boolean };
		execution: ReturnType<AdaptiveModelRouter["executionPlan"]>;
		maximumContextCharacters: number;
		maximumOutputTokens: number;
		temperature: number;
		instructions: string;
		decision: ReturnType<AdaptiveModelRouter["route"]>;
		requirements: ReturnType<TaskRequirementAnalyzer["analyze"]>;
	}> {
		if (!this.providers || !this.modelRouter || !this.modelRegistry)
			throw new Error(
				"Automatic delegation is unavailable because the adaptive model registry is not attached.",
			);
		const policy = this.requirementAnalyzer.routingPolicy(
			input.prompt,
			this.modelRouter.policy(),
		);
		const depth = this.delegationDepth(input.parentSessionId);
		if (depth > policy.maximumDelegationDepth)
			throw new Error(
				`Delegation depth exceeds the configured maximum of ${policy.maximumDelegationDepth}.`,
			);
		this.modelRegistry.applyProviderHealth(this.providers.health());
		const requirements = this.requirementAnalyzer.analyze(
			taskId,
			input.prompt,
			{ requiresTools: Boolean(effectiveAllowedTools?.length) },
		);
		for (const [capability, importance] of Object.entries(
			input.requiredCapabilities ?? {},
		)) {
			if (importance !== undefined)
				requirements.capabilities[capability as ModelCapability] = Math.max(
					requirements.capabilities[capability as ModelCapability] ?? 0,
					importance,
				);
		}
		const parentRun =
			input.role === "reviewer"
				? this.database.listAgentRuns(input.parentSessionId).at(-1)
				: undefined;
		const reviewedModelIds = parentRun
			? this.modelRegistry
					.list()
					.filter(
						(profile) =>
							profile.model === parentRun.model &&
							parentRun.providerIds.some(
								(providerId) =>
									providerId === profile.provider ||
									providerId === profile.endpointId,
							),
					)
					.map((profile) => profile.id)
			: [];
		const failedModelIds: string[] = [...reviewedModelIds];
		const errors: string[] = [];
		const parentTrace = [...this.modelRouter.traces()]
			.reverse()
			.find(
				(trace) =>
					trace.status === "running" &&
					(trace.taskId === `run-${input.parentSessionId}` ||
						trace.taskId === `retry-${input.parentSessionId}`),
			);
		for (let attempt = 0; attempt <= policy.maximumRetries; attempt += 1) {
			const decision = this.modelRouter.route(requirements, {
				role: attempt === 0 ? (input.role ?? "worker") : "fallback",
				allowedProviderIds: input.providerIds,
				excludeModelIds: failedModelIds,
				...(parentTrace ? { parentTraceId: parentTrace.id } : {}),
				policy,
			});
			const verification = await this.providers.verify(decision.endpointId);
			const checked = verification.find(
				(item) => item.providerId === decision.endpointId,
			);
			if (checked?.ok) {
				const profile = this.modelRegistry.get(decision.selectedModelId);
				if (decision.traceId)
					this.modelRouter.completeTrace(decision.traceId, {
						status: "running",
					});
				return {
					route: {
						providerId: decision.providerId,
						model: decision.model,
						selectedModelId: decision.selectedModelId,
						...(decision.tier ? { tier: decision.tier } : {}),
						role: decision.role,
						reasoningEffort: decision.reasoningLevel,
						fastMode: decision.fastMode,
						local: profile.local,
						confidence: decision.confidence,
						...(decision.estimatedCost === undefined
							? {}
							: { estimatedCost: decision.estimatedCost }),
						fallbackModelIds: decision.fallbackModelIds,
						...(decision.traceId ? { traceId: decision.traceId } : {}),
						...(decision.refusalRecovery ? { refusalRecovery: true } : {}),
						verifiedAt: this.now().toISOString(),
						verificationLatencyMs: checked.latencyMs,
						rationale: decision.reasons.join(" "),
					},
					execution: this.modelRouter.executionPlan(decision),
					maximumContextCharacters: decision.settings.maximumContextCharacters,
					maximumOutputTokens: decision.settings.maximumOutputTokens,
					temperature: decision.settings.temperature,
					instructions: [
						`You are the ${decision.role} for one focused subtask. Stay within the supplied context and constraints.`,
						"Do not delegate again unless the parent explicitly authorized nested delegation.",
						decision.validationStrategy,
					]
						.filter(Boolean)
						.join(" "),
					decision,
					requirements,
				};
			}
			this.modelRegistry.recordOutcome({
				modelId: decision.selectedModelId,
				capabilities: requirements.capabilities,
				succeeded: false,
				validationPassed: false,
				escalated: attempt > 0,
				observedAt: this.now().toISOString(),
			});
			if (decision.traceId)
				this.modelRouter.completeTrace(decision.traceId, {
					status: "failed",
					escalated: attempt > 0,
				});
			failedModelIds.push(decision.selectedModelId);
			errors.push(
				`${decision.endpointId}: ${checked?.error ?? "health check failed"}`,
			);
		}
		throw new Error(
			`No routed worker endpoint passed its health check (${errors.join("; ")}).`,
		);
	}

	private recordSelectedOutcome(
		selected: Awaited<ReturnType<TaskOrchestrator["selectWorker"]>> | undefined,
		result: AgentLoopResult,
	): void {
		if (!selected || result.run.status === "waiting_approval") return;
		const audits = this.database.listModelCallAudits(result.run.id);
		const winning = result.modelResult
			? this.modelRegistry
					?.list()
					.find(
						(profile) =>
							profile.endpointId === result.modelResult?.providerId &&
							profile.model === result.modelResult.model,
					)
			: undefined;
		const modelId = winning?.id ?? selected.decision.selectedModelId;
		const actualCostUsd = audits.reduce(
			(sum, audit) => sum + audit.estimatedCostUsd,
			0,
		);
		this.modelRegistry?.recordOutcome({
			modelId,
			capabilities: selected.requirements.capabilities,
			succeeded: result.run.status === "completed",
			validationPassed: result.run.status === "completed",
			latencyMs: audits.reduce((sum, audit) => sum + audit.durationMs, 0),
			actualCostUsd,
			escalated: modelId !== selected.decision.selectedModelId,
			observedAt: this.now().toISOString(),
		});
		if (selected.decision.traceId)
			this.modelRouter?.completeTrace(selected.decision.traceId, {
				status:
					result.run.status === "completed"
						? "completed"
						: result.run.status === "cancelled"
							? "cancelled"
							: "failed",
				actualCostUsd,
				escalated: modelId !== selected.decision.selectedModelId,
			});
	}

	private delegationDepth(parentSessionId: string): number {
		let depth = 1;
		let current = this.runtime.getSession(parentSessionId);
		const visited = new Set<string>();
		while (current.parentSessionId) {
			if (visited.has(current.id))
				throw new Error("Delegation session hierarchy contains a cycle.");
			visited.add(current.id);
			depth += 1;
			current = this.runtime.getSession(current.parentSessionId);
		}
		return depth;
	}

	async runTeam(
		inputs: DelegatedTaskInput[],
		maximumConcurrency = this.maximumWorkers,
	): Promise<Array<DelegatedTaskResult | Error>> {
		if (
			!Number.isInteger(maximumConcurrency) ||
			maximumConcurrency < 1 ||
			maximumConcurrency > this.maximumWorkers
		)
			throw new Error(
				`Team concurrency must be between 1 and ${this.maximumWorkers}.`,
			);
		const results: Array<DelegatedTaskResult | Error> = new Array(
			inputs.length,
		);
		let cursor = 0;
		const worker = async () => {
			while (cursor < inputs.length) {
				const index = cursor++;
				const input = inputs[index];
				if (!input) continue;
				try {
					results[index] = await this.delegate(input);
				} catch (error) {
					results[index] =
						error instanceof Error
							? error
							: new Error("Delegated task failed.");
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(maximumConcurrency, inputs.length) }, () =>
				worker(),
			),
		);
		return results;
	}

	createGoal(
		sessionId: string,
		title: string,
		objective: string,
		tasks: string[] = [],
		options: { sourceOpportunityId?: string; deadline?: string } = {},
	): GoalRecord {
		this.runtime.getSession(sessionId);
		if (
			!title.trim() ||
			!objective.trim() ||
			title.length > 200 ||
			objective.length > 20_000 ||
			tasks.length > 200
		)
			throw new Error("Goal input is invalid.");
		const timestamp = this.now().toISOString();
		if (
			options.deadline &&
			!Number.isFinite(new Date(options.deadline).getTime())
		)
			throw new Error("Goal deadline is invalid.");
		const goal: GoalRecord = {
			id: `goal-${randomUUID()}`,
			sessionId,
			title: title.trim(),
			objective: objective.trim(),
			status: "active",
			tasks: tasks.map((task) => ({
				id: `goal-task-${randomUUID()}`,
				title: task.slice(0, 500),
				status: "pending",
			})),
			...(options.sourceOpportunityId
				? { sourceOpportunityId: options.sourceOpportunityId }
				: {}),
			...(options.deadline
				? { deadline: new Date(options.deadline).toISOString() }
				: {}),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.saveGoals([...this.listGoals(), goal]);
		return goal;
	}

	listGoals(sessionId?: string): GoalRecord[] {
		const goals = parseStoredGoals(
			this.database.getPrivateState<unknown>(this.goalsKey),
		);
		return sessionId
			? goals.filter((goal) => goal.sessionId === sessionId)
			: goals;
	}

	goalFromOpportunity(
		sessionId: string,
		opportunity: TaskOpportunity,
	): GoalRecord {
		const existing = this.listGoals(sessionId).find(
			(goal) =>
				goal.sourceOpportunityId === opportunity.id && goal.status === "active",
		);
		if (existing) return existing;
		return this.createGoal(
			sessionId,
			opportunity.title,
			opportunity.proposedGoal,
			opportunity.expectedOutputs.map(
				(output) => `${output.type}: ${output.description}`,
			),
			{
				sourceOpportunityId: opportunity.id,
				...(opportunity.expiresAt ? { deadline: opportunity.expiresAt } : {}),
			},
		);
	}

	updateGoal(
		goalId: string,
		input: {
			status?: GoalRecord["status"];
			taskId?: string;
			taskStatus?: GoalTask["status"];
			assigneeSessionId?: string | null;
		},
	): GoalRecord {
		const goals = this.listGoals();
		const index = goals.findIndex((goal) => goal.id === goalId);
		const current = goals[index];
		if (!current) throw new Error("Goal not found.");
		let tasks = current.tasks;
		if (input.taskId) {
			if (!tasks.some((task) => task.id === input.taskId))
				throw new Error("Goal task not found.");
			if (
				input.taskStatus === undefined &&
				input.assigneeSessionId === undefined
			)
				throw new Error("Task status or worker lane is required.");
			if (input.assigneeSessionId) {
				const assignee = this.runtime.getSession(input.assigneeSessionId);
				if (assignee.parentSessionId !== current.sessionId)
					throw new Error(
						"Worker lane must be a child session of the goal session.",
					);
			}
			tasks = tasks.map((task) => {
				if (task.id !== input.taskId) return task;
				const base =
					input.assigneeSessionId === null
						? (({ assigneeSessionId: _assigneeSessionId, ...unassigned }) =>
								unassigned)(task)
						: task;
				return {
					...base,
					...(input.taskStatus ? { status: input.taskStatus } : {}),
					...(input.assigneeSessionId
						? { assigneeSessionId: input.assigneeSessionId }
						: {}),
				};
			});
		}
		const updated = {
			...current,
			...(input.status ? { status: input.status } : {}),
			tasks,
			updatedAt: this.now().toISOString(),
		};
		goals[index] = updated;
		this.saveGoals(goals);
		return updated;
	}

	createTeam(
		parentSessionId: string,
		title: string,
		memberSessionIds: string[],
		sharedPlan: string[] = [],
	): TeamRecord {
		this.runtime.getSession(parentSessionId);
		const members = [...new Set(memberSessionIds)];
		if (
			!title.trim() ||
			members.length === 0 ||
			members.length > this.maximumWorkers ||
			sharedPlan.length > 200
		)
			throw new Error("Team input is invalid.");
		for (const member of members) {
			const session = this.runtime.getSession(member);
			if (session.parentSessionId !== parentSessionId)
				throw new Error("Team members must be child sessions of the parent.");
		}
		const timestamp = this.now().toISOString();
		const team: TeamRecord = {
			id: `team-${randomUUID()}`,
			parentSessionId,
			title: title.trim().slice(0, 200),
			memberSessionIds: members,
			sharedPlan: sharedPlan.map((item) => item.slice(0, 1_000)),
			messages: [],
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.database.setPrivateState(this.teamsKey, [...this.listTeams(), team]);
		return team;
	}

	listTeams(): TeamRecord[] {
		return this.database.getPrivateState<TeamRecord[]>(this.teamsKey) ?? [];
	}

	teamUsage(teamId: string): {
		runs: number;
		inputTokens: number;
		outputTokens: number;
	} {
		const team = this.listTeams().find((candidate) => candidate.id === teamId);
		if (!team) throw new Error("Team not found.");
		const runs = team.memberSessionIds.flatMap((sessionId) =>
			this.database.listAgentRuns(sessionId),
		);
		const calls = runs.flatMap((run) =>
			this.database.listModelCallAudits(run.id),
		);
		return {
			runs: runs.length,
			inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
			outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
		};
	}

	updateTeam(
		teamId: string,
		input: { memberSessionIds?: string[]; sharedPlan?: string[] },
	): TeamRecord {
		const teams = this.listTeams();
		const index = teams.findIndex((team) => team.id === teamId);
		const current = teams[index];
		if (!current) throw new Error("Team not found.");
		const members = input.memberSessionIds
			? [...new Set(input.memberSessionIds)]
			: current.memberSessionIds;
		if (members.length === 0 || members.length > this.maximumWorkers)
			throw new Error("Team member count is invalid.");
		for (const member of members) {
			const session = this.runtime.getSession(member);
			if (session.parentSessionId !== current.parentSessionId)
				throw new Error("Team members must be child sessions of the parent.");
		}
		const plan = input.sharedPlan ?? current.sharedPlan;
		if (plan.length > 200) throw new Error("Team plan is too large.");
		const updated = {
			...current,
			memberSessionIds: members,
			sharedPlan: plan.map((item) => item.slice(0, 1_000)),
			updatedAt: this.now().toISOString(),
		};
		teams[index] = updated;
		this.database.setPrivateState(this.teamsKey, teams);
		return updated;
	}

	sendPeerMessage(
		teamId: string,
		fromSessionId: string,
		toSessionId: string,
		text: string,
	): TeamMessage {
		const teams = this.listTeams();
		const index = teams.findIndex((team) => team.id === teamId);
		const team = teams[index];
		if (
			!team ||
			!team.memberSessionIds.includes(fromSessionId) ||
			!team.memberSessionIds.includes(toSessionId) ||
			fromSessionId === toSessionId ||
			!text.trim() ||
			text.length > 20_000
		)
			throw new Error("Peer message is invalid for this team.");
		const message: TeamMessage = {
			id: `team-message-${randomUUID()}`,
			fromSessionId,
			toSessionId,
			text: text.trim(),
			createdAt: this.now().toISOString(),
		};
		this.runtime.appendMessage({
			sessionId: toSessionId,
			role: "system",
			content: `[Team peer message from ${fromSessionId}; provenance ${message.id}]\n${message.text}`,
		});
		teams[index] = {
			...team,
			messages: [...team.messages, message].slice(-1_000),
			updatedAt: message.createdAt,
		};
		this.database.setPrivateState(this.teamsKey, teams);
		return message;
	}

	handoff(
		childSessionId: string,
		summary: string,
	): ReturnType<AgentRuntime["appendMessage"]> {
		const child = this.runtime.getSession(childSessionId);
		if (!child.parentSessionId)
			throw new Error("Only a delegated child session can hand work back.");
		if (!summary.trim() || summary.length > 100_000)
			throw new Error("Handoff summary is invalid.");
		const evidence = this.runtime
			.listMessages(child.id)
			.filter(
				(message) => message.role === "assistant" || message.role === "tool",
			)
			.slice(-8)
			.map((message) => message.id);
		return this.runtime.appendMessage({
			sessionId: child.parentSessionId,
			role: "system",
			content: `[Delegated handoff from ${child.id}; evidence ${evidence.join(", ") || "none"}]\n${summary.trim()}`,
		});
	}

	schedule(
		input: Omit<ScheduledAgentJob, "id" | "status" | "createdAt" | "updatedAt">,
	): ScheduledAgentJob {
		if (input.providerIds.length === 0)
			throw new Error("Scheduled jobs need at least one provider.");
		if (!Number.isFinite(new Date(input.schedule.nextRunAt).getTime()))
			throw new Error("Scheduled next run is invalid.");
		if (
			input.schedule.kind === "interval" &&
			(!Number.isSafeInteger(input.schedule.intervalMs) ||
				input.schedule.intervalMs < MIN_SCHEDULE_INTERVAL_MS ||
				input.schedule.intervalMs > MAX_SCHEDULE_INTERVAL_MS)
		)
			throw new Error(
				"Scheduled intervals must be whole milliseconds between one minute and one year.",
			);
		if (input.schedule.kind === "cron") {
			const expected = nextCronOccurrence(
				input.schedule.expression,
				new Date(new Date(input.schedule.nextRunAt).getTime() - 60_000),
			);
			if (expected.toISOString() !== input.schedule.nextRunAt)
				throw new Error("Cron next run does not match its expression.");
		}
		this.runtime.getSession(input.sessionId);
		const timestamp = this.now().toISOString();
		const job: ScheduledAgentJob = {
			...input,
			id: `job-${randomUUID()}`,
			status: "pending",
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.saveJobs([...this.listJobs(), job]);
		return job;
	}

	listJobs(): ScheduledAgentJob[] {
		const stored: unknown = this.database.getPrivateState<unknown>(
			this.jobsKey,
		);
		return Array.isArray(stored) ? stored.filter(isScheduledAgentJob) : [];
	}

	cancelJob(id: string): ScheduledAgentJob {
		const jobs = this.listJobs();
		const index = jobs.findIndex((job) => job.id === id);
		const job = jobs[index];
		if (!job) throw new Error("Scheduled job not found.");
		const updated = {
			...job,
			status: "cancelled" as const,
			updatedAt: this.now().toISOString(),
		};
		jobs[index] = updated;
		this.saveJobs(jobs);
		return updated;
	}

	async resumeJob(id: string): Promise<ScheduledAgentJob> {
		const job = this.listJobs().find((candidate) => candidate.id === id);
		if (!job) throw new Error("Scheduled job not found.");
		if (job.status !== "waiting_approval" || !job.lastRunId)
			throw new Error("Scheduled job is not waiting for approval.");
		let updated: ScheduledAgentJob = {
			...job,
			status: "running",
			updatedAt: this.now().toISOString(),
		};
		this.replaceJob(updated);
		try {
			const result = await this.loop.resume({
				runId: job.lastRunId,
				approvalDecision: "approved",
				maximumTurns: this.maximumTurnsForRun(),
			});
			updated = this.finishJob(updated, result, this.now());
		} catch (error) {
			updated =
				error instanceof SessionRunBusyError
					? {
							...job,
							status: "waiting_approval",
							error: error.message,
							updatedAt: this.now().toISOString(),
						}
					: {
							...updated,
							status: "failed",
							error: "Scheduled agent resume failed.",
							updatedAt: this.now().toISOString(),
						};
		}
		this.replaceJob(updated);
		return updated;
	}

	async runDue(
		at = this.now(),
		signal?: AbortSignal,
	): Promise<ScheduledAgentJob[]> {
		const jobs = this.listJobs();
		const due = jobs.filter(
			(job) =>
				job.status === "pending" &&
				new Date(job.schedule.nextRunAt).getTime() <= at.getTime(),
		);
		const output: ScheduledAgentJob[] = [];
		for (const job of due) {
			if (signal?.aborted) break;
			let current: ScheduledAgentJob = {
				...job,
				status: "running",
				updatedAt: this.now().toISOString(),
			};
			this.replaceJob(current);
			try {
				const session = this.runtime.getSession(job.sessionId);
				const selected =
					job.model === "auto" || job.providerIds.includes("auto")
						? await this.selectWorker(
								{
									parentSessionId: job.sessionId,
									title: job.title,
									prompt: job.prompt,
									model: job.model,
									providerIds: job.providerIds,
									...(job.providerModels
										? { providerModels: job.providerModels }
										: {}),
									...(job.instructions
										? { instructions: job.instructions }
										: {}),
									role: "worker",
									...(signal ? { signal } : {}),
								},
								`scheduled-${job.id}`,
								session.allowedTools,
							)
						: undefined;
				const result = await this.loop.run({
					sessionId: job.sessionId,
					model: selected?.execution.model ?? job.model,
					providerIds: selected?.execution.providerIds ?? job.providerIds,
					...(job.providerModels || selected
						? {
								providerModels: {
									...selected?.execution.providerModels,
									...job.providerModels,
								},
							}
						: {}),
					...(selected
						? {
								reasoningEffort: selected.route.reasoningEffort,
								serviceTier: selected.route.fastMode ? "priority" : "standard",
								maximumContextCharacters: selected.maximumContextCharacters,
								maximumOutputTokens: selected.maximumOutputTokens,
								temperature: selected.temperature,
							}
						: {}),
					userContent: textContent(job.prompt),
					...(job.instructions || selected?.instructions
						? {
								instructions: [job.instructions, selected?.instructions]
									.filter(Boolean)
									.join("\n\n"),
							}
						: {}),
					maximumTurns: this.maximumTurnsForRun(),
					...(signal ? { signal } : {}),
				});
				this.recordSelectedOutcome(selected, result);
				current = this.finishJob(current, result, at);
			} catch (error) {
				current = signal?.aborted
					? {
							...current,
							status: "failed",
							error:
								"Scheduled agent run was interrupted and will not be retried automatically.",
							updatedAt: this.now().toISOString(),
						}
					: error instanceof SessionRunBusyError
						? {
								...job,
								status: "pending",
								error: error.message,
								updatedAt: this.now().toISOString(),
							}
						: {
								...current,
								status: "failed",
								error: "Scheduled agent run failed.",
								updatedAt: this.now().toISOString(),
							};
			}
			this.replaceJob(current);
			output.push(current);
		}
		return output;
	}

	startWorkflow(
		sessionId: string,
		title: string,
		steps: WorkflowStep[],
	): Promise<WorkflowRecord> {
		if (
			steps.length === 0 ||
			new Set(steps.map((step) => step.id)).size !== steps.length
		)
			throw new Error("Workflow steps require unique IDs.");
		const expanded = steps.flatMap((step) => {
			if (!step.forEach) return [step];
			if (step.forEach.length === 0 || step.forEach.length > 20)
				throw new Error("Workflow loops require from 1 through 20 items.");
			const { forEach: _items, ...template } = step;
			return step.forEach.map((item, index) => ({
				...template,
				id: `${step.id}[${index}]`,
				input: substituteItem(step.input, item) as Record<string, unknown>,
			}));
		});
		if (expanded.length > 200)
			throw new Error("Expanded workflows cannot exceed 200 steps.");
		const timestamp = this.now().toISOString();
		const workflow: WorkflowRecord = {
			id: `workflow-${randomUUID()}`,
			sessionId,
			title,
			steps: expanded,
			nextStep: 0,
			status: "running",
			results: {},
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.database.setPrivateState(
			`orchestrator.workflow.${workflow.id}`,
			workflow,
		);
		return this.continueWorkflow(workflow);
	}

	resumeWorkflow(
		id: string,
		approvedStepIds: string[] = [],
	): Promise<WorkflowRecord> {
		const stored = this.database.getPrivateState<unknown>(
			`orchestrator.workflow.${id}`,
		);
		if (!isWorkflowRecord(stored)) throw new Error("Workflow not found.");
		const workflow = stored;
		if (workflow.status !== "waiting_approval" && workflow.status !== "running")
			throw new Error(`Workflow is ${workflow.status}.`);
		return this.continueWorkflow(
			{ ...workflow, status: "running" },
			new Set(approvedStepIds),
		);
	}

	private async continueWorkflow(
		initial: WorkflowRecord,
		approved = new Set<string>(),
	): Promise<WorkflowRecord> {
		let workflow = initial;
		for (
			let index = workflow.nextStep;
			index < workflow.steps.length;
			index += 1
		) {
			const step = workflow.steps[index]!;
			if (!workflowConditionMatches(step.when, workflow.results)) {
				workflow = {
					...workflow,
					nextStep: index + 1,
					updatedAt: this.now().toISOString(),
				};
				this.database.setPrivateState(
					`orchestrator.workflow.${workflow.id}`,
					workflow,
				);
				continue;
			}
			const input = resolveInput(step.input, workflow.results) as Record<
				string,
				unknown
			>;
			const execution = await this.runtime.callTool(
				workflow.sessionId,
				step.toolName,
				input,
				{
					approvalStatus: approved.has(step.id)
						? "approved"
						: (step.approvalStatus ?? "pending"),
					idempotencyKey: `${workflow.id}:${step.id}`,
				},
			);
			if (execution.status === "blocked") {
				workflow = {
					...workflow,
					status:
						execution.output?.approvalRequired === true
							? "waiting_approval"
							: "failed",
					nextStep: index,
					results: { ...workflow.results, [step.id]: execution },
					updatedAt: this.now().toISOString(),
				};
				this.database.setPrivateState(
					`orchestrator.workflow.${workflow.id}`,
					workflow,
				);
				return workflow;
			}
			if (execution.status !== "verified") {
				workflow = {
					...workflow,
					status: "failed",
					nextStep: index,
					results: { ...workflow.results, [step.id]: execution },
					updatedAt: this.now().toISOString(),
				};
				this.database.setPrivateState(
					`orchestrator.workflow.${workflow.id}`,
					workflow,
				);
				return workflow;
			}
			workflow = {
				...workflow,
				nextStep: index + 1,
				results: { ...workflow.results, [step.id]: execution },
				updatedAt: this.now().toISOString(),
			};
			this.database.setPrivateState(
				`orchestrator.workflow.${workflow.id}`,
				workflow,
			);
		}
		workflow = {
			...workflow,
			status: "completed",
			updatedAt: this.now().toISOString(),
		};
		this.database.setPrivateState(
			`orchestrator.workflow.${workflow.id}`,
			workflow,
		);
		return workflow;
	}

	private saveJobs(jobs: ScheduledAgentJob[]): void {
		this.database.setPrivateState(this.jobsKey, jobs);
	}

	private saveGoals(goals: GoalRecord[]): void {
		const active = goals.filter((goal) => goal.status === "active");
		if (active.length > this.maximumStoredGoals)
			throw new Error("Active goal history exceeds the storage limit.");
		const terminal = goals.filter((goal) => goal.status !== "active");
		const terminalLimit = Math.max(0, this.maximumStoredGoals - active.length);
		const retainedTerminal = terminal.slice(
			Math.max(0, terminal.length - terminalLimit),
		);
		const retainedIds = new Set(retainedTerminal.map((goal) => goal.id));
		const value = goals.filter(
			(goal) => goal.status === "active" || retainedIds.has(goal.id),
		);
		this.database.setPrivateState(this.goalsKey, value);
	}

	private replaceJob(job: ScheduledAgentJob): void {
		const jobs = this.listJobs();
		const index = jobs.findIndex((candidate) => candidate.id === job.id);
		if (index < 0) jobs.push(job);
		else jobs[index] = job;
		this.saveJobs(jobs);
	}

	private finishJob(
		job: ScheduledAgentJob,
		result: AgentLoopResult,
		at: Date,
	): ScheduledAgentJob {
		if (result.run.status === "waiting_approval") {
			return {
				...job,
				status: "waiting_approval",
				lastRunId: result.run.id,
				error: undefined,
				updatedAt: this.now().toISOString(),
			};
		}
		if (result.run.status !== "completed") {
			return {
				...job,
				status: "failed",
				lastRunId: result.run.id,
				error: `Agent run ended with status ${result.run.status}.`,
				updatedAt: this.now().toISOString(),
			};
		}
		if (job.schedule.kind === "interval")
			return {
				...job,
				status: "pending",
				lastRunId: result.run.id,
				error: undefined,
				schedule: {
					...job.schedule,
					nextRunAt: new Date(
						at.getTime() + job.schedule.intervalMs,
					).toISOString(),
				},
				updatedAt: this.now().toISOString(),
			};
		if (job.schedule.kind === "cron")
			return {
				...job,
				status: "pending",
				lastRunId: result.run.id,
				error: undefined,
				schedule: {
					...job.schedule,
					nextRunAt: nextCronOccurrence(
						job.schedule.expression,
						at,
					).toISOString(),
				},
				updatedAt: this.now().toISOString(),
			};
		return {
			...job,
			status: "completed",
			lastRunId: result.run.id,
			error: undefined,
			updatedAt: this.now().toISOString(),
		};
	}

	private maximumTurnsForRun(requested?: number): number {
		const configured = this.configuredMaximumTurns();
		return Math.min(requested ?? configured, configured);
	}

	private reconcileInterruptedJobs(): void {
		const jobs = this.listJobs();
		let changed = false;
		const recovered = jobs.map((job) => {
			if (job.status !== "running") return job;
			changed = true;
			return {
				...job,
				status: "failed" as const,
				error:
					"Kestrel stopped before this scheduled run finished. Its outcome is uncertain, so it will not be retried automatically.",
				updatedAt: this.now().toISOString(),
			};
		});
		if (changed) this.saveJobs(recovered);
	}
}

export function installOrchestrationTools(
	runtime: AgentRuntime,
	orchestrator: TaskOrchestrator,
	sessionId: string,
): void {
	const add = (
		name: string,
		title: string,
		readOnly: boolean,
		schema: Record<string, unknown>,
		execute: Parameters<AgentRuntime["registerExternalTool"]>[0]["execute"],
		riskLevel: "low" | "sensitive" = "sensitive",
	) => {
		runtime.registerExternalTool({
			descriptor: {
				name,
				title,
				description: title,
				category: "automation",
				riskLevel,
				readOnly,
				requiresWorkspace: false,
				source: "builtin",
				tags: ["goal", "team", "orchestration"],
			},
			inputSchema: schema,
			execute,
		});
		runtime.allowTool(sessionId, name);
	};
	add(
		"goal.list",
		"List durable goals",
		true,
		{ type: "object", properties: {}, additionalProperties: false },
		async () => ({ goals: orchestrator.listGoals() }),
	);
	add(
		"goal.create",
		"Create a durable goal and task list",
		false,
		{
			type: "object",
			properties: {
				sessionId: { type: "string" },
				title: { type: "string" },
				objective: { type: "string" },
				tasks: { type: "array", items: { type: "string" } },
			},
			required: ["sessionId", "title", "objective"],
			additionalProperties: false,
		},
		async (_context, input) => ({
			goal: orchestrator.createGoal(
				String(input.sessionId),
				String(input.title),
				String(input.objective),
				Array.isArray(input.tasks) ? input.tasks.map(String) : [],
			),
		}),
	);
	add(
		"goal.update",
		"Update a goal task, status, or worker lane",
		false,
		{
			type: "object",
			properties: {
				goalId: { type: "string" },
				status: { enum: ["active", "completed", "cancelled"] },
				taskId: { type: "string" },
				taskStatus: { enum: ["pending", "in_progress", "completed"] },
				assigneeSessionId: { anyOf: [{ type: "string" }, { type: "null" }] },
			},
			required: ["goalId"],
			additionalProperties: false,
		},
		async (_context, input) => ({
			goal: orchestrator.updateGoal(String(input.goalId), {
				...(input.status
					? { status: input.status as GoalRecord["status"] }
					: {}),
				...(input.taskId ? { taskId: String(input.taskId) } : {}),
				...(input.taskStatus
					? { taskStatus: input.taskStatus as GoalTask["status"] }
					: {}),
				...(input.assigneeSessionId !== undefined
					? {
							assigneeSessionId:
								input.assigneeSessionId === null
									? null
									: String(input.assigneeSessionId),
						}
					: {}),
			}),
		}),
	);
	add(
		"orchestration.delegate",
		"Delegate one focused child-agent task. Automatic routing selects a verified model by required capability, quality, reliability, latency, cost, locality, and policy; use a reviewer role for independent validation.",
		false,
		{
			type: "object",
			properties: {
				parentSessionId: { type: "string" },
				parentTaskId: { type: "string" },
				dependencyTaskIds: { type: "array", items: { type: "string" }, maxItems: 100 },
				taskId: { type: "string" },
				title: { type: "string" },
				prompt: { type: "string" },
				model: { type: "string", default: "auto" },
				providerIds: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
					default: ["auto"],
				},
				role: {
					enum: ["orchestrator", "worker", "reviewer", "fallback"],
					default: "worker",
				},
				requiredCapabilities: {
					type: "object",
					additionalProperties: { type: "number", minimum: 0, maximum: 1 },
				},
				allowedTools: { type: "array", items: { type: "string" } },
				isolateWorktree: { type: "boolean" },
			},
			required: ["parentSessionId", "title", "prompt"],
			additionalProperties: false,
		},
		async (context, input) => ({
			delegated: await orchestrator.delegate({
				parentSessionId: String(input.parentSessionId),
				...(input.parentTaskId ? { parentTaskId: String(input.parentTaskId) } : {}),
				...(Array.isArray(input.dependencyTaskIds)
					? { dependencyTaskIds: input.dependencyTaskIds.map(String) }
					: {}),
				...(input.taskId ? { taskId: String(input.taskId) } : {}),
				title: String(input.title),
				prompt: String(input.prompt),
				model: input.model ? String(input.model) : "auto",
				providerIds: Array.isArray(input.providerIds)
					? input.providerIds.map(String)
					: ["auto"],
				...(input.role
					? { role: input.role as NonNullable<DelegatedTaskInput["role"]> }
					: {}),
				...(input.requiredCapabilities &&
				typeof input.requiredCapabilities === "object"
					? {
							requiredCapabilities: input.requiredCapabilities as Partial<
								Record<ModelCapability, number>
							>,
						}
					: {}),
				...(Array.isArray(input.allowedTools)
					? { allowedTools: input.allowedTools.map(String) }
					: {}),
				isolateWorktree: Boolean(input.isolateWorktree),
				signal: context.signal,
			}),
		}),
		"low",
	);
	add(
		"orchestration.delegate-team",
		"Delegate independent work to parallel child agents and wait for their results",
		false,
		{
			type: "object",
			properties: {
				tasks: {
					type: "array",
					minItems: 2,
					maxItems: 4,
					items: {
						type: "object",
						properties: {
							taskId: { type: "string" },
							parentTaskId: { type: "string" },
							dependencyTaskIds: { type: "array", items: { type: "string" }, maxItems: 100 },
							title: { type: "string", minLength: 1, maxLength: 200 },
							prompt: { type: "string", minLength: 1, maxLength: 100_000 },
							model: { type: "string", default: "auto" },
							providerIds: {
								type: "array",
								items: { type: "string" },
								minItems: 1,
								default: ["auto"],
							},
							role: {
								enum: ["worker", "reviewer", "fallback"],
								default: "worker",
							},
							requiredCapabilities: {
								type: "object",
								additionalProperties: { type: "number", minimum: 0, maximum: 1 },
							},
							allowedTools: { type: "array", items: { type: "string" } },
							isolateWorktree: { type: "boolean" },
						},
						required: ["title", "prompt"],
						additionalProperties: false,
					},
				},
			},
			required: ["tasks"],
			additionalProperties: false,
		},
		async (context, input) => {
			if (!Array.isArray(input.tasks) || input.tasks.length < 2)
				throw new Error("Parallel delegation needs at least two tasks.");
			const tasks = input.tasks.map((candidate, index) => {
				if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
					throw new Error(`Parallel delegation task ${index + 1} is invalid.`);
				const task = candidate as Record<string, unknown>;
				return {
					parentSessionId: context.session.id,
					...(task.taskId ? { taskId: String(task.taskId) } : {}),
					...(task.parentTaskId ? { parentTaskId: String(task.parentTaskId) } : {}),
					...(Array.isArray(task.dependencyTaskIds)
						? { dependencyTaskIds: task.dependencyTaskIds.map(String) }
						: {}),
					title: String(task.title ?? ""),
					prompt: String(task.prompt ?? ""),
					model: task.model ? String(task.model) : "auto",
					providerIds: Array.isArray(task.providerIds)
						? task.providerIds.map(String)
						: ["auto"],
					...(task.role
						? { role: task.role as NonNullable<DelegatedTaskInput["role"]> }
						: {}),
					...(task.requiredCapabilities &&
						typeof task.requiredCapabilities === "object"
						? {
								requiredCapabilities: task.requiredCapabilities as Partial<
									Record<ModelCapability, number>
								>,
						  }
						: {}),
					...(Array.isArray(task.allowedTools)
						? { allowedTools: task.allowedTools.map(String) }
						: {}),
					isolateWorktree: Boolean(task.isolateWorktree),
					signal: context.signal,
				};
			});
			const results = await orchestrator.runTeam(tasks);
			return {
				delegated: results.map((result) =>
					result instanceof Error
						? { status: "failed", error: result.message }
						: {
								status: result.result.run.status,
								taskId: result.taskId,
								sessionId: result.sessionId,
								result:
									result.result.assistantMessage?.content.slice(0, 50_000) ??
									"[No assistant text was returned.]",
							},
				),
			};
		},
		"low",
	);
	add(
		"orchestration.handoff",
		"Hand delegated work back to its parent",
		false,
		{
			type: "object",
			properties: {
				childSessionId: { type: "string" },
				summary: { type: "string" },
			},
			required: ["childSessionId", "summary"],
			additionalProperties: false,
		},
		async (_context, input) => ({
			message: orchestrator.handoff(
				String(input.childSessionId),
				String(input.summary),
			),
		}),
	);
	add(
		"team.list",
		"List durable agent teams",
		true,
		{ type: "object", properties: {}, additionalProperties: false },
		async () => ({ teams: orchestrator.listTeams() }),
	);
	add(
		"team.create",
		"Create an agent team with shared plan",
		false,
		{
			type: "object",
			properties: {
				parentSessionId: { type: "string" },
				title: { type: "string" },
				memberSessionIds: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
				},
				sharedPlan: { type: "array", items: { type: "string" } },
			},
			required: ["parentSessionId", "title", "memberSessionIds"],
			additionalProperties: false,
		},
		async (_context, input) => ({
			team: orchestrator.createTeam(
				String(input.parentSessionId),
				String(input.title),
				(input.memberSessionIds as unknown[]).map(String),
				Array.isArray(input.sharedPlan) ? input.sharedPlan.map(String) : [],
			),
		}),
	);
	add(
		"team.update",
		"Update team membership or shared plan",
		false,
		{
			type: "object",
			properties: {
				teamId: { type: "string" },
				memberSessionIds: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
				},
				sharedPlan: { type: "array", items: { type: "string" } },
			},
			required: ["teamId"],
			additionalProperties: false,
		},
		async (_context, input) => ({
			team: orchestrator.updateTeam(String(input.teamId), {
				...(Array.isArray(input.memberSessionIds)
					? { memberSessionIds: input.memberSessionIds.map(String) }
					: {}),
				...(Array.isArray(input.sharedPlan)
					? { sharedPlan: input.sharedPlan.map(String) }
					: {}),
			}),
		}),
	);
	add(
		"team.message",
		"Send a provenance-backed peer message",
		false,
		{
			type: "object",
			properties: {
				teamId: { type: "string" },
				fromSessionId: { type: "string" },
				toSessionId: { type: "string" },
				text: { type: "string" },
			},
			required: ["teamId", "fromSessionId", "toSessionId", "text"],
			additionalProperties: false,
		},
		async (_context, input) => ({
			message: orchestrator.sendPeerMessage(
				String(input.teamId),
				String(input.fromSessionId),
				String(input.toSessionId),
				String(input.text),
			),
		}),
	);
}

export class AutomationDaemon {
	constructor(
		private readonly orchestrator: TaskOrchestrator,
		private readonly pollMs = 5_000,
		private readonly now: () => Date = () => new Date(),
	) {
		if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 300_000)
			throw new Error(
				"Automation poll interval must be between 250 ms and 5 minutes.",
			);
	}

	async run(
		signal: AbortSignal,
		onCycle?: (result: {
			checkedAt: string;
			jobs: ScheduledAgentJob[];
		}) => void,
	): Promise<void> {
		while (!signal.aborted) {
			const checkedAt = this.now();
			let jobs: ScheduledAgentJob[];
			try {
				jobs = await this.orchestrator.runDue(checkedAt, signal);
			} catch (error) {
				if (signal.aborted) break;
				throw error;
			}
			onCycle?.({ checkedAt: checkedAt.toISOString(), jobs });
			if (signal.aborted) break;
			await new Promise<void>((resolve) => {
				const finish = () => {
					signal.removeEventListener("abort", abort);
					resolve();
				};
				const timer = setTimeout(finish, this.pollMs);
				const abort = () => {
					clearTimeout(timer);
					resolve();
				};
				signal.addEventListener("abort", abort, { once: true });
			});
		}
	}
}
