import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createEncryptionKey, decryptText, encryptText } from "@kestrel/encryption";
import { expect, it } from "vitest";
import { KestrelDatabase } from "./index";
import { createHostProfileTransferSnapshot } from "./profile-transfer";

const timestamp = "2026-11-02T12:00:00.000Z";

it.each(["legacy-json", "protected"])("projects deleted source evidence from a read-only %s legacy database without rewriting it", encoding => {
	const temporary = mkdtempSync(join(tmpdir(), "kestrel-readonly-deletion-"));
	const file = join(temporary, "source.sqlite"), key = createEncryptionKey(), targetKey = createEncryptionKey();
	let source: KestrelDatabase | undefined, reader: Database.Database | undefined, target: KestrelDatabase | undefined;
	try {
		source = new KestrelDatabase(file, key);
		source.saveRuntimeSession({ id: "source-session", title: "Generated deletion fixture", allowedTools: [], status: "active", checkpoints: [], createdAt: timestamp, updatedAt: timestamp });
		const privateText = "GENERATED_DELETED_SOURCE_CONTENT_MUST_NOT_TRANSFER";
		source.upsertTimelineEvent({ id: "deleted-event", startedAt: timestamp, eventType: "note", source: "connected-source", actor: "user", projectIds: [], personIds: [], entityIds: [], textSummary: privateText, structuredData: {}, importance: 0.5, sensitivity: "personal", retentionPolicy: "durable", embeddingStatus: "not_requested", status: "active", createdAt: timestamp, updatedAt: timestamp });
		const receipt = { id: "deleted-receipt", sessionId: "source-session", toolName: "sources.read", status: "verified" as const, riskLevel: "low" as const, input: {}, output: { events: [{ id: "deleted-event", text: privateText }] }, startedAt: timestamp };
		source.saveToolExecution(receipt);
		source.saveIdempotentResult("stale-replay", receipt);
		source.saveIdempotentResult("unrelated-result", { ...receipt, id: "retained-receipt", output: { text: "Retained source" }, opaqueMetadata: { retained: true } });
		source.saveIdempotentResult("literal-result", { toolName: "sources.read", id: receipt.id, literal: "Retained generic JSON" });
		for (const message of [
			{ id: "linked-tool", role: "tool" as const, toolExecutionId: receipt.id },
			{ id: "linked-derived", role: "assistant" as const, sourceToolExecutionIds: [receipt.id] },
			{ id: "legacy-unlinked", role: "assistant" as const },
		]) source.saveRuntimeMessage({ ...message, sessionId: receipt.sessionId, content: privateText, createdAt: timestamp });
		const legacyBody = encryptText(privateText, key);
		source.db.prepare("UPDATE runtime_messages SET content_ciphertext = ?, content_iv = ?, content_auth_tag = ? WHERE id = 'legacy-unlinked'").run(legacyBody.ciphertext, legacyBody.iv, legacyBody.authTag);
		source.saveRuntimeMessage({ id: "earlier-unrelated", sessionId: receipt.sessionId, role: "assistant", content: "Retained earlier assistant text", createdAt: "2026-11-02T11:59:00.000Z" });
		source.saveRuntimeMessage({ id: "explicit-unrelated", sessionId: receipt.sessionId, role: "assistant", sourceToolExecutionIds: ["retained-receipt"], content: "Retained unrelated source text", createdAt: timestamp });
		const staleMessages = source.db.prepare("SELECT * FROM runtime_messages WHERE id IN ('linked-tool', 'linked-derived', 'legacy-unlinked')").all() as Array<Record<string, string>>;
		const staleTerms = source.db.prepare("SELECT * FROM runtime_message_terms WHERE message_id IN ('linked-tool', 'linked-derived', 'legacy-unlinked')").all() as Array<{ message_id: string; term_hash: string }>;
		const staleTool = source.db.prepare("SELECT payload FROM tool_executions WHERE id = ?").get(receipt.id) as { payload: string };
		const staleCache = source.db.prepare("SELECT result FROM idempotency_keys WHERE key = 'stale-replay'").get() as { result: string };
		source.deleteTimelineEvent("deleted-event");
		// Model an old source whose deletion marker exists but whose journals and
		// linked messages have not received today's startup reconciliation.
		source.db.prepare("UPDATE tool_executions SET payload = ?, status = 'verified' WHERE id = ?").run(encoding === "legacy-json" ? JSON.stringify(receipt) : staleTool.payload, receipt.id);
		source.db.prepare("UPDATE idempotency_keys SET result = ? WHERE key = 'stale-replay'").run(encoding === "legacy-json" ? JSON.stringify(receipt) : staleCache.result);
		for (const message of staleMessages) source.db.prepare("UPDATE runtime_messages SET content_ciphertext = ?, content_iv = ?, content_auth_tag = ? WHERE id = ?").run(message.content_ciphertext, message.content_iv, message.content_auth_tag, message.id);
		for (const term of staleTerms) source.db.prepare("INSERT INTO runtime_message_terms (message_id, term_hash) VALUES (?, ?)").run(term.message_id, term.term_hash);
		source.close(); source = undefined;
		const before = readFileSync(file);
		reader = new Database(file, { readonly: true, fileMustExist: true });
		expect(() => reader!.prepare("DELETE FROM idempotency_keys").run()).toThrow(/readonly/);
		const snapshot = createHostProfileTransferSnapshot(reader, key);
		expect(JSON.stringify(snapshot)).not.toContain(privateText);
		target = new KestrelDatabase(":memory:", targetKey);
		target.importHostProfileTransferSnapshot(snapshot);
		expect(target.getToolExecution(receipt.id)).toMatchObject({ status: "failed", output: { sourceEvidenceRemoved: true } });
		expect(target.getIdempotentResult("stale-replay")).toMatchObject({ status: "failed", output: { sourceEvidenceRemoved: true } });
		expect(target.getIdempotentResult("unrelated-result")).toMatchObject({ output: { text: "Retained source" }, opaqueMetadata: { retained: true } });
		expect(target.getIdempotentResult("literal-result")).toEqual({ toolName: "sources.read", id: receipt.id, literal: "Retained generic JSON" });
		for (const id of ["linked-tool", "linked-derived", "legacy-unlinked"]) expect(target.listRuntimeMessages(receipt.sessionId).find(message => message.id === id)?.content).toBe("Source evidence was deleted or expired.");
		expect(target.listRuntimeMessages(receipt.sessionId).find(message => message.id === "earlier-unrelated")?.content).toBe("Retained earlier assistant text");
		expect(target.listRuntimeMessages(receipt.sessionId).find(message => message.id === "explicit-unrelated")?.content).toBe("Retained unrelated source text");
		expect(target.searchRuntimeMessages(privateText)).toEqual([]);
		const cache = target.db.prepare("SELECT result FROM idempotency_keys WHERE key = 'stale-replay'").get() as { result: string };
		expect(decryptText(JSON.parse(cache.result.slice("kestrel-encrypted-idempotency-v1:".length)), targetKey)).not.toContain(privateText);
		reader.close(); reader = undefined;
		expect(readFileSync(file)).toEqual(before);
	} finally { source?.close(); reader?.close(); target?.close(); key.fill(0); targetKey.fill(0); rmSync(temporary, { recursive: true, force: true }); }
});
