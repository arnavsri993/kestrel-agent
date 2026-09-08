import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import { RoutingOutcomeStore } from "./outcome-store";

describe("RoutingOutcomeStore", () => {
	it("records only bounded routing metadata in encrypted private state", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const store = new RoutingOutcomeStore(database, () => new Date("2026-09-07T12:00:00.000Z"));
		const outcome = store.record({
			taskProfile: "code-review",
			route: { providerId: "openai", accountId: "work", transportId: "responses", modelId: "gpt-5.6-sol" },
			thinkingLevel: "high",
			durationMs: 1234,
			retryCount: 2,
			toolFailureCount: 1,
			escalated: true,
			verifierStatus: "passed",
			success: true,
			costScarcity: "constrained",
		});

		expect(store.list()).toEqual([outcome]);
		const row = database.db.prepare("SELECT value_ciphertext FROM private_runtime_state WHERE key = ?").get("routing.outcomes.v1") as { value_ciphertext: string };
		expect(row.value_ciphertext).not.toContain("code-review");
	});

	it("rejects raw content, secrets, URLs, and malformed persisted records", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const store = new RoutingOutcomeStore(database);
		const secret = "sk-private-token";
		const recorded = store.record({
			taskProfile: `review this prompt ${secret}`,
			route: { providerId: "https://provider.example/v1", accountId: "person@example.com", modelId: secret },
			durationMs: Number.POSITIVE_INFINITY,
		});
		expect(recorded).toEqual(expect.objectContaining({ id: expect.any(String) }));
		expect(JSON.stringify(recorded)).not.toContain(secret);
		expect(recorded.route).toBeUndefined();
		database.setPrivateState("routing.outcomes.v1", [{ id: "bad", prompt: secret }]);
		expect(store.list()).toEqual([]);
	});

	it("rejects common credential formats from private route metadata", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const store = new RoutingOutcomeStore(database);
		for (const identifier of [
			`ghp_${"a".repeat(36)}`,
			`xoxb-${"a".repeat(24)}`,
			`AKIA${"A".repeat(16)}`,
			`AIza${"a".repeat(35)}`,
		]) {
			expect(store.record({ route: { providerId: identifier } }).route).toBeUndefined();
		}
		database.close();
	});

	it("keeps only the configured newest outcomes and lists newest first", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const store = new RoutingOutcomeStore(database, () => new Date(), 2);
		store.record({ taskProfile: "first" });
		store.record({ taskProfile: "second" });
		store.record({ taskProfile: "third" });
		expect(store.list().map((record) => record.taskProfile)).toEqual(["third", "second"]);
	});
});
