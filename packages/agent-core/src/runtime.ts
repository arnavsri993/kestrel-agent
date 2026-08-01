import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { IdempotencyClaim, KestrelDatabase } from "@kestrel/database";
import { assessExternalContent, mayExecute } from "@kestrel/policy-engine";
import { SandboxedCommandRunner, type SandboxedCommandHandle } from "./command-runner";
import { localSemanticEmbedding, semanticSimilarity } from "./semantic-search";
import {
  RuntimeSessionSchema,
  RuntimeEventSchema,
  RuntimeMessageSchema,
  RuntimeToolDescriptorSchema,
  RuntimeToolExecutionSchema,
  ApprovalRuleSchema,
  WorkspaceMutationSchema,
  type RuntimeEvent,
  type RuntimeMessage,
  type RuntimeSession,
  type RuntimeToolDescriptor,
  type RuntimeToolExecution,
  type ApprovalRule,
  type WorkspaceMutation
} from "@kestrel/shared-types";

export type RuntimeHookEvent = "pre_tool" | "post_tool" | "tool_error";

export interface RuntimeHookContext {
  event: RuntimeHookEvent;
  session: RuntimeSession;
  tool: RuntimeToolDescriptor;
  execution: RuntimeToolExecution;
}

export interface RuntimeHookResult {
  blocked?: boolean;
  reason?: string;
}

export interface RuntimeHook {
  id: string;
  event: RuntimeHookEvent;
  toolPattern?: RegExp;
  run(context: RuntimeHookContext): RuntimeHookResult | Promise<RuntimeHookResult>;
}

export interface RuntimeToolPolicyDecision {
  denied?: boolean;
  requireApproval?: boolean;
  reason?: string;
}

export interface RuntimeToolPolicyContext {
  session: RuntimeSession;
  tool: RuntimeToolDescriptor;
  input: Record<string, unknown>;
}

export interface DeclarativeRuntimeHook {
  id: string;
  event: RuntimeHookEvent;
  toolGlob?: string;
  conditions?: Array<{ field: "tool.name" | "session.id" | "execution.status" | `input.${string}`; equals?: unknown; matches?: string }>;
  action: { kind: "block"; reason: string } | { kind: "notice"; message: string };
}

function globPattern(value: string): RegExp {
  if (!value || value.length > 200) throw new Error("Hook tool glob is invalid.");
  return new RegExp(`^${value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
}

function hookField(context: RuntimeHookContext, field: DeclarativeRuntimeHook["conditions"] extends Array<infer T> | undefined ? T extends { field: infer F } ? F : never : never): unknown {
  if (field === "tool.name") return context.tool.name;
  if (field === "session.id") return context.session.id;
  if (field === "execution.status") return context.execution.status;
  let value: unknown = context.execution.input;
  for (const segment of field.slice(6).split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

interface RuntimeToolContext {
  session: RuntimeSession;
  executionId: string;
  signal: AbortSignal;
  workspaceRoot?: string;
  progress(payload: Record<string, unknown>): void;
}

interface RuntimeToolDefinition {
  descriptor: RuntimeToolDescriptor;
  inputSchema: z.ZodType<Record<string, unknown>>;
  jsonSchema?: Record<string, unknown>;
  outputSchema: z.ZodType<Record<string, unknown>>;
  execute(context: RuntimeToolContext, input: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>;
  verify?(context: RuntimeToolContext, input: Record<string, unknown>, output: Record<string, unknown>): { method: string; evidence: unknown } | Promise<{ method: string; evidence: unknown }>;
}

export interface ToolCallOptions {
  approvalStatus?: "pending" | "approved";
  approvalGrantExecutionId?: string;
  idempotencyKey?: string;
  externalContent?: string;
  signal?: AbortSignal;
}

export interface RuntimeModelTool {
  descriptor: RuntimeToolDescriptor;
  inputSchema: Record<string, unknown>;
}

export interface ExternalRuntimeTool {
  descriptor: RuntimeToolDescriptor;
  inputSchema: Record<string, unknown>;
  execute(context: { session: RuntimeSession; signal: AbortSignal; workspaceRoot?: string; progress(payload: Record<string, unknown>): void }, input: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>;
  verify?(context: { session: RuntimeSession; signal: AbortSignal; workspaceRoot?: string; progress(payload: Record<string, unknown>): void }, input: Record<string, unknown>, output: Record<string, unknown>): { method: string; evidence: unknown } | Promise<{ method: string; evidence: unknown }>;
}

export interface DeferredToolCatalog {
  id: string;
  list(): RuntimeToolDescriptor[];
  activate(name: string): ExternalRuntimeTool | Promise<ExternalRuntimeTool>;
}

const readInputSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(1_000_000).default(256_000)
});
const binaryReadInputSchema = z.object({ path: z.string().min(1), maxBytes: z.number().int().positive().max(1_000_000).default(256_000) });

const listInputSchema = z.object({
  path: z.string().default("."),
  maxEntries: z.number().int().positive().max(2_000).default(500)
});

const searchInputSchema = z.object({
  query: z.string().min(1).max(500),
  path: z.string().default("."),
  caseSensitive: z.boolean().default(false),
  maxMatches: z.number().int().positive().max(500).default(100)
});

const writeInputSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(1_000_000),
  expectedContent: z.string().max(1_000_000).optional()
});

const deleteInputSchema = z.object({
  path: z.string().min(1),
  expectedContent: z.string().max(1_000_000).optional()
});

const undoInputSchema = z.object({ mutationId: z.string().min(1).optional() });
const patchInputSchema = z.object({
  path: z.string().min(1),
  edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().default(false) })).min(1).max(100),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
});
const moveInputSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });
const directoryInputSchema = z.object({ path: z.string().min(1) });
const instructionInputSchema = z.object({ targetPath: z.string().min(1).optional() });
const commandInputSchema = z.object({
  command: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  args: z.array(z.string().max(10_000)).max(200).default([]),
  cwd: z.string().default("."),
  timeoutMs: z.number().int().min(100).max(300_000).default(120_000)
});
const backgroundCommandInputSchema = commandInputSchema.extend({
  interactive: z.boolean().default(false),
  timeoutMs: z.number().int().min(1_000).max(86_400_000).default(3_600_000)
});
const processIdInputSchema = z.object({ processId: z.string().min(1) });
const processWriteInputSchema = processIdInputSchema.extend({ data: z.string().min(1).max(65_536) });
const gitDiffInputSchema = z.object({
  staged: z.boolean().default(false),
  pathspec: z.array(z.string().min(1).max(1_000)).max(100).default([])
});
const gitWorktreeInputSchema = z.object({
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/),
  startPoint: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/).default("HEAD"),
  createBranch: z.boolean().default(true)
});
const gitStageInputSchema = z.object({ pathspec: z.array(z.string().min(1).max(1_000)).min(1).max(100) });
const gitBranchInputSchema = z.object({
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/),
  startPoint: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/).default("HEAD")
});
const gitCommitInputSchema = z.object({ message: z.string().min(1).max(10_000) });
const gitPushInputSchema = z.object({ remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).default("origin"), branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/), setUpstream: z.boolean().default(true) });
const githubPrInputSchema = z.object({ remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).default("origin"), title: z.string().min(1).max(500), body: z.string().max(100_000).default(""), head: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/), base: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/).default("main"), draft: z.boolean().default(true) });
const githubRefInputSchema = z.object({ remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).default("origin"), ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/).default("HEAD") });
const githubReviewInputSchema = z.object({ remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).default("origin"), pullNumber: z.number().int().positive(), event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]), body: z.string().min(1).max(100_000) });

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function resolveExistingPath(root: string, requestedPath: string): string {
  const candidate = realpathSync(isAbsolute(requestedPath) ? requestedPath : resolve(root, requestedPath));
  if (!isWithin(root, candidate)) throw new Error("Workspace path escapes the granted root.");
  return candidate;
}

function resolveWritablePath(root: string, requestedPath: string): string {
  const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
  if (!isWithin(root, candidate)) throw new Error("Workspace path escapes the granted root.");
  const parent = realpathSync(dirname(candidate));
  if (!isWithin(root, parent)) throw new Error("Workspace parent path escapes the granted root.");
  if (existsSync(candidate)) {
    if (lstatSync(candidate).isSymbolicLink()) throw new Error("Workspace mutations do not follow symbolic links.");
    const canonical = realpathSync(candidate);
    if (!isWithin(root, canonical)) throw new Error("Workspace path escapes the granted root.");
  }
  return candidate;
}

function walkFiles(root: string, start: string, maximum: number): string[] {
  const files: string[] = [];
  const pending = [start];
  while (pending.length > 0 && files.length < maximum) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= maximum) break;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        if (!isWithin(root, target)) continue;
      }
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

function textFile(path: string, maximumBytes: number): { content: string; truncated: boolean } | undefined {
  const size = statSync(path).size;
  const buffer = readFileSync(path).subarray(0, maximumBytes);
  if (buffer.includes(0)) return undefined;
  return { content: buffer.toString("utf8"), truncated: size > buffer.byteLength };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Execution cancelled by the user.");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class AgentRuntime extends EventEmitter {
  private readonly tools = new Map<string, RuntimeToolDefinition>();
  private readonly deferredCatalogs = new Map<string, DeferredToolCatalog>();
  private readonly deferredTools = new Map<string, { catalogId: string; descriptor: RuntimeToolDescriptor }>();
  private readonly hooks: RuntimeHook[] = [];
  private readonly workspaceRoots: string[];
  private readonly configuredWorkspaceRoots: string[];
  private readonly activeExecutions = new Map<
    string,
    { controller: AbortController; sessionId: string }
  >();
  private readonly inFlightIdempotentExecutions = new Map<string, Promise<RuntimeToolExecution>>();
  private readonly idempotencyOwnerToken = `runtime-${randomUUID()}`;
  private readonly commandRunner = new SandboxedCommandRunner();
  private readonly backgroundProcesses = new Map<string, {
    sessionId: string;
    handle: SandboxedCommandHandle;
    status: "running" | "completed" | "failed" | "stopped";
    exitCode?: number;
    signal?: string | null;
    error?: string;
    stopRequested: boolean;
  }>();
  private readonly approvalRulesKey = "runtime.approval-rules";
  private readonly processJournalKey = "runtime.background-processes";
  private toolPolicyResolver:
    | ((
        context: RuntimeToolPolicyContext,
      ) => RuntimeToolPolicyDecision)
    | undefined;

  constructor(
    private readonly database: KestrelDatabase,
    workspaceRoots: string[] = [],
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly githubToken?: string,
    configuredWorkspaceRoots: string[] = workspaceRoots,
  ) {
    super();
    const canonicalWorkspaceRoots: string[] = [];
    for (const root of workspaceRoots) {
      try {
        canonicalWorkspaceRoots.push(realpathSync(root));
      } catch {
        // Missing, unmounted, or newly inaccessible roots are not active grants.
      }
    }
    this.workspaceRoots = [...new Set(canonicalWorkspaceRoots)];
    this.configuredWorkspaceRoots = [
      ...new Set(
        [
          ...canonicalWorkspaceRoots,
          ...configuredWorkspaceRoots.map((root) => {
            try {
              return realpathSync(root);
            } catch {
              return resolve(root);
            }
          }),
        ],
      ),
    ];
    this.reconcilePersistedWorkspaceRoots();
    this.reconcileIdempotencyClaims();
    const previousProcesses = this.database.getPrivateState<Array<Record<string, unknown>>>(this.processJournalKey) ?? [];
    if (previousProcesses.some((process) => process.status === "running")) this.database.setPrivateState(this.processJournalKey, previousProcesses.map((process) => process.status === "running" ? { ...process, status: "interrupted", error: "The host restarted while this process was running.", updatedAt: this.now() } : process));
    this.registerWorkspaceTools();
    this.registerExecutionTools();
    this.registerDiscoveryTools();
  }

  ensureMainSession(): RuntimeSession {
    const storedId = this.database.getState<string>("runtimeMainSessionId");
    const existing = storedId ? this.database.getRuntimeSession(storedId) : undefined;
    if (existing) return existing;
    const session = this.createSession({
      title: "Main session",
      ...(this.workspaceRoots[0] ? { workspaceRoot: this.workspaceRoots[0] } : {})
    });
    this.database.setState("runtimeMainSessionId", session.id);
    return session;
  }

  createSession(input: { title: string; workspaceRoot?: string; parentSessionId?: string; allowedTools?: string[] }): RuntimeSession {
    const workspaceRoot = input.workspaceRoot ? this.resolveGrantedRoot(input.workspaceRoot) : undefined;
    const timestamp = this.now();
    const session = RuntimeSessionSchema.parse({
      id: `session-${randomUUID()}`,
      title: input.title,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(workspaceRoot ? { workspaceRoot } : {}),
      allowedTools: input.allowedTools ?? [...this.tools.keys()],
      status: "active",
      checkpoints: [],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.database.saveRuntimeSession(session);
    this.emitRuntimeEvent("session.created", session.id, { title: session.title });
    return session;
  }

  listSessions(): RuntimeSession[] {
    return this.database.listRuntimeSessions();
  }

  getSession(sessionId: string): RuntimeSession {
    return this.requireSession(sessionId);
  }

  workspaceInstructions(sessionId: string, targetPath?: string): Array<{ path: string; content: string; precedence: number }> {
    const session = this.requireSession(sessionId);
    const workspaceRoot = this.resolveActiveWorkspaceRoot(session);
    if (!workspaceRoot) return [];
    return this.loadInstructions(workspaceRoot, targetPath);
  }

  activeWorkspaceRoot(sessionId: string): string | undefined {
    return this.resolveActiveWorkspaceRoot(this.requireSession(sessionId));
  }

  checkpoint(sessionId: string, summary: string): RuntimeSession {
    const session = this.requireSession(sessionId);
    const checkpoint = {
      id: `checkpoint-${randomUUID()}`,
      sequence: session.checkpoints.length + 1,
      summary,
      createdAt: this.now()
    };
    const updated = this.database.db.transaction(() => {
      const saved = this.saveSession({ ...session, checkpoints: [...session.checkpoints, checkpoint], updatedAt: checkpoint.createdAt });
      this.database.setPrivateState(`session.checkpoint.${checkpoint.id}`, { sessionId, messageCount: this.listMessages(sessionId).length, mutationIds: this.database.listWorkspaceMutationIds(sessionId) });
      return saved;
    })();
    this.emitRuntimeEvent("session.updated", sessionId, { action: "checkpoint", checkpointId: checkpoint.id });
    return updated;
  }

  restoreCheckpoint(sessionId: string, checkpointId: string): RuntimeSession {
    const session = this.requireSession(sessionId);
    const checkpointIndex = session.checkpoints.findIndex(
      (checkpoint) => checkpoint.id === checkpointId,
    );
    if (checkpointIndex < 0)
      throw new Error("Checkpoint does not belong to this session.");
    const state = this.database.getPrivateState<{ sessionId: string; messageCount: number; mutationIds: string[] }>(`session.checkpoint.${checkpointId}`);
    if (!state || state.sessionId !== sessionId) throw new Error("Checkpoint restoration state is unavailable.");
    const completedAt = this.now();
    const reason =
      "Agent run and any pending approval were invalidated because the session was restored to an earlier checkpoint.";
    this.abortActiveExecutionsForHistoryRollback(sessionId, reason);
    this.database.retireActiveAgentHistory(sessionId, completedAt, reason);
    const baseline = new Set(state.mutationIds);
    for (const mutation of this.database.listWorkspaceMutations(sessionId).filter((item) => !baseline.has(item.id) && !item.undoneAt)) this.undoWorkspaceMutation(sessionId, mutation.id);
    const checkpoints = session.checkpoints.slice(0, checkpointIndex + 1);
    const prunedCheckpointIds = session.checkpoints
      .slice(checkpointIndex + 1)
      .map((checkpoint) => checkpoint.id);
    const { session: updated } = this.database.rollbackRuntimeHistory({
      session: {
        ...session,
        status: "active",
        checkpoints,
        updatedAt: completedAt,
      },
      keepMessageCount: state.messageCount,
      prunedCheckpointIds,
      completedAt,
      reason,
    });
    this.emitRuntimeEvent("session.updated", sessionId, { action: "restore-checkpoint", checkpointId });
    return updated;
  }

  retryLastTurnMessage(sessionId: string): string {
    return this.retryableUserTurn(sessionId).user.content;
  }

  rewindLastTurn(sessionId: string): { message: string } {
    const session = this.requireSession(sessionId);
    const { index, user } = this.retryableUserTurn(sessionId);
    const matchingRun = [...this.database.listAgentRuns(sessionId)].reverse().find((run) => {
      const baseline = this.database.getPrivateState<{ userMessageId?: string }>(`agent-run-baseline.${run.id}`);
      return baseline?.userMessageId === user.id;
    });
    const baseline = matchingRun
      ? this.database.getPrivateState<{ sessionId: string; userMessageId: string; messageCount: number; mutationIds: string[] }>(`agent-run-baseline.${matchingRun.id}`)
      : undefined;
    const keepMessageCount =
      baseline?.sessionId === sessionId ? baseline.messageCount : index;
    const completedAt = this.now();
    const reason =
      "Agent run and any pending approval were invalidated because the session turn was retried.";
    this.abortActiveExecutionsForHistoryRollback(sessionId, reason);
    this.database.retireActiveAgentHistory(sessionId, completedAt, reason);
    if (baseline?.sessionId === sessionId) {
      const mutationIds = new Set(baseline.mutationIds);
      for (const mutation of this.database.listWorkspaceMutations(sessionId).filter((item) => !item.undoneAt && !mutationIds.has(item.id))) this.undoWorkspaceMutation(sessionId, mutation.id);
    } else {
      // Legacy turns created before exact run baselines use the safest available fallback.
      for (const mutation of this.database.listWorkspaceMutations(sessionId).filter((item) => !item.undoneAt && item.createdAt >= user.createdAt)) this.undoWorkspaceMutation(sessionId, mutation.id);
    }
    const prunedCheckpointIds = session.checkpoints
      .filter((checkpoint) => {
        const checkpointState = this.database.getPrivateState<{
          sessionId: string;
          messageCount: number;
        }>(`session.checkpoint.${checkpoint.id}`);
        return (
          checkpointState?.sessionId === sessionId &&
          checkpointState.messageCount > keepMessageCount
        );
      })
      .map((checkpoint) => checkpoint.id);
    const prunedCheckpointSet = new Set(prunedCheckpointIds);
    this.database.rollbackRuntimeHistory({
      session: {
        ...session,
        status: "active",
        checkpoints: session.checkpoints.filter(
          (checkpoint) => !prunedCheckpointSet.has(checkpoint.id),
        ),
        updatedAt: completedAt,
      },
      keepMessageCount,
      prunedCheckpointIds,
      completedAt,
      reason,
    });
    this.emitRuntimeEvent("session.updated", sessionId, { action: "rewind-turn", messageId: user.id });
    return { message: user.content };
  }

  private retryableUserTurn(sessionId: string): {
    messages: RuntimeMessage[];
    index: number;
    user: RuntimeMessage;
  } {
    const messages = this.listMessages(sessionId);
    let index = messages.length - 1;
    while (index >= 0 && messages[index]?.role !== "user") index -= 1;
    const user = messages[index];
    if (!user) throw new Error("No user turn is available to retry.");
    return { messages, index, user };
  }

  forkSession(sessionId: string, title?: string): RuntimeSession {
    const parent = this.requireSession(sessionId);
    const activeWorkspaceRoot = this.resolveActiveWorkspaceRoot(parent);
    let child = this.createSession({
      title: title ?? `${parent.title} (fork)`,
      parentSessionId: parent.id,
      ...(activeWorkspaceRoot ? { workspaceRoot: activeWorkspaceRoot } : {}),
      allowedTools: parent.allowedTools
    });
    if (!activeWorkspaceRoot && parent.workspaceRoot) {
      child = this.saveSession({
        ...child,
        workspaceRoot: parent.workspaceRoot,
      });
    }
    const messageIds = new Map<string, string>();
    for (const message of this.listMessages(parent.id)) {
      const cloned = this.appendMessage({
        sessionId: child.id,
        role: message.role,
        content: message.content,
        ...(message.parentMessageId && messageIds.has(message.parentMessageId) ? { parentMessageId: messageIds.get(message.parentMessageId)! } : {}),
        ...(message.modelToolCalls ? { modelToolCalls: message.modelToolCalls } : {}),
        ...(message.providerToolCallId ? { providerToolCallId: message.providerToolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {})
      });
      messageIds.set(message.id, cloned.id);
    }
    child = this.requireSession(child.id);
    this.emitRuntimeEvent("session.updated", child.id, {
      action: "fork",
      parentSessionId: parent.id,
      inheritedMessages: messageIds.size,
      sessionUpdatedAt: child.updatedAt
    });
    return child;
  }

  resumeSession(sessionId: string): RuntimeSession {
    const session = this.requireSession(sessionId);
    if (session.status === "cancelled") throw new Error("A cancelled session cannot be resumed.");
    const updated = this.saveSession({ ...session, status: "active", updatedAt: this.now() });
    this.emitRuntimeEvent("session.updated", sessionId, { action: "resume" });
    return updated;
  }

  cancelSession(sessionId: string): RuntimeSession {
    const session = this.requireSession(sessionId);
    const updated = this.saveSession({ ...session, status: "cancelled", updatedAt: this.now() });
    this.emitRuntimeEvent("session.updated", sessionId, { action: "cancel" });
    return updated;
  }

  appendMessage(input: Omit<RuntimeMessage, "id" | "createdAt">): RuntimeMessage {
    this.requireSession(input.sessionId);
    const message = RuntimeMessageSchema.parse({ ...input, id: `message-${randomUUID()}`, createdAt: this.now() });
    const session = this.database.saveRuntimeMessage(message);
    this.emitRuntimeEvent("message.appended", message.sessionId, {
      role: message.role,
      sessionUpdatedAt: session.updatedAt
    }, { messageId: message.id });
    return message;
  }

  listMessages(sessionId: string): RuntimeMessage[] {
    this.requireSession(sessionId);
    return this.database.listRuntimeMessages(sessionId);
  }

  searchMessages(query: string, limit = 20): RuntimeMessage[] {
    const exact = this.database.searchRuntimeMessages(query, limit);
    if (exact.length >= limit) return exact;
    const queryTerms = [...new Set(query.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
    if (!queryTerms.length) return exact;
    const queryEmbedding = localSemanticEmbedding(query);
    const seen = new Set(exact.map((message) => message.id));
    const ranked = this.database.listRuntimeSessions().flatMap((session) => this.database.listRuntimeMessages(session.id)).filter((message) => !seen.has(message.id)).map((message) => {
      const body = [...new Set(message.content.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
      const lexical = queryTerms.reduce((total, term) => total + (body.includes(term) ? 4 : body.some((word) => word.startsWith(term) || term.startsWith(word)) ? 1 : 0), 0);
      const semantic = semanticSimilarity(queryEmbedding, localSemanticEmbedding(message.content));
      return { message, score: lexical + semantic * 3, semantic };
    }).filter(({ score, semantic }) => score > 0.55 || semantic >= 0.18).sort((left, right) => right.score - left.score || right.message.createdAt.localeCompare(left.message.createdAt));
    return [...exact, ...ranked.map(({ message }) => message)].slice(0, limit);
  }

  cancelExecution(executionId: string): boolean {
    const active = this.activeExecutions.get(executionId);
    if (!active) return false;
    active.controller.abort(new Error("Execution cancelled by the user."));
    return true;
  }

  listApprovalRules(): ApprovalRule[] { return this.database.getPrivateState<ApprovalRule[]>(this.approvalRulesKey) ?? []; }

  setApprovalRule(input: Pick<ApprovalRule, "toolName" | "decision" | "scope"> & { sessionId?: string }): ApprovalRule {
    const definition = this.tools.get(input.toolName);
    if (!definition) throw new Error("Approval rule tool is not registered.");
    if (
      input.decision === "allow" &&
      definition.descriptor.approvalMode === "always"
    )
      throw new Error(
        "This protected action always requires a fresh one-time approval.",
      );
    if (input.scope === "session") {
      if (!input.sessionId) throw new Error("Session-scoped approval rules require a session.");
      this.requireSession(input.sessionId);
    }
    const timestamp = this.now();
    const records = this.listApprovalRules();
    const existing = records.find((rule) => rule.toolName === input.toolName && rule.scope === input.scope && rule.sessionId === input.sessionId);
    const rule = ApprovalRuleSchema.parse({ id: existing?.id ?? `approval-rule-${randomUUID()}`, ...input, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp });
    this.database.setPrivateState(this.approvalRulesKey, [...records.filter((candidate) => candidate.id !== rule.id), rule]);
    return rule;
  }

  removeApprovalRule(id: string): ApprovalRule {
    const rules = this.listApprovalRules();
    const rule = rules.find((candidate) => candidate.id === id);
    if (!rule) throw new Error("Approval rule not found.");
    this.database.setPrivateState(this.approvalRulesKey, rules.filter((candidate) => candidate.id !== id));
    return rule;
  }

  undoWorkspaceMutation(sessionId: string, mutationId?: string): { mutationId: string; path: string; restored: boolean } {
    const session = this.requireSession(sessionId);
    if (!session.workspaceRoot) throw new Error("Workspace root is unavailable.");
    const mutation = mutationId ? this.database.getWorkspaceMutation(mutationId) : this.database.listWorkspaceMutations(session.id).find((item) => !item.undoneAt);
    if (!mutation || mutation.sessionId !== session.id) throw new Error("Undoable workspace mutation not found in this session.");
    if (mutation.undoneAt) throw new Error("Workspace mutation has already been undone.");
    const path = resolveWritablePath(session.workspaceRoot, mutation.path);
    if (mutation.operation === "create") {
      if (existsSync(path)) {
        if (mutation.entryKind === "directory") {
          if (!statSync(path).isDirectory() || readdirSync(path).length > 0) throw new Error("Cannot undo because the created directory is no longer empty.");
          rmdirSync(path);
        } else {
          if (mutation.afterContent !== undefined && this.readMutationText(path) !== mutation.afterContent) throw new Error("Cannot undo because the created file changed afterward.");
          unlinkSync(path);
        }
      }
    } else if (mutation.operation === "delete" && mutation.entryKind === "directory") {
      if (existsSync(path)) throw new Error("Cannot undo delete because the directory path is occupied.");
      mkdirSync(path, { mode: 0o700 });
    } else if (mutation.operation === "update" || mutation.operation === "delete") {
      if (mutation.beforeContent === undefined) throw new Error("Mutation is missing its encrypted recovery content.");
      if (mutation.operation === "update" && (!existsSync(path) || (mutation.afterContent !== undefined && this.readMutationText(path) !== mutation.afterContent))) throw new Error("Cannot undo because the updated file changed afterward.");
      if (mutation.operation === "delete" && existsSync(path)) throw new Error("Cannot undo delete because the path is occupied.");
      this.writeTextAtomically(path, mutation.beforeContent);
    } else if (mutation.operation === "move") {
      if (!mutation.destinationPath) throw new Error("Move mutation is missing its destination path.");
      const destination = resolveExistingPath(session.workspaceRoot, mutation.destinationPath);
      if (existsSync(path)) throw new Error("Cannot undo move because the original path is occupied.");
      renameSync(destination, path);
    }
    this.database.saveWorkspaceMutation({ ...mutation, undoneAt: this.now() });
    return { mutationId: mutation.id, path: mutation.path, restored: true };
  }

  close(): void {
    for (const process of this.backgroundProcesses.values()) process.handle.stop();
    this.backgroundProcesses.clear();
  }

  registerHook(hook: RuntimeHook): void {
    if (this.hooks.some((candidate) => candidate.id === hook.id)) throw new Error(`Hook ${hook.id} is already registered.`);
    this.hooks.push(hook);
  }

  setToolPolicyResolver(
    resolver:
      | ((context: RuntimeToolPolicyContext) => RuntimeToolPolicyDecision)
      | undefined,
  ): void {
    this.toolPolicyResolver = resolver;
  }

  registerDeclarativeHook(config: DeclarativeRuntimeHook): void {
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(config.id)) throw new Error("Declarative hook ID is invalid.");
    if (config.conditions && config.conditions.length > 20) throw new Error("Declarative hooks support at most 20 conditions.");
    if (config.action.kind === "block" && config.event !== "pre_tool") throw new Error("Only pre-tool declarative hooks can block execution.");
    const toolPattern = config.toolGlob ? globPattern(config.toolGlob) : undefined;
    const conditions = (config.conditions ?? []).map((condition) => ({ ...condition, ...(condition.matches ? { matcher: globPattern(condition.matches) } : {}) }));
    this.registerHook({
      id: config.id,
      event: config.event,
      ...(toolPattern ? { toolPattern } : {}),
      run: (context) => {
        const matched = conditions.every((condition) => {
          const value = hookField(context, condition.field);
          if ("equals" in condition && JSON.stringify(value) !== JSON.stringify(condition.equals)) return false;
          return !condition.matcher || (typeof value === "string" && condition.matcher.test(value));
        });
        if (!matched) return {};
        if (config.action.kind === "block") return { blocked: true, reason: config.action.reason.slice(0, 2_000) };
        this.emitRuntimeEvent("tool.progress", context.session.id, { hookId: config.id, message: config.action.message.slice(0, 2_000) }, { executionId: context.execution.id });
        return {};
      }
    });
  }

  registerExternalTool(tool: ExternalRuntimeTool): void {
    this.registerTool({
      descriptor: tool.descriptor,
      inputSchema: z.record(z.string(), z.unknown()),
      jsonSchema: tool.inputSchema,
      outputSchema: z.record(z.string(), z.unknown()),
      execute: ({ session, signal, workspaceRoot, progress }, input) => tool.execute({ session, signal, ...(workspaceRoot ? { workspaceRoot } : {}), progress }, input),
      ...(tool.verify ? { verify: ({ session, signal, workspaceRoot, progress }, input, output) => tool.verify!({ session, signal, ...(workspaceRoot ? { workspaceRoot } : {}), progress }, input, output) } : {})
    });
  }

  registerDeferredCatalog(catalog: DeferredToolCatalog): void {
    if (!/^[a-z][a-z0-9_.-]+$/.test(catalog.id)) throw new Error("Deferred catalog ID is invalid.");
    this.deferredCatalogs.set(catalog.id, catalog);
    this.refreshDeferredCatalog(catalog.id);
  }

  refreshDeferredCatalog(catalogId: string): RuntimeToolDescriptor[] {
    const catalog = this.deferredCatalogs.get(catalogId);
    if (!catalog) throw new Error(`Deferred catalog ${catalogId} is not registered.`);
    for (const [name, entry] of this.deferredTools) if (entry.catalogId === catalogId) this.deferredTools.delete(name);
    for (const raw of catalog.list()) {
      const descriptor = RuntimeToolDescriptorSchema.parse(raw);
      const existing = this.deferredTools.get(descriptor.name);
      if (existing && existing.catalogId !== catalogId) throw new Error(`Deferred tool ${descriptor.name} is already registered by ${existing.catalogId}.`);
      if (this.tools.has(descriptor.name)) continue;
      this.deferredTools.set(descriptor.name, { catalogId, descriptor });
    }
    return this.discoverDeferredTools();
  }

  discoverDeferredTools(query?: string): RuntimeToolDescriptor[] {
    const terms = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    return [...this.deferredTools.values()].map((entry) => entry.descriptor)
      .filter((tool) => terms.length === 0 || terms.every((term) => `${tool.name} ${tool.title} ${tool.description} ${tool.tags.join(" ")}`.toLowerCase().includes(term)))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async activateDeferredTool(sessionId: string, name: string): Promise<RuntimeToolDescriptor> {
    const entry = this.deferredTools.get(name);
    if (!entry) throw new Error(`Deferred tool ${name} was not discovered.`);
    const catalog = this.deferredCatalogs.get(entry.catalogId);
    if (!catalog) throw new Error(`Deferred catalog ${entry.catalogId} is unavailable.`);
    const tool = await catalog.activate(name);
    const descriptor = RuntimeToolDescriptorSchema.parse(tool.descriptor);
    if (JSON.stringify(descriptor) !== JSON.stringify(entry.descriptor)) throw new Error("Activated tool metadata does not match its deferred catalog descriptor.");
    this.registerExternalTool(tool);
    this.deferredTools.delete(name);
    this.allowTool(sessionId, name);
    return descriptor;
  }

  unregisterExternalTool(toolName: string): void {
    const definition = this.tools.get(toolName);
    if (!definition) return;
    if (definition.descriptor.source === "builtin") throw new Error("Built-in runtime tools cannot be unregistered.");
    this.tools.delete(toolName);
    for (const session of this.listSessions()) {
      if (!session.allowedTools.includes(toolName)) continue;
      this.saveSession({ ...session, allowedTools: session.allowedTools.filter((name) => name !== toolName), updatedAt: this.now() });
    }
  }

  allowTool(sessionId: string, toolName: string): RuntimeSession {
    const session = this.requireSession(sessionId);
    if (!this.tools.has(toolName)) throw new Error(`Tool ${toolName} is not registered.`);
    if (session.allowedTools.includes(toolName)) return session;
    return this.saveSession({ ...session, allowedTools: [...session.allowedTools, toolName], updatedAt: this.now() });
  }

  discoverTools(sessionId: string, query?: string): RuntimeToolDescriptor[] {
    const session = this.requireSession(sessionId);
    const hasActiveWorkspace = Boolean(this.resolveActiveWorkspaceRoot(session));
    const terms = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    return [...this.tools.values()]
      .map((definition) => definition.descriptor)
      .filter((tool) => session.allowedTools.includes(tool.name))
      .filter((tool) => !tool.requiresWorkspace || hasActiveWorkspace)
      .filter((tool) => terms.length === 0 || terms.every((term) => `${tool.name} ${tool.title} ${tool.description} ${tool.tags.join(" ")}`.toLowerCase().includes(term)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  modelTools(sessionId: string): RuntimeModelTool[] {
    const available = new Set(this.discoverTools(sessionId).map((tool) => tool.name));
    return [...this.tools.values()]
      .filter((definition) => available.has(definition.descriptor.name))
      .map((definition) => ({
        descriptor: definition.descriptor,
        inputSchema: definition.jsonSchema ?? z.toJSONSchema(definition.inputSchema) as Record<string, unknown>
      }));
  }

  private registerDiscoveryTools(): void {
    this.registerTool({
      descriptor: { name: "tools.search", title: "Search tool catalog", description: "Search active and deferred tools by capability before loading them.", category: "extension", riskLevel: "read_only", readOnly: true, requiresWorkspace: false, source: "builtin", tags: ["tools", "discovery", "deferred", "catalog"] },
      inputSchema: z.object({ query: z.string().max(500).default("") }),
      outputSchema: z.record(z.string(), z.unknown()),
      execute: ({ session }, input) => ({
        active: this.discoverTools(session.id, String(input.query ?? "")),
        deferred: this.discoverDeferredTools(String(input.query ?? ""))
      })
    });
    this.registerTool({
      descriptor: { name: "tools.activate", title: "Activate deferred tool", description: "Load one discovered deferred tool after explicit approval.", category: "extension", riskLevel: "sensitive", readOnly: false, requiresWorkspace: false, source: "builtin", tags: ["tools", "discovery", "deferred", "activate"] },
      inputSchema: z.object({ name: z.string().min(1) }),
      outputSchema: z.record(z.string(), z.unknown()),
      execute: async ({ session }, input) => ({ descriptor: await this.activateDeferredTool(session.id, String(input.name)) })
    });
  }

  async callTool(sessionId: string, toolName: string, rawInput: Record<string, unknown>, options: ToolCallOptions = {}): Promise<RuntimeToolExecution> {
    const session = this.requireSession(sessionId);
    const workspaceRoot = this.resolveActiveWorkspaceRoot(session);
    const definition = this.tools.get(toolName);
    if (!definition || !session.allowedTools.includes(toolName)) throw new Error(`Tool ${toolName} is unavailable in this session.`);
    if (session.status !== "active") throw new Error(`Session ${sessionId} is ${session.status}.`);
    if (definition.descriptor.requiresWorkspace && !workspaceRoot) throw new Error("This tool requires a user-granted workspace root.");
    if (!definition.descriptor.readOnly && !options.idempotencyKey) throw new Error("Mutating tools require an idempotency key.");

    const idempotencyKey = options.idempotencyKey ? `runtime-tool:${sessionId}:${toolName}:${options.idempotencyKey}` : undefined;
    const repeated = idempotencyKey ? this.database.getIdempotentResult<RuntimeToolExecution>(idempotencyKey) : undefined;
    if (repeated) return RuntimeToolExecutionSchema.parse(repeated);

    const activeExecution = idempotencyKey
      ? this.inFlightIdempotentExecutions.get(idempotencyKey)
      : undefined;
    if (activeExecution) return this.waitForPromise(activeExecution, options.signal);

    const pendingExecution = this.executeToolCall(
      session,
      workspaceRoot,
      definition,
      toolName,
      rawInput,
      options,
      idempotencyKey,
    );
    if (!idempotencyKey) return pendingExecution;

    this.inFlightIdempotentExecutions.set(idempotencyKey, pendingExecution);
    try {
      return await pendingExecution;
    } finally {
      if (this.inFlightIdempotentExecutions.get(idempotencyKey) === pendingExecution) {
        this.inFlightIdempotentExecutions.delete(idempotencyKey);
      }
    }
  }

  private async executeToolCall(
    session: RuntimeSession,
    workspaceRoot: string | undefined,
    definition: RuntimeToolDefinition,
    toolName: string,
    rawInput: Record<string, unknown>,
    options: ToolCallOptions,
    idempotencyKey: string | undefined,
  ): Promise<RuntimeToolExecution> {
    const input = definition.inputSchema.parse(rawInput);
    const assessment = options.externalContent ? assessExternalContent(options.externalContent) : undefined;
    const configuredPolicy = this.toolPolicyResolver?.({
      session,
      tool: definition.descriptor,
      input,
    }) ?? {};
    const approvalRule = this.listApprovalRules().filter((rule) => rule.toolName === toolName && (rule.scope === "global" || rule.sessionId === session.id)).sort((left, right) => left.scope === "session" ? -1 : right.scope === "session" ? 1 : 0)[0];
    const alwaysRequireApproval =
      definition.descriptor.approvalMode === "always" ||
      configuredPolicy.requireApproval === true;
    const oneTimeApprovalGrant =
      options.approvalStatus === "approved" && alwaysRequireApproval
        ? this.validOneTimeApprovalGrant(
            session.id,
            toolName,
            input,
            options.approvalGrantExecutionId,
          )
        : undefined;
    const oneTimeApprovalValid =
      options.approvalStatus === "approved" &&
      (!alwaysRequireApproval || Boolean(oneTimeApprovalGrant));
    const effectiveRisk =
      alwaysRequireApproval &&
      (definition.descriptor.riskLevel === "read_only" ||
        definition.descriptor.riskLevel === "low")
        ? "sensitive"
        : definition.descriptor.riskLevel;
    const policy = configuredPolicy.denied
      ? {
          allowed: false,
          approvalRequired: false,
          reason:
            configuredPolicy.reason ??
            `The active agent configuration denies ${toolName}.`,
        }
      : approvalRule?.decision === "deny"
      ? { allowed: false, approvalRequired: false, reason: `A persistent ${approvalRule.scope} rule denies ${toolName}.` }
      : mayExecute({
      risk: effectiveRisk,
      ...(
        alwaysRequireApproval
          ? oneTimeApprovalValid
            ? { approvalStatus: "approved" }
            : {}
          : approvalRule?.decision === "allow"
            ? { approvalStatus: "approved" }
            : options.approvalStatus
              ? { approvalStatus: options.approvalStatus }
              : {}
      ),
      ...(assessment ? { externalContentSuspicious: assessment.suspicious } : {})
    });
    if (
      !policy.allowed &&
      policy.approvalRequired &&
      configuredPolicy.reason
    )
      policy.reason = configuredPolicy.reason;
    const startedAt = this.now();
    if (policy.allowed && oneTimeApprovalGrant) {
      this.database.saveToolExecution({
        ...oneTimeApprovalGrant,
        status: "cancelled",
        error: "The approved one-time grant was consumed.",
        completedAt: startedAt,
      });
    }
    let execution = RuntimeToolExecutionSchema.parse({
      id: `tool-${randomUUID()}`,
      sessionId: session.id,
      toolName,
      status: policy.allowed ? "running" : "blocked",
      riskLevel: effectiveRisk,
      input,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(!policy.allowed ? { output: {
        preview: this.approvalPreview(session, toolName, input),
        approvalRequired: policy.approvalRequired,
        persistentApprovalAllowed: !alwaysRequireApproval,
      } } : {}),
      startedAt,
      ...(!policy.allowed ? { error: policy.reason, completedAt: startedAt } : {})
    });
    if (!policy.allowed) {
      this.database.saveToolExecution(execution);
      this.emitRuntimeEvent("tool.started", session.id, { toolName, status: execution.status }, { executionId: execution.id });
      this.emitRuntimeEvent("tool.completed", session.id, { toolName, status: execution.status, error: execution.error }, { executionId: execution.id });
      return execution;
    }

    const preHook = await this.runHooks("pre_tool", session, definition.descriptor, execution);
    if (preHook.blocked) {
      execution = RuntimeToolExecutionSchema.parse({ ...execution, status: "blocked", error: preHook.reason ?? "A pre-tool hook blocked execution.", completedAt: this.now() });
      this.database.saveToolExecution(execution);
      this.emitRuntimeEvent("tool.started", session.id, { toolName, status: execution.status }, { executionId: execution.id });
      this.emitRuntimeEvent("tool.completed", session.id, { toolName, status: execution.status, error: execution.error }, { executionId: execution.id });
      return execution;
    }

    if (options.signal?.aborted) {
      const reason = abortReason(options.signal);
      execution = RuntimeToolExecutionSchema.parse({
        ...execution,
        status: "cancelled",
        error: reason instanceof Error
          ? reason.message
          : "Execution cancelled by the user.",
        completedAt: this.now(),
      });
      this.database.saveToolExecution(execution);
      this.emitRuntimeEvent("tool.started", session.id, { toolName, status: execution.status }, { executionId: execution.id });
      this.emitRuntimeEvent("tool.completed", session.id, { toolName, status: execution.status, error: execution.error }, { executionId: execution.id });
      return execution;
    }

    if (idempotencyKey) {
      const repeatedExecution = await this.acquireIdempotentExecution(
        idempotencyKey,
        execution,
        options.signal,
      );
      if (repeatedExecution) return repeatedExecution;
    }

    const activeExecutionId = execution.id;
    let claimOwned = Boolean(idempotencyKey);
    let effectStarted = false;
    let effectVerified = false;
    let controller: AbortController | undefined;
    const abortFromCaller = () => {
      if (controller && !controller.signal.aborted) {
        controller.abort(options.signal ? abortReason(options.signal) : new Error("Execution cancelled by the user."));
      }
    };
    try {
      this.database.saveToolExecution(execution);
      this.emitRuntimeEvent("tool.started", session.id, { toolName, status: execution.status }, { executionId: execution.id });
      controller = new AbortController();
      if (options.signal?.aborted) abortFromCaller();
      else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
      this.activeExecutions.set(activeExecutionId, {
        controller,
        sessionId: session.id,
      });
      const context: RuntimeToolContext = {
        session,
        executionId: activeExecutionId,
        signal: controller.signal,
        progress: (payload) => this.emitRuntimeEvent("tool.progress", session.id, payload, { executionId: activeExecutionId }),
        ...(workspaceRoot ? { workspaceRoot } : {})
      };
      if (controller.signal.aborted) throw abortReason(controller.signal);
      effectStarted = true;
      const output = definition.outputSchema.parse(await definition.execute(context, input));
      const verificationResult = definition.descriptor.readOnly ? undefined : await this.verifyMutation(definition, context, input, output);
      effectVerified = true;
      const verifiedAt = this.now();
      const verification = verificationResult ? {
        method: verificationResult.method,
        evidenceSha256: createHash("sha256").update(JSON.stringify(verificationResult.evidence) ?? String(verificationResult.evidence)).digest("hex"),
        verifiedAt
      } : undefined;
      execution = RuntimeToolExecutionSchema.parse({ ...execution, status: "verified", output, ...(verification ? { verification } : {}), completedAt: verifiedAt });
      this.database.saveToolExecution(execution);
      await this.runHooks("post_tool", session, definition.descriptor, execution);
      if (idempotencyKey) {
        execution = this.completeIdempotentExecution(idempotencyKey, execution);
        claimOwned = false;
      }
      this.emitRuntimeEvent("tool.completed", session.id, { toolName, status: execution.status }, { executionId: execution.id });
      return execution;
    } catch (error) {
      const cancelled = controller?.signal.aborted === true || options.signal?.aborted === true;
      const uncertainMutation = cancelled
        && !definition.descriptor.readOnly
        && effectStarted
        && !effectVerified;
      execution = RuntimeToolExecutionSchema.parse({
        ...execution,
        status: uncertainMutation
          ? "failed"
          : cancelled && !effectVerified
            ? "cancelled"
            : "failed",
        error: uncertainMutation
          ? "Cancellation arrived after this mutation started, so Kestrel could not confirm whether it completed. The action will not be retried automatically."
          : error instanceof Error
            ? error.message
            : "Tool execution failed.",
        completedAt: this.now()
      });
      this.database.saveToolExecution(execution);
      if (idempotencyKey && effectStarted) {
        execution = this.completeIdempotentExecution(idempotencyKey, execution);
        claimOwned = false;
      } else if (idempotencyKey && claimOwned) {
        this.database.releaseIdempotentClaim(idempotencyKey, this.idempotencyOwnerToken);
        claimOwned = false;
      }
      if (effectStarted) await this.runHooks("tool_error", session, definition.descriptor, execution);
      try {
        this.emitRuntimeEvent("tool.completed", session.id, { toolName, status: execution.status, error: execution.error }, { executionId: execution.id });
      } catch {
        // Observer failures must not strand an idempotency claim.
      }
      return execution;
    } finally {
      options.signal?.removeEventListener("abort", abortFromCaller);
      this.activeExecutions.delete(activeExecutionId);
      if (idempotencyKey && claimOwned) {
        if (!effectStarted) {
          this.database.releaseIdempotentClaim(idempotencyKey, this.idempotencyOwnerToken);
        } else {
          const uncertain = RuntimeToolExecutionSchema.parse({
            ...execution,
            status: "failed",
            error: "Kestrel lost the terminal journal update after this mutation started. The outcome is uncertain and the action will not be retried automatically.",
            completedAt: this.now(),
          });
          const completion = this.database.abandonIdempotentClaim(
            idempotencyKey,
            this.idempotencyOwnerToken,
            uncertain,
          );
          this.database.saveToolExecution(
            RuntimeToolExecutionSchema.parse(completion.result),
          );
        }
      }
    }
  }

  private completeIdempotentExecution(
    idempotencyKey: string,
    execution: RuntimeToolExecution,
  ): RuntimeToolExecution {
    const completion = this.database.completeIdempotentResult(
      idempotencyKey,
      this.idempotencyOwnerToken,
      execution,
    );
    const result = RuntimeToolExecutionSchema.parse(completion.result);
    this.database.saveToolExecution(result);
    return result;
  }

  private async acquireIdempotentExecution(
    idempotencyKey: string,
    pendingExecution: RuntimeToolExecution,
    signal?: AbortSignal,
  ): Promise<RuntimeToolExecution | undefined> {
    const waitStartedAt = Date.now();
    const initial = this.database.claimIdempotentResult(
      idempotencyKey,
      this.idempotencyOwnerToken,
      process.pid,
      pendingExecution,
    );
    if (initial.state === "claimed") return undefined;
    if (initial.state === "completed") {
      return RuntimeToolExecutionSchema.parse(initial.result);
    }
    let activeClaim = initial.claim;
    while (true) {
      // A live owner may be slow or hung, but stealing its claim could repeat an
      // external side effect. Bound only this caller's wait; leave ownership intact.
      if (!processIsAlive(activeClaim.ownerPid)) {
        return this.recoverAbandonedIdempotentClaim(idempotencyKey, activeClaim);
      }
      if (Date.now() - waitStartedAt >= 30_000) {
        throw new Error("A matching tool execution is still running in another Kestrel process. Retry after it finishes or cancel this wait.");
      }
      await this.waitForPromise(
        new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50)),
        signal,
      );
      const completed = this.database.getIdempotentResult<RuntimeToolExecution>(idempotencyKey);
      if (completed) return RuntimeToolExecutionSchema.parse(completed);
      const observed = this.database.getIdempotentClaim<RuntimeToolExecution>(idempotencyKey);
      if (observed) {
        activeClaim = observed;
        continue;
      }
      const retry = this.database.claimIdempotentResult(
        idempotencyKey,
        this.idempotencyOwnerToken,
        process.pid,
        pendingExecution,
      );
      if (retry.state === "claimed") return undefined;
      if (retry.state === "completed") return RuntimeToolExecutionSchema.parse(retry.result);
      activeClaim = retry.claim;
    }
  }

  private recoverAbandonedIdempotentClaim(
    idempotencyKey: string,
    claim: IdempotencyClaim<RuntimeToolExecution>,
  ): RuntimeToolExecution {
    const pending = RuntimeToolExecutionSchema.parse(claim.pendingResult);
    const recorded = this.database.getToolExecution(pending.id);
    const terminal = recorded && recorded.status !== "running"
      ? recorded
      : RuntimeToolExecutionSchema.parse({
          ...pending,
          status: "failed",
          error: "The previous Kestrel process stopped before it could confirm this tool's outcome. The action will not be retried automatically because it may already have completed.",
          completedAt: this.now(),
        });
    const completion = this.database.abandonIdempotentClaim(
      idempotencyKey,
      claim.ownerToken,
      terminal,
    );
    const result = RuntimeToolExecutionSchema.parse(completion.result);
    if (completion.completed) {
      this.database.saveToolExecution(result);
      this.emitRuntimeEvent(
        "tool.completed",
        result.sessionId,
        { toolName: result.toolName, status: result.status, error: result.error },
        { executionId: result.id },
      );
    }
    return result;
  }

  private reconcileIdempotencyClaims(): void {
    for (const claim of this.database.listIdempotentClaims<RuntimeToolExecution>("runtime-tool:")) {
      if (!processIsAlive(claim.ownerPid)) {
        this.recoverAbandonedIdempotentClaim(claim.key, claim);
      }
    }
  }

  private waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        rejectPromise(abortReason(signal));
      };
      signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolvePromise(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          rejectPromise(error);
        },
      );
    });
  }

  private abortActiveExecutionsForHistoryRollback(
    sessionId: string,
    reason: string,
  ): void {
    for (const active of this.activeExecutions.values()) {
      if (active.sessionId === sessionId && !active.controller.signal.aborted)
        active.controller.abort(new Error(reason));
    }
  }

  private registerWorkspaceTools(): void {
    this.registerTool({
      descriptor: {
        name: "workspace.list",
        title: "List workspace files",
        description: "List files under a user-granted workspace without following paths outside it.",
        category: "workspace",
        riskLevel: "read_only",
        readOnly: true,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["files", "workspace", "search"]
      },
      inputSchema: listInputSchema,
      outputSchema: z.object({ root: z.string(), files: z.array(z.string()), truncated: z.boolean() }),
      execute: ({ workspaceRoot }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = listInputSchema.parse(input);
        const start = resolveExistingPath(workspaceRoot, parsed.path);
        if (!statSync(start).isDirectory()) throw new Error("workspace.list requires a directory path.");
        const files = walkFiles(workspaceRoot, start, parsed.maxEntries + 1);
        return {
          root: relative(workspaceRoot, start) || ".",
          files: files.slice(0, parsed.maxEntries).map((path) => relative(workspaceRoot, path)),
          truncated: files.length > parsed.maxEntries
        };
      }
    });

    this.registerTool({
      descriptor: {
        name: "workspace.read",
        title: "Read workspace file",
        description: "Read a bounded UTF-8 text file inside a user-granted workspace.",
        category: "workspace",
        riskLevel: "read_only",
        readOnly: true,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["files", "read", "code", "context"]
      },
      inputSchema: readInputSchema,
      outputSchema: z.object({ path: z.string(), content: z.string(), truncated: z.boolean() }),
      execute: ({ workspaceRoot }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = readInputSchema.parse(input);
        const path = resolveExistingPath(workspaceRoot, parsed.path);
        if (!statSync(path).isFile()) throw new Error("workspace.read requires a file path.");
        const text = textFile(path, parsed.maxBytes);
        if (!text) throw new Error("Binary files are not exposed as text context.");
        return { path: relative(workspaceRoot, path), ...text };
      }
    });

    this.registerTool({
      descriptor: {
        name: "workspace.search",
        title: "Search workspace text",
        description: "Search bounded text files inside a user-granted workspace and return matching lines.",
        category: "workspace",
        riskLevel: "read_only",
        readOnly: true,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["files", "search", "code", "context"]
      },
      inputSchema: searchInputSchema,
      outputSchema: z.object({ query: z.string(), matches: z.array(z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() })), truncated: z.boolean() }),
      execute: ({ workspaceRoot }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = searchInputSchema.parse(input);
        const start = resolveExistingPath(workspaceRoot, parsed.path);
        const files = statSync(start).isFile() ? [start] : walkFiles(workspaceRoot, start, 2_000);
        const needle = parsed.caseSensitive ? parsed.query : parsed.query.toLowerCase();
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const path of files) {
          const text = textFile(path, 1_000_000);
          if (!text) continue;
          for (const [index, line] of text.content.split(/\r?\n/).entries()) {
            const haystack = parsed.caseSensitive ? line : line.toLowerCase();
            if (haystack.includes(needle)) matches.push({ path: relative(workspaceRoot, path), line: index + 1, text: line.slice(0, 2_000) });
            if (matches.length > parsed.maxMatches) break;
          }
          if (matches.length > parsed.maxMatches) break;
        }
        return { query: parsed.query, matches: matches.slice(0, parsed.maxMatches), truncated: matches.length > parsed.maxMatches };
      }
    });

    this.registerTool({
      descriptor: {
        name: "workspace.read-binary",
        title: "Read workspace binary",
        description: "Read a bounded binary file chunk inside a user-granted workspace with size, media type, and digest metadata.",
        category: "workspace",
        riskLevel: "read_only",
        readOnly: true,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["files", "binary", "image", "audio", "document", "context"]
      },
      inputSchema: binaryReadInputSchema,
      outputSchema: z.object({ path: z.string(), mediaType: z.string(), size: z.number().int().nonnegative(), dataBase64: z.string(), chunkSha256: z.string(), truncated: z.boolean() }),
      execute: ({ workspaceRoot }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = binaryReadInputSchema.parse(input);
        const path = resolveExistingPath(workspaceRoot, parsed.path);
        const metadata = statSync(path);
        if (!metadata.isFile()) throw new Error("workspace.read-binary requires a file path.");
        const chunk = Buffer.alloc(Math.min(metadata.size, parsed.maxBytes));
        const descriptor = openSync(path, "r");
        try { readSync(descriptor, chunk, 0, chunk.byteLength, 0); } finally { closeSync(descriptor); }
        const mediaType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime", ".zip": "application/zip" } as Record<string, string>)[extname(path).toLowerCase()] ?? "application/octet-stream";
        return { path: relative(workspaceRoot, path), mediaType, size: metadata.size, dataBase64: chunk.toString("base64"), chunkSha256: createHash("sha256").update(chunk).digest("hex"), truncated: metadata.size > chunk.byteLength };
      }
    });

    this.registerTool({
      descriptor: {
        name: "workspace.instructions",
        title: "Load workspace instructions",
        description: "Load root-to-leaf AGENTS.md, CLAUDE.md, HERMES.md, and Kestrel instruction files for a target path.",
        category: "workspace",
        riskLevel: "read_only",
        readOnly: true,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["instructions", "rules", "agents", "context"]
      },
      inputSchema: instructionInputSchema,
      outputSchema: z.object({ instructions: z.array(z.object({ path: z.string(), content: z.string(), precedence: z.number().int().nonnegative() })) }),
      execute: ({ workspaceRoot }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = instructionInputSchema.parse(input);
        return { instructions: this.loadInstructions(workspaceRoot, parsed.targetPath) };
      }
    });

    this.registerTool({
      descriptor: {
        name: "workspace.write",
        title: "Write workspace file",
        description: "Create or replace a bounded UTF-8 file atomically and record an encrypted undo mutation.",
        category: "workspace",
        riskLevel: "low",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["files", "write", "edit", "patch", "undo"]
      },
      inputSchema: writeInputSchema,
      outputSchema: z.object({ path: z.string(), mutationId: z.string(), operation: z.enum(["create", "update"]), bytes: z.number().int().nonnegative() }),
      execute: ({ session, executionId, workspaceRoot }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = writeInputSchema.parse(input);
        const path = resolveWritablePath(workspaceRoot, parsed.path);
        const before = existsSync(path) ? this.readMutationText(path) : undefined;
        if (parsed.expectedContent !== undefined && before !== parsed.expectedContent) throw new Error("Workspace file changed since it was read; refusing to overwrite it.");
        const operation = before === undefined ? "create" as const : "update" as const;
        this.writeTextAtomically(path, parsed.content);
        const mutation = WorkspaceMutationSchema.parse({
          id: `mutation-${randomUUID()}`,
          sessionId: session.id,
          toolExecutionId: executionId,
          operation,
          path: relative(workspaceRoot, path),
          ...(before !== undefined ? { beforeContent: before } : {}),
          afterContent: parsed.content,
          createdAt: this.now()
        });
        this.database.saveWorkspaceMutation(mutation);
        return { path: mutation.path, mutationId: mutation.id, operation, bytes: Buffer.byteLength(parsed.content) };
      }
    });

    this.registerTool({
      descriptor: {
        name: "workspace.delete",
        title: "Delete workspace file",
        description: "Delete one bounded UTF-8 file after explicit approval and retain an encrypted undo record.",
        category: "workspace",
        riskLevel: "sensitive",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["files", "delete", "undo", "sensitive"]
      },
      inputSchema: deleteInputSchema,
      outputSchema: z.object({ path: z.string(), mutationId: z.string(), operation: z.literal("delete") }),
      execute: ({ session, executionId, workspaceRoot }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = deleteInputSchema.parse(input);
        const path = resolveExistingPath(workspaceRoot, parsed.path);
        if (!statSync(path).isFile()) throw new Error("workspace.delete only deletes files.");
        const before = this.readMutationText(path);
        if (parsed.expectedContent !== undefined && before !== parsed.expectedContent) throw new Error("Workspace file changed since it was read; refusing to delete it.");
        unlinkSync(path);
        const mutation = WorkspaceMutationSchema.parse({
          id: `mutation-${randomUUID()}`,
          sessionId: session.id,
          toolExecutionId: executionId,
          operation: "delete",
          path: relative(workspaceRoot, path),
          beforeContent: before,
          createdAt: this.now()
        });
        this.database.saveWorkspaceMutation(mutation);
        return { path: mutation.path, mutationId: mutation.id, operation: "delete" };
      }
    });

    this.registerTool({
      descriptor: { name: "workspace.mkdir", title: "Create workspace directory", description: "Create one directory inside the granted workspace and record an undo mutation.", category: "workspace", riskLevel: "low", readOnly: false, requiresWorkspace: true, source: "builtin", tags: ["directory", "create", "write", "undo"] },
      inputSchema: directoryInputSchema,
      outputSchema: z.object({ path: z.string(), mutationId: z.string(), operation: z.literal("create") }),
      execute: ({ session, executionId, workspaceRoot }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = directoryInputSchema.parse(input);
        const path = resolveWritablePath(workspaceRoot, parsed.path);
        if (existsSync(path)) throw new Error("Workspace directory path already exists.");
        mkdirSync(path, { mode: 0o700 });
        const mutation = WorkspaceMutationSchema.parse({ id: `mutation-${randomUUID()}`, sessionId: session.id, toolExecutionId: executionId, operation: "create", entryKind: "directory", path: relative(workspaceRoot, path), createdAt: this.now() });
        this.database.saveWorkspaceMutation(mutation);
        return { path: mutation.path, mutationId: mutation.id, operation: "create" as const };
      }
    });

    this.registerTool({
      descriptor: { name: "workspace.rmdir", title: "Delete empty workspace directory", description: "Delete one empty directory after approval and retain an undo mutation.", category: "workspace", riskLevel: "sensitive", readOnly: false, requiresWorkspace: true, source: "builtin", tags: ["directory", "delete", "undo", "sensitive"] },
      inputSchema: directoryInputSchema,
      outputSchema: z.object({ path: z.string(), mutationId: z.string(), operation: z.literal("delete") }),
      execute: ({ session, executionId, workspaceRoot }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = directoryInputSchema.parse(input);
        const path = resolveExistingPath(workspaceRoot, parsed.path);
        if (path === workspaceRoot) throw new Error("Workspace root cannot be deleted.");
        if (!statSync(path).isDirectory()) throw new Error("workspace.rmdir requires a directory path.");
        if (readdirSync(path).length > 0) throw new Error("workspace.rmdir only deletes empty directories.");
        rmdirSync(path);
        const mutation = WorkspaceMutationSchema.parse({ id: `mutation-${randomUUID()}`, sessionId: session.id, toolExecutionId: executionId, operation: "delete", entryKind: "directory", path: relative(workspaceRoot, path), createdAt: this.now() });
        this.database.saveWorkspaceMutation(mutation);
        return { path: mutation.path, mutationId: mutation.id, operation: "delete" as const };
      }
    });

    this.registerTool({
      descriptor: {
        name: "workspace.patch",
        title: "Patch workspace file",
        description: "Apply exact checked text replacements atomically and retain an encrypted undo record.",
        category: "workspace",
        riskLevel: "low",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["files", "patch", "edit", "diff", "undo"]
      },
      inputSchema: patchInputSchema,
      outputSchema: z.object({ path: z.string(), mutationId: z.string(), sha256: z.string(), replacements: z.number().int().positive() }),
      execute: ({ session, executionId, workspaceRoot }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = patchInputSchema.parse(input);
        const path = resolveExistingPath(workspaceRoot, parsed.path);
        if (!statSync(path).isFile()) throw new Error("workspace.patch requires a file path.");
        const before = this.readMutationText(path);
        const beforeHash = createHash("sha256").update(before).digest("hex");
        if (parsed.expectedSha256 && parsed.expectedSha256 !== beforeHash) throw new Error("Workspace file hash changed since it was read; refusing to patch it.");
        let after = before;
        let replacements = 0;
        for (const edit of parsed.edits) {
          const first = after.indexOf(edit.oldText);
          if (first < 0) throw new Error("Patch context was not found in the current file.");
          if (!edit.replaceAll && after.indexOf(edit.oldText, first + edit.oldText.length) >= 0) throw new Error("Patch context is ambiguous; set replaceAll or provide a more specific oldText value.");
          if (edit.replaceAll) {
            const count = after.split(edit.oldText).length - 1;
            after = after.split(edit.oldText).join(edit.newText);
            replacements += count;
          } else {
            after = `${after.slice(0, first)}${edit.newText}${after.slice(first + edit.oldText.length)}`;
            replacements += 1;
          }
        }
        this.writeTextAtomically(path, after);
        const mutation = WorkspaceMutationSchema.parse({
          id: `mutation-${randomUUID()}`,
          sessionId: session.id,
          toolExecutionId: executionId,
          operation: "update",
          path: relative(workspaceRoot, path),
          beforeContent: before,
          afterContent: after,
          createdAt: this.now()
        });
        this.database.saveWorkspaceMutation(mutation);
        return { path: mutation.path, mutationId: mutation.id, sha256: createHash("sha256").update(after).digest("hex"), replacements };
      }
    });

    this.registerTool({
      descriptor: {
        name: "workspace.move",
        title: "Move workspace file",
        description: "Rename one file within the granted workspace and retain an undo record.",
        category: "workspace",
        riskLevel: "low",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["files", "move", "rename", "undo"]
      },
      inputSchema: moveInputSchema,
      outputSchema: z.object({ from: z.string(), to: z.string(), mutationId: z.string() }),
      execute: ({ session, executionId, workspaceRoot }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = moveInputSchema.parse(input);
        const from = resolveExistingPath(workspaceRoot, parsed.from);
        const to = resolveWritablePath(workspaceRoot, parsed.to);
        const entryKind = statSync(from).isDirectory() ? "directory" as const : statSync(from).isFile() ? "file" as const : undefined;
        if (!entryKind) throw new Error("workspace.move only moves files or directories.");
        if (existsSync(to)) throw new Error("workspace.move will not overwrite an existing destination.");
        renameSync(from, to);
        const mutation = WorkspaceMutationSchema.parse({
          id: `mutation-${randomUUID()}`,
          sessionId: session.id,
          toolExecutionId: executionId,
          operation: "move",
          entryKind,
          path: relative(workspaceRoot, from),
          destinationPath: relative(workspaceRoot, to),
          createdAt: this.now()
        });
        this.database.saveWorkspaceMutation(mutation);
        return { from: mutation.path, to: mutation.destinationPath, mutationId: mutation.id };
      }
    });

    this.registerTool({
      descriptor: {
        name: "workspace.undo",
        title: "Undo workspace mutation",
        description: "Restore a recorded create, update, or delete mutation exactly once.",
        category: "workspace",
        riskLevel: "low",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["files", "undo", "restore", "checkpoint"]
      },
      inputSchema: undoInputSchema,
      outputSchema: z.object({ mutationId: z.string(), path: z.string(), restored: z.boolean() }),
      execute: ({ session }, input) => {
        const parsed = undoInputSchema.parse(input);
        return this.undoWorkspaceMutation(session.id, parsed.mutationId);
      }
    });
  }

  private registerExecutionTools(): void {
    const commandOutputSchema = z.object({
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      exitCode: z.number().int(),
      signal: z.string().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      durationMs: z.number().int().nonnegative()
    });

    this.registerTool({
      descriptor: {
        name: "execution.run-readonly",
        title: "Run read-only command",
        description: "Run one allowlisted executable without a shell in a macOS sandbox that denies network and all file writes.",
        category: "execution",
        riskLevel: "read_only",
        readOnly: true,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["shell", "terminal", "process", "sandbox", "stream"]
      },
      inputSchema: commandInputSchema,
      outputSchema: commandOutputSchema,
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = commandInputSchema.parse(input);
        const cwd = resolveExistingPath(workspaceRoot, parsed.cwd);
        if (!statSync(cwd).isDirectory()) throw new Error("Command cwd must be a directory.");
        return { ...await this.commandRunner.run({ ...parsed, cwd, workspaceRoot, mode: "read_only" }, { signal, onProgress: progress }) };
      }
    });

    const processOutputSchema = z.object({
      processId: z.string(),
      pid: z.number().int().nonnegative(),
      status: z.enum(["running", "completed", "failed", "stopped", "interrupted"]),
      exitCode: z.number().int().optional(),
      signal: z.string().nullable().optional(),
      stdout: z.string(),
      stderr: z.string(),
      durationMs: z.number().int().nonnegative(),
      error: z.string().optional()
    });

    this.registerTool({
      descriptor: {
        name: "execution.start-background",
        title: "Start background process",
        description: "Start an approved allowlisted process under the workspace Seatbelt profile and supervise it by process ID.",
        category: "execution",
        riskLevel: "sensitive",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["shell", "terminal", "background", "process", "sandbox", "stream"]
      },
      inputSchema: backgroundCommandInputSchema,
      outputSchema: z.object({ processId: z.string(), pid: z.number().int().nonnegative(), status: z.literal("running") }),
      execute: ({ session, workspaceRoot, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = backgroundCommandInputSchema.parse(input);
        const cwd = resolveExistingPath(workspaceRoot, parsed.cwd);
        if (!statSync(cwd).isDirectory()) throw new Error("Command cwd must be a directory.");
        const processId = `process-${randomUUID()}`;
        const handle = this.commandRunner.start({ ...parsed, cwd, workspaceRoot, mode: "workspace_write" }, {
          interactive: parsed.interactive,
          onProgress: (payload) => progress({ processId, ...payload })
        });
        const record = { sessionId: session.id, handle, status: "running" as const, stopRequested: false };
        this.backgroundProcesses.set(processId, record);
        this.saveProcessJournal({ processId, sessionId: session.id, pid: handle.pid, status: "running", command: parsed.command, cwd: relative(workspaceRoot, cwd) || ".", interactive: parsed.interactive, stdout: "", stderr: "", durationMs: 0, createdAt: this.now(), updatedAt: this.now() });
        void handle.completion.then((result) => {
          const current = this.backgroundProcesses.get(processId);
          if (!current) return;
          current.status = current.stopRequested ? "stopped" : "completed";
          current.exitCode = result.exitCode;
          current.signal = result.signal;
          this.saveProcessJournal({ processId, sessionId: session.id, pid: handle.pid, status: current.status, command: parsed.command, cwd: relative(workspaceRoot, cwd) || ".", interactive: parsed.interactive, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, exitCode: result.exitCode, signal: result.signal, createdAt: this.processJournal(processId)?.createdAt ?? this.now(), updatedAt: this.now() });
          progress({ processId, state: current.status, exitCode: result.exitCode, signal: result.signal });
        }).catch((error) => {
          const current = this.backgroundProcesses.get(processId);
          if (!current) return;
          current.status = current.stopRequested ? "stopped" : "failed";
          current.error = error instanceof Error ? error.message : "Background process failed.";
          const snapshot = handle.snapshot(); this.saveProcessJournal({ processId, sessionId: session.id, pid: handle.pid, status: current.status, command: parsed.command, cwd: relative(workspaceRoot, cwd) || ".", interactive: parsed.interactive, stdout: snapshot.stdout, stderr: snapshot.stderr, durationMs: snapshot.durationMs, error: current.error, createdAt: this.processJournal(processId)?.createdAt ?? this.now(), updatedAt: this.now() });
          progress({ processId, state: current.status, error: current.error });
        });
        return { processId, pid: handle.pid, status: "running" as const };
      }
    });

    this.registerTool({
      descriptor: {
        name: "execution.process-status",
        title: "Inspect background process",
        description: "Read bounded output and lifecycle state for a session-owned background process.",
        category: "execution",
        riskLevel: "read_only",
        readOnly: true,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["terminal", "background", "process", "output", "status"]
      },
      inputSchema: processIdInputSchema,
      outputSchema: processOutputSchema,
      execute: ({ session }, input) => {
        const parsed = processIdInputSchema.parse(input);
        return this.backgroundProcessSnapshot(session.id, parsed.processId);
      }
    });

    this.registerTool({
      descriptor: {
        name: "execution.process-write",
        title: "Write background process input",
        description: "Write a bounded input chunk to an approved interactive background process.",
        category: "execution",
        riskLevel: "sensitive",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["terminal", "background", "process", "stdin", "interactive"]
      },
      inputSchema: processWriteInputSchema,
      outputSchema: z.object({ processId: z.string(), bytes: z.number().int().positive() }),
      execute: ({ session }, input) => {
        const parsed = processWriteInputSchema.parse(input);
        const process = this.requireBackgroundProcess(session.id, parsed.processId);
        process.handle.write(parsed.data);
        return { processId: parsed.processId, bytes: Buffer.byteLength(parsed.data) };
      }
    });

    this.registerTool({
      descriptor: {
        name: "execution.process-stop",
        title: "Stop background process",
        description: "Request termination of a session-owned background process.",
        category: "execution",
        riskLevel: "low",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["terminal", "background", "process", "cancel", "stop"]
      },
      inputSchema: processIdInputSchema,
      outputSchema: z.object({ processId: z.string(), stopRequested: z.boolean() }),
      execute: ({ session }, input) => {
        const parsed = processIdInputSchema.parse(input);
        const process = this.requireBackgroundProcess(session.id, parsed.processId);
        const stopRequested = process.status === "running";
        process.stopRequested = stopRequested;
        process.handle.stop();
        return { processId: parsed.processId, stopRequested };
      }
    });

    this.registerTool({
      descriptor: {
        name: "execution.run",
        title: "Run workspace-write command",
        description: "Run one allowlisted executable without a shell in a macOS sandbox that denies network and writes outside the granted workspace.",
        category: "execution",
        riskLevel: "sensitive",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["shell", "terminal", "process", "sandbox", "stream", "write"]
      },
      inputSchema: commandInputSchema,
      outputSchema: commandOutputSchema,
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = commandInputSchema.parse(input);
        const cwd = resolveExistingPath(workspaceRoot, parsed.cwd);
        if (!statSync(cwd).isDirectory()) throw new Error("Command cwd must be a directory.");
        return { ...await this.commandRunner.run({ ...parsed, cwd, workspaceRoot, mode: "workspace_write" }, { signal, onProgress: progress }) };
      }
    });

    this.registerTool({
      descriptor: {
        name: "git.status",
        title: "Inspect Git status",
        description: "Read concise branch and worktree status in the sandbox.",
        category: "execution",
        riskLevel: "read_only",
        readOnly: true,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["git", "status", "repository"]
      },
      inputSchema: z.object({}),
      outputSchema: z.object({ branch: z.string(), porcelain: z.string() }),
      execute: async ({ workspaceRoot, signal, progress }) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const result = await this.commandRunner.run({ command: "git", args: ["status", "--short", "--branch"], cwd: workspaceRoot, workspaceRoot, mode: "read_only", timeoutMs: 30_000 }, { signal, onProgress: progress });
        if (result.exitCode !== 0) throw new Error(result.stderr || "git status failed.");
        const [branch = "", ...changes] = result.stdout.trimEnd().split("\n");
        return { branch, porcelain: changes.join("\n") };
      }
    });

    this.registerTool({
      descriptor: {
        name: "git.diff",
        title: "Inspect Git diff",
        description: "Read a bounded staged or unstaged Git diff for optional pathspecs.",
        category: "execution",
        riskLevel: "read_only",
        readOnly: true,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["git", "diff", "review", "repository"]
      },
      inputSchema: gitDiffInputSchema,
      outputSchema: z.object({ diff: z.string(), staged: z.boolean() }),
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = gitDiffInputSchema.parse(input);
        const args = ["diff", "--no-ext-diff", "--no-color", ...(parsed.staged ? ["--cached"] : []), ...(parsed.pathspec.length ? ["--", ...parsed.pathspec] : [])];
        const result = await this.commandRunner.run({ command: "git", args, cwd: workspaceRoot, workspaceRoot, mode: "read_only", timeoutMs: 30_000 }, { signal, onProgress: progress });
        if (result.exitCode !== 0) throw new Error(result.stderr || "git diff failed.");
        return { diff: result.stdout, staged: parsed.staged };
      }
    });

    this.registerTool({
      descriptor: {
        name: "git.worktree-create",
        title: "Create isolated Git worktree",
        description: "Create an approved branch worktree under the granted repository's .kestrel/worktrees directory.",
        category: "execution",
        riskLevel: "sensitive",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["git", "worktree", "branch", "isolation"]
      },
      inputSchema: gitWorktreeInputSchema,
      outputSchema: z.object({ branch: z.string(), path: z.string(), stdout: z.string() }),
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = gitWorktreeInputSchema.parse(input);
        const directoryName = parsed.branch.replaceAll("/", "--");
        const relativePath = `.kestrel/worktrees/${directoryName}`;
        const absolutePath = resolve(workspaceRoot, relativePath);
        if (existsSync(absolutePath)) throw new Error("The requested Kestrel worktree path already exists.");
        const args = ["worktree", "add", ...(parsed.createBranch ? ["-b", parsed.branch] : []), relativePath, parsed.startPoint];
        const result = await this.commandRunner.run({ command: "git", args, cwd: workspaceRoot, workspaceRoot, mode: "workspace_write", timeoutMs: 120_000 }, { signal, onProgress: progress });
        if (result.exitCode !== 0) throw new Error(result.stderr || "git worktree add failed.");
        return { branch: parsed.branch, path: relativePath, stdout: result.stdout };
      }
    });

    this.registerTool({
      descriptor: {
        name: "git.stage",
        title: "Stage Git paths",
        description: "Stage explicit pathspecs inside the granted repository.",
        category: "execution",
        riskLevel: "low",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["git", "stage", "index", "repository"]
      },
      inputSchema: gitStageInputSchema,
      outputSchema: z.object({ pathspec: z.array(z.string()), stdout: z.string() }),
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = gitStageInputSchema.parse(input);
        const result = await this.commandRunner.run({ command: "git", args: ["add", "--", ...parsed.pathspec], cwd: workspaceRoot, workspaceRoot, mode: "workspace_write", timeoutMs: 30_000 }, { signal, onProgress: progress });
        if (result.exitCode !== 0) throw new Error(result.stderr || "git add failed.");
        return { pathspec: parsed.pathspec, stdout: result.stdout };
      }
    });

    this.registerTool({
      descriptor: {
        name: "git.branch-create",
        title: "Create Git branch",
        description: "Create an approved local branch from an explicit start point without switching worktrees.",
        category: "execution",
        riskLevel: "low",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["git", "branch", "repository"]
      },
      inputSchema: gitBranchInputSchema,
      outputSchema: z.object({ branch: z.string(), startPoint: z.string() }),
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = gitBranchInputSchema.parse(input);
        const result = await this.commandRunner.run({ command: "git", args: ["branch", parsed.branch, parsed.startPoint], cwd: workspaceRoot, workspaceRoot, mode: "workspace_write", timeoutMs: 30_000 }, { signal, onProgress: progress });
        if (result.exitCode !== 0) throw new Error(result.stderr || "git branch failed.");
        return parsed;
      }
    });

    this.registerTool({
      descriptor: {
        name: "git.commit",
        title: "Create Git commit",
        description: "Create an explicitly approved commit from the current index and return the verified commit ID.",
        category: "execution",
        riskLevel: "sensitive",
        readOnly: false,
        requiresWorkspace: true,
        source: "builtin",
        tags: ["git", "commit", "repository", "sensitive"]
      },
      inputSchema: gitCommitInputSchema,
      outputSchema: z.object({ commitId: z.string().regex(/^[a-f0-9]{40,64}$/), stdout: z.string() }),
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = gitCommitInputSchema.parse(input);
        const commit = await this.commandRunner.run({ command: "git", args: ["commit", "-m", parsed.message], cwd: workspaceRoot, workspaceRoot, mode: "workspace_write", timeoutMs: 120_000 }, { signal, onProgress: progress });
        if (commit.exitCode !== 0) throw new Error(commit.stderr || commit.stdout || "git commit failed.");
        const verify = await this.commandRunner.run({ command: "git", args: ["rev-parse", "HEAD"], cwd: workspaceRoot, workspaceRoot, mode: "read_only", timeoutMs: 30_000 }, { signal, onProgress: progress });
        if (verify.exitCode !== 0) throw new Error(verify.stderr || "git commit verification failed.");
        return { commitId: verify.stdout.trim(), stdout: commit.stdout };
      }
    });

    this.registerTool({
      descriptor: { name: "git.push", title: "Push Git branch", description: "Push an explicit branch to an explicit remote through the protected GitHub credential without placing the token in argv, files, output, or audit records.", category: "execution", riskLevel: "external", readOnly: false, requiresWorkspace: true, source: "builtin", tags: ["git", "push", "remote", "github", "publish"] },
      inputSchema: gitPushInputSchema,
      outputSchema: z.object({ remote: z.string(), branch: z.string(), remoteSha: z.string().regex(/^[a-f0-9]{40,64}$/), stdout: z.string() }),
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot || !this.githubToken) throw new Error("GitHub publishing requires a protected GitHub token.");
        const parsed = gitPushInputSchema.parse(input);
        await this.githubRepository(workspaceRoot, parsed.remote, signal, progress);
        const helperDirectory = resolve(workspaceRoot, ".kestrel", "runtime"); mkdirSync(helperDirectory, { recursive: true, mode: 0o700 });
        const helper = resolve(helperDirectory, "git-askpass.sh");
        writeFileSync(helper, "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' x-access-token ;; *) printf '%s\\n' \"$KESTREL_GIT_TOKEN\" ;; esac\n", { mode: 0o700 }); chmodSync(helper, 0o700);
        const environment = { GIT_ASKPASS: helper, GIT_TERMINAL_PROMPT: "0", KESTREL_GIT_TOKEN: this.githubToken };
        const pushed = await this.commandRunner.run({ command: "git", args: ["push", ...(parsed.setUpstream ? ["--set-upstream"] : []), parsed.remote, parsed.branch], cwd: workspaceRoot, workspaceRoot, mode: "network_workspace_write", timeoutMs: 300_000, environment }, { signal, onProgress: progress });
        if (pushed.exitCode !== 0) throw new Error(pushed.stderr || "git push failed.");
        const verify = await this.commandRunner.run({ command: "git", args: ["ls-remote", "--heads", parsed.remote, `refs/heads/${parsed.branch}`], cwd: workspaceRoot, workspaceRoot, mode: "network_workspace_write", timeoutMs: 60_000, environment }, { signal, onProgress: progress });
        if (verify.exitCode !== 0 || !/^[a-f0-9]{40,64}\s/.test(verify.stdout)) throw new Error(verify.stderr || "Git push remote verification failed.");
        return { remote: parsed.remote, branch: parsed.branch, remoteSha: verify.stdout.trim().split(/\s+/)[0]!, stdout: pushed.stdout };
      }
    });

    this.registerTool({
      descriptor: { name: "github.pr-create", title: "Create GitHub pull request", description: "Open a GitHub pull request for an already-pushed branch after explicit external-action approval.", category: "connector", riskLevel: "external", readOnly: false, requiresWorkspace: true, source: "connector", tags: ["github", "pull-request", "pr", "publish"] },
      inputSchema: githubPrInputSchema,
      outputSchema: z.object({ number: z.number().int().positive(), url: z.string().url(), title: z.string(), state: z.string(), draft: z.boolean() }),
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable.");
        const parsed = githubPrInputSchema.parse(input); const repository = await this.githubRepository(workspaceRoot, parsed.remote, signal, progress);
        const result = await this.githubApi<{ number: number; html_url: string; title: string; state: string; draft: boolean }>(`/repos/${repository.owner}/${repository.repo}/pulls`, { method: "POST", body: JSON.stringify({ title: parsed.title, body: parsed.body, head: parsed.head, base: parsed.base, draft: parsed.draft }) }, signal);
        return { number: result.number, url: result.html_url, title: result.title, state: result.state, draft: result.draft };
      }
    });

    this.registerTool({
      descriptor: { name: "github.ci-checks", title: "Inspect GitHub CI checks", description: "Read bounded GitHub check-run conclusions and diagnostic summaries for an explicit ref.", category: "connector", riskLevel: "read_only", readOnly: true, requiresWorkspace: true, source: "connector", tags: ["github", "ci", "checks", "review", "diagnose"] },
      inputSchema: githubRefInputSchema,
      outputSchema: z.object({ repository: z.string(), ref: z.string(), checks: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), url: z.string(), title: z.string(), summary: z.string() })) }),
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable."); const parsed = githubRefInputSchema.parse(input); const repository = await this.githubRepository(workspaceRoot, parsed.remote, signal, progress);
        const response = await this.githubApi<{ check_runs?: Array<{ name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown; output?: { title?: unknown; summary?: unknown } }> }>(`/repos/${repository.owner}/${repository.repo}/commits/${encodeURIComponent(parsed.ref)}/check-runs`, {}, signal);
        return { repository: `${repository.owner}/${repository.repo}`, ref: parsed.ref, checks: (response.check_runs ?? []).slice(0, 100).map((check) => ({ name: String(check.name ?? "check"), status: String(check.status ?? "unknown"), conclusion: check.conclusion == null ? null : String(check.conclusion), url: String(check.html_url ?? "https://github.com"), title: String(check.output?.title ?? "").slice(0, 2_000), summary: String(check.output?.summary ?? "").slice(0, 20_000) })) };
      }
    });

    this.registerTool({
      descriptor: { name: "engineering.review-prepare", title: "Prepare structured code review", description: "Build a bounded review packet from changed files, line counts, whitespace errors, staged or unstaged diff, and nearby tests for model review and CI repair.", category: "execution", riskLevel: "read_only", readOnly: true, requiresWorkspace: true, source: "builtin", tags: ["review", "diff", "ci", "tests", "repository"] },
      inputSchema: gitDiffInputSchema,
      outputSchema: z.object({ staged: z.boolean(), files: z.array(z.string()), testFiles: z.array(z.string()), numstat: z.string(), whitespaceErrors: z.string(), diff: z.string(), truncated: z.boolean() }),
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable."); const parsed = gitDiffInputSchema.parse(input); const prefix = parsed.staged ? ["--cached"] : []; const suffix = parsed.pathspec.length ? ["--", ...parsed.pathspec] : [];
        const run = (args: string[]) => this.commandRunner.run({ command: "git", args, cwd: workspaceRoot, workspaceRoot, mode: "read_only", timeoutMs: 60_000 }, { signal, onProgress: progress });
        const [names, stats, check, diff] = await Promise.all([run(["diff", ...prefix, "--name-only", ...suffix]), run(["diff", ...prefix, "--numstat", ...suffix]), run(["diff", ...prefix, "--check", ...suffix]), run(["diff", ...prefix, "--no-ext-diff", "--no-color", ...suffix])]);
        if (names.exitCode !== 0 || stats.exitCode !== 0 || diff.exitCode !== 0) throw new Error(names.stderr || stats.stderr || diff.stderr || "Git review preparation failed.");
        const files = names.stdout.split(/\r?\n/).filter(Boolean).slice(0, 500); const testFiles = files.filter((path) => /(^|\/)(__tests__|test|tests|spec)(\/|\.|$)|\.(test|spec)\.[^.]+$/i.test(path));
        return { staged: parsed.staged, files, testFiles, numstat: stats.stdout, whitespaceErrors: check.stdout || check.stderr, diff: diff.stdout.slice(0, 900_000), truncated: diff.stdout.length > 900_000 };
      }
    });

    this.registerTool({
      descriptor: { name: "github.pr-review", title: "Submit GitHub pull-request review", description: "Submit an explicit comment, approval, or request-changes review to GitHub.", category: "connector", riskLevel: "external", readOnly: false, requiresWorkspace: true, source: "connector", tags: ["github", "review", "pull-request", "external"] },
      inputSchema: githubReviewInputSchema,
      outputSchema: z.object({ id: z.number().int().positive(), state: z.string(), url: z.string().url() }),
      execute: async ({ workspaceRoot, signal, progress }, input) => {
        if (!workspaceRoot) throw new Error("Workspace root is unavailable."); const parsed = githubReviewInputSchema.parse(input); const repository = await this.githubRepository(workspaceRoot, parsed.remote, signal, progress);
        const result = await this.githubApi<{ id: number; state: string; html_url: string }>(`/repos/${repository.owner}/${repository.repo}/pulls/${parsed.pullNumber}/reviews`, { method: "POST", body: JSON.stringify({ body: parsed.body, event: parsed.event }) }, signal);
        return { id: result.id, state: result.state, url: result.html_url };
      }
    });
  }

  private async githubRepository(workspaceRoot: string, remote: string, signal: AbortSignal, progress: (payload: Record<string, unknown>) => void): Promise<{ owner: string; repo: string }> {
    const result = await this.commandRunner.run({ command: "git", args: ["remote", "get-url", remote], cwd: workspaceRoot, workspaceRoot, mode: "read_only", timeoutMs: 30_000 }, { signal, onProgress: progress });
    if (result.exitCode !== 0) throw new Error(result.stderr || `Git remote ${remote} is unavailable.`);
    const value = result.stdout.trim(); const match = value.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (!match) throw new Error("GitHub workflows require an explicit github.com HTTPS or SSH remote.");
    return { owner: match[1]!, repo: match[2]! };
  }

  private async githubApi<T>(path: string, init: RequestInit, signal: AbortSignal): Promise<T> {
    if (!this.githubToken) throw new Error("GitHub workflows require a protected GitHub token.");
    const response = await fetch(`https://api.github.com${path}`, { ...init, signal, redirect: "error", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.githubToken}`, "content-type": "application/json", "x-github-api-version": "2022-11-28", ...(init.headers ?? {}) } });
    const text = (await response.text()).slice(0, 1_000_000); if (!response.ok) { let message = response.statusText; try { message = String((JSON.parse(text) as { message?: unknown }).message ?? message); } catch {} throw new Error(`GitHub request failed (${response.status}: ${message.slice(0, 2_000)}).`); }
    return JSON.parse(text) as T;
  }

  private registerTool(definition: RuntimeToolDefinition): void {
    const descriptor = RuntimeToolDescriptorSchema.parse(definition.descriptor);
    if (this.tools.has(descriptor.name)) throw new Error(`Tool ${descriptor.name} is already registered.`);
    this.tools.set(descriptor.name, { ...definition, descriptor });
  }

  private async verifyMutation(definition: RuntimeToolDefinition, context: RuntimeToolContext, input: Record<string, unknown>, output: Record<string, unknown>): Promise<{ method: string; evidence: unknown }> {
    if (definition.verify) return definition.verify(context, input, output);
    const root = context.workspaceRoot;
    const tool = definition.descriptor.name;
    if (root && tool === "workspace.write") {
      const path = resolveExistingPath(root, String(output.path));
      const content = this.readMutationText(path);
      if (content !== String(input.content ?? "")) throw new Error("Workspace write read-back verification failed.");
      return { method: "filesystem-content-readback", evidence: { path: output.path, sha256: createHash("sha256").update(content).digest("hex") } };
    }
    if (root && (tool === "workspace.delete" || tool === "workspace.rmdir")) {
      const path = resolve(root, String(output.path));
      if (!isWithin(root, path) || existsSync(path)) throw new Error("Workspace deletion read-back verification failed.");
      return { method: "filesystem-absence-readback", evidence: { path: output.path } };
    }
    if (root && tool === "workspace.mkdir") {
      const path = resolveExistingPath(root, String(output.path));
      if (!statSync(path).isDirectory()) throw new Error("Workspace directory read-back verification failed.");
      return { method: "filesystem-directory-readback", evidence: { path: output.path } };
    }
    if (root && tool === "workspace.patch") {
      const path = resolveExistingPath(root, String(output.path));
      const sha256 = createHash("sha256").update(this.readMutationText(path)).digest("hex");
      if (sha256 !== output.sha256) throw new Error("Workspace patch read-back verification failed.");
      return { method: "filesystem-digest-readback", evidence: { path: output.path, sha256 } };
    }
    if (root && tool === "workspace.move") {
      const from = resolve(root, String(output.from));
      const to = resolve(root, String(output.to));
      if (!isWithin(root, from) || !isWithin(root, to) || existsSync(from) || !existsSync(to)) throw new Error("Workspace move read-back verification failed.");
      return { method: "filesystem-move-readback", evidence: { from: output.from, to: output.to } };
    }
    if (tool === "workspace.undo") {
      const mutation = this.database.getWorkspaceMutation(String(output.mutationId));
      if (!mutation?.undoneAt || output.restored !== true) throw new Error("Workspace undo read-back verification failed.");
      return { method: "mutation-journal-readback", evidence: { mutationId: mutation.id, undoneAt: mutation.undoneAt } };
    }
    if (tool === "tools.activate") {
      const descriptor = output.descriptor as Record<string, unknown> | undefined;
      const name = String(descriptor?.name ?? "");
      if (!name || !this.tools.has(name)) throw new Error("Deferred tool activation verification failed.");
      return { method: "tool-registry-readback", evidence: { name } };
    }
    if (tool === "execution.start-background") {
      const process = this.backgroundProcesses.get(String(output.processId));
      if (!process || process.sessionId !== context.session.id) throw new Error("Background process read-back verification failed.");
      return { method: "process-supervisor-readback", evidence: { processId: output.processId, pid: output.pid } };
    }
    if (tool === "execution.process-write" || tool === "execution.process-stop") {
      const process = this.requireBackgroundProcess(context.session.id, String(output.processId));
      return { method: "process-supervisor-readback", evidence: { processId: output.processId, status: process.status, stopRequested: process.stopRequested, bytes: output.bytes } };
    }
    if (tool === "execution.run") return { method: "sandbox-process-exit", evidence: { command: output.command, exitCode: output.exitCode, signal: output.signal } };
    if (root && tool === "git.worktree-create") {
      const path = resolve(root, String(output.path));
      if (!isWithin(root, path) || !existsSync(path) || !existsSync(resolve(path, ".git"))) throw new Error("Git worktree read-back verification failed.");
      return { method: "git-worktree-readback", evidence: { branch: output.branch, path: output.path } };
    }
    if (root && tool === "git.stage") {
      const parsed = gitStageInputSchema.parse(input);
      const snapshot = await this.commandRunner.run({ command: "git", args: ["diff", "--cached", "--name-only", "--", ...parsed.pathspec], cwd: root, workspaceRoot: root, mode: "read_only", timeoutMs: 30_000 }, { signal: context.signal, onProgress: context.progress });
      if (snapshot.exitCode !== 0) throw new Error(snapshot.stderr || "Git index read-back verification failed.");
      return { method: "git-index-readback", evidence: { pathspec: parsed.pathspec, stagedPaths: snapshot.stdout.trim().split("\n").filter(Boolean) } };
    }
    if (root && tool === "git.branch-create") {
      const branch = String(output.branch);
      const snapshot = await this.commandRunner.run({ command: "git", args: ["rev-parse", `refs/heads/${branch}`], cwd: root, workspaceRoot: root, mode: "read_only", timeoutMs: 30_000 }, { signal: context.signal, onProgress: context.progress });
      if (snapshot.exitCode !== 0 || !snapshot.stdout.trim()) throw new Error(snapshot.stderr || "Git branch read-back verification failed.");
      return { method: "git-reference-readback", evidence: { branch, commitId: snapshot.stdout.trim() } };
    }
    if (root && tool === "git.commit") {
      const snapshot = await this.commandRunner.run({ command: "git", args: ["rev-parse", "HEAD"], cwd: root, workspaceRoot: root, mode: "read_only", timeoutMs: 30_000 }, { signal: context.signal, onProgress: context.progress });
      if (snapshot.exitCode !== 0 || snapshot.stdout.trim() !== output.commitId) throw new Error(snapshot.stderr || "Git commit read-back verification failed.");
      return { method: "git-commit-readback", evidence: { commitId: output.commitId } };
    }
    return { method: `${definition.descriptor.source}-typed-receipt`, evidence: output };
  }

  private loadInstructions(workspaceRoot: string, targetPath?: string): Array<{ path: string; content: string; precedence: number }> {
    const resolvedTarget = targetPath ? resolveExistingPath(workspaceRoot, targetPath) : workspaceRoot;
    const targetDirectory = statSync(resolvedTarget).isDirectory() ? resolvedTarget : dirname(resolvedTarget);
    const relativeDirectory = relative(workspaceRoot, targetDirectory);
    const directories = [workspaceRoot];
    if (relativeDirectory) {
      let current = workspaceRoot;
      for (const segment of relativeDirectory.split(sep)) {
        current = resolve(current, segment);
        directories.push(current);
      }
    }
    const names = ["AGENTS.md", "CLAUDE.md", "HERMES.md", ".kestrel/instructions.md"];
    const instructions: Array<{ path: string; content: string; precedence: number }> = [];
    for (const directory of directories) {
      for (const name of names) {
        const candidate = resolve(directory, name);
        if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
        const canonical = realpathSync(candidate);
        if (!isWithin(workspaceRoot, canonical)) continue;
        const text = textFile(canonical, 256_000);
        if (!text) continue;
        instructions.push({ path: relative(workspaceRoot, canonical), content: text.content, precedence: instructions.length });
      }
    }
    return instructions;
  }

  private readMutationText(path: string): string {
    if (statSync(path).size > 1_000_000) throw new Error("Workspace mutation files are limited to 1 MB.");
    const buffer = readFileSync(path);
    if (buffer.includes(0)) throw new Error("Binary workspace mutations are not supported.");
    return buffer.toString("utf8");
  }

  private approvalPreview(session: RuntimeSession, toolName: string, input: Record<string, unknown>): string {
    if (
      (toolName === "agent.config.apply" ||
        toolName === "agent.config.rollback") &&
      typeof input.preview === "string"
    )
      return input.preview.slice(0, 20_000);
    if (!session.workspaceRoot || !toolName.startsWith("workspace.")) return JSON.stringify(input, null, 2).slice(0, 20_000);
    try {
      if (toolName === "workspace.move") return `Move ${String(input.from)} → ${String(input.to)}`;
      if (toolName === "workspace.rmdir") return `Delete empty directory ${String(input.path)}`;
      const relativePath = String(input.path ?? "");
      const path = resolveWritablePath(session.workspaceRoot, relativePath);
      const before = existsSync(path) && statSync(path).isFile() ? this.readMutationText(path) : "";
      let after = before;
      if (toolName === "workspace.write") after = String(input.content ?? "");
      else if (toolName === "workspace.delete") after = "";
      else if (toolName === "workspace.patch" && Array.isArray(input.edits)) {
        for (const edit of input.edits as Array<Record<string, unknown>>) {
          const oldText = String(edit.oldText ?? "");
          const newText = String(edit.newText ?? "");
          after = edit.replaceAll ? after.split(oldText).join(newText) : after.replace(oldText, newText);
        }
      } else return JSON.stringify(input, null, 2).slice(0, 20_000);
      const removed = before.split(/\r?\n/).slice(0, 120).map((line) => `-${line}`);
      const added = after.split(/\r?\n/).slice(0, 120).map((line) => `+${line}`);
      return [`--- ${relativePath}`, `+++ ${relativePath}`, ...removed, ...added].join("\n").slice(0, 20_000);
    } catch {
      return JSON.stringify(input, null, 2).slice(0, 20_000);
    }
  }

  private validOneTimeApprovalGrant(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    executionId?: string,
  ): RuntimeToolExecution | undefined {
    if (!executionId) return undefined;
    const blocked = this.database.getToolExecution(executionId);
    return blocked &&
      blocked.sessionId === sessionId &&
      blocked.toolName === toolName &&
      blocked.status === "blocked" &&
      blocked.output?.approvalRequired === true &&
      blocked.output?.persistentApprovalAllowed === false &&
      JSON.stringify(blocked.input) === JSON.stringify(input)
      ? blocked
      : undefined;
  }

  private requireBackgroundProcess(sessionId: string, processId: string) {
    const process = this.backgroundProcesses.get(processId);
    if (!process || process.sessionId !== sessionId) throw new Error("Background process not found in this session.");
    return process;
  }

  private backgroundProcessSnapshot(sessionId: string, processId: string) {
    const process = this.backgroundProcesses.get(processId);
    if (!process) {
      const journal = this.processJournal(processId);
      if (!journal || journal.sessionId !== sessionId) throw new Error("Background process not found in this session.");
      return { processId, pid: Number(journal.pid ?? 0), status: String(journal.status), ...(journal.exitCode !== undefined ? { exitCode: Number(journal.exitCode) } : {}), ...(journal.signal !== undefined ? { signal: journal.signal as string | null } : {}), stdout: String(journal.stdout ?? ""), stderr: String(journal.stderr ?? ""), durationMs: Number(journal.durationMs ?? 0), ...(journal.error ? { error: String(journal.error) } : {}) };
    }
    if (process.sessionId !== sessionId) throw new Error("Background process not found in this session.");
    const snapshot = process.handle.snapshot();
    const existing = this.processJournal(processId);
    this.saveProcessJournal({ ...(existing ?? {}), processId, sessionId, pid: process.handle.pid, status: process.status, stdout: snapshot.stdout, stderr: snapshot.stderr, durationMs: snapshot.durationMs, ...(process.exitCode !== undefined ? { exitCode: process.exitCode } : {}), ...(process.signal !== undefined ? { signal: process.signal } : {}), ...(process.error ? { error: process.error } : {}), updatedAt: this.now() });
    return {
      processId,
      pid: process.handle.pid,
      status: process.status,
      ...(process.exitCode !== undefined ? { exitCode: process.exitCode } : {}),
      ...(process.signal !== undefined ? { signal: process.signal } : {}),
      stdout: snapshot.stdout,
      stderr: snapshot.stderr,
      durationMs: snapshot.durationMs,
      ...(process.error ? { error: process.error } : {})
    };
  }

  private processJournal(processId: string): Record<string, unknown> | undefined { return (this.database.getPrivateState<Array<Record<string, unknown>>>(this.processJournalKey) ?? []).find((process) => process.processId === processId); }

  private saveProcessJournal(record: Record<string, unknown>): void {
    const records = this.database.getPrivateState<Array<Record<string, unknown>>>(this.processJournalKey) ?? [];
    this.database.setPrivateState(this.processJournalKey, [...records.filter((process) => process.processId !== record.processId), record].slice(-200));
  }

  private writeTextAtomically(path: string, content: string): void {
    const temporaryPath = resolve(dirname(path), `.kestrel-write-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, path);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  private emitRuntimeEvent(
    type: RuntimeEvent["type"],
    sessionId: string,
    payload: Record<string, unknown>,
    references: { executionId?: string; messageId?: string } = {}
  ): void {
    const event = RuntimeEventSchema.parse({
      id: `event-${randomUUID()}`,
      type,
      sessionId,
      ...(references.executionId ? { executionId: references.executionId } : {}),
      ...(references.messageId ? { messageId: references.messageId } : {}),
      payload,
      createdAt: this.now()
    });
    this.emit("event", event);
  }

  private resolveGrantedRoot(requestedRoot: string): string {
    const candidate = realpathSync(requestedRoot);
    const granted = this.workspaceRoots.find((root) => isWithin(root, candidate));
    if (!granted) throw new Error("Workspace access has not been granted for this root.");
    return candidate;
  }

  private resolveActiveWorkspaceRoot(session: RuntimeSession): string | undefined {
    if (!session.workspaceRoot) return undefined;
    try {
      const candidate = realpathSync(session.workspaceRoot);
      return this.workspaceRoots.some((root) => isWithin(root, candidate))
        ? candidate
        : undefined;
    } catch {
      return undefined;
    }
  }

  private reconcilePersistedWorkspaceRoots(): void {
    for (const session of this.database.listRuntimeSessions()) {
      if (!session.workspaceRoot) continue;
      const candidate = resolve(session.workspaceRoot);
      if (
        this.configuredWorkspaceRoots.some((root) =>
          isWithin(root, candidate),
        )
      )
        continue;
      const detached = { ...session };
      delete detached.workspaceRoot;
      this.database.saveRuntimeSession(detached);
    }
  }

  private requireSession(id: string): RuntimeSession {
    const session = this.database.getRuntimeSession(id);
    if (!session) throw new Error("Runtime session not found.");
    return session;
  }

  private saveSession(session: RuntimeSession): RuntimeSession {
    const parsed = RuntimeSessionSchema.parse(session);
    this.database.saveRuntimeSession(parsed);
    return parsed;
  }

  private async runHooks(event: RuntimeHookEvent, session: RuntimeSession, tool: RuntimeToolDescriptor, execution: RuntimeToolExecution): Promise<RuntimeHookResult> {
    for (const hook of this.hooks) {
      if (hook.event !== event || (hook.toolPattern && !hook.toolPattern.test(tool.name))) continue;
      const result = await hook.run({ event, session, tool, execution });
      if (result.blocked) return result;
    }
    return {};
  }
}
