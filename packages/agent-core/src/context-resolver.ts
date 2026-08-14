import type { MemoryRecord } from "@kestrel/shared-types";

export type ContextCategory = "devices" | "software_versions" | "hardware" | "prior_errors" | "prior_attempts" | "schedule" | "people" | "projects" | "preferences" | "location" | "subscriptions" | "purchases" | "deadlines" | "documents";

import { localSemanticEmbedding, semanticSimilarity } from "./semantic-search";

export interface ContextResolutionRequest {
  userMessage: string;
  detectedIntent: string;
  detectedEntities: string[];
  possibleContextCategories: ContextCategory[];
  maximumRetrievedItems: number;
}

export interface ResolvedContext {
  confirmed: MemoryRecord[];
  inferred: MemoryRecord[];
  possiblyStale: MemoryRecord[];
}

const MAX_RETRIEVED_ITEMS = 100;

function boundedRetrievedItems(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_RETRIEVED_ITEMS, Math.trunc(value)));
}

export class PreResponseContextResolver {
  constructor(private readonly memoryProvider: () => MemoryRecord[]) {}

  categoriesFor(message: string): ContextCategory[] {
    const lower = message.toLowerCase();
    if (/connect|controller|device|phone|drone|dji|error|not working/.test(lower)) {
      return ["devices", "hardware", "software_versions", "prior_errors", "prior_attempts"];
    }
    if (/when|schedule|date|calendar|meeting|test/.test(lower)) return ["schedule", "deadlines", "preferences"];
    return ["projects", "preferences"];
  }

  resolve(request: ContextResolutionRequest): ResolvedContext {
    const allowed = new Set(request.possibleContextCategories);
    const now = Date.now();
    const queryEmbedding = localSemanticEmbedding(request.userMessage);

    const matches = this.memoryProvider()
      .filter((item) => allowed.has(String(item.structuredData.category) as ContextCategory))
      .filter((item) => item.status === "active")
      .map((item) => {
        const itemText = `${item.content} ${JSON.stringify(item.structuredData)}`;
        const similarity = semanticSimilarity(queryEmbedding, localSemanticEmbedding(itemText));
        return { item, similarity };
      })
      .sort((a, b) => {
        if (a.item.userConfirmed !== b.item.userConfirmed) {
          return a.item.userConfirmed ? -1 : 1;
        }
        if (Math.abs(a.similarity - b.similarity) > 0.1) {
          return b.similarity - a.similarity;
        }
        return b.item.importance - a.item.importance;
      })
      .slice(0, boundedRetrievedItems(request.maximumRetrievedItems))
      .map(({ item }) => item);
    return {
      confirmed: matches.filter((item) => item.userConfirmed && (!item.validUntil || Date.parse(item.validUntil) >= now)),
      inferred: matches.filter((item) => item.inferred),
      possiblyStale: matches.filter((item) => Boolean(item.validUntil && Date.parse(item.validUntil) < now))
    };
  }
}
