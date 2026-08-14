import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import { installMemoryTools, MemoryManager } from "./memory";
import { AgentRuntime } from "./runtime";

describe("durable memory manager", () => {
	it("captures only explicit memories and keeps inferred user facts proposed until review", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const manager = new MemoryManager(
			database,
			() => new Date("2026-07-22T22:00:00.000Z"),
		);
		expect(
			manager.captureExplicit("The sky is blue", "message-1").memory,
		).toBeUndefined();
		const captured = manager.captureExplicit(
			"Remember that I keep deployment notes in ops.md",
			"message-2",
		);
		expect(captured.memory).toMatchObject({
			content: "I keep deployment notes in ops.md",
			userConfirmed: true,
			inferred: false,
			sourceIds: ["message-2"],
		});
		const proposed = manager.captureExplicit(
			"I prefer compact status updates",
			"message-3",
		).userModelFacts[0]!;
		expect(proposed.status).toBe("proposed");
		expect(manager.userModel.promptContext()).toBe("");
		manager.userModel.review(proposed.id, "confirm");
		expect(manager.userModel.promptContext()).toContain(
			"compact status updates",
		);
		expect(manager.search("deployment note")).toMatchObject([
			{ id: captured.memory?.id },
		]);
		expect(manager.search("deployment note", Number.NaN)).toMatchObject([
			{ id: captured.memory?.id },
		]);
		expect(
			manager.correct(captured.memory!.id, {
				content: "Deployment notes belong in RELEASE.md",
				type: "project",
				sensitivity: "sensitive",
			}),
		).toMatchObject({
			content: "Deployment notes belong in RELEASE.md",
			type: "project",
			sensitivity: "sensitive",
			userConfirmed: true,
			inferred: false,
			sourceType: "user-correction",
		});
		expect(
			manager.list().find((memory) => memory.id === captured.memory?.id)
				?.structuredData,
		).toMatchObject({ correctionCount: 1 });
		expect(
			manager.list().find((memory) => memory.id === captured.memory?.id)
				?.structuredData,
		).not.toHaveProperty("previousContent");
		expect(manager.versions(captured.memory!.id)[0]?.content).toBe(
			"I keep deployment notes in ops.md",
		);
		expect(manager.forget(captured.memory!.id).status).toBe("deleted");
		expect(
			manager.list().some((memory) => memory.id === captured.memory?.id),
		).toBe(false);
		database.close();
	});

	it("exposes approval-gated memory mutations and ranked cross-session transcript search", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const runtime = new AgentRuntime(database);
		const session = runtime.createSession({ title: "Memory" });
		const other = runtime.createSession({ title: "Other" });
		runtime.appendMessage({
			sessionId: other.id,
			role: "user",
			content: "Deployed the kestrel service successfully",
		});
		expect(runtime.searchMessages("deploy kestrel")).toMatchObject([
			{ sessionId: other.id },
		]);
		expect(runtime.searchMessages("deploying kestrels")).toMatchObject([
			{ sessionId: other.id },
		]);
		expect(runtime.searchMessages("unrelated watercolor recipe")).toEqual([]);
		const manager = new MemoryManager(database);
		installMemoryTools(runtime, manager, session.id);
		const input = {
			type: "project",
			content: "Release checklist",
			sourceIds: ["message-source"],
		};
		expect(
			(
				await runtime.callTool(session.id, "memory.remember", input, {
					idempotencyKey: "remember-1",
				})
			).status,
		).toBe("blocked");
		const stored = await runtime.callTool(
			session.id,
			"memory.remember",
			input,
			{ approvalStatus: "approved", idempotencyKey: "remember-1" },
		);
		expect(stored).toMatchObject({
			status: "verified",
			output: { memory: { content: "Release checklist" } },
		});
		const proposal = await runtime.callTool(
			session.id,
			"memory.user-model-propose",
			{
				kind: "relationship",
				key: "release-reviewer",
				value: "Sam reviews production releases",
				sourceIds: ["message-source"],
				confidence: 0.8,
			},
			{ approvalStatus: "approved", idempotencyKey: "propose-1" },
		);
		expect(proposal).toMatchObject({
			status: "verified",
			output: { fact: { status: "proposed", kind: "relationship" } },
		});
		expect(manager.userModel.promptContext()).toBe("");
		database.close();
	});
});
