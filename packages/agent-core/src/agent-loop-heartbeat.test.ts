import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "./agent-loop";
import { AgentRuntime } from "./runtime";
import { ProviderPool } from "./providers";
import type { ModelProvider } from "./providers";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent-loop heartbeat recovery", () => {
	it("interrupts running work with a live-looking claim when the heartbeat is stale", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-heartbeat-"));
		roots.push(root);
		const databasePath = join(root, "db.sqlite");
		const key = createEncryptionKey();
		const startedAt = "2026-09-21T12:00:00.000Z";
		const later = new Date("2026-09-21T12:10:00.000Z");
		const database = new KestrelDatabase(databasePath, key);
		const runtime = new AgentRuntime(database, [], () => startedAt);
		const session = runtime.createSession({ title: "Stale heartbeat" });
		database.saveAgentRun({
			id: "run-stale-heartbeat",
			sessionId: session.id,
			model: "fixture",
			providerIds: ["local"],
			status: "running",
			turn: 1,
			createdAt: startedAt,
			updatedAt: startedAt,
		});
		expect(
			database.claimIdempotentResult(
				`agent-session-run:${session.id}`,
				"still-looking-alive",
				process.pid,
				{ sessionId: session.id, status: "running" },
			).state,
		).toBe("claimed");
		database.setPrivateState("agent-run-heartbeat.run-stale-heartbeat", {
			updatedAt: "2026-09-21T12:00:00.000Z",
			ownerToken: "still-looking-alive",
			ownerPid: process.pid,
		});
		runtime.close();
		database.close();

		const restarted = new KestrelDatabase(databasePath, key);
		const restartedRuntime = new AgentRuntime(restarted, [], () => later.toISOString());
		const provider: ModelProvider = {
			id: "local",
			defaultModel: "fixture",
			capabilities: {
				streaming: false,
				tools: false,
				images: false,
				audio: false,
				documents: false,
				local: true,
			},
			complete: async () => {
				throw new Error("should not run");
			},
		};
		new AgentLoop(
			restarted,
			restartedRuntime,
			new ProviderPool([provider], () => later),
			() => later,
		);
		expect(restarted.getAgentRun("run-stale-heartbeat")).toMatchObject({
			status: "failed",
			recovery: { reason: "stale_owner", action: "retry_last_turn" },
		});
		restartedRuntime.close();
		restarted.close();
	});
});
