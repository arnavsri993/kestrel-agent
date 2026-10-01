# Kestrel engineering mission

Started 2026-09-30. Integration and canonical deployment owner: the mission
branch in `/private/tmp/kestrel-reliability-mission`. Specialists use isolated
worktrees and never install an app or change the production profile.

## Baseline and evidence rules

- Remote: `arnavsri993/kestrel-agent`; default branch: `main`.
- Initial main: `f9f7e45f15f2a36afa6e6d6ac9b878b3d791e93c`.
- Primary checkout: clean `codex/acquisition-readiness`, `b8f1013cee68df16bc1d5541929e40e1015837ac`.
- Canonical process: `/Applications/Kestrel.app/Contents/MacOS/Kestrel`,
  PID 90212, started September 30 at 11:01:56 America/Chicago.
- Initial installed `app.asar` SHA-256:
  `5aebe4090fb4ac31ea8ede1ea52f4d37c20795c8aa7c1bb751c71a66bdb74a90`.
- No desktop development watcher was observed. The installed app has no
  source/component build provenance, so its commit is unverified.
- Live WhatsApp tab reproduced “WhatsApp works with Google Chrome 100+”.
- Live repository-review task selected GPT-6-Astra / High, but Send was
  disabled: no configured route satisfied the task's required tools.
- Eighteen PRs were open. Snapshot includes exact heads; most require review,
  several fail CI, and four conflict. No protection bypass is authorized.
- Jules key is not configured. The requested worker catalog file is absent;
  the live `models_cache.json` advertises tool-capable Sol high workers.
- Private browser traces, account details, screenshots and raw logs remain
  local, outside the repository. Never put credentials in this record.

Source, deterministic fixtures, live provider turns, live services, packaged
artifacts, installed files, and running UI are separate evidence classes.
Skipped or simulated tests never count as live success.

## Requirements register

Each row tracks the ten original requirements. Commit and deployment fields
must be updated only after the corresponding operation is verified.

| Requirement | Reproduced symptom / hypothesis | Owner | Dependency | Implementation | Evidence | Integrated commit | Deployment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1. WhatsApp compatibility | Live unsupported-browser screen; Electron/app tokens exposed in UA | Browser specialist | Reviewed canonical deployment; real service | Embedded Chromium identity applied to persistent session and every view before navigation | UA/restore/session fixtures pass; real QR login across reload/restart in disposable candidate; pairing/canonical pending | Local `8e649457` plus broker hardening | Existing app preserved |
| 2. Teams native handoff | PR #789 route/error slice useful but origin/intent needed hardening | Browser specialist | Validated main broker; reviewed canonical deployment | Bounded Teams/Cursor routes, exact-origin app grants, active-tab input and consent revalidation | Positive/hostile frame, popup, reload, revocation and failure fixtures pass; live OS handoff pending | Local `8e649457` plus broker hardening | Not deployed |
| 3. Complex task completion | Text-only Codex route could not execute Kestrel tools | Runtime specialist | Official dynamic-tool bridge; route readiness | Codex dynamic calls return to existing AgentLoop approvals/scopes/receipts | Four real account tool reads and one full three-turn, two-file derived-answer completion | Local `2f51c29b`; final transport review in progress | Not deployed |
| 4. Sustained progress / fewer interruptions | Tool transport and oversized results can abort useful work | Runtime specialist | Verified cancellation, bounded task budgets, durable execution | Tool-capable fallback enforced; existing durable runtime retained | Small full completion and cancellation/RPC cleanup regressions verified; broader long-running recovery target unmeasured | Local `2f51c29b` + `55429bae`; transport cleanup hardened | Not deployed |
| 5. Model / effort selection | Picker lacked minimal/ultra; model listing could overstate transport support | Runtime specialist | Account-specific discovery and wire validation | Exact advertised efforts, model/transport intersection, tools required through fallback | Four accounts sent exact `gpt-6-astra` / `high`; registrations and reads observed; other efforts/modalities not live-verified | Local `2f51c29b` plus shared/picker changes | Not deployed |
| 6. Persistent engineering agent / four accounts | Existing agent and account systems must be extended, not duplicated | Integration owner / runtime specialist | Verified provider isolation, tools, cancellation, deployment | Safety/readiness audit | Agent not enabled; four live account tool reads verified, scheduler not verified | Pending | Pending |
| 7. PR integration | Initial 18 became 22, then 23 with #809; all main-target heads require approval | PR reviewer / integration owner | Complete exact-head source review, passing CI and compatibility | Every refreshed PR has explicit disposition; no eligible protected merge | 7 green, 14 failed, 1 missing checks; see dated PR record and review-coverage limits | No GitHub merge | No unreviewed deployment |
| 8. Changes appearing in actual app | No cross-worktree lock/provenance gate; prior overwrite documented | Integration/deployment owner | Clean current integrated main; recorded owner; signed matching artifact | Kernel lock, fresh-main/owner/downgrade/hash gates, recoverable previous app and component diagnostic implemented | Competing-process, stale/revoked-owner, stale-source and tampered/mixed fixtures; visible development diagnostic matches all components; package/canonical pending | Mission branch; unmerged | Existing app preserved |
| 9. Competitor overlap / switching reasons | Overlap requires journey evidence, not feature-count marketing | Integration owner | Measured user journeys | Seven current primary-source products compared with bounded switching hypotheses | See competitor benchmark; zero competitor trials; no market-leader claim | Mission documentation | Not applicable |
| 10. Measurable reliability | Fixture counts alone do not measure live usefulness | Integration owner / specialists | Repeatable production-path evaluations | Baseline and thresholds established | See thresholds below | Pending | Pending |

## Acceptance thresholds fixed before tuning

- Critical integrity: zero unauthorized tool execution, secret disclosure,
  profile loss, duplicate consequential writes, or silent capability downgrade.
  All applicable deterministic safety regressions must pass.
- Deployment: two competing installers cannot replace simultaneously; stale
  process ownership recovers safely; non-owner, dirty, unintegrated and
  downgrade candidates fail before touching the canonical app. Installed
  hashes and all observed component IDs must match the intended build.
- Browser: real WhatsApp reaches login/session across reload and restart;
  Teams native launch or working web fallback is observed. A fixture does not
  satisfy either live-service threshold.
- Routing: manual and auto selections reach the wire; unsupported values are
  rejected and fallback preserves required tools/modalities/context. Four
  accounts require four separately authenticated live receipts.
- Recovery: cancellation halts new work and reaches workers; uncertain writes
  reconcile before retry. Restart must preserve task and approval state.
- Broader usefulness target: at least 9/10 verified completions per selected
  journey over ten live trials, with intervention/time/failure counts reported.
  This is a target until those trials are actually run.

## Deployment and continuation contract

Only a clean source commit at the fetched and freshly confirmed remote `origin/main` tip may replace
the canonical app. Packaging a candidate is permitted for isolated review.
Branch protections and required review remain in force. Recoverable prior
bundles go to Trash; production databases, sessions and Keychain are untouched.

A configured persistent-agent template is not an active supervisor. Enable
Kestrel Engineering only after its real tool route, account isolation, stop
control and bounded first task pass. Local work cannot continue while the
machine is asleep or powered off. App-quit/window-close behavior must be
measured before claiming background continuity.

Next executable steps: finish installation lock/provenance tests, reconcile
browser/runtime specialist commits, record all PR dispositions, validate the
combined exact commit, publish its PR, then deploy only after review/merge.

## October 1 verified milestones

- Browser compatibility/handoff and runtime bridge commits are reconciled in one
  local integration branch. This is source integration, not a protected-main merge.
- Current four-account probes: 4/4 account reads, advertised Astra High choices
  and rate-limit probes pass. Each account completed one bounded dynamic-tool
  read of a synthetic isolated fixture through the real provider transport.
- One further live run used three exact Astra/high turns and two verified
  `workspace.read` results (`ALPHA=12`, `BETA=30`) to return
  `TOTAL=42; inputs=alpha.txt,beta.txt`. Both observed and persisted run states
  were `completed`. This is one simple task, not a complex-task reliability rate.
- Read-only executions have persisted RuntimeToolExecution verification; the
  separate side-effect ActionReceipt list is intentionally empty for reads.
- No credentials copied, paid fallback, production agent, canonical install,
  profile reset or GitHub merge occurred. Raw provider evidence remains private.
- The production Engineering agent ID is **none**, enabled **false**. Its
  sustained-run, stop, permission and canonical deployment prerequisites still
  need the reviewed integrated app. No background continuation is claimed.
- Full default-main baseline: 225 files / 1,565 tests passed on September 30.
  Focused browser/deployment regressions and 736 agent-core tests passed before
  final combined verification; later transport hardening requires rerun.

See [PR dispositions](kestrel-pr-dispositions-20261001.md) and
[competitor journeys](kestrel-competitor-benchmark.md). The next executable
steps are final transport cleanup, security/receipt/benchmark reconciliation,
combined verification and signed package inspection, then the normal review
and merge gate before canonical installation and real-service journeys.

- October 1 canonical recheck: PID 6000, launched September 30 at 19:38:35
  America/Chicago; installed app.asar SHA-256
  `573dc322d10e50a719614a25612499b2e13e52c9419f8ad3eba8e0197210e304`.
  The artifact and process changed outside this mission since its baseline.
  Existing user activity was visible, so the mission did not restart the app.
  Its source commit remains unverified because provenance is absent.
- Final provider hardening rejects orphan turns: known turns interrupt before
  archive; unknown startup or failed interruption closes the transport before
  reuse. Both numeric and string server RPC IDs preserve exact response IDs.
  Six fault regressions and 105 focused tests pass before combined verification.

## Integrated candidate validation and checkpoint

The mission branch selectively reconciles the reviewed maintenance slices of
#805 (patched runtime dependencies), #806 (truthful oversized-result receipt)
and #808 (dedicated full 50,000-record benchmark). Their original PRs remain
unmerged and open under the protected review gate. These source integrations
are commits `a32f7e13`, `55429bae`, and `2ed962e6`. Broad unreviewed UI, native
computer-use and static model priors were not imported. #782 remains rejected
as written; #795 remains held for authentication regression evidence.

- The combined candidate passed 230 files / 1,629 tests and the full
  50,000-record encrypted-storage benchmark; website E2E passed 50 tests.
  Dependency audit reports no known vulnerabilities.
- Layout, settings, new tab, browser navigation/auth popup fixtures, restart
  restoration and protected autofill coverage passed. The aggregate run was
  interrupted during autofill; its isolated rerun passed. Remaining aggregate
  checks and the final exact candidate rerun are required before a full pass.
- Package provenance rejected a desktop/core mismatch. Investigation confirmed
  electron-vite's temporary generated config entered only the desktop source
  digest. Only untracked exact generated-config modules are excluded; tracked
  and other new source still affect the identity. A regression verifies this.
- Exact-head merge-tree checks cover all 22 snapshot heads with no head drift.
  Conflicts against initial main: #793 package.json; #789 auth-link smoke;
  #785 DESIGN.md; #783 DESIGN, browser service/tests, App, BrowserWorkspace,
  renderer entry and package.json. Clean merge trees do not establish approval.

The candidate remains uninstalled. Only a normally reviewed, passing merge to
current main permits canonical deployment. The previous app and all user data
remain available. The existing source/profile are unchanged outside the
mission's isolated worktrees. No persistent supervisor or durable wake-up is
active. Final exact-head evidence is recorded in the mission pull request;
private raw canaries, screenshots and logs stay outside Git.

## Resumed verification checkpoint

At `54ed70e8`, the exact-source run passed 231 files / 1,630 tests, full 50,000-record benchmark (9 tests), audits/builds, 50 website E2E tests, browser benchmark and desktop checks through model routing/provider accounts. The aggregate then correctly failed the old auth-link fixture's automatic HTTP/no-click launch expectation. Fixture repair preserves POST/redirect/opener checks and adds actual HTTPS native input and explicit fixture consent. Real Electron inspection also showed default-policy protocol popups omit the referrer; a secure scoped main-frame popup path is implemented rather than lending a top-origin grant to unknown frames. Final exact-source verification remains required after that change.

The same candidate reached the **real WhatsApp QR login** in an isolated disposable profile across new tab, reload, and app restart/tab restore. Unsupported-screen false; Electron 43.7.7 / actual Chromium 150.0.7871.250, matching view/navigator engine identity, persistent browser partition, secure storage and activated service worker observed. QR pairing, authenticated reads, connection setup and canonical-profile delivery remain unverified. No existing session was reset. The visible diagnostic showed matching main, renderer, preload and core IDs and honestly marked the run as development, with installed identity unverified.

A final-root live account-3 canary completed two scoped file reads and verified the derived answer in 19.758 seconds / three Astra High turns. Both observed and persisted run states were completed. The provider did not report complete token usage for interrupted tool-request turns; zero fields there do not establish zero resource use. This simple canary does not establish complex-task reliability.

New #809 has an explicit hold; #786 now has complete changed-diff coverage and two confirmed findings. Review coverage for other large held PRs remains bounded as recorded. No protected merge, deployment-owner claim, canonical install or production Engineering agent occurred.

The popup bridge keeps the native missing-referrer handler closed and uses isolated trusted main-frame input, matched native intent, exact sender/document/URL, a private nonce and acknowledged generation. It preserves the same main-process validators, consent, revocation and one-use limit. Foreign frames cannot borrow it. BFCache restoration rotates registration and requires new input/ack. Independent source review found no confirmed authority bypass; 160 focused tests and desktop typecheck passed. Built/packaged default-policy popup verification is still required. The existing experimental Electron `executeInMainWorld` API is used with a fail-closed fallback; same-document URL changes also fail closed until a new document loads.
