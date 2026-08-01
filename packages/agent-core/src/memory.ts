import { randomUUID } from "node:crypto";
import type { KestrelDatabase } from "@kestrel/database";
import type { MemoryRecord, MemoryVersion } from "@kestrel/shared-types";
import type { AgentRuntime } from "./runtime";
import { UserModelStore } from "./user-model";

export type MemoryInput = Pick<MemoryRecord, "type" | "content" | "structuredData" | "sourceIds" | "sourceType" | "confidence" | "importance" | "sensitivity" | "entityIds" | "userConfirmed" | "inferred"> &
  Partial<Pick<MemoryRecord, "subject" | "layer" | "confirmationStatus" | "validFrom" | "validUntil" | "reviewAt" | "relatedPersonIds" | "relatedProjectIds" | "relatedEventIds" | "relatedLocationIds">>;

function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
}

export class MemoryManager {
  readonly userModel: UserModelStore;
  constructor(private readonly database: KestrelDatabase, private readonly now: () => Date = () => new Date()) { this.userModel = new UserModelStore(database, now); }
  list(): MemoryRecord[] { return this.database.listMemories(); }

  remember(input: MemoryInput): MemoryRecord {
    if (!input.content.trim() || input.content.length > 100_000 || input.sourceIds.length === 0) throw new Error("Memory content and provenance are required.");
    const timestamp = this.now().toISOString();
    const prior = this.conflictsFor(input);
    const obviousUpdate = prior.length > 0 && this.isAuthoritativeUpdate(input);
    const record: MemoryRecord = {
      ...input,
      id: `memory-${randomUUID()}`,
      content: input.content.trim(),
      status: prior.length > 0 && !obviousUpdate ? "contradicted" : "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAccessedAt: timestamp,
      relevanceScore: input.importance,
      layer: input.layer ?? this.defaultLayer(input),
      confirmationStatus:
        input.confirmationStatus ??
        (input.userConfirmed
          ? "user_confirmed"
          : input.inferred
            ? "inferred"
            : "suggested"),
      relatedPersonIds: input.relatedPersonIds ?? [],
      relatedProjectIds: input.relatedProjectIds ?? [],
      relatedEventIds: input.relatedEventIds ?? [],
      relatedLocationIds: input.relatedLocationIds ?? [],
      conflictingMemoryIds: prior.map((memory) => memory.id),
      version: 1,
    };
    this.database.db.transaction(() => {
      for (const conflict of prior) {
        this.saveVersion(conflict, "agent");
        this.database.upsertMemory({
          ...conflict,
          status: obviousUpdate ? "superseded" : "contradicted",
          conflictingMemoryIds: [
            ...new Set([...(conflict.conflictingMemoryIds ?? []), record.id]),
          ],
          updatedAt: timestamp,
          version: (conflict.version ?? 1) + 1,
        });
      }
      this.database.upsertMemory(record);
    })();
    return record;
  }

  search(query: string, limit = 20): MemoryRecord[] {
    const queryTerms = terms(query);
    if (!queryTerms.length) return [];
    return this.list().map((memory) => {
      const body = terms(`${memory.content} ${JSON.stringify(memory.structuredData)} ${memory.entityIds.join(" ")}`);
      const exact = queryTerms.filter((term) => body.includes(term)).length;
      const related = queryTerms.filter((term) => body.some((candidate) => candidate.startsWith(term) || term.startsWith(candidate))).length;
      return { memory, score: exact * 4 + related + memory.importance + memory.confidence };
    }).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score).slice(0, Math.max(1, Math.min(100, limit))).map(({ memory }) => memory);
  }

  forget(id: string): MemoryRecord {
    const memory = this.database.getMemory(id);
    if (!memory) throw new Error("Memory not found.");
    this.saveVersion(memory, "user");
    const deleted = {
      ...memory,
      status: "deleted" as const,
      updatedAt: this.now().toISOString(),
      version: (memory.version ?? 1) + 1,
    };
    this.database.upsertMemory(deleted);
    return deleted;
  }

  correct(id: string, input: { content: string; type?: MemoryRecord["type"]; sensitivity?: MemoryRecord["sensitivity"]; layer?: NonNullable<MemoryRecord["layer"]> }): MemoryRecord {
    const memory = this.database.getMemory(id);
    if (!memory) throw new Error("Memory not found.");
    const content = input.content.trim();
    if (!content || content.length > 100_000) throw new Error("Corrected memory content is required.");
    this.saveVersion(memory, "user");
    const corrected: MemoryRecord = {
      ...memory,
      type: input.type ?? memory.type,
      content,
      sensitivity: input.sensitivity ?? memory.sensitivity,
      layer: input.layer ?? memory.layer ?? this.defaultLayer(memory),
      structuredData: {
        ...memory.structuredData,
        correctionCount:
          Number(memory.structuredData.correctionCount ?? 0) + 1,
      },
      sourceIds: [...new Set([...memory.sourceIds, `correction:${id}`])],
      sourceType: "user-correction",
      confidence: 1,
      userConfirmed: true,
      inferred: false,
      confirmationStatus: "user_confirmed",
      status: "active",
      conflictingMemoryIds: [],
      updatedAt: this.now().toISOString(),
      lastAccessedAt: this.now().toISOString(),
      relevanceScore: Math.max(memory.relevanceScore ?? memory.importance, 0.8),
      version: (memory.version ?? 1) + 1,
    };
    this.database.upsertMemory(corrected);
    return corrected;
  }

  captureExplicit(text: string, sourceId: string): { memory?: MemoryRecord; userModelFacts: ReturnType<UserModelStore["proposeFromText"]> } {
    const explicit = text.trim().match(/^remember(?:\s+that)?\s+([\s\S]{1,100000})$/i)?.[1]?.trim();
    const existing = explicit ? this.list().find((memory) => memory.content.toLowerCase() === explicit.toLowerCase() && memory.status === "active") : undefined;
    const memory = explicit && !existing ? this.remember({ type: "semantic", content: explicit, structuredData: { capture: "explicit-command" }, sourceIds: [sourceId], sourceType: "explicit-user-command", confidence: 1, importance: 0.75, sensitivity: "personal", entityIds: [], userConfirmed: true, inferred: false, confirmationStatus: "explicit" }) : existing;
    return { ...(memory ? { memory } : {}), userModelFacts: this.userModel.proposeFromText(text, sourceId) };
  }

  versions(id: string): MemoryVersion[] {
    return this.database.listMemoryVersions(id);
  }

  touch(ids: string[]): void {
    const timestamp = this.now().toISOString();
    for (const id of new Set(ids)) {
      const memory = this.database.getMemory(id);
      if (!memory || memory.status !== "active") continue;
      this.database.upsertMemory({
        ...memory,
        lastAccessedAt: timestamp,
        relevanceScore: Math.min(
          1,
          (memory.relevanceScore ?? memory.importance) + 0.03,
        ),
      });
    }
  }

  maintain(): MemoryRecord[] {
    const timestamp = this.now();
    const changed: MemoryRecord[] = [];
    for (const memory of this.list()) {
      if (!["active", "contradicted"].includes(memory.status)) continue;
      const reference = new Date(
        memory.lastAccessedAt ?? memory.updatedAt,
      ).getTime();
      const ageDays = Math.max(
        0,
        (timestamp.getTime() - reference) / 86_400_000,
      );
      const decayed = Math.max(
        0.05,
        (memory.relevanceScore ?? memory.importance) -
          Math.min(0.6, ageDays / 900),
      );
      const expired =
        memory.validUntil !== undefined &&
        Date.parse(memory.validUntil) < timestamp.getTime();
      const archive =
        !expired &&
        memory.layer !== "short_term" &&
        ageDays >= 180 &&
        decayed < 0.35;
      if (
        !expired &&
        !archive &&
        Math.abs(decayed - (memory.relevanceScore ?? memory.importance)) < 0.01
      )
        continue;
      const next: MemoryRecord = {
        ...memory,
        relevanceScore: decayed,
        status: expired ? "expired" : memory.status,
        layer: archive ? "archived" : memory.layer,
        ...(archive ? { archivedAt: timestamp.toISOString() } : {}),
        updatedAt: timestamp.toISOString(),
      };
      this.database.upsertMemory(next);
      changed.push(next);
    }
    return changed;
  }

  private conflictsFor(input: MemoryInput): MemoryRecord[] {
    const conflictKey =
      typeof input.structuredData.conflictKey === "string"
        ? input.structuredData.conflictKey
        : undefined;
    if (!conflictKey) return [];
    return this.list().filter(
      (memory) =>
        ["active", "contradicted"].includes(memory.status) &&
        memory.content.trim().toLowerCase() !==
          input.content.trim().toLowerCase() &&
        memory.structuredData.conflictKey === conflictKey,
    );
  }

  private isAuthoritativeUpdate(input: MemoryInput): boolean {
    return (
      input.userConfirmed ||
      input.sourceType === "direct-user-statement" ||
      input.sourceType === "user-correction" ||
      input.sourceType === "connected-calendar"
    );
  }

  private defaultLayer(
    input: Pick<MemoryRecord, "type" | "validUntil">,
  ): NonNullable<MemoryRecord["layer"]> {
    if (
      input.validUntil &&
      Date.parse(input.validUntil) - this.now().getTime() < 14 * 86_400_000
    )
      return "short_term";
    if (["procedural", "relationship"].includes(input.type)) return "long_term";
    return "mid_term";
  }

  private saveVersion(
    memory: MemoryRecord,
    changedBy: MemoryVersion["changedBy"],
  ): void {
    this.database.saveMemoryVersion({
      id: `memory-version-${randomUUID()}`,
      memoryId: memory.id,
      version: memory.version ?? 1,
      content: memory.content,
      structuredData: memory.structuredData,
      sourceIds: memory.sourceIds,
      sourceType: memory.sourceType,
      changedAt: this.now().toISOString(),
      changedBy,
    });
  }
}

export function installMemoryTools(runtime: AgentRuntime, manager: MemoryManager, sessionId: string): void {
  const register = (name: string, title: string, readOnly: boolean, inputSchema: Record<string, unknown>, execute: Parameters<AgentRuntime["registerExternalTool"]>[0]["execute"]) => {
    runtime.registerExternalTool({ descriptor: { name, title, description: title, category: "memory", riskLevel: "sensitive", readOnly, requiresWorkspace: false, source: "builtin", tags: ["memory", "private", "provenance"] }, inputSchema, execute });
    runtime.allowTool(sessionId, name);
  };
  register("memory.list", "List durable memories", true, { type: "object", properties: {}, additionalProperties: false }, async () => ({ memories: manager.list() }));
  register("memory.search", "Search durable memories", true, { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["query"], additionalProperties: false }, async (_context, input) => ({ memories: manager.search(String(input.query), Number(input.limit ?? 20)) }));
  register("memory.remember", "Store a provenance-backed memory", false, { type: "object", properties: { type: { enum: ["episodic", "semantic", "procedural", "project", "relationship"] }, content: { type: "string", minLength: 1, maxLength: 100_000 }, sourceIds: { type: "array", items: { type: "string" }, minItems: 1 }, confidence: { type: "number", minimum: 0, maximum: 1 }, importance: { type: "number", minimum: 0, maximum: 1 }, sensitivity: { enum: ["public", "personal", "sensitive", "restricted"] } }, required: ["type", "content", "sourceIds"], additionalProperties: false }, async (_context, input) => ({ memory: manager.remember({ type: input.type as MemoryRecord["type"], content: String(input.content), structuredData: {}, sourceIds: (input.sourceIds as unknown[]).map(String), sourceType: "agent-proposal", confidence: Number(input.confidence ?? 0.7), importance: Number(input.importance ?? 0.5), sensitivity: (input.sensitivity ?? "personal") as MemoryRecord["sensitivity"], entityIds: [], userConfirmed: false, inferred: true }) }));
  register("memory.forget", "Delete a durable memory", false, { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, async (_context, input) => ({ memory: manager.forget(String(input.id)) }));
  register("memory.user-model-list", "List reviewed and proposed user-model facts", true, { type: "object", properties: {}, additionalProperties: false }, async () => ({ facts: manager.userModel.list() }));
  register("memory.user-model-propose", "Propose a provenance-backed user-model fact for review", false, { type: "object", properties: { kind: { enum: ["preference", "profile", "relationship", "boundary"] }, key: { type: "string", minLength: 1, maxLength: 200 }, value: { type: "string", minLength: 1, maxLength: 10_000 }, sourceIds: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }, confidence: { type: "number", minimum: 0, maximum: 1 }, sensitivity: { enum: ["normal", "sensitive"] } }, required: ["kind", "key", "value", "sourceIds"], additionalProperties: false }, async (_context, input) => ({ fact: manager.userModel.propose({ kind: input.kind as "preference" | "profile" | "relationship" | "boundary", key: String(input.key), value: String(input.value), sourceIds: (input.sourceIds as unknown[]).map(String), confidence: Number(input.confidence ?? 0.7), sensitivity: (input.sensitivity ?? "normal") as "normal" | "sensitive" }) }));
  register("memory.user-model-review", "Confirm or reject a proposed user-model fact", false, { type: "object", properties: { id: { type: "string" }, decision: { enum: ["confirm", "reject"] } }, required: ["id", "decision"], additionalProperties: false }, async (_context, input) => ({ fact: manager.userModel.review(String(input.id), input.decision as "confirm" | "reject") }));
}
