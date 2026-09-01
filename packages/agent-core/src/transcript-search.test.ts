import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime, normalizeTranscriptText } from "./runtime";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("local transcript search behavior", () => {
	it("searches eligible conversations locally and restores exact results after restart", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-transcript-search-"));
		temporaryDirectories.push(root);
		const databasePath = join(root, "runtime.sqlite");
		const encryptionKey = createEncryptionKey();
		const createdAt = "2026-08-31T10:00:00.000Z";
		const database = new KestrelDatabase(databasePath, encryptionKey);
		const runtime = new AgentRuntime(database, [], () => createdAt);
		const standard = runtime.createSession({ title: "Release notes" });
		const other = runtime.createSession({ title: "Other conversation" });
		const privateSession = runtime.createSession({
			title: "Private notes",
			privacyMode: "private",
		});
		const incognitoSession = runtime.createSession({
			title: "Incognito notes",
			privacyMode: "incognito",
		});
		const forgotten = runtime.createSession({ title: "Forgotten notes" });
		const matchingContent =
			"Deploy the cafe\u0301 deployment to staging after the release review. " +
			"This sentence is intentionally long enough to exercise the bounded preview.";
		const matching = runtime.appendMessage({
			sessionId: standard.id,
			role: "user",
			content: matchingContent,
		});
		runtime.appendMessage({
			sessionId: other.id,
			role: "assistant",
			content: "This is another unrelated conversation about calendars.",
		});
		runtime.appendMessage({
			sessionId: privateSession.id,
			role: "user",
			content: "Deploy the cafe\u0301 deployment privately.",
		});
		runtime.appendMessage({
			sessionId: incognitoSession.id,
			role: "user",
			content: "Deploy the cafe\u0301 deployment incognito.",
		});
		runtime.appendMessage({
			sessionId: forgotten.id,
			role: "user",
			content: "Deploy the cafe\u0301 deployment in a forgotten conversation.",
		});
		runtime.forgetSession(forgotten.id);
		const hiddenSessionIds = new Set([
			privateSession.id,
			incognitoSession.id,
			forgotten.id,
		]);

		const providerRequest = vi.spyOn(globalThis, "fetch");
		try {
			const results = runtime.searchTranscript("CAFÉ deployment", 20);
			expect(providerRequest).not.toHaveBeenCalled();
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({
				messageId: matching.id,
				sessionId: standard.id,
				sessionTitle: "Release notes",
				role: "user",
			});
			expect(results[0]!.preview).toContain("café deployment");
			expect(results[0]!.preview.length).toBeLessThanOrEqual(400);
			expect(results[0]!.matchStart).toBe(
				normalizeTranscriptText(matchingContent).indexOf("café deployment"),
		);
			expect(results[0]!.matchLength).toBe("café deployment".length);

			// The renderer's exact-message target is a durable identity, not a search
			// snippet: loading the conversation reaches the matching message by ID.
			const loaded = runtime.listMessagesPage(standard.id, { limit: 100 });
			expect(loaded.messages.find((message) => message.id === matching.id)).toEqual(
				matching,
			);
		// Search is intentionally scoped before ranking, so hidden records can
		// never appear as semantic fallbacks for a matching standard conversation.
		expect(
			runtime
				.searchTranscript("café deployment")
				.some((result) => hiddenSessionIds.has(result.sessionId)),
		).toBe(false);
		} finally {
			providerRequest.mockRestore();
		}
		runtime.close();
		database.close();

		const restartedDatabase = new KestrelDatabase(databasePath, encryptionKey);
		const restarted = new AgentRuntime(restartedDatabase, [], () => createdAt);
		try {
			const restored = restarted.searchTranscript("café deployment");
			expect(restored).toHaveLength(1);
			expect(restored[0]).toMatchObject({
				messageId: matching.id,
				sessionId: standard.id,
				sessionTitle: "Release notes",
			});
			expect(
				restarted
					.listMessagesPage(standard.id, { limit: 100 })
					.messages.some((message) => message.id === restored[0]!.messageId),
			).toBe(true);
			expect(
			restarted
				.searchTranscript("café deployment")
				.every((result) => !hiddenSessionIds.has(result.sessionId)),
		).toBe(true);
		} finally {
			restarted.close();
			restartedDatabase.close();
		}
	});
});
