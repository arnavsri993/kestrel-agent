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

## Resumed navigation slice

The non-Electron Chromium host now supports a per-message navigation proposal through `browser.navigate-tab`, the existing core approval execution, and `runtime-resume-agent`. The user sees the source/destination and approves once or rejects. The host consumes a matching grant before dispatch, rejects replay, and rejects a changed document even at the same URL. Other browser mutations remain unavailable. Shell reload retains pending approval; full host restart remains unsupported with this temporary profile.

The scripted browser smoke verifies no navigation before approval, successful navigation followed by actual page evidence, rejection, replay denial, and a same-URL reload invalidating approval. A stale-action error refreshes the shell so a dead approval does not block the composer. This is integration evidence, not a real-model competitive benchmark.

The desktop rail continuity check now samples closing in the same click event, as reopening already did. This avoids mistaking spring movement during CI/CDP latency for a layout jump while retaining continuity, settling, direction and endpoint checks.

## Browser form workflow

Chromium now supports separately approved ordinary text entry and button clicks using inspected refs. The integrated fixture covers entry, visible draft evidence, separately approved save, observed saved content, rejection and changed sensitive targets. Shared core approval resume preserves exact text in bounded expiring memory while redacting durable input and preview records. Restarted or expired typing proposals fail closed.

This is still a temporary-profile preview. Persistent browser/account setup, native packaging and representative real-model task evaluation remain release gates. No new competitive score is claimed. Work was recovered into a persistent worktree after the temporary directory disappeared; validation is rerun on the recovered files.

Recovered-worktree validation: all 209 test files / 1,458 tests and workspace typecheck passed; headed and headless Chromium workflow smoke passed. The typing retention expiry received an additional focused regression pass after review. These checks use fixture data and a scripted provider.
