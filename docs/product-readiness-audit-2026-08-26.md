# Kestrel product readiness audit and execution backlog

**Snapshot:** 2026-08-26

**Audited commit:** `ac634cbe6e69ae1ed2c53861feae68747313fe7b` (`origin/main`)

**Product thesis:** Kestrel is a local-first personal execution layer: goal → work → verified result.

This is an evidence snapshot, not a claim that every documented capability has
been verified against a real external account or a clean public install. It is
the decision record for choosing the next increment. Re-run the live checks
before relying on time-sensitive GitHub, Apple, Google, or provider state.

## Evidence collected

- Read the repository overview, design system, browser architecture, unified
  life-context, permissions, threat model, market-release, Google OAuth,
  conversational configuration, plugin/runtime, parity, data, memory, and
  observability documentation.
- Inspected the package/workspace structure, desktop renderer and main-process
  boundaries, task/runtime persistence, orchestration, browser automation,
  release workflows, website release gate, migrations, and test surface.
- Ran the current verification command with pnpm 11.15.1. Typecheck, 132 test
  files / 881 tests, and the 1,117-page reference audit passed. The command then
  stopped at its first failure: `audit:market` requires
  `pnpm test:desktop-personas`, but that runnable script is absent from
  `package.json` (`package.json:19-24,56`;
  `scripts/verify-market-release.mjs:248-255`). Later stages of `verify` were
  therefore not exercised in that run.
- Inspected live main CI run
  [33033511885](https://github.com/arnavsri993/kestrel-agent/actions/runs/33033511885).
  It independently confirmed two active failures: the missing persona command
  in the core job and a setup timeout that required a `.preferred` local-model
  tier even when the CI Mac exposed only one viable tier. The desktop workflow
  also retained six commands for scripts intentionally deleted by consolidation
  commit `aca9a13`: ambient, skins, dashboard extensions, Honcho memory,
  widgets, and events.
- Built the current Apple Silicon development package and ran the packaged
  smoke. Packaging, the ad-hoc development signature, the native Sharp load,
  renderer launch, and an isolated browser form action with verified output
  passed. This is private development evidence, not notarization evidence.
- Walked the packaged first-run UI in an isolated profile through Welcome,
  disclosure acknowledgment, and model choice. It showed no renderer console
  errors. The hierarchy is restrained and clear, but first use still reaches a
  model/provider decision before a demonstrated user outcome.
- Queried live GitHub state. There were no open pull requests; Pages was public;
  the only repository variable was `KESTREL_UPDATE_URL`; no `macos-release`
  environment or macOS release workflow run was present; the public releases
  were explicitly labeled development/CLI previews.
- The primary checkout contained unrelated user work on a gone branch. It was
  left untouched; all audit and implementation work uses a clean worktree from
  `origin/main`.

## Gap matrix

| System | Classification | Repository evidence | Audit conclusion |
| --- | --- | --- | --- |
| Local-first process and secret boundaries | **EXISTING AND GOOD** | `docs/architecture.md:3-16,35-49`; `docs/threat-model.md:7-26` | Renderer, main, utility core, encrypted persistence, typed IPC, policy, and untrusted-content boundaries form a credible foundation. Preserve them. |
| Approvals, idempotency, and mutation verification | **EXISTING AND GOOD** | `docs/permissions.md:3-13`; `packages/agent-core/src/runtime.ts` (`callTool`, idempotency and verification paths) | The system fails closed and does not allow page/model output to authorize actions. Do not weaken this to make demos easier. |
| Durable conversations and task ledger | **EXISTING BUT INCOMPLETE** | `docs/architecture.md:35-47`; `docs/ai-native-browser.md:29-31`; `docs/data-model.md:5` | Sessions, messages, approvals, child sessions, schedules, and agent runs persist, but an active run can remain stranded after a host crash and the transcript still carries too much task truth. |
| Plans, subtasks, and parallel execution | **EXISTING BUT INCOMPLETE** | `docs/architecture.md:55`; `packages/agent-core/src/orchestration.ts` | Bounded workers, child sessions, and typed workflows exist. There is no complete durable plan/DAG with parent reconciliation, per-node evidence, and cancellation propagation. |
| Action receipts and undo | **EXISTING BUT INCOMPLETE** | `docs/ai-native-browser.md:33-39`; `docs/chat-configuration.md:51-101` | Configuration changes have excellent preview/version/rollback semantics and browser activity has an encrypted ledger, but there is no universal user-facing receipt tying intent, approval, action, observation, verification, and rollback. |
| Visible and isolated browsing | **EXISTING BUT INCOMPLETE** | `docs/ai-native-browser.md:5-21`; `docs/architecture.md:65` | Tabs, history, bookmarks, downloads, page context, visible-browser tools, isolated sessions, and origin limits exist. Private browsing, browser import/sync, Chrome-complete extensions, per-action receipts, and production reliability evidence do not. |
| Browser failure recovery | **EXISTING BUT NOT USER-READY** | `packages/agent-core/src/browser-automation.ts`; `apps/desktop/src/main/electron-browser-service.ts` | Preconditions and post-action snapshots catch stale state, but Kestrel lacks a measured state-machine recovery strategy for changed pages, modals, redirects, login expiry, and partial progress. |
| Browser/agent benchmark | **MISSING AND REQUIRED** | No product benchmark command or workflow is present in `package.json:11-57`; current browser proof is focused smoke and unit/integration coverage | There is no reproducible high-frequency workflow suite reporting verified completion, false positives, recovery, intervention, latency, tokens, or cost. |
| Life context, people, and memory | **EXISTING AND GOOD as a foundation** | `docs/unified-life-context.md:7-73`; `docs/architecture.md:41-43` | Encrypted provenance, authority, contradiction, sensitivity, corrections, bounded retrieval, people, and calendar projections are differentiated foundations. They are not yet proven to improve ordinary tasks often enough. |
| Context usefulness and explanation | **EXISTING BUT INCOMPLETE** | `docs/unified-life-context.md:49-73`; `apps/desktop/src/renderer/components/LifeContext.tsx` | Influence receipts and correction paths exist, but there is no longitudinal evaluation showing that memory improves verified outcomes without increasing wrong assumptions. |
| Workflow reuse and learning | **EXISTING BUT INCOMPLETE** | `docs/chat-configuration.md:103-115`; workflow/result handling in `apps/desktop/src/renderer/App.tsx` | Reviewable improvement proposals and workflows exist, but the repeat-use loop is buried. A successful run does not consistently end with an editable, approval-gated “keep this workflow” experience. |
| Goals, schedules, and proactive continuation | **EXISTING BUT INCOMPLETE** | `docs/architecture.md:55`; `apps/desktop/src/renderer/components/GoalKanban.tsx` | Users can see goals/delegates/schedules, but durable user goals, progress criteria, event-driven continuation, and OS-woken automation are not a complete consumer loop. |
| Gmail and Calendar | **EXISTING BUT NOT USER-READY** | `docs/google-workspace-oauth.md:3-35,44-46` | Secure PKCE, encrypted refresh storage, narrow scopes, Gmail send/code lookup, Calendar reads/writes, revocation, approval, and read-back verification exist. Normal users must create their own Google Cloud client. |
| Files and local tools | **EXISTING BUT INCOMPLETE** | `docs/architecture.md:35-39,47`; workspace/attachment tools in `packages/agent-core` | Scoped local file and command work is strong for builders. Normal-user document preview/transformation breadth and habitual Finder/Share-menu handoff remain incomplete. |
| Onboarding and first value | **EXISTING BUT NOT USER-READY** | `README.md:7-25`; first-run implementation in `apps/desktop/src/renderer/App.tsx`; packaged walkthrough | The five-stage setup is coherent and truthful, but activation is infrastructure readiness, not a verified meaningful task within five minutes. |
| Consumer information architecture | **EXISTING BUT INCOMPLETE** | `DESIGN.md:26-150`; destination catalog in `apps/desktop/src/renderer/App.tsx` | The current restrained design has strong focus and accessibility intent. Many specialist surfaces expose architecture before a clear recurring job earns their place. Do not start another visual redesign. |
| Privacy-safe operational observability | **EXISTING AND GOOD** | `docs/external-observability.md:1-47` | Content-free OTLP/Prometheus boundaries are unusually strong. This is operational diagnostics, not product activation/retention analytics. |
| Product analytics and retention evidence | **MISSING AND REQUIRED** | No activation/cohort product event contract is described in `docs/external-observability.md`; product data claims are absent from the app | Kestrel cannot yet truthfully measure time-to-first-value, verified tasks/WAU, repeat workflows, W1/W4 retention, or failure concentration. |
| Feedback and failure taxonomy | **MISSING AND REQUIRED** | Model-call and tool audits exist (`docs/data-model.md:5`), but no end-to-end task outcome taxonomy is exposed | Failures cannot yet drive a weekly “fix the largest problem” loop. A content-free feedback path and structured failure categories are needed. |
| Development packaging | **EXISTING AND GOOD** | `README.md:23-25`; `docs/macos-distribution.md`; successful current package/smoke | The ad-hoc Apple Silicon development app is reproducible and useful for focused validation. It must never be presented as a public release. |
| Public macOS distribution | **EXISTING BUT NOT USER-READY** | `docs/market-release.md:9-24,88-141`; `.github/workflows/release-macos.yml` | Code supports Developer ID signing, notarization, DMG/ZIP/PKG, manifests, checksums, Gatekeeper, and fail-closed publication. Operator credentials, protected environment, successful tagged run, public artifact host, and clean-machine proof are absent. |
| Updates and rollback | **EXISTING BUT INCOMPLETE** | `docs/market-release.md:112-124,126-138`; update code in `apps/desktop/src/main` | Signed update metadata/check/install architecture exists. Binary failed-update recovery and a tested rollback drill are missing. |
| Privacy/support website | **EXISTING BUT NOT USER-READY** | `apps/website/src/app/privacy/page.tsx`; `apps/website/src/app/support/page.tsx`; `docs/market-release.md:26-86` | Routes and fail-closed download state exist, but verified operator identity/contact and release-linked deployed content are not configured. |
| Production crash/error reporting | **MISSING AND REQUIRED** | Local logs/readiness and optional OTLP exist; no production crash-reporting service or consented diagnostic flow was found | Public release needs privacy-bounded crash/error evidence that never uploads prompts, page content, files, or secrets. |
| Mobile, team administration, marketplace | **SHOULD NOT BE BUILT NOW** | Current macOS scope and honest boundaries: `docs/market-release.md:3-7`; `docs/architecture.md:53,69` | These expand surface area before public release, core reliability, and retention are proven. Maintain extension contracts; defer product expansion. |

## Structured audit A–J

### A. What Kestrel already has

Kestrel already has more than a browser shell: a sandboxed local-first desktop
architecture, encrypted durable conversations, real provider adapters, bounded
workspace tools, policy-scoped approvals, idempotent mutations, verified
browser actions, a persistent visible browser, isolated autonomous sessions,
life context, people/memory/calendar models, schedules, delegated workers,
signed-plugin boundaries, readiness/backup, development packaging, and
fail-closed release automation. The strongest code-level differentiation is the
combination of personal context, authenticated local execution, explicit trust
boundaries, and durable work—not any single feature.

### B. What is partially implemented

The task engine persists sessions and runs but lacks a complete restart-safe
execution state machine and durable plan graph. Browser automation verifies
individual actions but lacks systematic recovery and benchmark evidence.
Memory is inspectable but not measured by task outcome. Workflow proposals,
goals, schedules, Gmail, Calendar, observability, updates, and release
automation all have meaningful foundations but are not complete normal-user
loops.

### C. What is genuinely missing

1. A reproducible end-to-end reliability benchmark with independently verified
   outcomes and fault injection.
2. Restart reconciliation for active runs and a durable plan/DAG.
3. A universal consequential-action receipt and truthful task outcome record.
4. Product activation, cohort, retention, feedback, and failure-taxonomy data.
5. Public signing/notarization/hosting/clean-machine evidence and a binary
   rollback drill.
6. A bundled, verified production Google OAuth client.
7. A privacy-bounded production crash/error reporting path.

### D. What prevents normal people from installing it today

- `pnpm verify` is not green because the required desktop persona matrix was
  removed from the runnable package surface.
- There is no configured Developer ID/notarization environment or successful
  stable release workflow run.
- No signed public DMG, mutually verified manifest/checksums/update feed, or
  clean-machine Gatekeeper proof is live.
- Website privacy/support routes are code-complete but lack verified operator
  release inputs.
- Update rollback and failed-update recovery are not proven.

### E. What prevents normal people from getting value in five minutes

- First run asks the user to choose or connect inference before showing one
  concrete verified outcome.
- The product exposes many capable destinations without guiding a low-risk,
  relevant first task.
- Google value requires a user-created Cloud project and OAuth client.
- The magic moment—context materially improving a completed task—is not a
  measured onboarding milestone.

### F. What prevents repeat daily or weekly use

- Successful work does not reliably become an obvious editable workflow.
- Users cannot see one concise verified outcome/recovery ledger across tasks.
- Active-run crash recovery and event/OS-woken continuation are incomplete.
- Kestrel has no product evidence identifying the workflow users repeat, the
  failure that makes them abandon, or the behavior that predicts W4 retention.

### G. What prevents obvious differentiation from current AI browsers

The differentiated systems exist mostly as architecture and specialist
surfaces. The default experience does not yet repeatedly demonstrate:

1. ambiguous intent resolved from permitted personal context;
2. work executed across browser, files, email, and calendar;
3. one meaningful approval at the consequential boundary;
4. independent final-state verification; and
5. a workflow that becomes faster and more reliable the next time.

Until that loop is habitual and measured, Kestrel can still be perceived as a
browser plus a powerful sidebar.

### H. What could cause users not to trust it

- A run that remains “running” or loses its place after a crash.
- A completion claim without a universal visible receipt.
- A development/ad-hoc build presented as publicly secure.
- “Connected” state inferred from configuration instead of a live probe.
- Memory affecting an action without concise provenance/correction.
- External diagnostics that are not explicit about what stayed local.
- Broad permissions requested before the first useful result.

### I. The technical bottleneck that most affects completion reliability

The largest bottleneck is the missing durable execution state machine that
joins the plan, active run, tool/idempotency journal, approval boundary,
observations, verification evidence, and restart reconciliation. Current code
is safety-oriented and correctly avoids blindly retrying uncertain mutations;
the cost is that it can fail closed without giving the user a reliable resume
path or a complete end-to-end proof record.

### J. Five changes with the largest expected user-value increase

1. **Restore a real full desktop persona matrix and green repository gate.** It
   is small, feasible, blocks every release candidate, and prevents silent
   surface regressions.
2. **Build restart-safe run reconciliation plus universal action receipts.** It
   turns safety primitives into trustworthy task completion and recovery.
3. **Create the first 50-workflow verified reliability benchmark and failure
   taxonomy.** It replaces feature-count confidence with reproducible evidence
   and points engineering at the largest failures.
4. **Ship one guided first-task magic moment with privacy-safe activation
   instrumentation.** It converts setup into a completed outcome and reveals
   time-to-value.
5. **Promote successful repeated work into an editable, approval-gated
   workflow.** It makes Kestrel’s usefulness compound and directly targets
   retention/differentiation.

Public signing/notarization/hosting remains a P0 blocker in parallel, but its
organization-owned credentials and clean-machine proof are external operating
inputs rather than a substitute for the product changes above.

## Prioritized backlog

Each item includes the required problem, user impact, evidence, change,
architecture, risk, dependencies, acceptance criteria, tests, and target
metric. Priority can change only when new product or reliability evidence
changes expected leverage.

### P0 blockers

#### P0-01 — Repair the desktop verification matrix

- **Problem / impact:** `verify` stops at the market gate, so no commit can be
  honestly called release-candidate green and broad UI regressions can escape.
- **Evidence:** `package.json:23-24,56`;
  `scripts/verify-market-release.mjs:248-255`; live CI run 33033511885; deletion
  history in `aca9a13`. The current run passed typecheck, 881 tests, and
  reference audit before the first market-gate failure.
- **Change / architecture:** Add an isolated Playwright persona matrix for a
  fresh real profile, a returning seeded profile, and accessibility/compact
  states; traverse every current Command Center destination and both Settings
  scopes without duplicating deeper suites. Make setup honest on constrained
  Macs, remove only nonexistent CI commands, and restore current focused
  browser/writing/fresh-profile coverage to the desktop job.
- **Risk / dependencies:** Stale selectors could create a flaky checkbox test;
  use current semantic roles, observable route predicates, isolated user data,
  zero external network, and no fixed delays. Requires a built desktop.
- **Acceptance / tests:** `pnpm build`; `pnpm test:desktop-personas`;
  `pnpm audit:market`; `pnpm verify`; package and packaged smoke.
- **Metric moved:** release-gate pass rate; desktop surface regression escape
  rate.

#### P0-02 — Configure and prove production macOS signing/notarization

- **Problem / impact:** normal users cannot install a trusted public build.
- **Evidence:** release requirements in `docs/market-release.md:88-141`; live
  GitHub audit found no `macos-release` environment or release workflow run.
- **Change / architecture:** Configure protected Apple credentials/environment,
  restrict stable tags, run the existing signed workflow, and retain the
  resulting notarization, stapling, Gatekeeper, and architecture evidence.
- **Risk / dependencies:** Apple Developer membership, organization-owned
  certificates, app-specific password/API access, and protected GitHub
  environment. Never weaken the gate when an input is missing.
- **Acceptance / tests:** successful stable tagged workflow; `codesign`,
  `spctl`, `stapler`, arm64 audit; matching release assets and source commit.
- **Metric moved:** verified public-install success rate.

#### P0-03 — Publish and verify public download/update/rollback

- **Problem / impact:** even a notarized build is unusable without a reachable
  download, consistent update feed, and recovery from a bad update.
- **Evidence:** `docs/market-release.md:26-86,112-138`; current Pages site is
  public but production artifact variables are absent.
- **Change / architecture:** Host DMG/manifest/checksums/update artifacts over
  HTTPS, enable the fail-closed website state, add a tested failed-update and
  previous-version rollback drill, and keep development channels isolated.
- **Risk / dependencies:** Depends on P0-02 and stable version/tag/commit
  identity. Never use the development preview as `latest` production proof.
- **Acceptance / tests:** distribution-mode verifier passes against deployed
  URLs; clean Mac updates, restarts, and rolls back safely after an injected
  failure.
- **Metric moved:** download-to-launch success; verified update success;
  rollback recovery rate.

#### P0-04 — Bundle and verify production Google OAuth

- **Problem / impact:** Gmail/Calendar’s strongest normal-user workflow starts
  with a developer-console project, API enablement, and client-ID copy.
- **Evidence:** `docs/google-workspace-oauth.md:3-12,44-46`.
- **Change / architecture:** Register Kestrel’s production desktop OAuth client,
  verify domains/privacy/support/scopes, bundle only the public client identity,
  preserve PKCE/loopback/revocation/in-memory token boundaries, and retain BYO
  client as an advanced fallback.
- **Risk / dependencies:** Google verification and final production domains;
  no client secret belongs in a desktop app.
- **Acceptance / tests:** clean profile connects without Cloud Console work;
  identity and Calendar read-back pass; revoke/reconnect/expiry recovery pass;
  Gmail/Calendar consequential actions still require policy approval.
- **Metric moved:** Google connection completion; first connected task success.

#### P0-05 — Privacy-safe production error reporting and clean-install gate

- **Problem / impact:** public failures cannot be prioritized or supported, and
  a developer-machine smoke does not prove clean-machine behavior.
- **Evidence:** local readiness/OTLP exist (`docs/external-observability.md`),
  but no consented product crash/error path was found; clean install is a
  release requirement (`docs/market-release.md:128-138`).
- **Change / architecture:** Add opt-in content-free crash/error envelopes with
  bounded version/process/failure-class data; add a clean-machine release
  checklist or runner that verifies download, Gatekeeper, install, first
  launch, profile isolation, quit/restart, and uninstall preparation.
- **Risk / dependencies:** Diagnostic payloads must exclude prompts, URLs, page
  content, files, paths, identities, and secrets. Depends on P0-02/P0-03 for
  public-candidate proof.
- **Acceptance / tests:** schema/redaction tests; opt-in/off tests; injected
  crash reaches the configured sink without content; clean-device evidence is
  attached to the release.
- **Metric moved:** crash-free launches; diagnosable failure rate; clean-install
  success.

### P1 core product

#### P1-01 — Restart-safe execution state machine

- **Problem / impact:** active work can be stranded or ambiguous after a host
  crash even though tool claims and sessions persist.
- **Evidence:** agent runs exist (`docs/data-model.md:5`), while runtime startup
  reconciliation focuses on idempotency/process journals in
  `packages/agent-core/src/runtime.ts`.
- **Change / architecture:** Introduce explicit `needs_recovery`/`uncertain`
  transitions, persist plan cursor and last verified boundary, reconcile stale
  runs at startup, and offer resume/rewind/abort without replaying mutations.
- **Risk / dependencies:** Schema migration and backwards compatibility;
  uncertain external mutations must never auto-retry.
- **Acceptance / tests:** crash at each run/tool/approval journal boundary;
  restart yields the correct recovery option; no duplicate side effect.
- **Metric moved:** restart recovery rate; stranded-run rate; duplicate-action
  rate.

#### P1-02 — Universal action receipt and rollback contract

- **Problem / impact:** users cannot inspect one consistent proof of what was
  intended, changed, verified, and undoable.
- **Evidence:** browser ledger is partial (`docs/ai-native-browser.md:33-39`);
  configuration receipts/version rollback are stronger
  (`docs/chat-configuration.md:51-101`).
- **Change / architecture:** Add a typed encrypted receipt spanning intent,
  destination, approval, precondition observation, action, expected/observed
  state, verification, result, provenance, uncertainty, and truthful rollback
  capability; render it in the task outcome.
- **Risk / dependencies:** Evidence must be bounded and must not persist typed
  secrets, cookies, full pages, or sensitive field values. Integrates policy,
  runtime, browser, connectors, and renderer.
- **Acceptance / tests:** email/calendar/file/browser fixture actions produce
  complete receipts; failed/uncertain actions cannot render “complete”;
  rollback is offered only when a tested inverse exists.
- **Metric moved:** verified completion; false-positive completion; trust/undo
  use.

#### P1-03 — Core browser-agent reliability benchmark

- **Problem / impact:** focused tests prove primitives, not whether Kestrel can
  repeatedly finish meaningful workflows.
- **Evidence:** browser smoke exists (`package.json:26-35`), but no benchmark
  command or product workflow corpus is present.
- **Change / architecture:** Build 50 versioned workflows across research,
  forms, productivity, commerce-stop-before-purchase, accounts, and failures;
  use local deterministic sites plus separately labeled live probes; require
  independent final-state predicates.
- **Risk / dependencies:** Live sites drift and authenticated accounts are
  sensitive. Separate deterministic CI scores from opt-in live canaries and
  never publish fabricated success.
- **Acceptance / tests:** runner reports completion, verified completion, false
  positives, retries, interventions, approvals, actions, latency, tokens, cost,
  recoveries, and failure class; results bind to commit/environment/corpus.
- **Metric moved:** verified workflow success; false-positive rate; p50/p95
  duration and cost.

#### P1-04 — Bounded browser recovery planner

- **Problem / impact:** moved elements, modals, redirects, slow loads, and login
  expiry cause safe but brittle failure.
- **Evidence:** browser preconditions/snapshots exist, but richer production
  recovery remains incomplete (`docs/architecture.md:65`).
- **Change / architecture:** Represent recognized page state, expected
  transition, bounded retry budget, recovery action, checkpoint, and escalation
  reason; combine DOM/AX/navigation/network/screenshot evidence.
- **Risk / dependencies:** Never retry uncertain consequential actions; CAPTCHA,
  expired login, permission, and security changes must escalate. Depends on
  P1-02/P1-03 for evidence and measurement.
- **Acceptance / tests:** fault fixtures for renamed/moved controls, modal,
  redirect, slow load, validation error, popup, and network loss recover or
  stop at the correct bounded intervention.
- **Metric moved:** recovery rate; user interventions; retries/task.

#### P1-05 — Gmail/Calendar execution depth

- **Problem / impact:** current Google support is strongest around send, code
  lookup, and event access, not the full “resolve person → inspect thread and
  schedule → prepare → approve once → verify” loop.
- **Evidence:** current scope in `docs/google-workspace-oauth.md:14-35`.
- **Change / architecture:** Add bounded thread/search/reply/draft/attachment
  retrieval, free-busy/conflict/timezone/update/delete/recurrence support, and
  route all consequential steps through P1-02 receipts.
- **Risk / dependencies:** Depends on P0-04; minimize mailbox/calendar retrieval
  and keep message bodies out of broad context.
- **Acceptance / tests:** fixture plus live opt-in end-to-end scheduling/reply
  workflow; one meaningful approval; remote read-back; revoke/expiry recovery.
- **Metric moved:** verified connected-workflow success; approvals/task;
  connected-user retention.

### P2 retention

#### P2-01 — Guided first-task magic moment

- **Problem / impact:** setup ends at a ready model rather than a completed job.
- **Evidence:** first-run flow in `README.md:7-25` and packaged walkthrough.
- **Change / architecture:** After route verification, offer one low-risk real
  task selected from available local/browser context, show the plan, execute,
  verify an artifact or browser state, and explain what stayed local.
- **Risk / dependencies:** No synthetic connected data or fake completion;
  degrade honestly when a required route is unavailable.
- **Acceptance / tests:** fresh-profile E2E reaches a verified result without
  hidden fixtures; error/cancel/restart states work; instrumentation records
  only typed content-free milestones.
- **Metric moved:** time-to-first-verified-task; onboarding completion-to-value;
  D1 return.

#### P2-02 — Product activation and cohort instrumentation

- **Problem / impact:** Kestrel cannot learn whether users reach or retain
  value.
- **Evidence:** `docs/external-observability.md` covers operations, not a
  consented activation/retention event contract.
- **Change / architecture:** Add privacy-reviewed events for install, first
  launch, route verified, first delegated task, verified outcome, repeat task,
  workflow reuse, return session, failure class, and feedback; derive cohorts
  without prompts/content.
- **Risk / dependencies:** Explicit consent, deletion/export, stable anonymous
  installation identity, and no fingerprinting/content. Requires policy and
  privacy-page updates.
- **Acceptance / tests:** allowlist/redaction/schema tests; opt-out produces no
  egress; cohort calculations for D1/D7/D30/W1/W4 and verified tasks/WAU.
- **Metric moved:** activation; verified tasks/WAU; W1/W4 retention.

#### P2-03 — Successful-run “keep this workflow” loop

- **Problem / impact:** repeatable work does not become an obvious reusable
  asset, so Kestrel’s utility does not visibly compound.
- **Evidence:** review-only improvement and configuration transactions exist
  (`docs/chat-configuration.md:103-115`), but promotion is not central.
- **Change / architecture:** After repeated verified receipts, propose an
  editable workflow with learned steps, trigger, tools, scope, approval policy,
  version, test run, disable/delete, and rollback; activation always requires
  approval.
- **Risk / dependencies:** Depends on P1-02; do not infer a workflow from
  sensitive values or silently enable automation.
- **Acceptance / tests:** three repeated fixture runs yield one deduplicated
  proposal; edit/approve/test/version/rollback/disable/delete work across
  restart.
- **Metric moved:** repeat workflow use; time/action/cost reduction on repeat;
  W4 retention.

#### P2-04 — Task feedback and failure-driven weekly loop

- **Problem / impact:** “worked / did not work / wrong / confusing / slow” is
  not captured where engineers can prioritize the largest problem.
- **Evidence:** task/model/tool audits exist without a product failure taxonomy
  (`docs/data-model.md:5`).
- **Change / architecture:** Add one compact task feedback control and an
  opt-in content-free diagnostic envelope linked to receipt/failure class;
  publish an internal weekly aggregate by top failure and workflow.
- **Risk / dependencies:** Never attach prompt/page/file/email content by
  default; allow review before any separately disclosed diagnostic upload.
- **Acceptance / tests:** all five outcomes record locally; opt-in payload passes
  redaction; aggregates reconcile with local fixtures and never count model
  self-reported completion as verified.
- **Metric moved:** feedback rate; top-failure resolution time; repeated failure
  rate.

#### P2-05 — Personally onboard the first retained cohort

- **Problem / impact:** repository capability does not prove product demand.
- **Evidence:** no real-user/retention claim is made in the product, correctly.
- **Change / architecture:** Recruit and observe 10 target users, log attempted
  outcomes/failures/manual fallback/return behavior with consent, and feed only
  validated patterns into the weekly backlog.
- **Risk / dependencies:** This is founder work, not a telemetry substitute;
  do not seed or manufacture traction.
- **Acceptance / tests:** 10 consented onboarding records; concrete top workflow
  and top failure; behavior-based return evidence; shipped fixes linked to
  feedback.
- **Metric moved:** retained weekly users; tasks/user; workflow concentration.

### P3 differentiation

#### P3-01 — Local execution knowledge layer

- **Problem / impact:** a successfully completed site workflow costs nearly the
  same reasoning and fails the same way next time.
- **Evidence:** current browser automation stores activity/evidence but not a
  reusable semantic site-state model (`docs/ai-native-browser.md:33-39`).
- **Change / architecture:** Store bounded non-secret landmarks, recognized
  states, transitions, successful paths, failure/recovery strategies, and
  freshness/version metadata; keep external content untrusted.
- **Risk / dependencies:** Depends on verified receipts/benchmark. Never store
  cookies, tokens, passwords, sensitive field values, or page instructions as
  authority.
- **Acceptance / tests:** a repeated fixture workflow uses the learned path,
  remains correct after a controlled page change, and measurably reduces
  actions/tokens/time without lowering verified success.
- **Metric moved:** repeat-task success, latency, model tokens, cost.

#### P3-02 — Context-assisted execution evaluation

- **Problem / impact:** rich memory may retrieve correctly yet fail to improve
  the action or introduce wrong assumptions.
- **Evidence:** bounded provenance-rich retrieval exists
  (`docs/unified-life-context.md:49-73`).
- **Change / architecture:** Add evaluation cases for pronoun/person resolution,
  communication tone, calendar constraints, superseded facts, privacy
  filtering, and “why did Kestrel assume this?”; compare with/without context.
- **Risk / dependencies:** Use synthetic labeled fixtures only in tests and
  never surface them as user data. Consequential ambiguity still asks.
- **Acceptance / tests:** report helpful/correct/irrelevant/harmful retrieval;
  correction/forget/expire/sensitivity changes alter subsequent context.
- **Metric moved:** context-assisted verified success; harmful-assumption rate;
  correction rate.

#### P3-03 — Durable user goal mode

- **Problem / impact:** multi-week outcomes are represented by tasks/boards but
  not one user-owned objective with completion criteria and upcoming work.
- **Evidence:** goals/delegates/schedules surface exists; complete goal semantics
  are not in the implemented data-model claim (`docs/data-model.md:5`).
- **Change / architecture:** Add explicit goal objective, constraints,
  completion criteria, progress, related tasks/files/context, next work, and
  recurring checks; users create goals explicitly.
- **Risk / dependencies:** Requires P1-01 plan/recovery and P2 analytics; never
  infer goals from browsing or nag without opt-in.
- **Acceptance / tests:** create/edit/pause/resume/delete/restart; child task
  receipts roll up without hiding failures; progress derives from verified
  criteria.
- **Metric moved:** verified goal progress; multi-week task return; completion
  rate.

#### P3-04 — Conservative event-driven continuation

- **Problem / impact:** a task waiting on a reply/calendar/page change cannot
  reliably resume at the useful moment.
- **Evidence:** interval schedules exist (`docs/architecture.md:55`), while
  OS-woken/event-driven automation remains incomplete (`docs/architecture.md:69`).
- **Change / architecture:** Add scoped connector/webhook/file/page events that
  wake the owning checkpoint, with deduplication, cost/concurrency limits, and
  a user-controlled notification rather than an automatic consequential action.
- **Risk / dependencies:** Depends on P1 recovery/receipts and production
  connector quality. Prefer webhooks/events over aggressive polling.
- **Acceptance / tests:** duplicated/out-of-order events resume once; revoked
  permission blocks; consequential boundary still pauses; disable/delete works.
- **Metric moved:** useful resumptions; false/duplicate wakeups; intervention
  time.

#### P3-05 — Outcome-trained model routing

- **Problem / impact:** current routing measures provider health/cost/latency
  but cannot optimize for verified task outcomes.
- **Evidence:** provider attempt and token audits exist
  (`docs/architecture.md:45`; `docs/data-model.md:5`).
- **Change / architecture:** Join privacy-safe task class and verified outcome
  to route/cost/latency history; use deterministic coverage and bounded
  exploration before changing default routes.
- **Risk / dependencies:** Depends on P1-02/P1-03; avoid leaking task content or
  optimizing to model self-report.
- **Acceptance / tests:** offline replay demonstrates no quality regression;
  fallback behavior remains safe; route changes are auditable and reversible.
- **Metric moved:** verified success per dollar; p95 latency; fallback rate.

### P4 growth

#### P4-01 — Truthful public launch path

- **Problem / impact:** distribution before reliable first value would amplify
  churn and support burden.
- **Evidence:** public release prerequisites are explicit
  (`docs/market-release.md:126-141`); retention evidence is not yet available.
- **Change / architecture:** Launch only after P0 gates and a stable core
  benchmark/activation loop; publish exact supported platform, privacy, and
  release evidence.
- **Risk / dependencies:** Depends on P0, P1 benchmark, and early retained users;
  no unsupported “Chrome replacement” or traction claims.
- **Acceptance / tests:** clean download/install/update; one-minute first-value
  path; public status matches live endpoints and measured capabilities.
- **Metric moved:** download-to-first-value; crash-free launch; organic retained
  users.

#### P4-02 — Five excellent workflow templates

- **Problem / impact:** a blank composer makes a general agent hard to adopt.
- **Evidence:** workflow/orchestration foundations exist
  (`docs/architecture.md:55`), but a marketplace would be premature.
- **Change / architecture:** Curate five workflows chosen from real retained-user
  behavior; each states data, tools, approvals, expected result, verification,
  and rollback limits.
- **Risk / dependencies:** Depends on P2-05 and P1 benchmark; no template may be
  demo-only or require undisclosed access.
- **Acceptance / tests:** every template passes deterministic and live opt-in
  acceptance; setup cost and failure state are documented.
- **Metric moved:** template activation, verified runs/template, repeat use.

#### P4-03 — One truthful one-minute demo and landing path

- **Problem / impact:** the current architecture is difficult to understand in
  under a minute.
- **Evidence:** product promise is concise (`README.md:1-5`), while the complete
  cross-source loop is not yet one proven path.
- **Change / architecture:** Use the distributed product to resolve a person,
  inspect permitted message/calendar context, prepare one response/event, ask
  once, verify remotely, and show the receipt; link the exact supported build.
- **Risk / dependencies:** Depends on P0-04, P1-02, and benchmark proof; no
  hand-edited result, fixture presented as real, or prerecorded special case.
- **Acceptance / tests:** same clean build completes live repeatedly; demo
  evidence names environment/limitations; landing copy is result-first.
- **Metric moved:** visitor-to-install; install-to-first-value; demo workflow
  success.

#### P4-04 — Referral artifacts and YC evidence pack

- **Problem / impact:** useful work and company progress are not yet packaged
  into shareable, truthful evidence.
- **Evidence:** artifacts/provenance and release metadata exist; real product
  cohorts/traction do not yet.
- **Change / architecture:** Add privacy-reviewed share/export for research or
  workflow artifacts; generate a private founder report only from measured
  install/WAU/retention/task/reliability/revenue data and permissioned quotes.
- **Risk / dependencies:** Depends on P2 analytics and real usage; empty values
  remain empty and no metric or quote is inferred.
- **Acceptance / tests:** exported artifact exposes no private context by
  default; report reconciles to raw aggregates and labels unavailable metrics.
- **Metric moved:** organic referrals; real WAU growth; evidence completeness.

## First implementation decision

Use the objective’s leverage rule. P0-01 has high severity (the release gate is
red), high frequency (every verification/release candidate), high probability
of success, low engineering effort, and no external credential dependency. It
also adds meaningful surface coverage instead of weakening the gate. It is the
first implementation. P0-02 through P0-05 remain the parallel operator track;
P1-01/P1-02 are the next substantial product-engineering candidates after the
repository gate is honestly green.

### P0-01 implementation status

The focused branch now contains the real persona matrix rather than a command
alias. It launches a fixture-free profile twice to prove idle/empty restart
behavior, then a separately isolated seeded returning profile. The returning
pass discovers and traverses all 18 current Command Center destinations,
checks both Settings scopes and every section, exercises the tab-cluster and
keyboard-shortcuts dialogs, verifies keyboard focus, reduced-motion behavior,
compact/wide reflow, zero renderer errors, and zero HTTP(S) requests from the
tested renderer contexts. The
new assertions exposed and fixed route-focus conflicts between Command Center
search and generic page-heading focus.

The setup smoke now accepts one or two viable local-model tiers without
fabricating a recommended balanced tier, while still requiring the three-tier
Light/Balanced/Power contract when the device supports it. CI no longer calls
six deleted scripts; live supported desktop smokes are restored explicitly.
The full rerun also repaired observable-state races it exposed instead of
adding fixed sleeps: vertical tab-menu stacking, route remount focus, tab
detachment across Electron pointer boundaries, Command Center readiness,
Kanban reduced-motion serialization, and separation of configuration traffic
from the bounded New Tab welcome call.

Final source evidence passes with pnpm 11.15.1: `pnpm verify`, including
workspace typecheck; 132 Vitest files / 881 tests; the 1,117-page reference
audit; repository market gate; production builds; 50 website Playwright tests;
all configured desktop smoke, persona, accessibility, persistence, policy,
browser, and configuration suites; packaged CLI; editor integrations; and the
production secret scan. `pnpm package:mac:dev` then produced the Apple Silicon
development app with a valid ad-hoc signature, embedded widget extension, and
hardened-runtime development configuration; `pnpm
test:packaged-desktop:arm64` passed renderer, native Sharp, and isolated
browser-tool smoke against that exact app. This remains development evidence,
not Developer ID or notarization proof.
