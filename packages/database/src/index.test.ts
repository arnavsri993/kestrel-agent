import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEncryptionKey, encryptText } from "@kestrel/encryption";
import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "./index";

const temporaryDirectories: string[] = [];

function sharedDatabases() {
	const directory = mkdtempSync(join(tmpdir(), "kestrel-database-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "kestrel.sqlite");
	const encryptionKey = createEncryptionKey();
	return {
		first: new KestrelDatabase(path, encryptionKey),
		second: new KestrelDatabase(path, encryptionKey),
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("idempotency claims", () => {
	it("coordinates one owner across database connections and preserves the first terminal result", () => {
		const { first, second } = sharedDatabases();
		try {
			expect(
				first.claimIdempotentResult("runtime-tool:one", "owner-one", 101, {
					status: "running",
					id: "first",
				}),
			).toMatchObject({
				state: "claimed",
				claim: {
					ownerToken: "owner-one",
					ownerPid: 101,
					pendingResult: { id: "first" },
				},
			});
			expect(
				second.claimIdempotentResult("runtime-tool:one", "owner-two", 202, {
					status: "running",
					id: "second",
				}),
			).toMatchObject({
				state: "active",
				claim: {
					ownerToken: "owner-one",
					ownerPid: 101,
					pendingResult: { id: "first" },
				},
			});
			expect(() =>
				second.completeIdempotentResult("runtime-tool:one", "owner-two", {
					status: "verified",
					id: "second",
				}),
			).toThrow("not owned");

			expect(
				first.completeIdempotentResult("runtime-tool:one", "owner-one", {
					status: "verified",
					id: "first",
				}),
			).toEqual({
				completed: true,
				result: { status: "verified", id: "first" },
			});
			expect(
				second.claimIdempotentResult("runtime-tool:one", "owner-two", 202, {
					status: "running",
					id: "second",
				}),
			).toEqual({
				state: "completed",
				result: { status: "verified", id: "first" },
			});
			expect(
				second.completeIdempotentResult("runtime-tool:one", "owner-two", {
					status: "verified",
					id: "second",
				}),
			).toEqual({
				completed: false,
				result: { status: "verified", id: "first" },
			});
			expect(first.listIdempotentClaims()).toEqual([]);
		} finally {
			first.close();
			second.close();
		}
	});

	it("releases only the matching owner claim so a safe pre-effect retry can acquire it", () => {
		const { first, second } = sharedDatabases();
		try {
			expect(
				first.claimIdempotentResult("runtime-tool:released", "owner-one", 101, {
					status: "running",
				}).state,
			).toBe("claimed");
			expect(
				second.releaseIdempotentClaim("runtime-tool:released", "owner-two"),
			).toBe(false);
			expect(
				first.releaseIdempotentClaim("runtime-tool:released", "owner-one"),
			).toBe(true);
			expect(
				second.claimIdempotentResult(
					"runtime-tool:released",
					"owner-two",
					202,
					{ status: "running" },
				).state,
			).toBe("claimed");
		} finally {
			first.close();
			second.close();
		}
	});

	it("terminalizes an abandoned claim and refuses a late owner overwrite", () => {
		const { first, second } = sharedDatabases();
		try {
			first.claimIdempotentResult(
				"runtime-tool:abandoned",
				"dead-owner",
				999_999,
				{ status: "running", id: "pending" },
			);
			expect(
				second.listIdempotentClaims<{ status: string; id: string }>(
					"runtime-tool:",
				),
			).toMatchObject([
				{
					key: "runtime-tool:abandoned",
					ownerToken: "dead-owner",
					pendingResult: { id: "pending" },
				},
			]);

			const uncertain = {
				status: "failed",
				id: "pending",
				error: "Outcome is uncertain; the mutation will not be retried.",
			};
			expect(
				second.abandonIdempotentClaim(
					"runtime-tool:abandoned",
					"dead-owner",
					uncertain,
				),
			).toEqual({ completed: true, result: uncertain });
			expect(
				first.completeIdempotentResult("runtime-tool:abandoned", "dead-owner", {
					status: "verified",
					id: "pending",
				}),
			).toEqual({ completed: false, result: uncertain });
			expect(
				first.getIdempotentClaim("runtime-tool:abandoned"),
			).toBeUndefined();
			expect(second.getIdempotentResult("runtime-tool:abandoned")).toEqual(
				uncertain,
			);
		} finally {
			first.close();
			second.close();
		}
	});

	it("keeps the existing completed-result API backward-compatible after migration", () => {
		const { first, second } = sharedDatabases();
		try {
			first.saveIdempotentResult("legacy-key", { accepted: true });
			expect(second.getIdempotentResult("legacy-key")).toEqual({
				accepted: true,
			});
			expect(
				second.claimIdempotentResult("legacy-key", "owner", 303, {
					accepted: false,
				}),
			).toEqual({ state: "completed", result: { accepted: true } });
			expect(
				second.db
					.prepare("SELECT version FROM schema_migrations WHERE version = 7")
					.get(),
			).toEqual({ version: 7 });
			expect(
				second.db
					.prepare("SELECT version FROM schema_migrations WHERE version = 8")
					.get(),
			).toEqual({ version: 8 });
		} finally {
			first.close();
			second.close();
		}
	});
});

describe("context usage", () => {
	it("normalizes malformed list limits before binding the SQL LIMIT", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const bundle = (id: string, createdAt: string) => ({
			id,
			query: "query",
			memories: [],
			people: [],
			events: [],
			influences: [],
			prompt: "prompt",
			createdAt,
		});
		try {
			database.saveContextUsage(
				bundle("context-1", "2026-07-23T00:00:00.000Z"),
			);
			database.saveContextUsage(
				bundle("context-2", "2026-07-23T00:01:00.000Z"),
			);
			expect(database.listContextUsage(Number.NaN)).toHaveLength(2);
			expect(database.listContextUsage(1.9)).toHaveLength(1);
		} finally {
			database.close();
		}
	});
});

describe("retention", () => {
	it("removes encrypted memory dependents before their expired parent", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		database.upsertMemory({
			id: "memory-expired",
			type: "semantic",
			content: "Expired fixture",
			structuredData: {},
			sourceIds: ["source-expired"],
			sourceType: "fixture",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			confidence: 1,
			importance: 0.5,
			sensitivity: "personal",
			status: "active",
			entityIds: [],
			userConfirmed: true,
			inferred: false,
		});
		database.saveMemoryVersion({
			id: "memory-version-expired",
			memoryId: "memory-expired",
			version: 1,
			content: "Expired fixture",
			structuredData: {},
			sourceIds: ["source-expired"],
			sourceType: "fixture",
			changedAt: "2026-01-01T00:00:00.000Z",
			changedBy: "user",
		});

		expect(
			database.enforceRetention("2026-02-01T00:00:00.000Z"),
		).toMatchObject({ memories: 1 });
		expect(database.getMemory("memory-expired")).toBeUndefined();
		expect(database.listMemoryVersions("memory-expired")).toEqual([]);
		database.close();
	});
});

describe("runtime message paging", () => {
	it("returns the newest bounded page and walks backward by message cursor", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const sessionId = "session-paged-transcript";
		database.saveRuntimeSession({
			id: sessionId,
			title: "Paged transcript",
			allowedTools: [],
			status: "active",
			checkpoints: [],
			createdAt: "2026-08-14T10:00:00.000Z",
			updatedAt: "2026-08-14T10:00:00.000Z",
		});
		for (let index = 1; index <= 5; index += 1) {
			database.saveRuntimeMessage({
				id: `message-${index}`,
				sessionId,
				role: index % 2 ? "user" : "assistant",
				content: `Message ${index}`,
				createdAt: `2026-08-14T10:00:0${index}.000Z`,
			});
		}

		try {
			const latest = database.listRuntimeMessagesPage(sessionId, { limit: 2 });
			expect(latest.messages.map((message) => message.id)).toEqual([
				"message-4",
				"message-5",
			]);
			expect(latest.hasMore).toBe(true);

			const earlier = database.listRuntimeMessagesPage(sessionId, {
				beforeMessageId: latest.messages[0]!.id,
				limit: 2,
			});
			expect(earlier.messages.map((message) => message.id)).toEqual([
				"message-2",
				"message-3",
			]);
			expect(earlier.hasMore).toBe(true);

			const first = database.listRuntimeMessagesPage(sessionId, {
				beforeMessageId: earlier.messages[0]!.id,
				limit: 2,
			});
			expect(first.messages.map((message) => message.id)).toEqual(["message-1"]);
			expect(first.hasMore).toBe(false);
			expect(() =>
				database.listRuntimeMessagesPage(sessionId, {
					beforeMessageId: "message-missing",
				}),
			).toThrow("cursor was not found");
		} finally {
			database.close();
		}
	});
});

describe("configuration history recovery", () => {
	it("skips malformed encrypted versions in the recovery view", () => {
		const key = createEncryptionKey();
		const database = new KestrelDatabase(":memory:", key);
		const corrupt = encryptText(JSON.stringify({ id: "not-a-version" }), key);
		database.db
			.prepare(
				`INSERT INTO agent_configuration_records (
          id, kind, status, payload_ciphertext, payload_iv,
          payload_auth_tag, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"corrupt-version",
				"version",
				"verified",
				corrupt.ciphertext,
				corrupt.iv,
				corrupt.authTag,
				"2026-07-29T12:00:00.000Z",
				"2026-07-29T12:00:00.000Z",
			);

		expect(database.listValidAgentConfigurationVersions()).toEqual([]);
		expect(() => database.listAgentConfigurationVersions()).toThrow();
		database.close();
	});
});

describe("tool execution history queries", () => {
	it("filters tool executions at the database boundary", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const sessionId = "session-tool-history";
		const common = {
			sessionId,
			toolName: "fixture.tool",
			status: "verified" as const,
			riskLevel: "low" as const,
			input: {},
			output: { ok: true },
		};
		database.saveRuntimeSession({
			id: sessionId,
			title: "Tool history",
			allowedTools: ["fixture.tool"],
			status: "active",
			checkpoints: [],
			createdAt: "2026-07-29T10:00:00.000Z",
			updatedAt: "2026-07-29T10:00:00.000Z",
		});
		database.saveToolExecution({
			...common,
			id: "tool-old",
			startedAt: "2026-07-29T10:00:00.000Z",
			completedAt: "2026-07-29T10:00:01.000Z",
		});
		database.saveToolExecution({
			...common,
			id: "tool-recent",
			startedAt: "2026-07-29T11:00:00.000Z",
			completedAt: "2026-07-29T11:00:01.000Z",
		});

		expect(
			database
				.listAllToolExecutions("2026-07-29T11:00:00.000Z")
				.map((item) => item.id),
		).toEqual(["tool-recent"]);
		database.close();
	});

	it("lists waiting agent runs across sessions", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const sessionId = "session-waiting";
		database.saveRuntimeSession({
			id: sessionId,
			title: "Waiting run",
			allowedTools: ["fixture.tool"],
			status: "active",
			checkpoints: [],
			createdAt: "2026-08-19T12:00:00.000Z",
			updatedAt: "2026-08-19T12:00:00.000Z",
		});
		database.saveAgentRun({
			id: "run-complete",
			sessionId,
			model: "fixture",
			providerIds: ["fixture"],
			status: "completed",
			turn: 1,
			createdAt: "2026-08-19T12:00:00.000Z",
			updatedAt: "2026-08-19T12:01:00.000Z",
		});
		database.saveAgentRun({
			id: "run-waiting",
			sessionId,
			model: "fixture",
			providerIds: ["fixture"],
			status: "waiting_approval",
			turn: 1,
			pendingToolExecutionId: "tool-blocked",
			createdAt: "2026-08-19T12:02:00.000Z",
			updatedAt: "2026-08-19T12:03:00.000Z",
		});
		expect(database.listWaitingAgentRuns().map((run) => run.id)).toEqual([
			"run-waiting",
		]);
		database.close();
	});
});

describe("runtime history retirement", () => {
	it("atomically retires active runs and their approval executions without releasing an in-flight idempotency claim", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const sessionId = "session-rollback";
		const runId = "run-rollback";
		const startedAt = "2026-07-22T18:00:00.000Z";
		const completedAt = "2026-07-22T18:01:00.000Z";
		const reason = "Approval invalidated because history was rolled back.";
		try {
			database.saveRuntimeSession({
				id: sessionId,
				title: "Rollback fixture",
				allowedTools: ["test.mutation"],
				status: "active",
				checkpoints: [],
				createdAt: startedAt,
				updatedAt: startedAt,
			});
			database.saveAgentRun({
				id: runId,
				sessionId,
				model: "fixture",
				providerIds: ["fixture"],
				status: "waiting_approval",
				turn: 1,
				pendingToolExecutionId: "tool-blocked",
				pendingProviderToolCallId: "call-blocked",
				pendingToolName: "test.mutation",
				createdAt: startedAt,
				updatedAt: startedAt,
			});
			database.saveToolExecution({
				id: "tool-blocked",
				sessionId,
				toolName: "test.mutation",
				status: "blocked",
				riskLevel: "sensitive",
				input: { target: "pending" },
				output: { approvalRequired: true, preview: "Pending mutation" },
				error: "Approval required.",
				idempotencyKey: `${runId}:call-blocked`,
				startedAt,
				completedAt: startedAt,
			});
			const runningStartedAt = "2026-07-22T18:00:30.000Z";
			const runningExecution = {
				id: "tool-running",
				sessionId,
				toolName: "test.mutation",
				status: "running" as const,
				riskLevel: "sensitive" as const,
				input: { target: "in-flight" },
				idempotencyKey: `${runId}:call-running`,
				startedAt: runningStartedAt,
			};
			database.saveToolExecution(runningExecution);
			const claimKey = `runtime-tool:${sessionId}:test.mutation:${runId}:call-running`;
			expect(
				database.claimIdempotentResult(
					claimKey,
					"runtime-owner",
					process.pid,
					runningExecution,
				).state,
			).toBe("claimed");

			database.db.exec(`
        CREATE TRIGGER fail_history_retirement
        BEFORE UPDATE OF status ON tool_executions
        WHEN OLD.id = 'tool-blocked'
        BEGIN
          SELECT RAISE(ABORT, 'fixture retirement failure');
        END;
      `);
			expect(() =>
				database.retireActiveAgentHistory(sessionId, completedAt, reason),
			).toThrow("fixture retirement failure");
			expect(database.getAgentRun(runId)).toMatchObject({
				status: "waiting_approval",
				pendingToolExecutionId: "tool-blocked",
			});
			expect(database.getToolExecution("tool-blocked")).toMatchObject({
				status: "blocked",
				output: { approvalRequired: true },
			});
			expect(database.getToolExecution("tool-running")).toMatchObject({
				status: "running",
			});
			database.db.exec("DROP TRIGGER fail_history_retirement");

			expect(
				database.retireActiveAgentHistory(sessionId, completedAt, reason),
			).toMatchObject({
				runs: [
					{
						id: runId,
						status: "cancelled",
						error: reason,
					},
				],
				toolExecutions: [
					{
						id: "tool-blocked",
						status: "cancelled",
						output: { approvalRequired: false },
					},
					{
						id: "tool-running",
						status: "failed",
						error: expect.stringContaining(
							"outcome is uncertain and it will not be retried automatically",
						),
					},
				],
			});
			expect(database.getAgentRun(runId)).not.toHaveProperty(
				"pendingToolExecutionId",
			);
			expect(database.getIdempotentClaim(claimKey)).toMatchObject({
				ownerToken: "runtime-owner",
				pendingResult: { id: "tool-running", status: "running" },
			});
		} finally {
			database.close();
		}
	});
});

describe("browser activity ledger", () => {
	function event(
		overrides: Partial<{
			id: string;
			ownerSessionId: string;
			title: string;
			url: string;
		}> = {},
	) {
		return {
			id:
				overrides.id ??
				"browser-activity-00000000-0000-4000-8000-000000000001",
			ownerSessionId: overrides.ownerSessionId ?? "session-a",
			surface: "autonomous" as const,
			toolName: "browser.act" as const,
			toolExecutionId: "tool-1",
			target: {
				kind: "session" as const,
				browserSessionId: "browser-1",
			},
			intent: { type: "click" as const, target: "#save" },
			approval: { required: true, result: "approved" as const },
			observation: {
				before: {
					url: overrides.url ?? "https://example.test/",
					title: overrides.title ?? "Example",
				},
				after: { url: "https://example.test/done", title: "Done" },
				added: 0,
				removed: 0,
				changed: 1,
				truncated: (overrides.title?.length ?? 0) > 500,
				trust: "untrusted_browser" as const,
			},
			outcome: "performed" as const,
			createdAt: "2026-08-19T18:00:00.000Z",
			completedAt: "2026-08-19T18:00:01.000Z",
			trust: "untrusted_browser" as const,
		};
	}

	it("is append-only for a given activity id", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const first = event();
		database.appendBrowserActivity(first);
		expect(() => database.appendBrowserActivity(first)).toThrow();
		expect(
			database.listBrowserActivity({ ownerSessionId: "session-a" }),
		).toHaveLength(1);
		database.close();
	});

	it("stores ciphertext that does not contain page titles", () => {
		const { first, second } = sharedDatabases();
		try {
			first.appendBrowserActivity(
				event({
					title: "Secret research title",
					url: "https://secret.example/path",
				}),
			);
			const row = first.db
				.prepare("SELECT payload_ciphertext FROM browser_activity_events")
				.get() as { payload_ciphertext: string };
			expect(row.payload_ciphertext).not.toContain("Secret research title");
			expect(row.payload_ciphertext).not.toContain("secret.example");
			expect(
				second.listBrowserActivity({ ownerSessionId: "session-a" })[0],
			).toMatchObject({
				observation: { before: { title: "Secret research title" } },
			});
		} finally {
			first.close();
			second.close();
		}
	});

	it("lists only the requested owner session", () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		database.appendBrowserActivity(event({ ownerSessionId: "session-a" }));
		database.appendBrowserActivity(
			event({
				id: "browser-activity-00000000-0000-4000-8000-000000000002",
				ownerSessionId: "session-b",
			}),
		);
		expect(
			database.listBrowserActivity({ ownerSessionId: "session-a" }),
		).toHaveLength(1);
		expect(
			database.listBrowserActivity({ ownerSessionId: "session-b" })[0]
				?.ownerSessionId,
		).toBe("session-b");
		database.close();
	});
});
