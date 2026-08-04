import { randomUUID } from "node:crypto";
import type { KestrelDatabase } from "@kestrel/database";
import {
  DreamingConfigurationSchema,
  DreamingCandidateSchema,
  DreamDiaryEntrySchema,
  DreamingStatusSchema,
  type DreamDiaryEntry,
  type DreamingCandidate,
  type DreamingConfiguration,
  type DreamingStatus,
  type MemoryRecord
} from "@kestrel/shared-types";

export const DEFAULT_DREAMING_CONFIGURATION: DreamingConfiguration = {
  enabled: false,
  scheduleHour: 3,
  minimumScore: 0.55,
  minimumRecallCount: 2,
  minimumUniqueDays: 2
};

interface StoredDreamingState {
  phase: DreamingStatus["phase"];
  candidates: DreamingCandidate[];
  diary: DreamDiaryEntry[];
  lastRunAt?: string;
  detail: string;
}

interface Evaluation {
  candidates: DreamingCandidate[];
  diary: DreamDiaryEntry;
}

const CONFIGURATION_KEY = "memory.dreaming.configuration";
const STATE_KEY = "memory.dreaming.state";

function normalizedTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
}

function sourceKind(sourceId: string): string {
  return sourceId.split(/[:/]/, 1)[0] || "unknown";
}

function sourceDays(memory: MemoryRecord): string[] {
  const found = memory.sourceIds.flatMap((sourceId) => sourceId.match(/\d{4}-\d{2}-\d{2}/g) ?? []);
  return [...new Set([...found, memory.createdAt.slice(0, 10), memory.updatedAt.slice(0, 10)])];
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

export class DreamingManager {
  constructor(private readonly database: KestrelDatabase, private readonly now: () => Date = () => new Date()) {}

  configuration(): DreamingConfiguration {
    return DreamingConfigurationSchema.parse(this.database.getPrivateState(CONFIGURATION_KEY) ?? DEFAULT_DREAMING_CONFIGURATION);
  }

  configure(configuration: DreamingConfiguration): DreamingStatus {
    const parsed = DreamingConfigurationSchema.parse(configuration);
    this.database.setPrivateState(CONFIGURATION_KEY, parsed);
    const current = this.storedState();
    this.saveState({
      ...current,
      detail: parsed.enabled
        ? "Memory consolidation is enabled. Automatic runs stage private candidates for review."
        : "Memory consolidation is off. Preview remains available and no automatic run will occur."
    });
    return this.status();
  }

  status(): DreamingStatus {
    const state = this.storedState();
    const configuration = this.configuration();
    return DreamingStatusSchema.parse({
      configuration,
      phase: state.phase,
      candidates: state.candidates,
      diary: state.diary,
      ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
      ...(configuration.enabled ? { nextRunAt: this.nextRunAt(state.lastRunAt).toISOString() } : {}),
      detail: state.detail
    });
  }

  run(preview = false): DreamingStatus {
    const configuration = this.configuration();
    if (!preview && !configuration.enabled) throw new Error("Enable memory consolidation before running it.");
    const startedAt = this.now();
    const evaluation = this.evaluate(configuration, startedAt, preview);
    if (preview) {
      const state = this.storedState();
      return DreamingStatusSchema.parse({
        configuration,
        phase: "idle",
        candidates: evaluation.candidates,
        diary: [evaluation.diary, ...state.diary].slice(0, 100),
        ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
        ...(configuration.enabled ? { nextRunAt: this.nextRunAt(state.lastRunAt).toISOString() } : {}),
        detail: "Preview complete. Nothing was stored or promoted."
      });
    }
    const current = this.storedState();
    const reviewedByMemory = new Map(current.candidates.filter((candidate) => candidate.status !== "review").map((candidate) => [candidate.memoryId, candidate]));
    const candidates = evaluation.candidates.map((candidate) => reviewedByMemory.get(candidate.memoryId) ?? candidate);
    this.saveState({
      phase: "idle",
      candidates: candidates.slice(0, 500),
      diary: [evaluation.diary, ...current.diary].slice(0, 100),
      lastRunAt: evaluation.diary.completedAt,
      detail: candidates.some((candidate) => candidate.status === "review")
        ? "Consolidation complete. Review staged candidates before they change durable memory."
        : "Consolidation complete. No memory met the review threshold."
    });
    return this.status();
  }

  runIfDue(at = this.now()): DreamingStatus | undefined {
    const configuration = this.configuration();
    if (!configuration.enabled) return undefined;
    const state = this.storedState();
    if (at.getTime() < this.nextRunAt(state.lastRunAt, at).getTime()) return undefined;
    return this.run(false);
  }

  review(id: string, decision: "promote" | "reject"): DreamingStatus {
    const state = this.storedState();
    const candidate = state.candidates.find((item) => item.id === id);
    if (!candidate) throw new Error("Dreaming candidate not found.");
    if (candidate.status !== "review") throw new Error("Dreaming candidate was already reviewed.");
    const timestamp = this.now().toISOString();
    this.database.db.transaction(() => {
      if (decision === "promote") {
        const memory = this.database.listMemories().find((item) => item.id === candidate.memoryId && item.status === "active");
        if (!memory) throw new Error("The source memory is no longer active.");
        this.database.upsertMemory({
          ...memory,
          structuredData: {
            ...memory.structuredData,
            dreaming: {
              reviewedAt: timestamp,
              candidateId: candidate.id,
              score: candidate.score,
              sourceCount: candidate.sourceCount
            }
          },
          sourceType: "dreaming-user-review",
          confidence: Math.max(memory.confidence, candidate.score),
          importance: Math.max(memory.importance, candidate.score),
          userConfirmed: true,
          inferred: false,
          updatedAt: timestamp
        });
      }
      this.saveState({
        ...state,
        candidates: state.candidates.map((item) => item.id === id ? { ...item, status: decision === "promote" ? "promoted" : "rejected", updatedAt: timestamp } : item),
        detail: decision === "promote" ? "Candidate promoted after explicit review." : "Candidate rejected; durable memory was not changed."
      });
    })();
    return this.status();
  }

  private evaluate(configuration: DreamingConfiguration, startedAt: Date, preview: boolean): Evaluation {
    const active = this.database.listMemories().filter((memory) =>
      memory.status === "active"
      && memory.inferred
      && !memory.userConfirmed
      && memory.sensitivity !== "restricted"
    );
    const termSets = new Map(active.map((memory) => [memory.id, new Set(normalizedTerms(memory.content))]));
    const scored = active.map((memory) => {
      const terms = termSets.get(memory.id)!;
      const related = active.filter((other) => {
        if (other.id === memory.id) return false;
        const otherTerms = termSets.get(other.id)!;
        let overlap = 0;
        for (const term of terms) if (otherTerms.has(term)) overlap += 1;
        return overlap >= 2;
      });
      const sourceIds = [...new Set([memory.sourceIds, ...related.map((item) => item.sourceIds)].flat())];
      const days = [...new Set([sourceDays(memory), ...related.map(sourceDays)].flat())];
      const kinds = new Set(sourceIds.map(sourceKind));
      const ageDays = Math.max(0, (startedAt.getTime() - new Date(memory.updatedAt).getTime()) / 86_400_000);
      const recency = Math.exp(-ageDays / 90);
      const score = clampScore(
        memory.importance * 0.30
        + memory.confidence * 0.24
        + Math.min(sourceIds.length / 4, 1) * 0.15
        + recency * 0.15
        + Math.min(kinds.size / 3, 1) * 0.10
        + Math.min(terms.size / 16, 1) * 0.06
      );
      return { memory, sourceIds, days, score, related: related.length };
    });
    const timestamp = this.now().toISOString();
    const candidates = scored
      .filter(({ sourceIds, days, score }) => sourceIds.length >= configuration.minimumRecallCount && days.length >= configuration.minimumUniqueDays && score >= configuration.minimumScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, 500)
      .map<DreamingCandidate>(({ memory, sourceIds, days, score, related }) => ({
        id: `dream-${randomUUID()}`,
        memoryId: memory.id,
        memoryType: memory.type,
        sourceCount: sourceIds.length,
        uniqueDays: days.length,
        score,
        reasons: [
          `Recalled from ${sourceIds.length} provenance records across ${days.length} days.`,
          related > 0 ? `Reinforced by ${related} related active ${related === 1 ? "memory" : "memories"}.` : "Scored from direct provenance, confidence, importance, and recency.",
          "Content stayed encrypted; this diary contains signals and provenance counts only."
        ],
        status: "review",
        createdAt: timestamp,
        updatedAt: timestamp
      }));
    const themes = new Set(active.map((memory) => memory.type)).size;
    const diary: DreamDiaryEntry = {
      id: `dream-diary-${randomUUID()}`,
      startedAt: startedAt.toISOString(),
      completedAt: timestamp,
      lightCandidates: active.length,
      remThemes: themes,
      deepCandidates: candidates.length,
      summary: `Light recall inspected ${active.length} eligible inferred memories. REM grouped ${themes} typed themes without promotion. Deep scoring staged ${candidates.length} review ${candidates.length === 1 ? "candidate" : "candidates"}.`,
      preview
    };
    return { candidates, diary };
  }

  private nextRunAt(lastRunAt?: string, reference = this.now()): Date {
    const configuration = this.configuration();
    const scheduled = new Date(reference);
    scheduled.setHours(configuration.scheduleHour, 0, 0, 0);
    if (lastRunAt) {
      const last = new Date(lastRunAt);
      const afterLast = new Date(last);
      afterLast.setDate(afterLast.getDate() + 1);
      afterLast.setHours(configuration.scheduleHour, 0, 0, 0);
      while (afterLast.getTime() <= last.getTime()) afterLast.setDate(afterLast.getDate() + 1);
      return afterLast;
    }
    if (scheduled.getTime() <= reference.getTime()) return scheduled;
    return scheduled;
  }

  private storedState(): StoredDreamingState {
    const stored = this.database.getPrivateState<unknown>(STATE_KEY);
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      const value = stored as Record<string, unknown>;
      const candidates = value.candidates;
      const diary = value.diary;
      if (
        ["idle", "light", "rem", "deep", "error"].includes(
          String(value.phase),
        ) &&
        Array.isArray(candidates) &&
        candidates.length <= 500 &&
        candidates.every((candidate) =>
          DreamingCandidateSchema.safeParse(candidate).success,
        ) &&
        Array.isArray(diary) &&
        diary.length <= 100 &&
        diary.every((entry) => DreamDiaryEntrySchema.safeParse(entry).success) &&
        (value.lastRunAt === undefined ||
          (typeof value.lastRunAt === "string" &&
            !Number.isNaN(Date.parse(value.lastRunAt)))) &&
        typeof value.detail === "string" &&
        value.detail.length >= 1 &&
        value.detail.length <= 1_000
      ) {
        return {
          phase: value.phase as StoredDreamingState["phase"],
          candidates: candidates as DreamingCandidate[],
          diary: diary as DreamDiaryEntry[],
          ...(typeof value.lastRunAt === "string"
            ? { lastRunAt: value.lastRunAt }
            : {}),
          detail: value.detail,
        };
      }
    }
    return {
      phase: "idle",
      candidates: [],
      diary: [],
      detail: "Memory consolidation is off by default. Preview performs local scoring without storing changes."
    };
  }

  private saveState(state: StoredDreamingState): void {
    this.database.setPrivateState(STATE_KEY, state);
  }
}
