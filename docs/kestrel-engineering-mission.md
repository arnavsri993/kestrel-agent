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
| 1. WhatsApp compatibility | Live unsupported-browser screen; Electron/app tokens exposed in UA | Browser specialist | Reviewed canonical deployment; real service | Embedded Chromium identity applied to persistent session and every view before navigation | UA/restore/session fixtures pass; real QR login across new tab/reload/restart in disposable candidate; authenticated pairing/read/connection and canonical delivery pending | Local `8e649457` plus broker hardening | Existing app preserved |
| 2. Teams native handoff | PR #789 route/error slice useful but origin/intent needed hardening | Browser specialist | Validated main broker; reviewed canonical deployment | Bounded Teams/Cursor routes, exact-origin app grants, active-tab input and consent revalidation | Positive/hostile frame, popup, reload, revocation and failure fixtures pass; live OS handoff pending | Local `8e649457` plus broker hardening | Not deployed |
| 3. Complex task completion | Text-only Codex route could not execute Kestrel tools | Integration owner / runtime specialist | Official dynamic-tool bridge; route readiness | Structured calls execute through existing approvals, scopes and receipts | Four live profile reads, two-file derived answer and bounded PR #809 review completed; broader multi-app reliability pending | Candidate `1a331645` plus current controls | Not deployed |
| 4. Sustained progress / fewer interruptions | Routing/worktree cancellation gaps and ineffective background pause | Integration owner | Durable execution and safe shutdown | Persistent pause, atomic job claims, active/delegated cancellation and stale-owner lease implemented | 46 focused fault tests including two actual scheduler processes with a fixture provider; full current unit suite 1,659 passes | Current control patch; exact-head full verification pending | Not deployed |
| 5. Model / effort selection | Picker lacked minimal/ultra; model listing could overstate transport support | Runtime specialist | Account-specific discovery and wire validation | Exact advertised efforts, model/transport intersection, tools required through fallback | Four accounts sent exact `gpt-6-astra` / `high`; registrations and reads observed; other efforts/modalities not live-verified | Local `2f51c29b` plus shared/picker changes | Not deployed |
| 6. Persistent engineering agent / four accounts | Existing core must supply safe persistent work without a parallel engine | Integration owner | Canonical reviewed build; scoped provider/tool/stop/restart acceptance | Existing scheduler control hardening; production agent ID none, enabled false | Four profiles execute real tools; independent quota pools unverified; scheduler fault fixtures pass | Current mission branch | Production agent not enabled |
| 7. PR integration | 23 other PRs plus mission #810; required independent latest-push approval absent | Integration owner | Exact-head review, passing CI, compatibility and protection | Every snapshot PR has a disposition; maintenance slices #805/#806/#808 reconciled; broader held reviews bounded | #810 prior head `1a331645` has passing CI/CodeQL; current patch requires new checks | Source integrated; no GitHub merge | Not deployed |
| 8. Changes appearing in actual app | Concurrent external overwrite confirmed; installed source commit unknown | Integration/deployment owner | Fresh integrated main and owner; signed matching artifact | Kernel installation lock, ownership/main/hash/downgrade gates and visible component diagnostic | Clean `1a331645` package and packaged smokes pass; visible candidate component IDs match; installed identity unverified | Source candidate `1a331645` | Canonical app preserved; updated install pending |
| 9. Competitor overlap / switching reasons | Dots and Grok Bot share the persistent teammate promise | Integration owner | Matched journey evidence | Compare delegated responsibility, follow-through and verifiable outcomes | Current primary sources refreshed; zero standalone competitor trials or leadership claim | Mission benchmark documentation | Not applicable |
| 10. Measurable reliability | Test counts do not establish live usefulness | Integration owner | Repeated real user journeys | Explicit evidence classes and 9/10 live journey target retained | Prior complete candidate verify/package; current control unit/fault tests; simple live tasks only | Full current candidate rerun pending | Canonical visible journeys pending |

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

Current executable steps are in the latest checkpoint below. The branch must
pass its review gate before any protected-main merge or canonical deployment.

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
[competitor journeys](kestrel-competitor-benchmark.md). At this checkpoint,
transport cleanup, combined verification and signed package inspection were
still outstanding; later checkpoints supersede that task list.

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


## Authoritative October 1 control checkpoint

The clean candidate `1a331645d8cd9035cef742a43d2a8fa0aaebb02d` completed
the full `corepack pnpm verify`: 232 unit-test files / 1,645 tests, the dedicated
50,000-record encrypted-source benchmark (9 tests), audits, typechecking,
builds, 50 website E2E tests, browser benchmark and all aggregate desktop,
packaged CLI and security checks. The clean ad-hoc signed development package
passed separate packaged smoke, auth-link, model-routing, account and restart
checks. Its visible diagnostic matched main/preload/renderer/core identities,
and honestly marked installation identity unverified. This evidence belongs
to that prior commit, not the current control patch.

Current controls fix persisted background pause, route/worktree/model/child
cancellation, approval retirement, atomic cross-process claims and immediate
terminal run authority. Job ownership has a 30-second lease renewed every
5 seconds. Shutdown releases owned jobs as failed with uncertain outcome;
late results cannot revive them. Interrupted work is never silently replayed.
An independent source review found a shutdown drain gap when pause arrived
during routing; completion now occurs on every finally path and the regression
awaits drain. The current patch passed 46 focused tests, 233 unit-test files /
1,659 tests and repository typechecking. Final exact-head aggregate, package
and remote CI verification remain required before treating this patch as ready.

A real bounded PR #809 review through the candidate used six Astra High turns
and five verified tool reads/writes, completed in 77.635 seconds and persisted
completed. This is a bounded repository canary, not a sustained production
Engineering agent or a complex multi-app completion rate. Four authenticated
profiles executed real dynamic tools, but profile comparison found only three
distinct emails, including one email with separate Team/Plus profiles. The
provider does not expose a billing/quotapool identity, so four independent
capacity pools are unverified. No account preference or credential changed.

PR #810 is open; its prior exact head passed CI and CodeQL, but protection
requires one eligible independent approval after the latest push. Source
integration, packaged inspection and an unmerged PR do not satisfy that gate.
The canonical app remains the separately observed PID 6000 / installed asar
`573dc322d10e50a719614a25612499b2e13e52c9419f8ad3eba8e0197210e304`,
with source commit unverified. No canonical replacement, production profile
reset, protected merge, deployment-owner claim or persistent supervisor was
performed. Production Engineering agent ID: **none**; enabled: **false**.

The real WhatsApp QR page and restart restoration were observed in a
disposable candidate profile. Canonical connection setup, pairing and
authenticated read remain pending; real Teams OS handoff also remains pending.
Dots and Grok Bot are compared as the same persistent teammate promise.
Private raw traces, provider/account evidence and screenshots remain outside
Git. The mission is unfinished until the review, canonical delivery and
production-agent acceptance boundaries are satisfied.
