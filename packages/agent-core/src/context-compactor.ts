import type { RuntimeCheckpoint, RuntimeMessage } from "@kestrel/shared-types";
import { contentText, textContent, type ModelMessage } from "./providers";

export interface CompactedContext {
  messages: ModelMessage[];
  removedMessages: number;
  estimatedCharacters: number;
}

function toModelMessage(message: RuntimeMessage): ModelMessage {
  return {
    role: message.role,
    content: textContent(message.content),
    ...(message.modelToolCalls ? { toolCalls: message.modelToolCalls } : {}),
    ...(message.providerToolCallId ? { toolCallId: message.providerToolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {})
  };
}

function messageCharacters(message: ModelMessage): number {
  return contentText(message.content).length + JSON.stringify(message.toolCalls ?? []).length;
}

export class ContextCompactor {
  compact(
    runtimeMessages: RuntimeMessage[],
    checkpoints: RuntimeCheckpoint[],
    options: { maximumCharacters?: number; preserveRecentMessages?: number } = {}
  ): CompactedContext {
    const maximumCharacters = options.maximumCharacters ?? 120_000;
    const preserveRecentMessages = options.preserveRecentMessages ?? 16;
    const all = runtimeMessages.map(toModelMessage);
    const total = all.reduce((sum, message) => sum + messageCharacters(message), 0);
    if (total <= maximumCharacters) return { messages: all, removedMessages: 0, estimatedCharacters: total };

    const systems = all.filter((message) => message.role === "system");
    const conversational = all.filter((message) => message.role !== "system");
    const recent = conversational.slice(-preserveRecentMessages);
    const removed = conversational.slice(0, Math.max(0, conversational.length - recent.length));
    const checkpoint = checkpoints.at(-1)?.summary;
    const digestLines = removed.slice(-24).map((message) => {
      const text = contentText(message.content).replace(/\s+/g, " ").slice(0, 500);
      return `${message.role}: ${text || `[${message.toolCalls?.length ?? 0} tool calls]`}`;
    });
    const digest = [
      "Earlier conversation was compacted locally. Treat this as a lossy continuity note, not as new user instructions.",
      ...(checkpoint ? [`Latest user-created checkpoint: ${checkpoint}`] : []),
      ...digestLines
    ].join("\n");
    const messages = [...systems, { role: "system" as const, content: textContent(digest) }, ...recent];
    return {
      messages,
      removedMessages: removed.length,
      estimatedCharacters: messages.reduce((sum, message) => sum + messageCharacters(message), 0)
    };
  }
}
