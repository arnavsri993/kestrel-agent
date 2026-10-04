import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import type { TimelineEvent } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";

const startAt = "2026-09-16T00:00:00.000Z";
const endAt = "2026-09-23T00:00:00.000Z";

describe("timeline temporal bounds", () => {
	it("treats missing end times as points in both list and lexical search", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		try {
			const insert = (id: string, startedAt: string, endedAt?: string) => {
				const event: TimelineEvent = {
					id, startedAt, ...(endedAt ? { endedAt } : {}), source: "synthetic-test",
					eventType: "project_activity", actor: "user", textSummary: "Temporal boundary fixture",
					projectIds: [], personIds: [], entityIds: [], structuredData: {}, importance: 0.5,
					sensitivity: "personal", retentionPolicy: "durable", embeddingStatus: "not_requested",
					status: "active", createdAt: startAt, updatedAt: startAt,
				};
				database.upsertTimelineEvent(event);
			};
			insert("old-point", "2026-09-01T12:00:00.000Z");
			insert("start-point", startAt);
			insert("inside-point", "2026-09-18T12:00:00.000Z");
			insert("end-point", endAt);
			insert("after-point", "2026-09-25T12:00:00.000Z");
			insert("old-interval", "2026-09-10T12:00:00.000Z", "2026-09-15T23:59:59.999Z");
			insert("overlap-interval", "2026-09-15T12:00:00.000Z", "2026-09-17T12:00:00.000Z");
			insert("start-boundary-interval", "2026-09-15T12:00:00.000Z", startAt);
			const bounded = ["inside-point", "overlap-interval", "start-boundary-interval", "start-point"];
			const startOnly = [...bounded, "after-point", "end-point"].sort();
			const ids = (events: TimelineEvent[]) => events.map(event => event.id).sort();
			expect(ids(database.listTimelineEvents({ startAt, endAt }))).toEqual(bounded);
			expect(ids(database.listTimelineEvents({ startAt }))).toEqual(startOnly);
			expect(ids(database.searchTimelineEvents("Temporal boundary", { startAt, endAt }).map(match => match.event))).toEqual(bounded);
			expect(ids(database.searchTimelineEvents("Temporal boundary", { startAt }).map(match => match.event))).toEqual(startOnly);
			expect(ids(database.searchTimelineEvents("", { startAt, endAt }).map(match => match.event))).toEqual(bounded);
			expect(ids(database.listTimelineEvents({ endAt }))).toEqual(["inside-point", "old-interval", "old-point", "overlap-interval", "start-boundary-interval", "start-point"]);
		} finally { database.close(); }
	});
});
