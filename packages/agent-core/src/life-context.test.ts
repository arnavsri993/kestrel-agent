import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import type { GoogleWorkspaceClient } from "./google-workspace";
import { LifeContextService } from "./life-context";

function fixture(
	now = new Date("2026-07-29T14:00:00.000Z"),
	google?: GoogleWorkspaceClient,
) {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	return {
		database,
		life: new LifeContextService(database, google, () => new Date(now)),
	};
}

describe("unified life context", () => {
	it("retrieves the smallest relevant context, filters sensitive fields, and explains relationship tone", () => {
		const { database, life } = fixture();
		const professor = life.upsertPerson({
			displayName: "Dr. Rivera",
			nicknames: ["Professor Rivera"],
			relationship: "Current statistics professor",
			organization: "North College",
			role: "Professor",
			tone: "Concise, respectful, and prepared",
			formality: "formal",
			email: "rivera@example.edu",
			sourceId: "message-person",
			sensitivity: "personal",
		});
		life.memory.remember({
			type: "project",
			subject: "Statistics paper",
			content: "The statistics paper is due Friday.",
			structuredData: {
				category: "deadlines",
				conflictKey: "deadline:statistics-paper",
			},
			sourceIds: ["message-deadline"],
			sourceType: "direct-user-statement",
			confidence: 1,
			importance: 0.9,
			sensitivity: "personal",
			entityIds: [professor.id],
			relatedPersonIds: [professor.id],
			userConfirmed: true,
			inferred: false,
			confirmationStatus: "explicit",
		});
		life.memory.remember({
			type: "semantic",
			content: "Private account recovery code",
			structuredData: { category: "preferences" },
			sourceIds: ["message-secret"],
			sourceType: "direct-user-statement",
			confidence: 1,
			importance: 1,
			sensitivity: "restricted",
			entityIds: [],
			userConfirmed: true,
			inferred: false,
		});

		const bundle = life.assembleContext({
			query: "Email Professor Rivera about the statistics paper",
		});
		expect(bundle.people).toMatchObject([
			{
				id: professor.id,
				communicationStyle: { formality: "formal" },
			},
		]);
		expect(bundle.memories.map((memory) => memory.content)).toEqual([
			"The statistics paper is due Friday.",
		]);
		expect(bundle.influences).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "person",
					reason: "The person is named in the request.",
				}),
			]),
		);
		expect(bundle.prompt).toContain("Concise, respectful, and prepared");
		expect(bundle.prompt).not.toContain("recovery code");
		expect(life.communicationContext("Professor Rivera")).toContain(
			"Formality: formal",
		);
		database.close();
	});

	it("tracks versions and resolves an obvious direct-user update without keeping contradictory active values", () => {
		const { database, life } = fixture();
		const first = life.memory.remember({
			type: "semantic",
			content: "My work address is 10 First Street.",
			structuredData: {
				category: "location",
				conflictKey: "profile:work-address",
			},
			sourceIds: ["message-address-1"],
			sourceType: "direct-user-statement",
			confidence: 1,
			importance: 0.8,
			sensitivity: "sensitive",
			entityIds: [],
			userConfirmed: true,
			inferred: false,
		});
		const second = life.memory.remember({
			type: "semantic",
			content: "My work address is 20 Lake Avenue.",
			structuredData: {
				category: "location",
				conflictKey: "profile:work-address",
			},
			sourceIds: ["message-address-2"],
			sourceType: "direct-user-statement",
			confidence: 1,
			importance: 0.8,
			sensitivity: "sensitive",
			entityIds: [],
			userConfirmed: true,
			inferred: false,
		});
		expect(database.getMemory(first.id)?.status).toBe("superseded");
		expect(database.getMemory(second.id)).toMatchObject({
			status: "active",
			conflictingMemoryIds: [first.id],
		});
		expect(life.memory.versions(first.id)).toHaveLength(1);
		database.close();
	});

	it("maps a direct recurring schedule and applies a Friday exception without duplicating the weekday routine", () => {
		const { database, life } = fixture();
		expect(
			life.captureConversation(
				"I have school every weekday from 8:00 AM to 2:30 PM",
				"message-school-1",
			),
		).toHaveLength(1);
		expect(
			life.captureConversation(
				"School ends at noon on Fridays",
				"message-school-2",
			),
		).toHaveLength(1);
		const events = database.listCalendarEvents();
		expect(events).toHaveLength(2);
		expect(
			events.find((event) => event.recurrenceDays?.includes(1)),
		).toMatchObject({
			title: "school",
			recurrenceDays: [1, 2, 3, 4],
			origin: "explicit",
			confidence: 1,
		});
		expect(
			events.find((event) => event.recurrenceDays?.includes(5)),
		).toMatchObject({
			recurrenceDays: [5],
			origin: "explicit",
			confidenceReason: "Mapped from a direct user statement.",
		});
		database.close();
	});

	it("normalizes and idempotently refreshes Google Calendar detail", async () => {
		let calls = 0;
		const google = {
			email: "owner@example.com",
			listEvents: async () => {
				calls += 1;
				return {
					calendar: "primary",
					items: [
						{
							id: "provider-event",
							title: "Project review",
							start: "2026-07-30T15:00:00.000Z",
							end: "2026-07-30T16:00:00.000Z",
							status: "confirmed",
							location: "Room 4",
							meetingUrl: "https://meet.google.com/abc-defg-hij",
							description: "Bring the revised brief.",
							attendees: [
								{
									email: "teammate@example.com",
									responseStatus: "accepted",
								},
							],
							recurrenceRule: "RRULE:FREQ=WEEKLY",
						},
					],
				};
			},
		} as unknown as GoogleWorkspaceClient;
		const { database, life } = fixture(
			new Date("2026-07-29T14:00:00.000Z"),
			google,
		);
		const range = {
			startsAt: "2026-07-29T00:00:00.000Z",
			endsAt: "2026-08-05T00:00:00.000Z",
		};
		const imported = await life.syncGoogle(range.startsAt, range.endsAt);
		await life.syncGoogle(range.startsAt, range.endsAt);
		expect(calls).toBe(2);
		expect(database.listCalendarEvents()).toMatchObject([
			{
				id: "calendar-google-provider-event",
				providerId: "google",
				origin: "provider",
				location: "Room 4",
				meetingUrl: "https://meet.google.com/abc-defg-hij",
				attendees: [
					{
						email: "teammate@example.com",
						responseStatus: "accepted",
					},
				],
			},
		]);
		expect(
			database.getCalendarSyncState<{ eventCount: number }>("google"),
		).toMatchObject({ eventCount: 1 });
		expect(() => life.deleteLocalEvent(imported[0]!.id)).toThrow(
			"approval-gated provider action",
		);
		database.close();
	});

	it("decays and archives stale context instead of deleting it", () => {
		const { database, life } = fixture(new Date("2025-01-01T12:00:00.000Z"));
		const memory = life.memory.remember({
			type: "project",
			content: "A temporary prototype from last year.",
			structuredData: { category: "projects" },
			sourceIds: ["message-old-project"],
			sourceType: "direct-user-statement",
			confidence: 1,
			importance: 0.1,
			sensitivity: "personal",
			entityIds: [],
			userConfirmed: true,
			inferred: false,
		});
		const person = life.upsertPerson({
			displayName: "Former Collaborator",
			relationship: "Former teammate",
			sourceId: "message-old-person",
			sensitivity: "personal",
		});
		database.upsertPerson({ ...person, relevanceScore: 0.2 });

		const later = new LifeContextService(
			database,
			undefined,
			() => new Date("2027-01-15T12:00:00.000Z"),
		);
		later.maintain();

		expect(database.getMemory(memory.id)).toMatchObject({
			status: "active",
			layer: "archived",
		});
		expect(database.getPerson(person.id)).toMatchObject({
			status: "archived",
		});
		database.close();
	});

	it("deletes a person and every directly related memory while preserving unrelated records", () => {
		const { database, life } = fixture();
		const person = life.upsertPerson({
			displayName: "Morgan",
			relationship: "Former teammate",
			sourceId: "message-person",
			sensitivity: "personal",
		});
		const related = life.memory.remember({
			type: "relationship",
			content: "Morgan prefers review notes in email.",
			structuredData: { category: "people" },
			sourceIds: ["message-related"],
			sourceType: "direct-user-statement",
			confidence: 1,
			importance: 0.7,
			sensitivity: "personal",
			entityIds: [person.id],
			relatedPersonIds: [person.id],
			userConfirmed: true,
			inferred: false,
		});
		const unrelated = life.memory.remember({
			type: "semantic",
			content: "Use metric units in reports.",
			structuredData: { category: "preferences" },
			sourceIds: ["message-unrelated"],
			sourceType: "direct-user-statement",
			confidence: 1,
			importance: 0.7,
			sensitivity: "personal",
			entityIds: [],
			userConfirmed: true,
			inferred: false,
		});
		life.deletePerson(person.id);
		expect(database.getPerson(person.id)).toBeUndefined();
		expect(database.getMemory(related.id)).toBeUndefined();
		expect(database.getMemory(unrelated.id)).toBeDefined();
		database.close();
	});
});
