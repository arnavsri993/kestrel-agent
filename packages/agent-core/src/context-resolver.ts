import type { MemoryRecord } from "@kestrel/shared-types";

export type ContextCategory = "devices" | "software_versions" | "hardware" | "prior_errors" | "prior_attempts" | "schedule" | "people" | "projects" | "preferences" | "location" | "subscriptions" | "purchases" | "deadlines" | "documents";

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

function expirationTimestamp(item: MemoryRecord): number {
  if (!item.validUntil) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(item.validUntil);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
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
    const matches = this.memoryProvider()
      .filter((item) => allowed.has(String(item.structuredData.category) as ContextCategory))
      .filter((item) => item.status === "active")
      .sort((a, b) => (b.userConfirmed ? 1 : 0) - (a.userConfirmed ? 1 : 0) || b.importance - a.importance)
      .slice(0, boundedRetrievedItems(request.maximumRetrievedItems));
    return {
      confirmed: matches.filter((item) => item.userConfirmed && expirationTimestamp(item) >= now),
      inferred: matches.filter((item) => item.inferred),
      possiblyStale: matches.filter((item) => item.validUntil !== undefined && expirationTimestamp(item) < now)
    };
  }
}
