# Ambient memory and presence

Kestrel exposes two complementary background capabilities that operate without requiring an active conversation: **ambient memory consolidation** (dreaming) and **ephemeral client presence**.

## Memory consolidation (dreaming)

Dreaming is off by default. When enabled, the desktop utility service runs three local passes — Light → REM → Deep — on a schedule configurable down to the hour.

### Phases

| Phase | What it does |
| ----- | ------------ |
| **Light** | Scores all episodic memory records by provenance, recurrence-across-unique-days, recency, confidence, and importance. Candidates above a configurable threshold are staged as encrypted `DreamingCandidate` objects. |
| **REM** | Compares candidates against existing confirmed memories, merges near-duplicates, and resolves contradictions by preferring the more recent or user-confirmed record. |
| **Deep** | Produces a content-free `DreamDiaryEntry` recording that a consolidation pass ran, its candidate count, and its outcome — without storing any user content in the diary entry itself. |

No candidate is ever promoted to confirmed memory automatically. The `DreamingPanel` in the desktop review surface presents staged candidates; only explicit user approval moves them into the encrypted memory store.

### Configuration

`DreamingConfiguration` fields:

| Field | Default | Description |
| ----- | ------- | ----------- |
| `enabled` | `false` | Master switch. Off by default; never auto-enables. |
| `scheduleHour` | `3` | Local hour (0–23) at which automatic passes run. |
| `minimumScore` | `0.55` | Candidates below this combined score are silently discarded. |
| `minimumRecallCount` | `2` | A record must have been recalled at least this many times. |
| `minimumUniqueDays` | `2` | A record must span at least this many calendar days. |

Configuration is stored encrypted in the Kestrel database under `memory.dreaming.configuration`. Dreaming state (current phase, staged candidates, diary) is stored separately under `memory.dreaming.state` and is restart-safe.

### Privacy boundaries

- No user content, prompts, conversation text, or tool output enters the Dream Diary.
- Candidates include only scored memory IDs and metadata; the raw memory value is never written into the dreaming state record.
- The consolidated pass result is auditable via the encrypted dream diary, but the diary entry body carries only counters and timestamps.

## Presence

Kestrel tracks ephemeral instance presence for desktop, web, and node surfaces.

Each instance registers a **stable instance ID** (derived deterministically from a keyed HMAC of the surface type and a random per-install seed) with:

- An **active/idle** heartbeat state.
- A **five-minute TTL** — instances that stop heartbeating are pruned automatically.
- A hard cap of **200 roster entries** to bound memory under adversarial conditions.

### What is and is not retained

| Retained | Not retained |
| -------- | ------------ |
| Stable instance ID | IP address or hostname |
| Surface type (`desktop`, `web`, `node`) | Loopback or local network details |
| Active/idle state | CLI or probe churn entries |
| Heartbeat timestamp | User identity or session content |

The authenticated HTTP presence endpoint (`/v1/presence`) and the desktop `PresenceSettings` panel expose only the deduplicated roster. The presence system does not retain a history of past instances.

## Capability evidence

| Capability ID | Implementation files |
| ------------- | -------------------- |
| `memory.consolidation` | `packages/agent-core/src/dreaming.ts`, `packages/agent-core/src/dreaming.test.ts`, `apps/desktop/src/renderer/components/DreamingPanel.tsx` |
| `extension.presence` | `packages/agent-core/src/channels.ts`, `apps/desktop/src/renderer/components/PresenceSettings.tsx` |
