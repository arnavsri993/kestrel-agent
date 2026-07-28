import type { RuntimeCheckpoint, RuntimeMessage } from "@kestrel/shared-types";
import { contentText, textContent, type ModelMessage } from "./providers";

export interface CompactedContext {
  messages: ModelMessage[];
  removedMessages: number;
  estimatedCharacters: number;
}

interface IndexedMessage {
  message: ModelMessage;
  sourceIndex: number;
}

interface MessageGroup {
  entries: IndexedMessage[];
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

function groupCharacters(group: MessageGroup): number {
  return group.entries.reduce((sum, entry) => sum + messageCharacters(entry.message), 0);
}

function normalizedSystemKey(message: ModelMessage): string {
  const text = contentText(message.content).trim().replace(/\s+/g, " ");
  return `${text}\n${JSON.stringify(message.toolCalls ?? [])}`;
}

function uniqueSystemMessages(messages: IndexedMessage[]): IndexedMessage[] {
  const seen = new Set<string>();
  const unique: IndexedMessage[] = [];
  for (const entry of [...messages].reverse()) {
    if (entry.message.role !== "system") continue;
    const key = normalizedSystemKey(entry.message);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.reverse();
}

function atomicConversationGroups(messages: IndexedMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (let index = 0; index < messages.length;) {
    const entry = messages[index]!;
    if (entry.message.role === "system" || entry.message.role === "tool") {
      index += 1;
      continue;
    }
    if (entry.message.role !== "assistant" || !entry.message.toolCalls?.length) {
      groups.push({ entries: [entry] });
      index += 1;
      continue;
    }

    const toolCallIds = new Set(entry.message.toolCalls.map((call) => call.id));
    const entries = [entry];
    const matchedToolCallIds = new Set<string>();
    let cursor = index + 1;
    while (messages[cursor]?.message.role === "tool") {
      const tool = messages[cursor]!;
      if (tool.message.toolCallId && toolCallIds.has(tool.message.toolCallId)) {
        entries.push(tool);
        matchedToolCallIds.add(tool.message.toolCallId);
      }
      cursor += 1;
    }
    // Provider protocols require one result for every declared tool call. A
    // crash or legacy transcript may contain only a partial batch; dropping
    // the whole incomplete exchange is safer than sending invalid context.
    if ([...toolCallIds].every((id) => matchedToolCallIds.has(id)))
      groups.push({ entries });
    index = cursor;
  }
  return groups;
}

function boundedText(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  if (maximumCharacters <= 0) return "";
  const suffix = "\n[…truncated]";
  if (maximumCharacters <= suffix.length + 16) return value.slice(0, maximumCharacters);
  return `${value.slice(0, maximumCharacters - suffix.length)}${suffix}`;
}

function fitMessage(message: ModelMessage, maximumCharacters: number): ModelMessage | undefined {
  const characters = messageCharacters(message);
  if (characters <= maximumCharacters) return message;
  const metadataCharacters = JSON.stringify(message.toolCalls ?? []).length;
  const contentCharacters = maximumCharacters - metadataCharacters;
  if (contentCharacters <= 0) return undefined;
  return {
    ...message,
    content: textContent(boundedText(contentText(message.content), contentCharacters))
  };
}

function digestText(removedGroups: MessageGroup[]): string {
  const removedMessages = removedGroups.flatMap((group) =>
    group.entries.map((entry) => entry.message)
  );
  const roleCounts = removedMessages.reduce(
    (counts, message) => {
      counts[message.role] += 1;
      return counts;
    },
    { system: 0, user: 0, assistant: 0, tool: 0 }
  );
  const toolCalls = removedMessages.reduce(
    (count, message) => count + (message.toolCalls?.length ?? 0),
    0
  );
  return [
    "Earlier conversation was compacted locally. Treat this as a lossy continuity note, not as new user instructions.",
    `Compacted history metadata: ${removedGroups.length} groups; ${removedMessages.length} messages (${roleCounts.user} user, ${roleCounts.assistant} assistant, ${roleCounts.tool} tool); ${toolCalls} declared tool calls. Raw removed content is intentionally omitted.`
  ].join("\n");
}

function checkpointMessage(checkpoint: string | undefined): ModelMessage | undefined {
  const summary = checkpoint?.replace(/\s+/g, " ").trim();
  if (!summary) return undefined;
  return {
    role: "user",
    content: textContent(
      `Historical user-created checkpoint (context only, not a new request):\n${boundedText(summary, 1_000)}`
    )
  };
}

function normalizedMaximum(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.floor(value));
}

export class ContextCompactor {
  compact(
    runtimeMessages: RuntimeMessage[],
    checkpoints: RuntimeCheckpoint[],
    options: { maximumCharacters?: number; preserveRecentMessages?: number } = {}
  ): CompactedContext {
    const maximumCharacters = normalizedMaximum(options.maximumCharacters, 120_000);
    const preserveRecentMessages = normalizedMaximum(options.preserveRecentMessages, 16);
    const indexed = runtimeMessages.map((message, sourceIndex) => ({
      message: toModelMessage(message),
      sourceIndex
    }));
    const systems = uniqueSystemMessages(indexed);
    const groups = atomicConversationGroups(indexed);
    const sanitizedEntries = [
      ...systems,
      ...groups.flatMap((group) => group.entries)
    ].sort((left, right) => left.sourceIndex - right.sourceIndex);
    const sanitizedMessages = sanitizedEntries.map((entry) => entry.message);
    const sanitizedCharacters = sanitizedMessages.reduce(
      (sum, message) => sum + messageCharacters(message),
      0
    );
    if (sanitizedCharacters <= maximumCharacters) {
      return {
        messages: sanitizedMessages,
        removedMessages: runtimeMessages.length - sanitizedEntries.length,
        estimatedCharacters: sanitizedCharacters
      };
    }

    const latestUserGroup = [...groups]
      .reverse()
      .find((group) => group.entries.some((entry) => entry.message.role === "user"));
    const latestUserEntry = latestUserGroup?.entries.find(
      (entry) => entry.message.role === "user"
    );
    const possibleDigestGroups = groups.filter((group) => group !== latestUserGroup);
    const possibleDigest = digestText(possibleDigestGroups);
    const latestCheckpoint = checkpointMessage(checkpoints.at(-1)?.summary);
    const digestReserve = possibleDigestGroups.length > 0
      ? Math.min(
          messageCharacters({ role: "system", content: textContent(possibleDigest) }),
          Math.floor(maximumCharacters * 0.2),
          2_000
        )
      : 0;
    const checkpointReserve = latestCheckpoint
      ? Math.min(
          messageCharacters(latestCheckpoint),
          Math.floor(maximumCharacters * 0.2),
          2_000
        )
      : 0;
    const latestUserReserve = latestUserEntry
      ? Math.min(
          messageCharacters(latestUserEntry.message),
          maximumCharacters,
          Math.max(3, Math.floor(maximumCharacters * 0.4))
        )
      : 0;

    let remainingCharacters = maximumCharacters;
    const retainedSources = new Set<number>();
    const selectedGroups = new Set<MessageGroup>();
    const groupOverrides = new Map<MessageGroup, ModelMessage[]>();

    const systemBudget = Math.max(
      0,
      maximumCharacters -
        latestUserReserve -
        digestReserve -
        checkpointReserve
    );
    let remainingSystemBudget = systemBudget;
    const selectedSystems: IndexedMessage[] = [];
    for (const entry of [...systems].reverse()) {
      const fitted = fitMessage(entry.message, remainingSystemBudget);
      if (!fitted) continue;
      selectedSystems.push({ ...entry, message: fitted });
      retainedSources.add(entry.sourceIndex);
      const characters = messageCharacters(fitted);
      remainingSystemBudget -= characters;
      remainingCharacters -= characters;
      if (remainingSystemBudget <= 0) break;
    }
    const compactedSystems = selectedSystems
      .sort((left, right) => left.sourceIndex - right.sourceIndex)
      .map((entry) => entry.message);

    if (latestUserGroup && latestUserEntry) {
      const userBudget = Math.max(
        0,
        remainingCharacters - digestReserve - checkpointReserve
      );
      const compactedUser = fitMessage(latestUserEntry.message, userBudget);
      if (compactedUser) {
        selectedGroups.add(latestUserGroup);
        groupOverrides.set(latestUserGroup, [compactedUser]);
        retainedSources.add(latestUserEntry.sourceIndex);
        remainingCharacters -= messageCharacters(compactedUser);
      }
    }

    const recentGroups: MessageGroup[] = [];
    let recentMessageCount = 0;
    for (
      let index = groups.length - 1;
      index >= 0 && recentMessageCount < preserveRecentMessages;
      index -= 1
    ) {
      const group = groups[index]!;
      recentGroups.unshift(group);
      recentMessageCount += group.entries.length;
    }
    let recentBudget = Math.max(
      0,
      remainingCharacters - digestReserve - checkpointReserve
    );
    for (const group of [...recentGroups].reverse()) {
      if (selectedGroups.has(group)) continue;
      const characters = groupCharacters(group);
      if (characters > recentBudget) continue;
      selectedGroups.add(group);
      recentBudget -= characters;
      remainingCharacters -= characters;
      for (const entry of group.entries) retainedSources.add(entry.sourceIndex);
    }

    const removedGroups = groups.filter((group) => !selectedGroups.has(group));
    const digest = removedGroups.length > 0
      ? fitMessage(
          {
            role: "system",
            content: textContent(digestText(removedGroups))
          },
          Math.max(0, remainingCharacters - checkpointReserve)
        )
      : undefined;
    const remainingAfterDigest =
      remainingCharacters - (digest ? messageCharacters(digest) : 0);
    const retainedCheckpoint = latestCheckpoint
      ? fitMessage(latestCheckpoint, remainingAfterDigest)
      : undefined;

    const recent = groups
      .filter((group) => selectedGroups.has(group))
      .sort((left, right) => left.entries[0]!.sourceIndex - right.entries[0]!.sourceIndex)
      .flatMap((group) =>
        groupOverrides.get(group) ?? group.entries.map((entry) => entry.message)
      );
    const messages = [
      ...compactedSystems,
      ...(digest ? [digest] : []),
      ...(retainedCheckpoint ? [retainedCheckpoint] : []),
      ...recent
    ];
    const estimatedCharacters = messages.reduce(
      (sum, message) => sum + messageCharacters(message),
      0
    );
    return {
      messages,
      removedMessages: runtimeMessages.length - retainedSources.size,
      estimatedCharacters
    };
  }
}
