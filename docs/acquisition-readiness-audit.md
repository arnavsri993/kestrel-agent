# Acquisition readiness audit

**Date:** 2026-09-21  
**Base:** `origin/main` @ `97e2cd74` (after #788 App Store/Zoom handoff and #784 Memory workspace)  
**Branch for this write-up:** `codex/acquisition-readiness`  
**Scope:** Engineering readiness for acquisition diligence — candid gaps, not a launch claim.

This audit does **not** invent passing gates. Where a PR claims local validation, that evidence is recorded as PR-local only unless remote CI / full `verify` / live operator credentials are also present. Electron remains the canonical shipping app at `/Applications/Kestrel.app`. Native CEF is a migration track, not cutover.

---

## Executive summary (honest ~1 page)

Kestrel on `main` @ `97e2cd74` is a coherent macOS Electron product with a real agent runtime, browser automation, encrypted local state, Memory workspace (#784), and a deterministic 50-workflow browser-tool benchmark. It is **not** acquisition-ready as a “agent that always has tools, survives restarts cleanly, and has left Electron behind” story.

The highest-severity product lie is **silent text-only execution**. `ModelCapabilitySchema` and `AdaptiveModelRouter` know when tools are required, but `ProviderPool` still drops tools when a provider advertises `capabilities.tools: false`. Claude Code, OpenCode, Cursor, and Codex-on-main all advertise tools as false. Automatic routing for persistent agents often omits `requiresTools`, so work that needs tools can complete as chat without a hard failure. PR #786 adds a Codex structured-tool bridge and fail-closed persistent routing; it is open and not on `main`.

Restart and approval durability are also P0. `AgentLoop.reconcileInterruptedRuns` skips interruption when the session claim PID still looks alive (`kill(pid,0)` success **or** `EPERM`), so stranded “running” claims can survive a dead owner. `waiting_approval` is retained across restart with **no approval TTL**, and scheduled jobs fail closed on restart rather than safely resuming with a reviewed policy. Heartbeat/strand ownership for long-lived persistent agents is incomplete relative to what an acquirer would expect from “always-on agents.”

Browser migration is progressive, not done. The native CEF host has shell/tabs/core relay; extensions are disabled in the normal native shell; credentials, deep site permissions, downloads, and profile migration are unmigrated. Electron is still canonical. PR #791 is an opt-in Electron-free extension workbench with disposable profile — useful evidence, not cutover. Site permissions persist camera/mic and generic grants in browser state; USB/HID/serial stay denied; private browsing is follow-up.

Secure storage policy on stable correctly prefers Keychain / Electron `safeStorage`. Development and test profiles use mock/plaintext isolation so ad-hoc signing churn does not spam Keychain prompts. **PR #782 must be rejected for production disposition:** it flips defaults toward plaintext envelopes as the normal path. Prompt root cause is signing identity churn plus historically eager `safeStorage` probing in prepare; the correct fix is **lazy migration on decrypt of legacy sealed keys**, not “plaintext forever.”

Evaluation and product truth gaps remain open: deterministic browser workflows exist, but there is no model-driven agent eval track; Memory hybrid lexical+local embedding landed with #784, but retrieval quality is not gated; connector registry and integration “truth” (configured vs reachable vs verified) are incomplete; UX IA improvements are split across open PRs (#790/#787/#785/#783) and need selective merge; privacy-preserving product analytics and crash diagnostics beyond content-free ops envelopes are missing; release gates (Developer ID, notarization, OAuth verification, production domains, support email) are external blockers.

**Bottom line:** Diligence should treat Kestrel as a strong macOS Electron agent+browser codebase with an honest migration path to native Chromium, **blocked on tool-routing integrity, restart/approval durability, storage policy discipline, and external release credentials**. Do not price the product as if #786, Chromium cutover, or plaintext-Keychain avoidance were already shipped.

---

## Implementation note (this branch)

As of the `codex/acquisition-readiness` pass that accompanies this document:

- **Integrated (reimplemented against current main, not a blind merge):** P0 Codex structured tool bridge + fail-closed `requireTools` routing from #786 agent-core files; #791 native extension workbench (opt-in); #787 chat layout CSS/sidebar widen.
- **Rejected as written:** #782 plaintext-by-default for stable/production. Kept stable=Keychain; applied only lazy `safeStorage` prepare so development plaintext paths do not probe Keychain.
- **Added here:** transport capability contract, run heartbeat / `stale_owner` recovery, Chromium cutover + parity JSON, secure-storage/portability/product-analytics docs, memory lexical baseline benchmark, model-agent fixture track, prompt-injection fixture suite, local product analytics module.
- **Still open / selective:** #790, #789 (rebase), #785 (rebase), #783, #781. Approvals TTL, private browsing, full hybrid embedding quality gate, live model-agent canaries, and external release credentials remain unresolved.

---

## Open PR disposition table for #791,#790,#789,#787,#786,#785,#783,#782,#781

| PR | Title | State (as of audit) | Disposition | Rationale |
| --- | --- | --- | --- | --- |
| [#791](https://github.com/arnavsri993/kestrel-agent/pull/791) | Add an Electron-free Chromium extension workbench | OPEN, mergeable | **HOLD — migration evidence only** | Opt-in `pnpm dev:native-extensions` workbench; normal native shell still disables extensions. Not cutover; do not replace `/Applications/Kestrel.app`. Accept only as incremental CEF evidence after review of isolation boundaries. |
| [#790](https://github.com/arnavsri993/kestrel-agent/pull/790) | Memory + Connections everyday IA | OPEN | **SELECTIVE — UX IA** | Improves Memory notes reader and Connections expandables; preserve credential/consent APIs. Merge after conflict check with #784-on-main and other IA PRs; not a P0 runtime fix. |
| [#789](https://github.com/arnavsri993/kestrel-agent/pull/789) | Fix Teams and Cursor redirects / launch failures | OPEN, **CONFLICTING** | **HOLD — rebase then accept if still green** | Real handoff bugfix; conflicts with post-#788 main. Rebase, re-run auth-link suite; do not claim live account sign-in. |
| [#787](https://github.com/arnavsri993/kestrel-agent/pull/787) | Widen agent chat / remove horizontal scroll | OPEN, mergeable | **SELECTIVE — UX IA** | Layout polish only; low risk if chat tests pass. |
| [#786](https://github.com/arnavsri993/kestrel-agent/pull/786) | Persistent-agent Codex tool execution + shared composer | OPEN, mergeable | **PRIORITY MERGE CANDIDATE (P0)** | Addresses AR-P0-CODEX-TOOLS-BRIDGE and part of AR-P0-ROUTING-SILENT-TEXTONLY for Codex. Keep unmerged until independent review of fail-closed routing + live structured tool round-trip evidence is accepted. |
| [#785](https://github.com/arnavsri993/kestrel-agent/pull/785) | Simplify navigation / projects overview | OPEN, **CONFLICTING** | **SELECTIVE — UX IA after rebase** | Navigation clarity; conflicts with main. Rebase before any merge. |
| [#783](https://github.com/arnavsri993/kestrel-agent/pull/783) | Native Find popover + UI consistency fixes | OPEN | **SELECTIVE — UX IA** | Find-in-page UX; PR body notes concurrent installs overwrote local verification — re-verify on current canonical app before merge. |
| [#782](https://github.com/arnavsri993/kestrel-agent/pull/782) | Keep macOS Keychain off by default | OPEN, mergeable | **REJECT for production disposition** | Flips stable/production toward plaintext envelopes / mock Keychain as default. Reject as shipping policy. Keep stable→Keychain; fix prompts via lazy prepare/migration (see `docs/secure-storage.md`). |
| [#781](https://github.com/arnavsri993/kestrel-agent/pull/781) | New Tab Codex usage widget | OPEN, mergeable | **OPTIONAL / non-blocking** | Useful subscription meters; not a P0 readiness gate. Keep tokens out of UI (status already claims no token copy). |

**Not in this table but on base:** #788 (merged — App Store/Zoom links), #784 (merged — Memory workspace). Those raise the baseline; they do not close the P0 catalog below.

---

## Limitation catalog

### ID: AR-P0-ROUTING-SILENT-TEXTONLY
- **Current state:** Tool-required work can be routed to text-only providers. `AdaptiveModelRouter` filters on `requiresTools`, but automatic persistent-agent routes often omit that flag. `ProviderPool` builds a request **without** tools when `provider.capabilities.tools === false`, so the model never sees tools and may answer as chat.
- **Code path:** `packages/agent-core/src/model-orchestration.ts` (`ModelCapabilitySchema`, adaptive routing); `packages/agent-core/src/providers/provider-pool.ts` (strip tools when `capabilities.tools` is false); provider adapters for Claude/OpenCode/Cursor/Codex-on-main advertising `tools: false`.
- **Severity:** P0
- **User impact:** Agents appear “done” while never executing tools; durable receipts may show no tool activity; user trust and automation outcomes fail silently.
- **Technical root cause:** Capability advertisement is honest (`tools: false`) but execution path fails open by stripping tools instead of failing closed when the task needed them; `requiresTools` is not always set for persistent automatic routes.
- **Proposed solution:** Fail closed when the task needs tools and no tool-capable provider is available; force `requiresTools` for persistent agent loops that expose tools; surface an explicit Settings error (already partially worded in orchestration). Land #786 for Codex bridge; extend the same fail-closed contract to other text-only CLIs.
- **Tests required:** Routing matrix: persistent agent + tools available / unavailable; assert no silent strip; assert user-visible error when only text-only routes exist; regression in `providers.test.ts` / persistent-agent routing suites.
- **Migration risk:** Low for fail-closed (behavior becomes louder). Medium if existing users relied on silent chat answers from agent sessions.
- **External credentials/operator action required:** no — fix is in-repo; live Codex verification helpful for #786 but not for the fail-closed guard itself.

### ID: AR-P0-CODEX-TOOLS-BRIDGE
- **Current state:** On `main`, Codex app-server route does not expose Kestrel tools to the model (`tools: false`). PR #786 implements validated structured tool requests through existing schemas, grants, approvals, execution, and verification, with native Codex permissions remaining read-only.
- **Code path:** `packages/agent-core/src/providers/codex-app-server.ts` (main); proposed `codex-tool-bridge.ts` on #786; agent loop + provider pool capability invalidation.
- **Severity:** P0
- **User impact:** ChatGPT/Codex plan users cannot run real agent work through the preferred subscription route without API keys.
- **Technical root cause:** Codex is treated as an isolated text transport; no structured tool-request bridge on main.
- **Proposed solution:** Merge #786 after review; keep approval authority in Kestrel; never stream raw tool JSON into chat; invalidate stale model catalogs when adapter capabilities change.
- **Tests required:** Unit suites for bridge + routing (PR claims 187 tests); live installed Codex app-server structured round-trip; persistent agent durable receipt with a real tool call.
- **Migration risk:** Medium — capability flip can invalidate cached catalogs; must not weaken native Codex permission read-only boundary.
- **External credentials/operator action required:** yes — operator must have a signed-in official Codex/ChatGPT plan for live verification; do not paste tokens into chat.

### ID: AR-P0-PERSIST-HEARTBEAT-STRAND
- **Current state:** Session run ownership uses idempotent claims with owner PID. `reconcileInterruptedRuns` only interrupts when the claim PID is not considered alive. `process.kill(pid, 0)` treating `EPERM` as alive can leave stranded “running” state when the process table entry is inaccessible or reused poorly across restarts. Heartbeat/strand semantics for multi-process desktop utility vs core are incomplete for diligence expectations of always-on agents.
- **Code path:** `packages/agent-core/src/agent-loop.ts` (`processIsAlive`, `reconcileInterruptedRuns`); database idempotent claims for `agent-session-run:*`.
- **Severity:** P0
- **User impact:** Runs stuck “running” after crash/restart; UI and schedulers disagree with reality; retries blocked or double-work risk if operators force-clear incorrectly.
- **Technical root cause:** Liveness is PID-signal based without a fresh heartbeat lease or generation token that survives EPERM ambiguity and PID reuse.
- **Proposed solution:** Add lease/heartbeat with TTL and generation; interrupt when lease expired even if PID check says alive; document reclaim UI; distinguish utility-process ownership from core.
- **Tests required:** Simulated dead owner with EPERM; PID reuse; utility restart; assert interrupt reason and no auto-resume of model/tool calls.
- **Migration risk:** Medium — more aggressive interruption may mark previously “stuck but claimed” runs interrupted.
- **External credentials/operator action required:** no

### ID: AR-P0-PERSIST-APPROVAL-TTL
- **Current state:** Runs in `waiting_approval` survive restart and are not auto-expired. There is no approval TTL. Scheduled jobs fail closed on restart (do not silently continue privileged work), which is safer than auto-resume but leaves pending human work without time-bound cleanup or clear expiry UX.
- **Code path:** Agent run status `waiting_approval` across `packages/agent-core/src/agent-loop.ts`, `runtime.ts`, `index.ts`; scheduled job restart policy (fail-closed).
- **Severity:** P0
- **User impact:** Stale approvals can be acted on much later than the user intends; queues fill with zombie waits; schedules do not recover without manual intervention.
- **Technical root cause:** Approval is durable state without a clock; restart policy correctly avoids blind resume but lacks expiry + notification + reschedule contract.
- **Proposed solution:** Add configurable approval TTL; on expiry mark run failed/cancelled with explicit reason; notify; for schedules, define reviewed re-arm vs remain fail-closed defaults.
- **Tests required:** Restart with waiting approval inside/outside TTL; schedule fire across restart; assert no silent privileged resume.
- **Migration risk:** Medium — existing long-lived waiting approvals may expire after deploy if TTL is applied retroactively (prefer apply TTL only to new approvals or migrate with warning).
- **External credentials/operator action required:** no

### ID: AR-P0-CHROMIUM-CUTOVER
- **Current state:** Native CEF host exists (`apps/native-chromium-host`) with shell/tabs/core relay. Extensions disabled in the normal native shell. Credentials, permissions depth, downloads, and profile migration are unmigrated. Electron remains canonical `/Applications/Kestrel.app`. See `docs/chromium-cutover.md` and `docs/chromium-parity.json`.
- **Code path:** `apps/native-chromium-host/`, `apps/chromium-host/`, Electron `UserBrowserService` / desktop main.
- **Severity:** P0 (for any diligence claim that “Kestrel is native Chromium”)
- **User impact:** Dual-runtime confusion; native demo ≠ shipping app; data would be lost or incomplete if cut over prematurely.
- **Technical root cause:** Progressive ownership without passed cutover gates; Electron still owns identity, updates, Keychain, and profile.
- **Proposed solution:** Follow controlled migration in `docs/chromium-cutover.md`; do **not** claim cutover until gates in `chromium-parity.json` pass; keep Electron shipping until then.
- **Tests required:** Parity gates per surface; packaged native smoke; profile migration dry-run; no silent replace of Application Support data.
- **Migration risk:** High — profile/credential cutover can brick user data if rushed.
- **External credentials/operator action required:** yes — Developer ID signing/notarization for any distributable native host; operator install path decisions.

### ID: AR-P0-EXTENSION-NATIVE
- **Current state:** Electron path: `BrowserExtensionManager` + `ElectronExtensionRuntime`. Native normal shell: extensions disabled. #791 adds opt-in Chrome-style extension workbench in the same Electron-free executable with disposable profile and no Kestrel shell/Core relay — evidence only.
- **Code path:** `apps/desktop/src/main/browser-extension-manager.ts`; Electron extension runtime; native host extension-disable path; #791 workbench.
- **Severity:** P0 (for native extension parity claims)
- **User impact:** Users cannot rely on extensions in native host; store install/update, toolbar actions, and privileged-shell integration remain ungated.
- **Technical root cause:** CEF Alloy/content-runtime choices and explicit disable in product shell; workbench intentionally isolated.
- **Proposed solution:** Implement `ChromiumExtensionRuntime` behind the same manager interface; require new evidence before raising compatibility state; integrate only after isolation review.
- **Tests required:** MV3 fixture matrix (content scripts, SW messaging, storage, popups, sandbox, bridge isolation); store install/update gates separate from fixture.
- **Migration risk:** High if privileged shell gains extension APIs without review.
- **External credentials/operator action required:** no for fixtures; yes for real Chrome Web Store exercises (manual, cancel-before-install as in #791).

### ID: AR-P0-SITE-PERMISSIONS-DEPTH
- **Current state:** Site permissions persist in browser state for camera/microphone and generic grants. USB, HID, and serial remain denied. Permission UX depth (per-origin management, revocation clarity, private-partition behavior) is incomplete relative to Chromium browsers users compare against.
- **Code path:** Electron browser service permission handlers / persisted browser state; deny paths for USB/HID/serial.
- **Severity:** P0 (for “full browser” diligence comparisons)
- **User impact:** Web apps needing device APIs fail closed; camera/mic grants may be hard to audit/revoke; native host unmigrated.
- **Technical root cause:** Policy intentionally deny-by-default for sensitive device APIs; persistence model not yet a full site-settings product.
- **Proposed solution:** Document denied APIs as product policy; deepen camera/mic management UI; migrate permission store as part of Chromium cutover; keep USB/HID/serial deny until explicit design.
- **Tests required:** Persist/revoke camera/mic; assert USB/HID/serial denied; partition isolation tests.
- **Migration risk:** Medium — changing persisted grant shape needs migration.
- **External credentials/operator action required:** no (OS TCC prompts are user-local when APIs are enabled).

### ID: AR-P0-SECURE-STORAGE-PROMPTS
- **Current state:** `secure-storage-policy`: stable → real Keychain / safeStorage; development/test → mock/plaintext isolation. Keychain prompts historically triggered by code-signing churn (changing ad-hoc identity) and eager `safeStorage` / `isEncryptionAvailable()` probing during prepare. **#782 proposes plaintext as the default normal path — REJECT for production.** Correct direction: keep stable=Keychain; lazy-prepare; migrate legacy sealed keys only on decrypt.
- **Code path:** `apps/desktop/src/main/secure-storage-policy.ts`; `apps/desktop/src/main/credential-broker.ts` (`PlaintextSecretProtection`, `SafeStorageSecretProtection`).
- **Severity:** P0
- **User impact:** Annoying or scary Keychain password dialogs on every rebuild; or — if #782 shipped — production secrets in plaintext envelopes by default.
- **Technical root cause:** Signing identity instability in dev + eager Keychain contact; conflating “stop prompting” with “disable protection.”
- **Proposed solution:** See `docs/secure-storage.md`. Reject #782 production default. Lazy migration; env overrides for recovery only (`KESTREL_USE_MOCK_KEYCHAIN`, `KESTREL_ALLOW_PLAINTEXT_SECRET_STORAGE`, etc.).
- **Tests required:** Policy matrix by channel; prepare does not touch Keychain in plaintext mode; legacy sealed→plaintext/safeStorage migration on read; no prompt in ad-hoc dev with mock policy.
- **Migration risk:** High if defaults flip under existing profiles; keep no-overwrite migrations.
- **External credentials/operator action required:** no for policy fix; yes for stable Developer ID consistency to reduce prompt churn in distributed builds.

### ID: AR-P0-MODEL-AGENT-EVAL
- **Current state:** Deterministic 50-workflow browser-agent benchmark exists (`docs/browser-agent-benchmark.md`, corpus-v1). It does **not** call a model. No gated model-driven agent eval track for planning quality, tool selection, or end-to-end task success under live providers.
- **Code path:** `benchmarks/browser-agent/`; runtime tool path through Electron browser service.
- **Severity:** P0 (for acquisition claims about agent intelligence/reliability)
- **User impact:** Diligence cannot distinguish “tools work” from “agents reliably complete goals.”
- **Technical root cause:** Benchmark charter deliberately excludes model calls; model track never productized with budget/secret boundaries.
- **Proposed solution:** Add an explicit opt-in model-driven track with allowlisted fixtures, cost/approval budgets, and separate report labels; never merge scores into the deterministic rate.
- **Tests required:** Fixture corpus + provider stubs; one live canary optional and labeled `live`; assert `not_measured` fields stay honest.
- **Migration risk:** Low for adding a parallel track.
- **External credentials/operator action required:** yes — for any live provider canary (operator-owned accounts; never paste secrets into chat).

### ID: AR-P0-MEMORY-RETRIEVAL-QUALITY
- **Current state:** #784 on main delivers scoped Memory documents and workspace UX. Substrate uses hybrid lexical + local embedding retrieval (`memory-substrate`). Quality is not gated by evals for recall@k, contamination across scopes, or prompt-injection via retrieved memory.
- **Code path:** `packages/agent-core/src/memory-substrate.ts`; Memory workspace UI; life-context scoring paths.
- **Severity:** P0 (if Memory is sold as durable personal context)
- **User impact:** Wrong or missing memories in agent context; cross-scope leakage risk; over-trust in “remembered” facts.
- **Technical root cause:** Retrieval shipped as infrastructure without a quality gate or red-team suite.
- **Proposed solution:** Build a fixed memory retrieval eval set (scoped hit/miss, stale docs, adversarial text); gate regressions; keep embeddings local by default.
- **Tests required:** Retrieval quality suite; scope isolation tests; embedding failure fallback to lexical.
- **Migration risk:** Low–medium if ranking changes alter which notes surface.
- **External credentials/operator action required:** no for local embedding evals.

### ID: AR-P1-CONNECTOR-REGISTRY
- **Current state:** Connections exist (Google, WhatsApp, Onshape, provider sign-ins, etc.) but there is no single machine-readable registry that enumerates every connector with setup state, scopes, verification probe, and failure taxonomy for diligence.
- **Code path:** Desktop Connections UI; provider account stores; OAuth helpers (e.g. Google Workspace docs).
- **Severity:** P1
- **User impact:** Operators and acquirers cannot see “what is connected vs decorative”; setup drifts from runtime truth.
- **Technical root cause:** Connectors grew as features without a registry contract.
- **Proposed solution:** Versioned connector registry (id, auth kind, scopes, probe, data classes, kill switch); UI and CLI read the same source.
- **Tests required:** Registry completeness vs UI; probe result enum tests (`configured` / `reachable` / `verified` distinct).
- **Migration risk:** Low.
- **External credentials/operator action required:** yes — per-connector live verify still needs operator accounts.

### ID: AR-P1-INTEGRATION-TRUTH
- **Current state:** Product guidance already says not to call a route ready because a binary exists. Implementation still risks collapsing configured/reachable/verified in UI and health. Codex usage widget (#781) helps meters but is not a full truth model.
- **Code path:** Provider health / Connections / New Tab widgets; status probes.
- **Severity:** P1
- **User impact:** Users enable a route that cannot complete verified work; support burden; diligence overclaim.
- **Technical root cause:** Status surfaces optimize for “setup complete” rather than three-state truth.
- **Proposed solution:** Enforce three-state model everywhere; never mark verified without a successful bounded probe; document probes.
- **Tests required:** Fake configured-but-unreachable; assert UI copy; probe timeout behavior.
- **Migration risk:** Low (copy/state stricter).
- **External credentials/operator action required:** yes — verified state needs live probes.

### ID: AR-P1-UX-IA
- **Current state:** Everyday IA is split across open PRs: #790 (Memory/Connections), #787 (chat width), #785 (nav/projects, conflicting), #783 (Find popover / consistency). Main already has #784 Memory workspace. Selective merge needed; not all must land for P0 runtime honesty.
- **Code path:** Desktop renderer navigation, Memory, Connections, chat layout, Find popover.
- **Severity:** P1
- **User impact:** First-run and everyday task friction; inconsistent chrome.
- **Technical root cause:** Parallel UX worktrees; conflicts with main; verification sometimes overwritten by concurrent installs.
- **Proposed solution:** Rebase conflicting PRs; merge selectively; re-verify canonical `/Applications/Kestrel.app` after each install; avoid stacking unverified UI claims.
- **Tests required:** Packaged smokes cited per PR; focused memory/nav/find tests; screenshot review without publishing personal profiles.
- **Migration risk:** Low–medium UI conflict risk.
- **External credentials/operator action required:** no

### ID: AR-P1-PRIVATE-BROWSING
- **Current state:** Private browsing is an acknowledged follow-up. Persistence, history, cookie, and permission isolation for a private mode are not acquisition-complete.
- **Code path:** Browser session/partition logic in Electron browser service; native host in-memory tabs (status JSON reports isolated/disabled credential storage).
- **Severity:** P1
- **User impact:** Users lack a trustworthy “leave no trace” mode comparable to Chrome/Safari private windows.
- **Technical root cause:** Deferred behind core browser reliability and cutover.
- **Proposed solution:** Define private partition semantics (no history write, ephemeral store, separate permissions); UI entry; tests for leakage.
- **Tests required:** Cross-session leakage tests; permission non-persistence; crash leftover cleanup.
- **Migration risk:** Medium if existing session IDs are reused incorrectly.
- **External credentials/operator action required:** no

### ID: AR-P1-PROMPT-INJECTION-SUITE
- **Current state:** Approvals, origin policy, and some browser recovery tests exist. There is no dedicated prompt-injection / tool-abuse suite covering malicious pages, retrieved memory, and connector content.
- **Code path:** Agent loop tool grants; browser automation; memory retrieval into context.
- **Severity:** P1
- **User impact:** Unmeasured jailbreak/tool-exfil risk via page text or memories.
- **Technical root cause:** Safety relies on approvals and schema validation without a continuous red-team corpus.
- **Proposed solution:** Versioned injection corpus (page, memory, MCP-like tool descriptors); expect safe-stop or approval; never auto-approve in suite.
- **Tests required:** Corpus runner in CI; golden safe-stop classes.
- **Migration risk:** Low.
- **External credentials/operator action required:** no for local fixtures.

### ID: AR-P1-PRODUCT-ANALYTICS
- **Current state:** Content-free enterprise/ops observability exists (`docs/external-observability.md`). Product activation/retention instrumentation is lacking — cannot truthfully report DAU/WAU/D1/D7/D30. See `docs/product-analytics.md`.
- **Code path:** External observability exporters; no product event pipeline for activation cohorts.
- **Severity:** P1
- **User impact:** Acquirer cannot see activation funnel; product team flies blind; risk of fabricating metrics.
- **Technical root cause:** Privacy-first ops metrics shipped; product analytics intentionally unfinished.
- **Proposed solution:** Privacy-preserving local event schema; local aggregation default; opt-in export; **do not fabricate metrics.**
- **Tests required:** Event schema validation; assert forbidden fields absent; aggregation formula tests with fixtures.
- **Migration risk:** Low if default remains local-only.
- **External credentials/operator action required:** no for local; yes if opt-in export to a collector is enabled.

### ID: AR-P1-CRASH-DIAGNOSTICS
- **Current state:** Content-free diagnostic envelopes and update-channel hooks exist. Crash/error product diagnostics with opt-in, symbolication, and actionable rates are incomplete.
- **Code path:** `apps/desktop/src/main/diagnostic-report.ts` and related tests; update failure diagnostics.
- **Severity:** P1
- **User impact:** Field failures hard to triage without asking users for sensitive logs.
- **Technical root cause:** Strong privacy boundary without a finished crash pipeline.
- **Proposed solution:** Opt-in content-free crash envelopes (stack hashes, versions, OS); never include prompts/page text/credentials; local store first.
- **Tests required:** Envelope redaction tests; size caps; opt-in off by default.
- **Migration risk:** Low.
- **External credentials/operator action required:** no for local; yes for any external crash backend.

### ID: AR-P1-RELEASE-GATES
- **Current state:** Development packages are ad-hoc signed. Production internet release still requires Developer ID Application/Installer, notarization, signed update host, arm64 packaged smoke, Gatekeeper validation, checksums (`docs/macos-distribution.md`). Public domains, support email, and Google OAuth verification are external.
- **Code path:** Electron Builder / packaging scripts; identity in `packages/shared-types/src/identity.ts`.
- **Severity:** P1 (P0 for any public download claim)
- **User impact:** Cannot ship trustworthy updates; Gatekeeper blocks; OAuth apps stuck in testing.
- **Technical root cause:** Release credentials and operator checklist incomplete relative to code readiness.
- **Proposed solution:** Execute `docs/public-release-operator-checklist.md` items; keep channel identity distinct; never call ad-hoc builds “release.”
- **Tests required:** `test:packaged-desktop:arm64`; Gatekeeper spctl; notarization staple check.
- **Migration risk:** High if bundle id / Keychain service names change without migration.
- **External credentials/operator action required:** yes — Developer ID, notarization, OAuth verification, DNS/domains, support mailbox (see External blockers).

### ID: AR-P2-PORTABILITY
- **Current state:** Product is macOS-first. Keychain, Accessibility, ScreenCaptureKit, Seatbelt, CEF host, and Apple Events are macOS-specific. Windows/Linux are **not** supported and must not be claimed. See `docs/platform-portability.md`.
- **Code path:** Desktop main native bridges; Seatbelt shell backend; native Chromium host.
- **Severity:** P2
- **User impact:** Non-issue for current macOS buyers; diligence risk only if portability is overclaimed.
- **Technical root cause:** Correct platform focus; interfaces not fully extracted for future ports.
- **Proposed solution:** Document portable Core vs macOS adapters; define interfaces without implementing Win/Linux.
- **Tests required:** unsupported-OS deny-closed tests already expected for shell; keep them green.
- **Migration risk:** N/A for ports not started.
- **External credentials/operator action required:** no

### ID: AR-P2-TEAMS-CURSOR-HANDOFF
- **Current state:** #789 fixes Teams `msteams:` and Cursor auth callback handoffs; currently conflicting with main after #788. Not merged.
- **Code path:** Browser navigation / external protocol / auth-link integration suite.
- **Severity:** P2 (P1 for users blocked on those handoffs)
- **User impact:** Silent rejection of Teams deep links or Cursor callbacks.
- **Technical root cause:** Over-strict external protocol allowlist; poor failure UX historically.
- **Proposed solution:** Rebase #789; merge after auth-link suite green; never include tokens in error strings.
- **Tests required:** Auth-link integration suite; popup/opener cases cited in PR.
- **Migration risk:** Low.
- **External credentials/operator action required:** no for synthetic tests; yes for real account sign-in (not claimed by PR).

---

## External blockers

These are **outside the git tree**. Code readiness cannot clear them:

| Blocker | Why it matters | Owner action |
| --- | --- | --- |
| **Apple Developer ID Application (+ Installer for PKG)** | Required for distributable stable builds; ad-hoc signing is not release. | Enroll/access certificates; wire CI secrets without exposing them in chat or repo. |
| **Apple notarization** | Gatekeeper path for internet download; staple required for smooth first launch. | Notary credentials + signed update host. |
| **Google OAuth verification** | Google Workspace / Google connector production use beyond test users. | OAuth consent verification, support email, privacy policy URLs on production domains. |
| **Production domains** | Update feed, marketing/docs, OAuth redirect URIs, support site. | DNS + TLS + redirect allowlist alignment with shipped app. |
| **Support email** | OAuth verification, user trust, incident response. | Mailbox staffed and listed in store/OAuth consoles. |

Until these exist and are exercised, **do not** describe Kestrel as publicly releasable, regardless of green unit tests or open PR merges.

---

## Explicit non-claims

- Native CEF is **not** the shipping app.
- Deterministic 50/50 browser workflows ≠ model agent quality.
- #786 tool bridge is **not** on `main` until merged.
- #782 plaintext-default is **not** an accepted production policy.
- No DAU/WAU/retention numbers are provided here because product analytics are not instrumented — fabricating them would be diligence fraud.
