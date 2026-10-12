import type { MemoryDocument, MemoryWorkspace, TimelineEvent } from "@kestrel/shared-types";
import { describe, expect, it, vi } from "vitest";
import { MemoryConsolidator, memoryTierForSignals, type ConsolidatedDaySummary, type MemoryConsolidationStore } from "./memory-consolidation";

const at = "2026-09-16T15:00:00.000Z";
function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
	return {
		id: "event-1", startedAt: at, eventType: "project_activity", source: "agent", actor: "user",
		projectIds: [], personIds: ["person-sai"], entityIds: [], textSummary: "Refined the robotics memory design.",
		structuredData: {}, importance: 0.8, sensitivity: "personal", retentionPolicy: "durable",
		embeddingStatus: "not_requested", status: "active", createdAt: at, updatedAt: at, ...overrides,
	};
}
function document(overrides: Partial<MemoryDocument> = {}): MemoryDocument {
	return {
		id: "person-doc", kind: "person", title: "Sai", text: "Sai is a robotics collaborator.", tier: "mid_term",
		domainIds: ["robotics"], sharing: "owner_only", sourceIds: ["source-old"], confidence: 0.7,
		confirmation: "inferred", sensitivity: "personal", passages: [], canonicalEntityId: "person-sai",
		origin: "evidence", createdAt: at, updatedAt: at, version: 3, ...overrides,
	};
}
function workspace(overrides: Partial<MemoryWorkspace> = {}): MemoryWorkspace {
	const activity = event();
	return {
		query: { includeSensitive: false, viewerId: "user", domainId: "robotics" }, viewers: [{ id: "user", label: "You" }],
		domains: [{ id: "robotics", label: "Robotics" }], documents: [document()],
		days: [{ day: "2026-09-16", summary: "", summaryMethod: "deterministic", events: [activity], eventCount: 1, sourceIds: ["agent"] }],
		generatedAt: at, summaryMethod: "deterministic", truncated: false, ...overrides,
	};
}
function store(value = workspace()) {
	const savedDocuments: unknown[] = [];
	const savedDays: ConsolidatedDaySummary[] = [];
	const adapter: MemoryConsolidationStore = {
		read: vi.fn(() => value),
		save: vi.fn(input => { savedDocuments.push(input); return document({ text: input.text }); }),
		saveDaySummary: vi.fn(input => { savedDays.push(input); }),
	};
	return { adapter, savedDocuments, savedDays };
}

describe("MemoryConsolidator", () => {
	it("does not call a model unless policy explicitly permits it and marks its fallback", async () => {
		const fixture = store();
		const invokeModel = vi.fn();
		const result = await new MemoryConsolidator({ store: fixture.adapter, invokeModel, canUseModel: () => false }).consolidate({ includeSensitive: false, viewerId: "user", domainId: "robotics" });
		expect(invokeModel).not.toHaveBeenCalled();
		expect(result).toMatchObject({ method: "deterministic", reason: "model_disabled", documentsUpdated: 0, daysUpdated: 1 });
		expect(fixture.savedDays[0]).toMatchObject({ summaryMethod: "deterministic", eventIds: ["event-1"] });
	});

	it("accepts only visible identities and evidence while preserving provenance and uncertainty", async () => {
		const fixture = store();
		const invokeModel = vi.fn(async () => ({
			documents: [
				{ id: "person-doc", text: "Sai is a robotics collaborator. Recent evidence suggests ongoing architecture work.", eventIds: ["event-1"], signals: { importance: 0.9, recurrence: 0.8, stability: 0.8, futureUsefulness: 0.9, confidence: 1 } },
				{ id: "manufactured-person", text: "Invented identity", eventIds: ["event-1"], signals: { importance: 1, recurrence: 1, stability: 1, futureUsefulness: 1, confidence: 1 } },
			],
			days: [
				{ day: "2026-09-16", summary: "Worked on robotics memory architecture.", eventIds: ["event-1"] },
				{ day: "2026-09-16", summary: "Hallucinated work.", eventIds: ["event-missing"] },
			],
		}));
		const result = await new MemoryConsolidator({ store: fixture.adapter, invokeModel, canUseModel: () => true }).consolidate({ includeSensitive: false, viewerId: "user", domainId: "robotics" });
		expect(result).toEqual({ method: "model", documentsUpdated: 1, daysUpdated: 1, rejectedProposals: 2 });
		expect(fixture.savedDocuments).toHaveLength(1);
		expect(fixture.savedDocuments[0]).toMatchObject({
			id: "person-doc", canonicalEntityId: "person-sai", sourceIds: ["source-old", "event-1"], confirmation: "inferred",
			confidence: 0.7, expectedVersion: 3, viewerId: "user", tier: "long_term",
		});
		expect(fixture.savedDays[0]).toMatchObject({ summaryMethod: "model", sourceIds: ["agent"], eventIds: ["event-1"] });
	});

	it("rejects type-invalid output and uses an honest deterministic summary", async () => {
		const fixture = store();
		const result = await new MemoryConsolidator({ store: fixture.adapter, invokeModel: async () => ({ documents: [{ id: "person-doc", text: 5 }], days: [] }), canUseModel: () => true }).consolidate({ includeSensitive: false, viewerId: "user" });
		expect(result.reason).toBe("model_invalid");
		expect(result.method).toBe("deterministic");
		expect(fixture.savedDocuments).toHaveLength(0);
	});

	it("passes the read version to storage so concurrent changes cannot be silently overwritten", async () => {
		const fixture = store();
		fixture.adapter.save = vi.fn(() => { throw new Error("stale version"); });
		const consolidator = new MemoryConsolidator({
			store: fixture.adapter, canUseModel: () => true,
			invokeModel: async () => ({ documents: [{ id: "person-doc", text: "Updated", eventIds: ["event-1"], signals: { importance: 0.8, recurrence: 0.8, stability: 0.8, futureUsefulness: 0.8, confidence: 0.8 } }], days: [] }),
		});
		await expect(consolidator.consolidate({ includeSensitive: false, viewerId: "user" })).resolves.toMatchObject({ documentsUpdated: 0, rejectedProposals: 1 });
		expect(fixture.adapter.save).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 3 }));
	});
});

describe("memoryTierForSignals", () => {
	it("uses importance, recurrence, stability, future usefulness and confidence rather than age", () => {
		expect(memoryTierForSignals({ importance: 0.99, recurrence: 0.1, stability: 0.1, futureUsefulness: 0.3, confidence: 0.9 })).toBe("long_term");
		expect(memoryTierForSignals({ importance: 0.6, recurrence: 0.7, stability: 0.7, futureUsefulness: 0.7, confidence: 0.8 })).toBe("mid_term");
		expect(memoryTierForSignals({ importance: 0.4, recurrence: 0.2, stability: 0.2, futureUsefulness: 0.3, confidence: 0.5 })).toBe("short_term");
	});
});
