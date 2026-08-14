import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import { DreamingManager } from "./dreaming";
import { MemoryManager } from "./memory";

describe("review-gated memory dreaming", () => {
	it("recovers to an idle ledger when persisted state is malformed", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		database.setPrivateState("memory.dreaming.state", {
			phase: "idle",
			candidates: { corrupted: true },
			diary: [],
			detail: "corrupted",
		});
		const dreaming = new DreamingManager(database);

		expect(dreaming.status()).toMatchObject({
			phase: "idle",
			candidates: [],
			diary: [],
			detail:
				"Memory consolidation is off by default. Preview performs local scoring without storing changes.",
		});
		database.close();
	});

	it("keeps preview non-mutating, excludes restricted memory, and promotes only after review", () => {
		let now = new Date("2026-07-23T09:00:00.000Z");
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const memory = new MemoryManager(database, () => now);
		const eligible = memory.remember({
			type: "semantic",
			content:
				"The user prefers concise release evidence with exact verification.",
			structuredData: {},
			sourceIds: [
				"session:2026-07-21:a",
				"task:2026-07-22:b",
				"review:2026-07-23:c",
			],
			sourceType: "agent-proposal",
			confidence: 0.9,
			importance: 0.85,
			sensitivity: "personal",
			entityIds: [],
			userConfirmed: false,
			inferred: true,
		});
		memory.remember({
			type: "semantic",
			content: "Private access phrase that must remain excluded.",
			structuredData: {},
			sourceIds: ["session:2026-07-21:x", "task:2026-07-22:y"],
			sourceType: "agent-proposal",
			confidence: 1,
			importance: 1,
			sensitivity: "restricted",
			entityIds: [],
			userConfirmed: false,
			inferred: true,
		});
		const dreaming = new DreamingManager(database, () => now);
		dreaming.configure({
			enabled: true,
			scheduleHour: 3,
			minimumScore: 0.5,
			minimumRecallCount: 2,
			minimumUniqueDays: 2,
		});

		const preview = dreaming.run(true);
		expect(preview.candidates).toHaveLength(1);
		expect(JSON.stringify(preview)).not.toContain(eligible.content);
		expect(dreaming.status().diary).toHaveLength(0);
		expect(
			database.listMemories().find((item) => item.id === eligible.id)
				?.userConfirmed,
		).toBe(false);

		const applied = dreaming.run(false);
		expect(applied.candidates[0]).toMatchObject({
			memoryId: eligible.id,
			status: "review",
		});
		expect(applied.diary[0]).toMatchObject({
			preview: false,
			lightCandidates: 1,
			deepCandidates: 1,
		});
		now = new Date("2026-07-23T09:05:00.000Z");
		const promoted = dreaming.review(applied.candidates[0]!.id, "promote");
		expect(promoted.candidates[0]?.status).toBe("promoted");
		expect(
			database.listMemories().find((item) => item.id === eligible.id),
		).toMatchObject({
			userConfirmed: true,
			inferred: false,
			sourceType: "dreaming-user-review",
		});
		database.close();
	});

	it("runs scheduled consolidation only when enabled and due", () => {
		let now = new Date(2026, 6, 23, 2);
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const dreaming = new DreamingManager(database, () => now);
		dreaming.configure({
			enabled: true,
			scheduleHour: 3,
			minimumScore: 0.5,
			minimumRecallCount: 2,
			minimumUniqueDays: 2,
		});
		expect(dreaming.runIfDue()).toBeUndefined();
		now = new Date(2026, 6, 23, 3);
		expect(dreaming.runIfDue()?.lastRunAt).toBe(now.toISOString());
		expect(dreaming.runIfDue()).toBeUndefined();
		database.close();
	});
});
