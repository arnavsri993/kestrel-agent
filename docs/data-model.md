# Data model

SQLite is canonical; embeddings are replaceable indexes, never the source of truth.

Implemented tables currently cover migrations, encrypted memories, approvals, runtime sessions, encrypted runtime messages, monotonic per-session message order, keyed message-search terms, encrypted workspace mutations, tool executions, agent runs, model-call audits, audit events, idempotency keys, and runtime state. Agent-run rows store lifecycle state and resumable approval boundaries; model-call audit rows store provider/model, status, timing, and token counts without prompt, response, or credential payloads. The target model also includes raw and normalized events, entities, relationships, memory sources, decisions, goals, tasks, scheduled jobs, permissions, and connectors; those target tables must not be described as implemented until migrations and adapters exist.

All external or model-produced structures enter through the Zod contracts in `packages/shared-types`. Important recommendations reference evidence IDs. Deleted memories are tombstoned before optional secure cleanup so actions remain explainable without retaining deleted content.

Sensitive memory content is stored as AES-256-GCM ciphertext with per-record IV and authentication tag. The database key is supplied by the main-process credential broker and must not be written to the database or renderer.
