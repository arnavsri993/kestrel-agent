# Agent shipping readiness — 2026-09-10

Scope: current main (`3fc8f3eb`) plus this change, Apple Silicon local desktop and the standalone agent boundary. This is an engineering assessment, not a measured reliability percentage or an independent security audit. Uncommitted work in the original checkout is excluded.

## Score withdrawn

The initial 72/100 and 82/100 scores overweighted infrastructure and deterministic tests. They did not measure whether a person can finish useful work, or establish competitive readiness against OpenClaw. They are withdrawn rather than replaced with another unsupported number.

This report documents a verified infrastructure improvement only. Product readiness must be assessed using end-to-end outcomes, intervention count, false completion, recovery, setup effort, and repeatability. The existing 50-workflow deterministic benchmark explicitly does not call a model. Its success cannot establish autonomous agent competence.

The product target and next capability sequence are in [browser-agent product architecture](browser-agent-product-architecture.md).

## Changes and failure modes

1. `CoreSupervisor.stop` previously abandoned child shutdown if browser cleanup rejected. Crash handling also evaluated cleanup before constructing a promise, allowing synchronous throws to interrupt recovery. A shared guarded cleanup method now reports the error and allows lifecycle handling to continue.
2. A synchronous browser adapter throw previously escaped the event handler. Adapter invocation now starts inside a promise, producing the same failed response as an asynchronous rejection.
3. `nodeCoreProcess` previously interpreted `ChildProcess.send()` returning false as proof the request was not dispatched. Node also returns false for backpressure; reporting failure for a queued mutation can encourage an unsafe retry. Completion callbacks now identify actual send errors. Spawn and asynchronous send failures are contained; the child is terminated and the supervisor sees termination only after close. Uncertain work is never replayed.
4. Supervisor regression ownership and the real-process smoke now belong directly to the independent core service. Durable session restoration is checked across a real process crash.

Node transport semantics: [official child-process documentation](https://nodejs.org/api/child_process.html#subprocesssendmessage-sendhandle-options-callback).

5. Production audit identified critical Next.js and high-severity Sharp/js-yaml advisories. Upgrade Next.js to 16.3.3, Sharp to 0.35.4 across all hosts, and the js-yaml override to 4.3.2. Add `pnpm audit --prod` to the local verification gate (CI already checked it) so a locally green verify cannot omit dependency auditing.

## Verified locally

- Production dependency audit: no known vulnerabilities after the patched dependency updates.
- Original complete `corepack pnpm verify` passed. After dependency updates, its browser smoke exposed an about:blank/localStorage startup race; the smoke now waits for the real shell URL and that check plus all remaining stages passed. Together, the final validation covers: workspace typecheck, all 207 unit-test files / 1,450 tests, audits, builds, browser benchmark, 50 website end-to-end tests, desktop flows, packaged CLI, editor integration and secret scanning.
- After the Chromium-reader and host-ceiling changes, workspace typecheck and all 208 test files / 1,454 tests passed. Focused supervisor and Node transport tests: 19 passed.
- Standalone core build rejects Electron imports; real Node bootstrap, request, crash recovery and durable session restoration passed.
- Packaged pinned-Node sidecar smoke passed. Missing Node executable is also exercised as a real spawn failure without crashing the host.
- Chromium host smoke passed headed and headless: conversation, reload, cancellation, native web tabs, opt-in model/tool/page round trip, denial after run completion, host mutation denial, bridge isolation and narrow layout. The provider is scripted; this does not measure model reasoning quality.
- Installed-executable packaged desktop smoke passed, including native Sharp, isolated browser tools and action receipts.
- Canonical `/Applications/Kestrel.app` rebuilt, installed and reopened with existing profile. App archive and core bundle hashes match the worktree's packaged output.
- Running child is `/Applications/Kestrel.app/Contents/Resources/agent-core/node/bin/node`; the installed app visibly returned `Agent runtime verification passed.` from a harmless no-tool request.

## Remaining release gates

- Establish signed/notarized distribution and update installation on a clean Mac. The local build is ad-hoc signed only.
- Run longer concurrent-agent and transport load tests, including stalled host cleanup. Cleanup needs an explicit failure policy before claiming bounded recovery for a hung native backend.
- Treat the Chromium host as a preview until durable profile handling, approved tools, protected credentials, native integration, packaging and browser feature parity are proven there. Never copy the user's encrypted profile into it implicitly.
- Validate representative real provider/tool workflows beyond the no-tool live response; existing deterministic benchmarks do not measure autonomous model quality on live sites.

Chromium now re-hosts read-only browser tools through the existing core contracts, protected by a host-owned tool ceiling. The next slice is one approved write flow with durable approvals. Removing the working desktop host before those boundaries are proven would reduce shipping readiness.
