import { createHash, createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { encryptText } from "@kestrel/encryption";
import { KestrelDatabase } from "./index.js";

// Generated-only historical format fixture. No existing profile or key lookup.
export function seedNativeLegacy19Source(path: string, key: Buffer, options: { diagnostics?: boolean; mutableJobMetadata?: boolean; compactDdl?: boolean; configurationAudit?: boolean; conflictingJobs?: boolean;
	largePrivateRecords?: { count: number; bytes: number }; idempotencyClaims?: number } = {}) {
	const time = "2026-11-04T12:00:00.000Z", dedupeKey = "GENERATED_LEGACY19_PRIVATE_DEDUPE";
	const oldMac = (purpose: string, value: string) => createHmac("sha256", key).update(`kestrel-memory-index-v1:${purpose}:`).update(value).digest("hex");
	const job = { id: `memory-job-${oldMac("job-id", dedupeKey).slice(0, 40)}`, kind: "cleanup" as const, dedupeKey,
		status: options.mutableJobMetadata ? "pending" as const : "failed" as const, payload: { generated: true, ...(options.conflictingJobs ? { ownerId: "generated-conflict-owner", sourceId: "generated-conflict-source" } : {}) }, attempts: options.mutableJobMetadata ? 0 : 3, maxAttempts: 3, runAfter: time, createdAt: time, updatedAt: time };
	const embedding = { id: "generated-legacy19-vector", ownerType: "memory" as const, ownerId: "generated-legacy19-owner", provider: "fixture", model: "fixture", dimension: 2, contentHash: "c".repeat(64), vector: [0.1, 0.2], status: "ready" as const, createdAt: time, updatedAt: time };
	const alias = `memory-job-${createHash("sha256").update(dedupeKey).digest("hex").slice(0, 40)}`;
	const privateMessage = "GENERATED_LEGACY19_PRIVATE_CONVERSATION", diagnostic = "GENERATED_LEGACY19_PRIVATE_ERROR\nquoted:\" unicode:☃";
	const canonical = new KestrelDatabase(":memory:", key), target = new Database(path);
	try {
		target.pragma("foreign_keys=OFF");
		canonical.saveRuntimeSession({ id: "generated-legacy19-session", title: "Generated legacy conversation", allowedTools: [], status: "active", checkpoints: [], createdAt: time, updatedAt: time });
		canonical.saveRuntimeMessage({ id: "generated-legacy19-message", sessionId: "generated-legacy19-session", role: "user", content: privateMessage, createdAt: time });
		canonical.queueMemoryJob(job); canonical.upsertMemoryEmbedding(embedding);
		if (options.configurationAudit) canonical.saveAgentConfigurationAuditEvent({ id: "config-audit-00000000-0000-4000-8000-000000000019", action: "default_migrated", actor: "system", detail: "Generated historical default migration audit", evidence: [], createdAt: time });
		if (options.largePrivateRecords) {
			const { count, bytes } = options.largePrivateRecords;
			if (!Number.isSafeInteger(count) || count < 1 || count > 30 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 4 * 1024 * 1024) throw new Error("Invalid generated large fixture.");
			const text = "GENERATED_PRIVATE_LARGE_TRANSFER_TEXT_".slice(0, bytes).padEnd(bytes, "x");
			for (let index = 0; index < count; index++) canonical.setPrivateState(`generated-large-${index}`, { index, text });
		}
		if (options.idempotencyClaims) {
			if (!Number.isSafeInteger(options.idempotencyClaims) || options.idempotencyClaims < 1 || options.idempotencyClaims > 250_001) throw new Error("Invalid generated claims fixture.");
			canonical.db.prepare(`WITH RECURSIVE generated(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM generated WHERE n<?)
				INSERT INTO idempotency_claims SELECT 'generated-'||n,'generated-owner',1,'{}',? FROM generated`).run(options.idempotencyClaims, time);
		}
		const definitions = canonical.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC,name").all() as Array<{ type: string; name: string; sql: string | null }>;
		const compact = new Set(["approvals", "audit_events", "idempotency_keys", "runtime_state", "schema_migrations"]);
		for (const row of definitions) if (row.sql) target.exec(options.compactDdl && row.type === "table" && compact.has(row.name) ? row.sql.replace(/\(\s+/gu, "(").replace(/\s+\)/gu, ")") : row.sql);
		for (const { name } of definitions.filter(row => row.type === "table")) {
			const quoted = `"${name.replaceAll('"', '""')}"`;
			const columns = (canonical.db.pragma(`table_info(${quoted})`) as Array<{ name: string }>).map(row => `"${row.name.replaceAll('"', '""')}"`);
			const insert = target.prepare(`INSERT INTO ${quoted} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
			for (const row of canonical.db.prepare(`SELECT * FROM ${quoted}`).iterate() as Iterable<Record<string, unknown>>) insert.run(...Object.values(row));
		}
		target.pragma("foreign_keys=ON");
		target.exec("CREATE TABLE memory_job_id_aliases ( alias_hash TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE ON UPDATE CASCADE )");
		target.prepare("INSERT INTO memory_job_id_aliases VALUES (?,?)").run(oldMac("job-alias", alias), job.id);
		target.prepare("INSERT INTO schema_migrations VALUES (19,?)").run(time);
		if (options.conflictingJobs) {
			const duplicate = { ...job, id: alias, status: "pending", attempts: 0 }, encrypted = encryptText(JSON.stringify(duplicate), key);
			target.prepare("INSERT INTO memory_jobs SELECT ?,kind,?,?,?,max_attempts,run_after,locked_at,lease_until,last_error,created_at,updated_at,?,?,? FROM memory_jobs WHERE id=?")
				.run(duplicate.id, duplicate.dedupeKey, duplicate.status, duplicate.attempts, encrypted.ciphertext, encrypted.iv, encrypted.authTag, job.id);
		}
		if (options.mutableJobMetadata) target.prepare("UPDATE memory_jobs SET status='running',attempts=2,locked_at=?,lease_until=NULL,updated_at=?").run(time, time);
		if (options.diagnostics !== false) {
			target.exec("CREATE TABLE internal_error_events ( id TEXT PRIMARY KEY, severity TEXT NOT NULL CHECK(severity IN ('error', 'warning')), source TEXT NOT NULL, created_at TEXT NOT NULL, payload_ciphertext TEXT NOT NULL, payload_iv TEXT NOT NULL, payload_auth_tag TEXT NOT NULL )");
			target.exec("CREATE INDEX idx_internal_error_created ON internal_error_events(created_at)");
			const encrypted = encryptText(diagnostic, key);
			target.prepare("INSERT INTO internal_error_events VALUES (?,?,?,?,?,?,?)").run("generated-error", "warning", "generated-fixture", time, encrypted.ciphertext, encrypted.iv, encrypted.authTag);
		}
	} finally { target.close(); canonical.close(); }
	return { job, embedding, alias, privateMessage, diagnostic, time };
}
