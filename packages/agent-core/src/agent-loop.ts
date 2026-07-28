import { randomUUID } from "node:crypto";
import type { AgentRun, ModelCallAudit, RuntimeMessage, RuntimeToolExecution } from "@kestrel/shared-types";
import type { KestrelDatabase } from "@kestrel/database";
import { ContextCompactor } from "./context-compactor";
import { UsageGovernor } from "./usage-governor";
import { AgentRuntime } from "./runtime";
import {
  ProviderPool,
  ProviderPoolError,
  contentText,
  textContent,
  type ModelContentPart,
  type ModelMessage,
  type ModelResult,
  type ProviderAttempt
} from "./providers";

const CREDENTIAL_BOUNDARY_INSTRUCTIONS = "Never ask the user to paste API keys, OAuth tokens, passwords, session cookies, private keys, or other secrets into chat. Direct credential entry to the product's protected native credential field or the provider's own OAuth or device-login surface. You may explain what a credential enables and verify only non-secret connection status.";
export const LOCAL_FIRST_TOOL_INSTRUCTIONS = "Prefer self-contained local capability before any external tool or hosted service. Inspect existing conversation, workspace files, local memory, and local runtime tools first. For interactive web research, prefer Kestrel's isolated on-device browser over a hosted search API when direct navigation can satisfy the request. Use web.search, hosted transcription, remote execution, or another external service only when local capability cannot complete the request and the user has explicitly enabled that fallback. Make the external boundary visible; never imply that network-derived content or hosted processing happened locally.";

export interface AgentLoopInput {
  sessionId: string;
  model: string;
  providerIds: string[];
  providerModels?: Record<string, string>;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  serviceTier?: "standard" | "priority";
  allowedTools?: string[];
  userContent: ModelContentPart[];
  instructions?: string;
  targetPath?: string;
  maximumTurns?: number;
  maximumContextCharacters?: number;
  approvalStatus?: "pending" | "approved";
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  takeSteering?: () => string[];
}

export interface AgentLoopResult {
  run: AgentRun;
  assistantMessage?: RuntimeMessage;
  pendingExecution?: RuntimeToolExecution;
  modelResult?: ModelResult;
  compactedMessages: number;
}

export interface AgentLoopResumeInput {
  runId: string;
  approvalDecision: "approved" | "rejected";
  maximumTurns?: number;
  maximumContextCharacters?: number;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  takeSteering?: () => string[];
}

function transcriptContent(parts: ModelContentPart[]): string {
  const text = contentText(parts).trim();
  const attachments = parts.filter((part) => part.type !== "text")
    .map((part) => `[${part.type} attachment: ${part.mediaType}]`);
  return [text, ...attachments].filter(Boolean).join("\n") || "[Empty multimodal message]";
}

function durationMs(startedAt: string, completedAt: string): number {
  return Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
}

export class AgentLoop {
  private readonly compactor = new ContextCompactor();
  private readonly usageGovernor: UsageGovernor;
  private readonly resumingRunIds = new Set<string>();

  constructor(
    private readonly database: KestrelDatabase,
    private readonly runtime: AgentRuntime,
    private readonly providers: ProviderPool,
    private readonly now: () => Date = () => new Date(),
    private readonly onMessage?: (message: RuntimeMessage) => void,
    usageGovernor?: UsageGovernor,
    private readonly providerAllowed?: (providerId: string, poolId?: string) => boolean
  ) { this.usageGovernor = usageGovernor ?? new UsageGovernor(database, now); }

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    const session = this.runtime.getSession(input.sessionId);
    if (session.status !== "active") throw new Error(`Session ${session.id} is ${session.status}.`);
    if (input.providerIds.length === 0) throw new Error("At least one model provider is required.");
    const messageCountBefore = this.runtime.listMessages(session.id).length;
    const mutationIdsBefore = this.database.listWorkspaceMutationIds(session.id);
    const createdAt = this.now().toISOString();
    let run: AgentRun = {
      id: `run-${randomUUID()}`,
      sessionId: session.id,
      model: input.model,
      providerIds: input.providerIds,
      ...(input.providerModels ? { providerModels: input.providerModels } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
      ...(input.allowedTools ? { toolScope: input.allowedTools } : {}),
      status: "running",
      turn: 0,
      createdAt,
      updatedAt: createdAt
    };
    this.database.saveAgentRun(run);

    const instructions = [
      CREDENTIAL_BOUNDARY_INSTRUCTIONS,
      LOCAL_FIRST_TOOL_INSTRUCTIONS,
      input.instructions,
      ...this.runtime.workspaceInstructions(session.id, input.targetPath)
        .map((item) => `Instructions from ${item.path} (precedence ${item.precedence}):\n${item.content}`)
    ].filter((value): value is string => Boolean(value));
    if (instructions.length) this.runtime.appendMessage({ sessionId: session.id, role: "system", content: instructions.join("\n\n") });
    const userMessage = this.runtime.appendMessage({ sessionId: session.id, role: "user", content: transcriptContent(input.userContent) });
    this.database.setPrivateState(`agent-run-baseline.${run.id}`, {
      sessionId: session.id,
      userMessageId: userMessage.id,
      messageCount: messageCountBefore,
      mutationIds: mutationIdsBefore
    });
    this.onMessage?.(userMessage);
    const compacted = this.compactor.compact(
      this.runtime.listMessages(session.id),
      session.checkpoints,
      { maximumCharacters: input.maximumContextCharacters ?? 120_000 }
    );
    this.database.setPrivateState(`agent-run-compaction.${run.id}`, { sessionId: session.id, removedMessages: compacted.removedMessages, estimatedCharacters: compacted.estimatedCharacters });
    const modelMessages: ModelMessage[] = [...compacted.messages];
    let lastUser = -1;
    for (let index = modelMessages.length - 1; index >= 0; index -= 1) {
      if (modelMessages[index]?.role === "user") {
        lastUser = index;
        break;
      }
    }
    if (lastUser >= 0) modelMessages[lastUser] = { role: "user", content: input.userContent };
    return this.continueRun(run, modelMessages, compacted.removedMessages, {
      maximumTurns: input.maximumTurns ?? 12,
      approvalStatus: input.approvalStatus ?? "pending",
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
      ...(input.takeSteering ? { takeSteering: input.takeSteering } : {})
    });
  }

  async resume(input: AgentLoopResumeInput): Promise<AgentLoopResult> {
    if (this.resumingRunIds.has(input.runId))
      throw new Error("Agent run approval is already being resolved.");
    this.resumingRunIds.add(input.runId);
    try {
      let run = this.database.getAgentRun(input.runId);
      if (!run) throw new Error("Agent run not found.");
      if (run.status !== "waiting_approval" || !run.pendingToolExecutionId || !run.pendingProviderToolCallId || !run.pendingToolName) {
        throw new Error("Agent run is not waiting at an approval boundary.");
      }
      const blocked = this.database.getToolExecution(run.pendingToolExecutionId);
      if (!blocked) throw new Error("Pending tool execution was not found.");
      let execution: RuntimeToolExecution;
      if (input.approvalDecision === "rejected") {
        execution = { ...blocked, status: "cancelled", error: "The user denied this tool call.", completedAt: this.now().toISOString() };
        this.database.saveToolExecution(execution);
      } else if (input.approvalDecision === "approved") {
        execution = await this.runtime.callTool(run.sessionId, run.pendingToolName, blocked.input, {
          approvalStatus: "approved",
          idempotencyKey: `${run.id}:${run.pendingProviderToolCallId}`
        });
        if (execution.status !== "verified") throw new Error(execution.error ?? "Approved tool execution did not complete.");
      } else {
        throw new Error("An explicit approval decision is required.");
      }
      const content = JSON.stringify({ status: execution.status, output: execution.output, error: execution.error });
      this.runtime.appendMessage({
        sessionId: run.sessionId,
        role: "tool",
        content,
        toolExecutionId: execution.id,
        providerToolCallId: run.pendingProviderToolCallId,
        toolName: run.pendingToolName
      });
      this.appendDeferredToolCancellations(
        run.sessionId,
        run.pendingProviderToolCallId,
      );
      const { pendingToolExecutionId: _execution, pendingProviderToolCallId: _call, pendingToolName: _tool, ...base } = run;
      run = { ...base, status: "running", updatedAt: this.now().toISOString() };
      this.database.saveAgentRun(run);
      const session = this.runtime.getSession(run.sessionId);
      const compacted = this.compactor.compact(this.runtime.listMessages(run.sessionId), session.checkpoints, {
        maximumCharacters: input.maximumContextCharacters ?? 120_000
      });
      const priorCompaction = this.database.getPrivateState<{ removedMessages: number }>(`agent-run-compaction.${run.id}`);
      this.database.setPrivateState(`agent-run-compaction.${run.id}`, { sessionId: run.sessionId, removedMessages: Math.max(priorCompaction?.removedMessages ?? 0, compacted.removedMessages), estimatedCharacters: compacted.estimatedCharacters });
      const configuredMaximumTurns = input.maximumTurns ?? 12;
      return await this.continueRun(run, compacted.messages, compacted.removedMessages, {
        maximumTurns: Math.max(configuredMaximumTurns, run.turn + 1),
        approvalStatus: "pending",
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
        ...(input.takeSteering ? { takeSteering: input.takeSteering } : {})
      });
    } finally {
      this.resumingRunIds.delete(input.runId);
    }
  }

  private async continueRun(
    initialRun: AgentRun,
    initialMessages: ModelMessage[],
    compactedMessages: number,
    options: { maximumTurns: number; approvalStatus: "pending" | "approved"; signal?: AbortSignal; onTextDelta?: (delta: string) => void; takeSteering?: () => string[] }
  ): Promise<AgentLoopResult> {
    let run = initialRun;
    let modelMessages = initialMessages;
    const session = this.runtime.getSession(run.sessionId);
    const modelToolDefinitions = this.runtime.modelTools(session.id).filter(({ descriptor }) => !run.toolScope || run.toolScope.includes(descriptor.name));
    const tools = modelToolDefinitions.map(({ descriptor, inputSchema }) => ({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema
    }));
    const descriptors = new Map(modelToolDefinitions.map((tool) => [tool.descriptor.name, tool.descriptor]));
    let untrustedExternalContent = "";
    try {
      for (let turn = run.turn + 1; turn <= options.maximumTurns; turn += 1) {
        if (options.signal?.aborted) throw options.signal.reason;
        run = { ...run, turn, updatedAt: this.now().toISOString() };
        this.database.saveAgentRun(run);
        const workspaceRoot = this.runtime.activeWorkspaceRoot(session.id);
        let poolResult;
        const lease = this.usageGovernor.acquire();
        try {
          poolResult = await this.providers.complete({ model: run.model, messages: modelMessages, tools, metadata: { session_id: session.id, ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}) }, ...(run.reasoningEffort ? { reasoningEffort: run.reasoningEffort } : {}), ...(run.serviceTier ? { serviceTier: run.serviceTier } : {}) }, {
            ...(run.providerIds.includes("auto") ? {} : { providerIds: run.providerIds }),
            automaticRouting: run.providerIds.includes("auto"),
            ...(run.providerModels ? { providerModels: run.providerModels } : {}),
            costScore: (providerId, model) => this.usageGovernor.routingCostScore(providerId, model),
            canAttempt: (_providerId, _model, attemptIndex) => this.usageGovernor.canAttempt(attemptIndex),
            ...(this.providerAllowed ? { providerAllowed: this.providerAllowed } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            onEvent: (event) => {
              if (event.type === "text_delta") options.onTextDelta?.(event.delta);
            }
          });
        } catch (error) {
          if (error instanceof ProviderPoolError) this.saveAttemptAudits(run, run.model, error.attempts);
          throw error;
        } finally {
          lease.release();
        }
        this.saveAttemptAudits(run, run.model, poolResult.attempts, poolResult.result);
        const result = poolResult.result;
        const assistantContent = result.text.trim() || `Requested tools: ${result.toolCalls.map((call) => call.name).join(", ")}`;
        const assistantMessage = this.runtime.appendMessage({
          sessionId: session.id,
          role: "assistant",
          content: assistantContent,
          ...(result.toolCalls.length ? { modelToolCalls: result.toolCalls } : {})
        });
        this.onMessage?.(assistantMessage);
        modelMessages = [...modelMessages, { role: "assistant", content: textContent(result.text), ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}) }];

        const consumeSteering = () => {
          const steering = options.takeSteering?.().map((message) => message.trim()).filter(Boolean) ?? [];
          for (const message of steering) {
            const appended = this.runtime.appendMessage({ sessionId: session.id, role: "user", content: message });
            this.onMessage?.(appended);
            modelMessages.push({ role: "user", content: textContent(message) });
          }
          return steering.length;
        };

        if (result.toolCalls.length === 0) {
          if (consumeSteering() > 0) continue;
          run = { ...run, status: "completed", updatedAt: this.now().toISOString() };
          this.database.saveAgentRun(run);
          return { run, assistantMessage, modelResult: result, compactedMessages };
        }

        for (const call of result.toolCalls) {
          const descriptor = descriptors.get(call.name);
          if (!descriptor) {
            const content = JSON.stringify({ status: "failed", error: `Tool ${call.name} is unavailable.` });
            this.runtime.appendMessage({ sessionId: session.id, role: "tool", content, providerToolCallId: call.id, toolName: call.name });
            modelMessages.push({ role: "tool", content: textContent(content), toolCallId: call.id, toolName: call.name });
            continue;
          }
          const execution = await this.runtime.callTool(session.id, call.name, call.arguments, {
            approvalStatus: options.approvalStatus,
            idempotencyKey: `${run.id}:${call.id}`,
            ...(!descriptor.readOnly && untrustedExternalContent ? { externalContent: untrustedExternalContent } : {})
          });
          if (execution.status === "blocked") {
            if (execution.output?.approvalRequired === true) {
              run = {
                ...run,
                status: "waiting_approval",
                pendingToolExecutionId: execution.id,
                pendingProviderToolCallId: call.id,
                pendingToolName: call.name,
                updatedAt: this.now().toISOString()
              };
              this.database.saveAgentRun(run);
              return { run, assistantMessage, pendingExecution: execution, modelResult: result, compactedMessages };
            }
            const content = JSON.stringify({ status: execution.status, output: execution.output, error: execution.error });
            this.runtime.appendMessage({ sessionId: session.id, role: "tool", content, toolExecutionId: execution.id, providerToolCallId: call.id, toolName: call.name });
            modelMessages.push({ role: "tool", content: textContent(content), toolCallId: call.id, toolName: call.name });
            continue;
          }
          const content = JSON.stringify({ status: execution.status, output: execution.output, error: execution.error });
          if (execution.status === "verified" && (descriptor.category === "web" || descriptor.category === "browser" || descriptor.source === "mcp" || (execution.output as Record<string, unknown> | undefined)?.trust === "untrusted_external")) {
            untrustedExternalContent = `${untrustedExternalContent}\n${JSON.stringify(execution.output ?? {})}`.slice(-100_000);
          }
          this.runtime.appendMessage({
            sessionId: session.id,
            role: "tool",
            content,
            toolExecutionId: execution.id,
            providerToolCallId: call.id,
            toolName: call.name
          });
          modelMessages.push({ role: "tool", content: textContent(content), toolCallId: call.id, toolName: call.name });
        }
        consumeSteering();
      }
      throw new Error(`Agent loop reached its maximum of ${options.maximumTurns} model turns.`);
    } catch (error) {
      const cancelled = options.signal?.aborted === true;
      run = {
        ...run,
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? "Cancelled by the user." : "Model or agent execution failed.",
        updatedAt: this.now().toISOString()
      };
      this.database.saveAgentRun(run);
      throw error;
    }
  }

  private appendDeferredToolCancellations(
    sessionId: string,
    pendingProviderToolCallId: string,
  ): void {
    const messages = this.runtime.listMessages(sessionId);
    const assistant = [...messages].reverse().find(
      (message) =>
        message.role === "assistant" &&
        message.modelToolCalls?.some(
          (call) => call.id === pendingProviderToolCallId,
        ),
    );
    const pendingIndex = assistant?.modelToolCalls?.findIndex(
      (call) => call.id === pendingProviderToolCallId,
    ) ?? -1;
    if (!assistant?.modelToolCalls || pendingIndex < 0) return;
    const assistantMessageIndex = messages.findIndex(
      (message) => message.id === assistant.id,
    );
    const resolved = new Set<string>();
    for (const message of messages.slice(assistantMessageIndex + 1)) {
      if (message.role !== "tool") break;
      if (message.providerToolCallId)
        resolved.add(message.providerToolCallId);
    }
    for (const deferred of assistant.modelToolCalls.slice(pendingIndex + 1)) {
      if (resolved.has(deferred.id)) continue;
      this.runtime.appendMessage({
        sessionId,
        role: "tool",
        content: JSON.stringify({
          status: "cancelled",
          error:
            "Deferred because an earlier tool call required user approval. Request this tool again if it is still needed.",
        }),
        providerToolCallId: deferred.id,
        toolName: deferred.name,
      });
      resolved.add(deferred.id);
    }
  }

  private saveAttemptAudits(run: AgentRun, model: string, attempts: ProviderAttempt[], result?: ModelResult): void {
    for (const attempt of attempts) {
      const winning = attempt.status === "completed" && attempt.providerId === result?.providerId;
      const audit: ModelCallAudit = {
        id: `model-call-${randomUUID()}`,
        runId: run.id,
        sessionId: run.sessionId,
        providerId: attempt.providerId,
        model: winning ? result.model : model,
        status: attempt.status,
        inputTokens: winning ? result.usage.inputTokens : 0,
        outputTokens: winning ? result.usage.outputTokens : 0,
        ...(winning && result.usage.cachedInputTokens !== undefined ? { cachedInputTokens: result.usage.cachedInputTokens } : {}),
        ...(winning && result.usage.reasoningTokens !== undefined ? { reasoningTokens: result.usage.reasoningTokens } : {}),
        estimatedCostUsd: winning ? this.usageGovernor.estimateCost(attempt.providerId, result.model, result.usage) : 0,
        durationMs: durationMs(attempt.startedAt, attempt.completedAt),
        ...(attempt.status === "failed" ? { error: "Provider attempt failed." } : {}),
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt
      };
      this.database.saveModelCallAudit(audit);
    }
  }
}
