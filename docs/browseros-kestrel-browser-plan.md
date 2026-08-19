# BrowserOS reference audit and Kestrel browser plan

Status: implementation plan for the first clean-room browser increment.

This document records what Kestrel learned from the BrowserOS repository and
defines the boundary for independently authored work. It is not a promise that
Kestrel ships BrowserOS code, a Chromium fork, or every capability described
below.

## Decision and provenance

The reviewed reference is [BrowserOS](https://github.com/browseros-ai/BrowserOS)
at commit `b67df9aa92cba4da758ba5cf0b9cc39de34f4c10` (reviewed 2026-08-18).
The repository root and `packages/browseros-agent/LICENSE` identify the agent
work as AGPL-3.0; the Chromium fork also carries Chromium and ungoogled-
Chromium notices. The fact that Kestrel has write access to its own repository
does not change those obligations.

Renaming, paraphrasing, reformatting, or making cosmetic changes to source code
would not make that code independently authored or remove its license
requirements. Kestrel therefore does **not** copy, disguise, translate, vendor,
or mechanically port BrowserOS source, patches, tests, assets, prompts, or UI
markup. This plan uses the reference only to identify product capabilities and
engineering questions. Any future direct reuse would require a separate,
explicit AGPL/compliance decision with notices, source-offer obligations, and
distribution review before it enters this repository.

## What the audit found

| BrowserOS area | Capability observed | Kestrel decision |
| --- | --- | --- |
| Chromium fork and patch/build system | A Chromium-based product layer, patch series, build profiles, and release tooling | Keep Kestrel on its existing Electron/WebContentsView architecture. A Chromium fork is a separate product and licensing project, not an incremental component import. |
| Browser CDP/core layer | Page/session control, navigation, input dispatch, screenshots, accessibility trees, stable element references, and frame-aware page inspection | Recreate the needed contracts in Kestrel's own types and Electron backend. Preserve Kestrel's origin allowlists, ephemeral agent partitions, cancellation, and untrusted-output labels. |
| Browser tool layer | A broad tool family for tabs, groups, history, navigation, snapshot, action, read/search, downloads/uploads, screenshots, PDF, waits, windows, evaluation, and composed runs | Extend Kestrel one bounded capability at a time. Reuse existing Kestrel tools where they already cover the behavior; add only contracts with a clear approval and output budget. |
| Agent/server layer | Session ownership, browser routing, audit-oriented state, recordings, and replay-oriented workflows | Use Kestrel's existing runtime, approval, encrypted state, and observability boundaries. Do not introduce a second server or persistence system for the first slice. |
| Cockpit/side-panel surfaces | Live browser activity, session/task visibility, audit/replay views, and setup flows | Evolve Kestrel's monochrome Browser + Agent workspace. Any activity surface must show real local state and never fabricate live progress or provider readiness. |

The useful product pattern is a tight feedback loop:

```text
typed action
  -> controlled browser backend
  -> bounded post-action observation
  -> approval/audit/runtime record
  -> agent-visible result marked untrusted_browser
```

The product value is the feedback contract and the trust boundary, not a visual
resemblance to BrowserOS.

## Kestrel baseline and gaps

Kestrel already provides:

- persistent user tabs, history, downloads, search, tab sleeping, and session
  restoration in the Electron desktop;
- isolated, memory-only autonomous browser sessions with origin and
  subresource policy, typed actions, deterministic viewports, diagnostics,
  screenshots, upload/download bounds, cancellation, and cleanup;
- visible-browser inspection and action tools separated from autonomous
  sessions, with page content treated as untrusted and mutating actions sent
  through the existing approval path;
- a stable Agent workspace and local-first monochrome design system documented
  in `DESIGN.md` and `docs/ai-native-browser.md`.

The immediate gap is that an action returns only `performed: true`. The agent
must make another full snapshot to learn what changed, which is expensive and
leaves the action/result relationship implicit. The first slice closes that
gap with a pure, bounded semantic diff helper and controller integration.

## Delivery plan

### P0 — action observation (this increment)

Implement a Kestrel-owned `browser-observation` module that:

1. normalizes the existing CDP accessibility-tree shapes into compact semantic
   nodes (role, accessible name, value, and selected state properties);
2. compares the pre-action and post-action snapshots without returning the raw
   tree;
3. reports page metadata plus added, removed, and changed semantic nodes;
4. caps node extraction and every result bucket, marks truncation, bounds text,
   redacts observation URL credentials/fragments, and preserves
   `trust: "untrusted_browser"`;
5. returns the same observation contract for autonomous and visible actions;
6. keeps approvals, origin checks, session separation, and cancellation in the
   existing controller/runtime path.

P0 acceptance is pure unit coverage plus agent-core typecheck. A live Electron
page, real form submission, and sustained packaged-browser run remain separate
runtime gates.

### P1 — local browser activity ledger

Add an append-only, owner-scoped record for action intent, target tab/session,
approval result, bounded observation summary, outcome, and timestamps. Store
only the minimum page material required for the local activity surface; never
persist cookies, credentials, raw page instructions, or unbounded AX trees.
Reuse Kestrel's existing encrypted database/audit mechanisms rather than adding
a parallel database.

### P2 — ownership and tab groups

Introduce explicit agent/session ownership for visible tabs and lightweight
local groups. A tab can be user-owned, agent-observed, or agent-actionable; the
last state requires a fresh approval boundary. Releasing a task must revoke its
action lease without closing or migrating the user's profile.

### P3 — inspect, search, and replay

Build bounded page text/link/form extraction, local grep-like search, and a
replay harness over recorded typed actions. Replays must run in isolated
profiles or test fixtures, display when the page diverges, and never silently
retry consequential actions. A replay is evidence for debugging, not proof of
provider-side success.

### P4 — browser depth

Evaluate multi-page/frame-aware references, wait conditions, download/upload
receipts, PDF capture, and composed runs only after P1–P3 have stable contracts.
Each feature needs a Kestrel-owned schema, size/timeout limits, cancellation,
approval classification, and focused tests before it is exposed to the agent.

### P5 — Kestrel browser workspace

Expose activity, ownership, and replay as additions to the existing Browser +
Agent workspace. Keep the graphite visual language, real-state copy, semantic
landmarks, keyboard focus, reduced-motion behavior, and explicit recovery
states. The UI should explain *why* an action is blocked or awaiting approval;
it must not imitate another product's layout or branding.

## Release gates

Every phase must pass these gates before being called ready:

- **Source boundary:** no BrowserOS source, patch, asset, test, generated
  artifact, or copied prompt enters Kestrel; provenance and third-party notices
  are reviewed for every dependency.
- **Trust:** page text, accessibility nodes, URLs, titles, links, forms, and
  screenshots remain reference data only and carry an untrusted label.
- **Safety:** navigation stays origin-scoped; user-browser mutations remain
  approval-gated; credentials and cookies never enter model-visible or durable
  observation state.
- **Bounds:** node count, text length, result buckets, file size, timeouts, and
  persisted history have explicit caps with tests for truncation and failure.
- **Evidence:** unit tests and typechecks are reported separately from live
  packaged Electron behavior, real authentication, and third-party provider
  outcomes. Missing live evidence remains `UNVERIFIED`.
- **Recovery:** cancellation, browser/session teardown, stale references,
  navigation races, and partial observation failures have deterministic,
  user-visible outcomes.

## Out of scope for this slice

This increment does not import the BrowserOS Chromium fork, add an AGPL
dependency, replace Electron, build a cloud browser, merge user and agent
cookies, add unrestricted JavaScript evaluation, or claim that the packaged
browser is production-ready. Those are separate decisions with materially
different security, licensing, and runtime-verification requirements.
