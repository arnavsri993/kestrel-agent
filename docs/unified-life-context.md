# Unified life context

Kestrel models time, people, and memory as one local-first context system. The
calendar is the temporal projection of that system; it is not a second source
of truth beside memory.

## Current increment

This increment adds:

- backward-compatible metadata for short-, mid-, long-term, and archived
  memories;
- encrypted memory version history, relationships, conflicts, relevance,
  review timing, and context-use receipts;
- encrypted people records with fact-level provenance, confidence,
  sensitivity, status, and relationship-specific communication style;
- encrypted unified calendar records that distinguish provider-confirmed,
  explicit, inferred, and suggested time;
- direct-statement routine capture for bounded recurring weekday schedules and
  day-specific corrections;
- deterministic context selection across memory, people, and upcoming time with
  sensitivity filters and a user-visible influence explanation;
- local event creation/deletion and Google Calendar read synchronization;
- lifecycle maintenance that decays stale relevance and archives instead of
  deleting;
- one desktop **Life** surface with Calendar, People, and Memory views.

The existing `memories` table remains authoritative for prior records.
Migration 8 adds encrypted companion and domain tables without rewriting
existing rows.

## Authority and contradiction rules

Context never becomes confirmed merely because it was retrieved often.

1. A direct user correction or statement can supersede an older value sharing
   the same explicit conflict key.
2. A connected provider refresh can supersede an older value for the same
   provider object.
3. Otherwise, incompatible values remain contradicted and link to each other.
4. Every correction creates an encrypted version record before replacing the
   current value.
5. The agent asks only when unresolved ambiguity materially affects an action.

Provider-confirmed events, explicit local blocks, inferred routines, and
suggestions remain separate event origins. Inference always carries confidence
and a confidence reason.

## Retrieval boundary

`LifeContextService.assembleContext` selects a bounded set:

- up to 8 relevant active memories;
- up to 4 directly named or related people;
- up to 12 upcoming events only for time-sensitive requests.

Selection considers lexical relevance, task category, recency/relevance,
confidence, confirmation, named people, and time intent. Sensitive records need
an explicit sensitive-context allowance; restricted records need a separate
restricted-context allowance. Each selection produces an encrypted influence
receipt. Retrieved content is labelled as context, never instructions.

## Permissions

- Local reads and local explicit records do not cross a provider boundary.
- Google sync reads a bounded range and stores an encrypted local projection.
- Google, Apple, Outlook, or CalDAV mutations are external actions and must use
  the normal runtime approval and verification path.
- Deleting a person is an explicit local destructive action. It deletes that
  person and directly related memories, removes their event relationship edges,
  and leaves unrelated records intact.
- Sensitive and restricted records remain encrypted at rest and are not
  returned to the renderer unless a user-facing management request needs them.

## Provider adapters

Google Calendar is the first functional sync adapter because Kestrel already
has user-owned Desktop OAuth, in-memory access-token rotation, bounded Calendar
API reads, and approval-gated writes.

Apple Calendar, Outlook Calendar, and CalDAV appear as honest unsupported
adapter boundaries in this increment. They are not shown as connected and no
mock provider data is presented as real.

## Incremental roadmap

1. **Foundation — implemented here.** Structured memory metadata, people,
   unified time, retrieval, contradiction handling, lifecycle, Google sync, and
   the Life UI.
2. **Provider depth.** EventKit with macOS permission handling, Microsoft Graph
   OAuth, CalDAV, incremental sync tokens, recurring-series exceptions,
   reminders, and provider-side update/move/delete tools.
3. **Inference depth.** Entity extraction beyond bounded deterministic phrases,
   commute/travel/sleep estimation, availability learning, confidence
   calibration, and review queues.
4. **User control depth.** Per-category retention policies, field-level access
   grants, person/project export, selective bulk erase, and a complete
   context-use audit timeline.
5. **Reasoning depth.** Free-time computation, travel departure estimates,
   sleep impact, workload capacity, deadline risk, and multi-calendar conflict
   resolution with explicit uncertainty.

Each phase must preserve migration compatibility, encrypted local authority,
source/confidence labels, and the external-action approval boundary.
