# Product analytics (privacy-preserving)

**Status:** Design contract — **instrumentation incomplete.**  
**Related:** `docs/external-observability.md` (ops/OTLP; content-free), acquisition ID AR-P1-PRODUCT-ANALYTICS  
**Hard rule:** Do **not** fabricate DAU/WAU/D1/D7/D30 or funnel rates. If events are not collected, the metric is `not_measured`.

---

## Purpose

Measure activation, retention, and reliability of the **product** without exporting prompts, page text, memories, or credentials. This is distinct from enterprise/ops observability (provider token counts, process metrics), which already exists in a content-free form.

---

## Privacy boundary (must never ship in product events)

Forbidden payloads and fields:

- Prompt, completion, reasoning, or chat message text
- Page HTML, URLs beyond coarse allowlisted host classes (prefer no raw URLs)
- Memory document bodies, titles that may contain PII, embeddings
- Credentials, tokens, cookies, Keychain material
- Tool inputs/outputs and approval dialog contents
- File paths, project names, workspace names, people names
- Raw error strings that might embed secrets

Allowed examples:

- Event name + schema version
- App version, release channel, OS major version
- Opaque install ID (rotatable), opaque session ID (local)
- Enumerated surface ids (`onboarding`, `browser`, `agent`, `memory`, `connections`)
- Booleans / small enums (`first_route_verified`, `outcome=success|safe_stop|error`)
- Durations in buckets (e.g. `0-1m`, `1-5m`)

---

## Default: local aggregation

| Mode | Default | Behavior |
| --- | --- | --- |
| Local event log | **On** (when feature ships) | Append-only, size-capped, retained with policy |
| Local aggregates | **On** | Daily rolls for DAU/WAU-style counters on device |
| Export | **Off** | Opt-in only; user-visible toggle; same forbidden-field filter |
| Third-party marketing SDKs | **Forbidden** | Do not add |

Export, when enabled, should reuse the same content-free discipline as external observability (HTTPS collector, no credential URLs, low-cardinality labels).

---

## Event schema (v0 draft)

All events share an envelope:

```json
{
  "schema": "kestrel.product.event.v0",
  "name": "app.launch",
  "ts": "2026-09-21T12:00:00.000Z",
  "installId": "opaque",
  "appVersion": "x.y.z",
  "channel": "development|stable",
  "os": { "family": "macos", "major": 15 },
  "props": {}
}
```

### Core events

| name | props (only) | Intent |
| --- | --- | --- |
| `app.launch` | `coldStart: boolean` | Sessions for DAU/WAU |
| `onboarding.step` | `step: enum`, `result: success\|skipped\|back` | Funnel without answers |
| `route.setup` | `routeClass: enum`, `state: configured\|reachable\|verified\|failed` | Integration truth |
| `task.first_value` | `surface: enum`, `latencyBucket: enum` | Activation |
| `agent.run_outcome` | `outcome: success\|waiting_approval\|safe_stop\|error\|interrupted`, `hadTools: boolean` | Reliability (no prompt text) |
| `browser.workflow_surface` | `surface: enum` | Coarse usage — not page content |
| `memory.workspace_open` | *(none or `section: enum`)* | Feature adoption |
| `approval.decision` | `decision: allow\|deny\|timeout`, `ttlExpired: boolean` | Safety UX — no action payload |
| `crash.envelope` | `fingerprint: string`, `fatal: boolean` | Opt-in diagnostics overlap |
| `analytics.export` | `result: success\|failed` | Audit of export use |

`routeClass` examples: `codex`, `claude_code`, `opencode`, `api_provider`, `ollama` — not account emails.

If a property cannot be expressed without forbidden content, **omit the event**.

---

## Metrics formulas

Computed from local events. Until the pipeline ships, publish **`not_measured`** — never `0` as a substitute for missing data (same honesty rule as the browser-agent benchmark’s token fields).

Let \(U(d)\) = set of `installId` with ≥1 `app.launch` on UTC day \(d\).

| Metric | Formula | Notes |
| --- | --- | --- |
| **DAU** | \(\|U(d)\|\) | Daily active installs |
| **WAU** | \(\|\bigcup_{i=0}^{6} U(d-i)\|\) | 7-day unique |
| **MAU** | \(\|\bigcup_{i=0}^{29} U(d-i)\|\) | 30-day unique |
| **D1** | Share of installs with first `app.launch` on day \(d0\) that also launch on \(d0+1\) | Cohort by first-seen day |
| **D7** | Same with \(d0+7\) | |
| **D30** | Same with \(d0+30\) | |
| **Stickiness** | DAU/MAU for day \(d\) | |
| **Verified route rate** | installs with `route.setup` `state=verified` / installs with any `route.setup` | Do not count “configured” as verified |
| **Time-to-first-value** | median bucket of `task.first_value.latencyBucket` among new installs | Bucketed only |
| **Agent tool silence rate** | `agent.run_outcome` with `hadTools=false` over agent surfaces | Guardrail for AR-P0-ROUTING-SILENT-TEXTONLY once instrumented |

### Cohort definition

- **New install cohort \(C(d0)\)**: first observed `app.launch` calendar day.
- Retention Dn requires a launch on day \(d0+n\), not merely background wake without `app.launch` (define wake separately if ever needed).

---

## What not to do

- Do not invent retention percentages for decks or diligence.
- Do not reuse ops Prometheus series as DAU.
- Do not log raw URLs “just for analytics.”
- Do not enable export by default in stable.
- Do not claim the deterministic 50-workflow benchmark as user retention evidence.

---

## Implementation sketch (non-binding)

1. Main-process recorder behind a feature flag; renderer sends only enum-safe IPC.
2. SQLite or append JSONL under Application Support with retention cap.
3. Settings: “Product insights (local)” and separate “Export insights” opt-in.
4. Tests: schema allowlist; reject payloads containing suspicious keys (`prompt`, `html`, `token`, `memoryText`).
5. Until shipped, public answers remain: **product analytics not measured.**

---

## Relationship to acquisition readiness

AR-P1-PRODUCT-ANALYTICS closes only when:

1. Events above (or a reviewed subset) are implemented,
2. Local aggregates are visible to the operator,
3. Export remains opt-in and content-free,
4. Diligence materials cite measured numbers with date range and build — or explicitly say `not_measured`.
