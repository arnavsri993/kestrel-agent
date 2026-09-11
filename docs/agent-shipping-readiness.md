# Agent shipping readiness — 2026-09-10

Scope: current main (`3fc8f3eb`) plus this change, Apple Silicon local desktop and the standalone agent boundary. This is an engineering assessment, not a measured reliability percentage or an independent security audit. Uncommitted work in the original checkout is excluded.

## Score: 72/100 before, 82/100 after

| Dimension | Maximum | Before | After | Evidence and remaining deduction |
| --- | ---: | ---: | ---: | --- |
| Policy, privacy, execution authority | 20 | 17 | 17 | Encrypted database, schema-validated broker, approvals and idempotency remain authoritative. No independent penetration assessment in this pass. |
| Recovery and lifecycle | 20 | 12 | 16 | Cleanup exceptions no longer bypass shutdown/recovery; adapter throws return failures. Real child crash and durable-session restoration pass. A never-settling cleanup can still delay recovery. |
| Node transport correctness | 15 | 9 | 13 | Queued sends are no longer reported as failed merely because send returns false. Spawn/send errors terminate safely, with recovery after close and no request replay. No prolonged load/soak evidence. |
| Independence from Electron | 15 | 11 | 11 | Packaged agent already uses pinned standalone Node; shared lifecycle tests now live with core-service, and smoke imports no desktop modules. Desktop UI, native browser and OS integration still depend on Electron. |
| Verification coverage | 15 | 13 | 14 | 1,450 unit tests and workspace typecheck pass; real Node, sidecar and Chromium flows pass. Fixture tests cannot establish general live-site agent success. |
| Delivery proof | 15 | 10 | 11 | Canonical app refreshed, matching hashes and real Node process observed, live harmless agent response succeeded. Development ad-hoc signing does not prove notarized release or updater delivery. |
| **Total** | **100** | **72** | **82** | **A stronger development build; unrestricted public release is not certified.** |

## Changes and failure modes

1. `CoreSupervisor.stop` previously abandoned child shutdown if browser cleanup rejected. Crash handling also evaluated cleanup before constructing a promise, allowing synchronous throws to interrupt recovery. A shared guarded cleanup method now reports the error and allows lifecycle handling to continue.
2. A synchronous browser adapter throw previously escaped the event handler. Adapter invocation now starts inside a promise, producing the same failed response as an asynchronous rejection.
3. `nodeCoreProcess` previously interpreted `ChildProcess.send()` returning false as proof the request was not dispatched. Node also returns false for backpressure; reporting failure for a queued mutation can encourage an unsafe retry. Completion callbacks now identify actual send errors. Spawn and asynchronous send failures are contained; the child is terminated and the supervisor sees termination only after close. Uncertain work is never replayed.
4. Supervisor regression ownership and the real-process smoke now belong directly to the independent core service. Durable session restoration is checked across a real process crash.

Node transport semantics: [official child-process documentation](https://nodejs.org/api/child_process.html#subprocesssendmessage-sendhandle-options-callback).

## Verified locally

- Complete `corepack pnpm verify` passed: workspace typecheck, all 207 unit-test files / 1,450 tests, audits, builds, browser benchmark, 50 website end-to-end tests, desktop flows, packaged CLI, editor integration and secret scanning.
- Focused supervisor and Node transport tests: 19 passed.
- Standalone core build rejects Electron imports; real Node bootstrap, request, crash recovery and durable session restoration passed.
- Packaged pinned-Node sidecar smoke passed. Missing Node executable is also exercised as a real spawn failure without crashing the host.
- Chromium host smoke passed: conversation, reload, cancellation, native web tabs, bridge isolation and narrow layout.
- Installed-executable packaged desktop smoke passed, including native Sharp, isolated browser tools and action receipts.
- Canonical `/Applications/Kestrel.app` rebuilt, installed and reopened with existing profile. App archive and core bundle hashes match the worktree's packaged output.
- Running child is `/Applications/Kestrel.app/Contents/Resources/agent-core/node/bin/node`; the installed app visibly returned `Agent runtime verification passed.` from a harmless no-tool request.

## Remaining release gates

- Establish signed/notarized distribution and update installation on a clean Mac. The local build is ad-hoc signed only.
- Run longer concurrent-agent and transport load tests, including stalled host cleanup. Cleanup needs an explicit failure policy before claiming bounded recovery for a hung native backend.
- Treat the Chromium host as a preview until durable profile handling, approved tools, protected credentials, native integration, packaging and browser feature parity are proven there. Never copy the user's encrypted profile into it implicitly.
- Validate representative real provider/tool workflows beyond the no-tool live response; existing deterministic benchmarks do not measure autonomous model quality on live sites.

The next Electron migration slice should re-host one approved tool flow with durable approvals in Chromium, using the existing core contracts. Removing the working desktop host before those boundaries are proven would reduce shipping readiness.
