# Kestrel memory system

This document describes the current local-first memory substrate and the
extension boundaries around it. It is deliberately an implementation guide,
not a product promise: Kestrel only remembers sources that are actually wired
to the runtime and permitted by the capture policy.

## Design goals and migration posture

Kestrel memory is a set of related projections rather than a chat transcript
dump or a single vector table. The substrate keeps chronological activity,
derived activity summaries, durable memories, entities, people, agent-owned
memory, working tasks, provenance, jobs, and embeddings separate so each can
have an appropriate lifecycle and access rule.

The repository already had an encrypted `MemoryManager` and
`LifeContextService`. The substrate is additive during rollout:

* `MemoryManager` remains the compatibility/source-of-truth projection for
  existing user memories and the existing memory tools.
* `MemorySubstrate` bridges those records into owner-scoped agent memory and
  owns timeline capture, retrieval, provenance, jobs, privacy filtering, and
  maintenance.
* `LifeContextService` remains the existing People/calendar integration. The
  substrate synchronizes People and folder-backed projects into entity records;
  it does not replace their permission or metadata stores.

This arrangement lets existing profiles migrate in place. New consumers should
use `MemorySubstrate` rather than issuing memory SQL or calling the legacy
manager directly. Removing the compatibility projection requires a later
data-migration milestone after all callers have moved.

## Source map

The main implementation surfaces are:

| Area | Source |
| --- | --- |
| Contracts and validation | `packages/shared-types/src/memory-architecture.ts` |
| Runtime/agent integration | `packages/agent-core/src/memory-substrate.ts`, `packages/agent-core/src/index.ts` |
| Legacy compatibility and explicit memory tools | `packages/agent-core/src/memory.ts` |
| Delegated task context | `packages/agent-core/src/orchestration.ts` |
| Encrypted persistence and indexes | `packages/database/src/index.ts` |
| IPC request/response contracts | `packages/shared-types/src/contracts.ts` |
| Timeline and memory UI | `apps/desktop/src/renderer/components/LifeContext.tsx` and `apps/desktop/src/renderer/life-context.css` |
| Focused substrate coverage | `packages/agent-core/src/memory-substrate.test.ts` |
| Developer architecture notes | this file |

## Data model

### Timeline memory

`TimelineEvent` is the normalized activity record. It includes start/end time,
event type, source and immutable source identifiers, originating runtime
conversation, actor, agent/task/project/person/entity links, application and
browser/file context, redacted summary and structured data, importance,
sensitivity, retention, embedding state, and lifecycle timestamps.

Timeline events are encrypted payloads. Only bounded identifying fields needed
for ordering and filtering are normalized in SQLite. Content search uses keyed
term hashes rather than a plaintext transcript index. Project, person, and
entity links are stored separately so relation filters remain bounded without
exposing the event body.

The substrate currently observes `AgentRuntime` events and runtime messages.
It intentionally does not claim to capture operating-system activity, arbitrary
browser history, email, calendar, or files unless an adapter emits a permitted
`captureActivity` call. Adapters should use that method instead of writing
directly to the database.

### Multiple timeline resolutions

The pipeline stores several resolutions, all retaining evidence IDs:

```text
runtime event/message
  -> TimelineEvent
  -> TimelineSession
  -> ActivityBlock
  -> DailySummary
```

Sessionization uses deterministic signals first. Events from the same source
conversation or with shared project/person/entity links can remain together
when the gap is at most 30 minutes. Activity blocks split a session after a
12-minute gap. The constants are in `memory-substrate.ts` so they are easy to
test and tune. A daily summary is a bounded concatenation of the day's session
summaries; it is never a replacement for the underlying event evidence.

### Memory horizons

The legacy memory record has a compatibility mapping to the substrate horizons:

* `short_term`: recent episodic detail; it is eligible for aggressive expiry.
* `mid_term`: ongoing project state, goals, commitments, and outcomes.
* `long_term`: durable preferences, procedures, relationships, and decisions.
* `archived`: retained history that should not normally influence context.

`AgentMemoryRecord` adds an explicit agent owner and supports facts, procedures,
lessons, outcomes, unresolved items, and preferences. Agent records are not a
generic replacement for timeline events: they are compact, reusable continuity
for one agent identity.

Decay lowers retrieval importance based on age since update/access and expires
short-term records after their bounded lifetime. Timeline retention and
retrieval relevance are separate: old activity can remain inspectable until its
retention policy or explicit deletion removes it.

### People, projects, and entities

`EntityRecord` and `EntityEdge` provide a relational memory graph for people,
projects, repositories, applications, topics, events, files, devices, trips,
assignments, products, and tasks. `LifeContextService` People records are
synchronized as person entities; runtime project records are synchronized as
project entities. A person's display name is not sufficient proof of identity:
duplicate names remain separate candidates and `resolvePerson`/`resolveEntity`
returns a result only when resolution is unambiguous.

The graph is intentionally relational instead of introducing a graph database.
Edges support `supports`, `supersedes`, `contradicts`, `confirms`,
`derived_from`, `updates`, `duplicate_of`, and other bounded relations. Source
IDs and provenance remain attached when an entity or memory changes.

### Agent and task memory

`AgentIdentity` gives the main agent and every delegated session a stable
identity. The main identity is `agent-main`; child identities are derived from
their runtime session and retain parent-agent links. A delegated child receives
its own agent memory and the minimum task-specific context assembled by the
orchestrator. It does not receive the global user model, unrelated legacy
memories, or the parent's entire transcript.

`WorkingTask` is durable task state: goal, plan, status, dependencies,
subtasks, evidence, artifacts, failures, unresolved questions, and outcome.
Completed outcomes can become mid-term agent memory. The orchestrator records
runtime messages/tool executions as task evidence and waits on declared
dependencies without putting dependency state in an in-memory-only map.

## Capture and privacy

`MemorySubstrate.captureActivity` is the single ingestion boundary. It:

1. checks the global enable flag and newest matching source policy;
2. rejects private and incognito sessions;
3. validates time ranges and bounds identifiers;
4. redacts bearer tokens, common API-key formats, passwords, cookies,
   authorization fields, secret-like structured keys, URL credentials, query
   secrets, and fragments;
5. stores encrypted payload, keyed lexical terms, relation links, and
   deterministic provenance;
6. queues extraction, sessionization, embedding, and later consolidation.

Capture policies can disable or shorten retention by domain, tab, file,
application, session, or conversation. A disabled automatic capture setting is
not the same as forgetting existing data and does not disable retrieval of
explicit memories the user already chose to keep. Explicit `Remember that ...`
commands and explicit UI/API writes are user-controlled operations. The
separate `memory.captureExplicit` configuration controls automatic explicit
command capture.

Private/incognito runtime conversations are excluded from timeline capture,
identity creation, global memory tools, and user-model access. A normal
delegated session is not incognito, but its `memoryScope: "private"` agent
records are owner-checked. IPC methods for correcting, forgetting, or reading
agent provenance require the requesting session to own the agent memory.

Forget is a data-governance operation, not a status toggle. Source deletion
removes or updates all matching events, sessions, blocks, summaries, legacy
memories, agent projections, provenance, embeddings, lexical links, relation
links, and queued jobs transactionally. Memory deletion also removes derived
embeddings and metadata. The system does not copy provider OAuth credentials,
cookies, or vendor caches into memory.

## Ingestion and background jobs

The substrate is an observer: capture errors are isolated from the runtime.
`start()` installs one bounded timer and triggers restart-safe maintenance.
Jobs are persisted in `memory_jobs` with a dedupe key, attempts, lease fields,
backoff, and terminal failure state. `runMaintenance(maxJobs)` claims at most a
bounded number of jobs, records retry/failure state, and never makes a model
turn depend on background success.

Current deterministic jobs are:

* `extract`: conservative pattern extraction for preferences, decisions,
  corrections, commitments, goals, and project state;
* `sessionize`: groups raw events and updates source-session links;
* `consolidate`: builds activity blocks and daily summaries with evidence IDs;
* `embed`: computes a versioned vector through the injected provider;
* `decay`: updates horizon memory relevance and legacy maintenance;
* `cleanup`: enforces event retention.

Extraction is deliberately conservative and schema-backed. Future model-based
extraction must return validated bounded data, pass the same redaction path,
and use a separate job/provider implementation. It must not make access-control
or deletion decisions.

## Embeddings and retrieval

`MemoryEmbeddingProvider` is the provider boundary. The default
`local-hash-256-v1` provider is deterministic and local, which keeps offline
operation functional. A custom provider may be injected for future local models
or an explicitly permitted service. Invalid vectors or provider failures fall
back to the local provider; lexical and temporal retrieval continue if no
embedding is available.

`queryTimeline` returns heterogeneous, typed results for events, sessions,
activity blocks, daily summaries, memories, people, entities, agent memories,
and tasks. Retrieval unions:

* deterministic temporal parsing (`today`, `yesterday`, `last week`, weekdays,
  `two weeks ago`, `last month`, and bounded `around/at` windows);
* keyed lexical term matching;
* optional persisted-vector similarity;
* importance, confidence, and recency;
* horizon, source-session, agent, project, person, entity, event-type, and
  sensitivity filters.

The default score weights are centralized in `MEMORY_SCORING_DEFAULTS`:
lexical 0.42, semantic 0.28, importance 0.14, confidence 0.10, and recency
0.06. Results are bounded and deduplicated: a bridged legacy memory and its
agent projection count as one retrieval item. Aggregate results include a
bounded drill-down list of source events so summaries cannot become opaque
hallucination surfaces.

`getRelevantContext` assembles a compact prompt with durable, current,
retrieved, working-task, and provenance sections. It never injects the whole
database. Standard shared context is capped at 24,000 characters; private
delegated context is capped at 12,000. The agent core applies the personality
and `memory.useSharedContext` gates separately from automatic capture: turning
off capture does not silently discard user-approved durable context.

## Lifecycle, correction, and provenance

Explicit writes are persisted through the legacy encrypted manager and bridged
to the main-agent projection. Corrections retain version history in the legacy
store, mark conflicting/superseded records through the existing memory
lifecycle, remove stale embeddings, and queue a fresh embedding. Every
meaningful event/memory/task/agent record gets a `ProvenanceRecord` with source
type and ID, actor, extraction method, content reference/excerpt where safe,
confidence, timestamps, and transformation history.

Provenance is inspectable through the IPC `memory-provenance-list` and the
Timeline inspector. It is evidence metadata, not an instruction channel; model
context labels retrieved memory as context only. User correction has higher
confidence than deterministic inference, while historical conflicting records
remain available for audit until their retention/deletion policy applies.

## IPC and user surfaces

`CoreRequestSchema` exposes bounded service operations rather than raw SQL:

* `memory-timeline-query`
* `memory-capture-status`, `memory-capture-configure`, and capture-policy CRUD
* `memory-diagnostics` and `memory-run-maintenance`
* `memory-provenance-list` and `memory-source-delete`
* owner-checked agent inspect/correct/forget/provenance operations
* existing remember/correct/forget/version and user-model operations

Life -> Timeline uses those APIs for day navigation, date filtering, timeline
search, activity-block drill-down, related project/person/entity references,
and provenance inspection. Life -> Memory keeps the existing ledger and adds
correction, forget, explicit remember, context preview, and transcript search.
Life -> People remains the People surface and its delete action reconciles
person entities and relation IDs in memory. Agent Universe exposes the selected
agent's bounded continuity through the existing agent workspace rather than
creating a second memory database or replacing the spatial UI.

Loading, empty, error, keyboard-focus, and bounded-list states are handled in
the renderer. UI code talks to `request()`/IPC and does not open SQLite.

## Schema migrations

The substrate migrations are forward-only and preserve existing profiles:

| Migration | Purpose |
| --- | --- |
| `012_memory_substrate.sql` | encrypted timeline, aggregates, entities, agent identities/memories, tasks, provenance, policies, jobs, embeddings |
| `013_memory_timeline_links.sql` | normalized project/person/entity link index |
| `014_memory_entity_ambiguity.sql` | preserves same-name entity candidates instead of enforcing a silent merge |
| `015_memory_provenance_updated_at.sql` | mutable provenance timestamp with legacy-row repair |
| `016_memory_timeline_source_metadata.sql` | immutable source and originating runtime-session identifiers |

Migration startup includes recovery guards for development profiles that may
have applied the `ALTER TABLE` portion of v015/v016 before recording the
migration marker. Production schema changes must continue to use the migration
registry; do not ask users to wipe their profile.

## Diagnostics and extension points

`memory-diagnostics` reports event/session/block counts, queue state, failed
jobs, embedding states, and local-only processing status. Use it when debugging
capture or retrieval instead of dumping encrypted payloads into logs.

Future adapters should:

1. obtain the relevant source permission and retention policy;
2. normalize to `CaptureActivityInput` with stable source/source-session IDs;
3. emit only the minimum useful redacted summary and structured metadata;
4. attach person/project/entity IDs only after unambiguous resolution;
5. preserve an evidence/source reference and test source deletion;
6. avoid remote model calls for deterministic parsing, filtering, or access
   control.

Candidate adapters include Kestrel browser-tab/page context, files opened
through Kestrel, calendar, email, and communication sources. Their absence is
an explicit current limitation, not a reason to fabricate timeline events.

## Verification expectations

Focused coverage lives in
`packages/agent-core/src/memory-substrate.test.ts` and covers redaction,
sessionization/aggregation, explicit remember with automatic capture disabled,
private/incognito exclusions, private agent isolation, temporal and sensitivity
filters, People deletion cleanup, restart persistence, direct legacy deletion,
supersession/correction, embedding fallback, and resilient background work.
Agent-core tests additionally verify context injection and the memory recall
receipt. Before changing this subsystem, run the focused tests and package
typechecks; before release, run the repository's complete `verify` sequence and
the packaged desktop Life/Timeline smoke path.

The substrate is considered production-safe only when source, running local
app, packaged/canonical app, and remote CI evidence are reported separately.
Passing a typecheck or a local test does not prove that a provider integration,
remote deployment, or user-visible packaged flow is ready.
