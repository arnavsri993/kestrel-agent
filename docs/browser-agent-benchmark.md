# Browser-agent reliability benchmark

Kestrel has a deterministic browser-agent benchmark for the narrow execution
path that can be verified without a live account or a model call. The first
version contains 50 versioned workflows:

| Category | Workflows |
| --- | ---: |
| Research | 10 |
| Forms | 10 |
| Productivity | 8 |
| Commerce | 8 |
| Accounts | 6 |
| Failure and recovery | 8 |

The corpus is defined in
`benchmarks/browser-agent/corpus-v1.mjs`. Each report records the corpus
version and a canonical SHA-256 so results from a changed corpus are not
silently compared with earlier runs.

## What this track measures

The runner launches the real Kestrel Electron application and invokes the
normal renderer-to-runtime tool path:

`runtime-call-tool → AgentRuntime → BrowserController → browser backend IPC → ElectronBrowserService`

Every workflow uses an isolated Kestrel browser session and two ephemeral
loopback fixture origins. The run therefore exercises:

- runtime tool discovery, explicit per-call policy approval grants, missing-
  approval blocking with independently verified untouched fixture state,
  idempotency, and execution status;
- origin-scoped navigation and subresource policy;
- accessibility snapshots, stable semantic element references, and the typed
  click, type, select, key, scroll, upload, download, screenshot, and
  authentication-handoff paths used by the corpus;
- bounded scripted recovery from delayed, renamed, missing, stale, obscured,
  redirected, modal, popup, validation, and expired-session states;
- independent server state for visits, submitted fields, activations, and
  downloads.

A workflow passes only when its expected outcome and its independent fixture
predicates both pass. Expected safe stops must name the correct failure class,
leave consequential fixture controls untouched, and satisfy their predicates.
An agent or tool execution saying “completed” is not sufficient.

## What this track does not measure

This is a deterministic browser-tool reliability track, not a claim about
open-ended agent intelligence. It does **not** measure:

- model planning or reasoning quality;
- token usage or model cost, because no model is called;
- live-site drift or third-party availability;
- real authenticated accounts, CAPTCHA handling, or provider rate limits;
- the quality of human intervention on an external service.
- how many approval prompts a person would see. The harness proves three
  missing-approval runtime blocks and then supplies explicit grants, but does
  not render or measure the approval UI.

Reports therefore set model input tokens, output tokens, total tokens, and
estimated cost to `null` with status `not_measured`. They do not substitute
zero for an unmeasured value.

Live-site or real-account canaries remain a separate, explicit opt-in track.
This benchmark does not run them, ask for credentials, or send traffic beyond
its two loopback servers. A future live runner must have its own reviewed
origin/account allowlist, cost and approval budget, secret boundary, and report
label; its results must not be merged into this deterministic rate.

## Run it

Build the development Electron output before a direct development run:

```bash
corepack pnpm build:desktop
corepack pnpm benchmark:browser-agent
```

Filter without changing the corpus identity:

```bash
corepack pnpm benchmark:browser-agent --category forms
corepack pnpm benchmark:browser-agent --workflow forms-country-dropdown
corepack pnpm benchmark:browser-agent --list
```

Write a report to an explicit path:

```bash
corepack pnpm benchmark:browser-agent \
  --report .tmp/browser-agent-benchmark/development.json
```

After building the Apple Silicon development package, exercise the packaged
binary rather than the development Electron entry point:

```bash
corepack pnpm package:mac:dev
corepack pnpm benchmark:browser-agent:packaged:arm64 \
  --report .tmp/browser-agent-benchmark/packaged.json
```

The ordinary `verify` path includes the deterministic development track after
the repository build. macOS CI runs both the development and packaged tracks
and uploads their JSON reports. The signed release workflow also runs the
packaged track. These gates do not enable live canaries.

## Report contract

The JSON report includes:

- schema and track identifiers;
- run ID, timestamps, duration, filters, and whether the full corpus ran;
- corpus version, SHA-256, total count, and category counts;
- Git commit/tree, branch, dirty-worktree state, and a SHA-256 over tracked
  changes plus non-ignored untracked file contents;
- OS, architecture, Node/Electron/app versions, executable kind, packaged
  status, the executed development `out` SHA-256, and packaged `app.asar`
  SHA-256 when available;
- completion claims, verified completions, verified safe stops, false-positive
  completions, pass rates, p50/p95 duration, actions, observations, actual
  retry loops, expected failed attempts, interventions, missing-approval block
  attempts and verified blocks, explicit approval grants, scripted recoveries,
  and failure classes. Filtered runs without an approval case label that rate
  `not_measured` rather than reporting a misleading zero;
- per-workflow expected/observed outcome, predicate results, tool-call status
  and duration, and a sanitized bounded failure detail;
- an explicit `not_run` live-canary record.

Generated reports live under `.tmp/browser-agent-benchmark/`, are owner-local
and ignored by Git. The source fingerprint makes a dirty run distinguishable
from any other working-tree state, while the development-output or packaged
`app.asar` hash binds the main compiled bundle actually launched. A focused run is evidence only for the
selected workflows. The full-corpus flag and count must be checked before
quoting an overall rate.
