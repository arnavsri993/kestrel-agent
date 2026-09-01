import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import type { AgentRun } from "@kestrel/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime";

const temporaryDirectories: string[] = [];

function runFor(sessionId: string, id: string, status: AgentRun["status"] = "running"): AgentRun {
	return {
		id,
		sessionId,
		model: "fixture-model",
		providerIds: ["fixture-provider"],
		status,
		turn: 0,
		createdAt: "2026-08-31T10:00:00.000Z",
		updatedAt: "2026-08-31T10:00:00.000Z",
	};
}

function fixture() {
	let current = new Date("2026-08-31T10:00:00.000Z");
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	const runtime = new AgentRuntime(
		database,
		[],
		() => current.toISOString(),
	);
	const session = runtime.createSession({ title: "Human input" });
	const run = runFor(session.id, "run-human-input");
	database.saveAgentRun(run);
	return {
		database,
		runtime,
		session,
		run,
		advance(milliseconds: number) {
			current = new Date(current.getTime() + milliseconds);
		},
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("structured human input", () => {
	it("supports single choice, multi-choice, free text, Skip, and one-shot answers", () => {
		const { database, runtime, session, run } = fixture();
		try {
			const single = runtime.createHumanInputRequest({
				sessionId: session.id,
				runId: run.id,
				prompt: "Choose a release channel",
				context: "This only changes the proposed release plan.",
				options: [
					{ id: "stable", label: "Stable", description: "Use the tested channel." },
					{ id: "beta", label: "Beta" },
				],
				selectionMode: "single",
				allowFreeText: false,
				allowSkip: true,
			});
			expect(single).toMatchObject({
				status: "waiting",
				sessionId: session.id,
				runId: run.id,
				options: [{ id: "stable" }, { id: "beta" }],
			});
			expect(database.getAgentRun(run.id)?.status).toBe("waiting_input");

			const answered = runtime.answerHumanInput({
				requestId: single.id,
				runId: run.id,
				answer: { kind: "single_choice", optionId: "stable" },
			});
			expect(answered).toMatchObject({
				status: "answered",
				answer: { kind: "single_choice", optionId: "stable" },
			});
			expect(database.getAgentRun(run.id)?.status).toBe("running");
			expect(() =>
				runtime.answerHumanInput({
					requestId: single.id,
					runId: run.id,
					answer: { kind: "single_choice", optionId: "beta" },
				}),
			).toThrow("answered");

			database.saveAgentRun({ ...run, status: "running" });
			const multiple = runtime.createHumanInputRequest({
				sessionId: session.id,
				runId: run.id,
				prompt: "Choose the review lenses",
				options: [
					{ id: "security", label: "Security" },
					{ id: "ux", label: "UX" },
					{ id: "docs", label: "Docs" },
				],
				selectionMode: "multiple",
				allowFreeText: false,
				allowSkip: false,
			});
			const multipleAnswer = runtime.answerHumanInput({
				requestId: multiple.id,
				runId: run.id,
				answer: { kind: "multi_choice", optionIds: ["security", "ux"] },
			});
			expect(multipleAnswer).toMatchObject({
				status: "answered",
				answer: { kind: "multi_choice", optionIds: ["security", "ux"] },
			});

			database.saveAgentRun({ ...run, status: "running" });
			const freeText = runtime.createHumanInputRequest({
				sessionId: session.id,
				runId: run.id,
				prompt: "Add a note for the plan",
				allowFreeText: true,
				allowSkip: true,
			});
			const textAnswer = runtime.answerHumanInput({
				requestId: freeText.id,
				runId: run.id,
				answer: { kind: "free_text", text: "Keep the rollout reversible." },
			});
			expect(textAnswer).toMatchObject({
				status: "answered",
				answer: { kind: "free_text", text: "Keep the rollout reversible." },
			});

			database.saveAgentRun({ ...run, status: "running" });
			const skippable = runtime.createHumanInputRequest({
				sessionId: session.id,
				runId: run.id,
				prompt: "Optional context",
				allowFreeText: true,
				allowSkip: true,
			});
			const skipped = runtime.answerHumanInput({
				requestId: skippable.id,
				runId: run.id,
				answer: { kind: "skip" },
			});
			expect(skipped).toMatchObject({ status: "skipped", answer: { kind: "skip" } });
		} finally {
			database.close();
		}
	});

	it("rejects stale, replaced, cancelled, completed, and invalid answers", () => {
		const { database, runtime, session, run } = fixture();
		try {
			const first = runtime.createHumanInputRequest({
				sessionId: session.id,
				runId: run.id,
				prompt: "First question",
				allowFreeText: true,
				allowSkip: true,
			});
			// A resumed run may replace a persisted question before pausing again.
			database.saveAgentRun({ ...run, status: "running" });
			const replacement = runtime.createHumanInputRequest({
				sessionId: session.id,
				runId: run.id,
				prompt: "Replacement question",
				allowFreeText: true,
				allowSkip: true,
			});
			expect(runtime.listHumanInputRequests(session.id)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: first.id, status: "replaced" }),
					expect.objectContaining({ id: replacement.id, status: "waiting" }),
				]),
			);
			expect(() =>
				runtime.answerHumanInput({
					requestId: first.id,
					runId: run.id,
					answer: { kind: "free_text", text: "stale" },
				}),
			).toThrow("replaced");
			expect(() =>
				runtime.answerHumanInput({
					requestId: replacement.id,
					runId: "another-run",
					answer: { kind: "free_text", text: "wrong owner" },
				}),
			).toThrow("does not belong");

			const cancelled = runtime.cancelHumanInput(replacement.id, run.id);
			expect(cancelled.status).toBe("cancelled");
			expect(database.getAgentRun(run.id)).toMatchObject({ status: "cancelled" });
			expect(() =>
				runtime.answerHumanInput({
					requestId: replacement.id,
					runId: run.id,
					answer: { kind: "free_text", text: "too late" },
				}),
			).toThrow("cancelled");

			database.saveAgentRun({ ...run, id: "run-completed", status: "running" });
			const completed = runtime.createHumanInputRequest({
				sessionId: session.id,
				runId: "run-completed",
				prompt: "Completed run question",
				allowFreeText: true,
				allowSkip: false,
			});
			database.saveAgentRun({ ...run, id: "run-completed", status: "completed" });
			expect(() =>
				runtime.answerHumanInput({
					requestId: completed.id,
					runId: "run-completed",
					answer: { kind: "free_text", text: "completed" },
				}),
			).toThrow("completed");
			expect(runtime.listHumanInputRequests(session.id)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: completed.id, status: "completed" }),
				]),
			);
		} finally {
			database.close();
		}
	});

	it("times out a request without leaving its owning run falsely waiting", () => {
		const { database, runtime, session, run, advance } = fixture();
		try {
			const request = runtime.createHumanInputRequest({
				sessionId: session.id,
				runId: run.id,
				prompt: "Answer before the deadline",
				allowFreeText: true,
				allowSkip: false,
				timeoutMs: 1_000,
			});
			advance(1_001);
			expect(runtime.listHumanInputRequests(session.id)).toEqual([
				expect.objectContaining({
					id: request.id,
					status: "timed_out",
				}),
			]);
			expect(database.getAgentRun(run.id)).toMatchObject({
				status: "failed",
				error: "Human input timed out.",
			});
			expect(() =>
				runtime.answerHumanInput({
					requestId: request.id,
					runId: run.id,
					answer: { kind: "free_text", text: "late" },
				}),
			).toThrow("timed_out");
		} finally {
			database.close();
		}
	});

	it("restores a legitimate waiting request but not authority from a completed run", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-human-input-restart-"));
		temporaryDirectories.push(root);
		const path = join(root, "runtime.sqlite");
		const key = createEncryptionKey();
		const database = new KestrelDatabase(path, key);
		const runtime = new AgentRuntime(database, [], () => "2026-08-31T10:00:00.000Z");
		const session = runtime.createSession({ title: "Restarted input" });
		const run = runFor(session.id, "run-restart");
		database.saveAgentRun(run);
		const waiting = runtime.createHumanInputRequest({
			sessionId: session.id,
			runId: run.id,
			prompt: "Survive a restart",
			allowFreeText: true,
			allowSkip: true,
		});
		runtime.close();
		database.close();

		const restartedDatabase = new KestrelDatabase(path, key);
		const restarted = new AgentRuntime(
			restartedDatabase,
			[],
			() => "2026-08-31T10:00:00.000Z",
		);
		try {
			expect(restarted.listHumanInputRequests(session.id)).toEqual([
				expect.objectContaining({ id: waiting.id, status: "waiting" }),
			]);
			expect(
				restarted.answerHumanInput({
					requestId: waiting.id,
					runId: run.id,
					answer: { kind: "skip" },
				}),
			).toMatchObject({ status: "skipped" });

			restartedDatabase.saveAgentRun({ ...run, status: "running", id: "run-invalid-after-restart" });
			const invalid = restarted.createHumanInputRequest({
				sessionId: session.id,
				runId: "run-invalid-after-restart",
				prompt: "Do not revive this",
				allowFreeText: true,
				allowSkip: false,
			});
			restartedDatabase.saveAgentRun({
				...run,
				id: "run-invalid-after-restart",
				status: "completed",
			});
			expect(() =>
				restarted.answerHumanInput({
					requestId: invalid.id,
					runId: "run-invalid-after-restart",
					answer: { kind: "free_text", text: "must reject" },
				}),
			).toThrow("completed");
		} finally {
			restarted.close();
			restartedDatabase.close();
		}
	});

	it("keeps consequential actions behind separate approval after an answer", async () => {
		const { database, runtime, session, run } = fixture();
		let executions = 0;
		try {
			runtime.registerExternalTool({
				descriptor: {
					name: "fixture.consequential-action",
					title: "Consequential fixture action",
					description: "A mutation used to verify separate approval.",
					category: "connector",
					riskLevel: "sensitive",
					readOnly: false,
					requiresWorkspace: false,
					source: "builtin",
					tags: ["test"],
				},
				inputSchema: { type: "object", additionalProperties: false },
				execute: async () => {
					executions += 1;
					return { changed: true };
				},
			});
			runtime.allowTool(session.id, "fixture.consequential-action");
			const request = runtime.createHumanInputRequest({
				sessionId: session.id,
				runId: run.id,
				prompt: "Confirm the proposed action",
				allowFreeText: true,
				allowSkip: false,
			});
			runtime.answerHumanInput({
				requestId: request.id,
				runId: run.id,
				answer: { kind: "free_text", text: "The plan looks good." },
			});

			expect(
				await runtime.callTool(
					session.id,
					"fixture.consequential-action",
					{},
					{ idempotencyKey: "human-input-does-not-approve" },
				),
			).toMatchObject({ status: "blocked" });
			expect(executions).toBe(0);
			expect(
				await runtime.callTool(
					session.id,
					"fixture.consequential-action",
					{},
					{
						approvalStatus: "approved",
						idempotencyKey: "human-input-separate-approval",
					},
				),
			).toMatchObject({ status: "verified", output: { changed: true } });
			expect(executions).toBe(1);
		} finally {
			database.close();
		}
	});
});
