# Memory workspace

Memory now has separate viewer, domain, and content axes. The default page is an
Overview with Timeline, Memory, People, and Tools. Domain knowledge and the
existing calendar/capture controls remain under advanced disclosures.

## Existing architecture and migration

The previous product combined `LifeContext`, `MemoryManager`, the timeline
`MemorySubstrate`, and a separate scoped-agent page. Legacy memories and people,
agent identities/memories, timeline events, and encrypted provenance already live
in `KestrelDatabase`. Runtime capture remains owned by `MemorySubstrate`.

Migration 018 adds encrypted canonical text documents and scoped day summaries.
It does not delete or rewrite previous tables. Legacy rows are projected under
stable IDs until explicitly edited; tombstones prevent forgotten projections
from reappearing. Existing database migration backup/recovery applies. Calendar
schedules remain distinct from observed activity. Uncertain legacy domains and
facts remain available without inferred visibility grants.

## Ownership and retrieval

A document is text plus identity, tier, provenance, confidence, and passages.
Passages carry visibility so a canonical person can have domain-specific views.
Only explicitly domain-shared parent/user passages are inherited. Sibling
private memory and private/incognito session material are excluded. Domain
selection narrows the user view independently of agent ownership. An agent
cannot overwrite an inherited document. Mixed-scope documents cannot be flattened
by an agent rewrite. Edits require the observed version.

Agent run/retry, delegated workers, and `memory.list`/`memory.search` use these canonical documents.
Legacy Life Context paragraphs are no longer separately injected. Timeline and
working-task context remain bounded substrate context. Reviewed user preferences
and explicitly enabled remote memory retain their existing configuration gates.
Knowledge is excluded from personal-memory document search. Ranking combines lexical
relevance, the existing local feature embedding similarity, active project,
confidence, recency, and tier. The local embedding is not a hosted language-model
embedding; semantic paraphrase recall remains limited.

## Consolidation

Activity digests work without a model. The existing configured provider pool can
produce bounded day summaries and rewrite existing documents from significant,
related evidence. Output is inferred, source IDs are validated, stale versions
are rejected, and scoped evidence is rechecked after provider latency. Day summary
fingerprints invalidate derived text after source changes. Tool usage is derived
from observed runtime tool completion namespaces rather than connection status.

The Timeline's model action requests consolidation explicitly. A 15-minute
maintenance timer processes one dirty viewer at a time, obeying capture, memory,
provider policy, and usage limits. Private/incognito sessions never enqueue.
Unavailable or malformed provider responses leave an honestly labeled digest.
New people are not invented from speculative model output. Multi-passage memory
requires source-aware editing; automatic consolidation currently rewrites only
single-passage documents to preserve independent visibility.

## Verification

Focused tests cover encrypted persistence/reopen, IPC CRUD, stale writes,
user-domain filtering, sensitive passage filtering, parent/child inheritance,
model-output validation, evidence changes, and relevant person context in a real
agent request using a deterministic test provider. The desktop smoke uses an
isolated profile and covers Overview, text editing, expandable Timeline,
advanced calendar access, and compact layout. These fixtures are test-only.
