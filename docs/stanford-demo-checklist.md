# Stanford demo readiness checklist

**Snapshot commit:** `35782c1d` (docs refresh recording `verify:meetup` **PASS** at `80baae38` in #639; engineering gate unchanged)

**Merged sprint:** #617–#637 — reliability, release gates, first-task auto-send,
meetup packaging, read-only first-task, contextual new-tab, bounds sync, memory
demo surfacing, browser smoke hardening, meetup preflight guard (#631), persona
Command Center smoke hardening (#632), in-chat memory recall receipt (#633),
Writing Studio profile panel dual loading/error fix (#636), usage-policy settings
loading/error fix (#638).

**Overall verdict:** **NOT COMPLETE** — `verify:meetup` **PASS** at `80baae38` (Aug 29,
~196s) on engineering Mac; operator rehearsal, Apple signing, Google OAuth, and
crash reporting remain open. Gate must pass again on the presentation Mac before the slot.

**Engineering handoff (Aug 29, `80baae38`):** Repository gates A1–A7 and A9 are
**COMPLETE** on the engineering Mac. Hero pillars B2–B3, first-task contract C1–C4/C6,
memory surfacing D1/D3–D4/D7, and New Tab home E1–E5 are **COMPLETE** in repo. Remaining
demo risk is **operator-only**: presentation Mac `verify:meetup`, canonical install,
Readiness warm-up, disposable project, memory beat rehearsal, and venue timing (sections
F and G). No further P0 engineering blockers identified for the primary offline demo path;
optional surfaces (Google OAuth, remote crash reporting, Honcho remote memory) are out of
scope for the stage story.

Use this matrix before going on stage. Each row has an owner, evidence command
or link, and an honest status as of the snapshot commit.

## Legend

| Status | Meaning |
| --- | --- |
| **COMPLETE** | Verified on snapshot commit or documented operator proof exists |
| **PARTIAL** | Implemented in repo; needs live rehearsal or environment-specific proof |
| **NOT COMPLETE** | Missing, blocked, or failed verification |

| Owner | Meaning |
| --- | --- |
| **Engineering** | Fix or verify in repository / CI |
| **Operator (Sai)** | Presentation Mac, credentials, rehearsal, venue |
| **Both** | Shared responsibility |

---

## A. Repository and packaging gates

| # | Requirement | Owner | Evidence | Status |
| --- | --- | --- | --- | --- |
| A1 | Full `pnpm verify` passes (typecheck, 985+ unit tests, desktop smokes, e2e) | Engineering | `corepack pnpm verify` | **COMPLETE** — passed at `94924dac` (Aug 29, run 2, ~198s); run 1 (~95s) failed `test-desktop-setup.mjs` when dev watcher lock was active — kill `dev:desktop` and clear `kestrel-electron-dev.lock` before gating |
| A2 | Meetup gate (`verify:meetup`) passes end-to-end | Engineering | `corepack pnpm verify:meetup` | **COMPLETE** — passed at `80baae38` (Aug 29, ~196s): verify → assets → real local-ai → package → packaged smokes → packaged benchmark (#638 on `main`; 1001 unit tests) |
| A3 | Website assets validate | Engineering | `corepack pnpm assets:verify` | **COMPLETE** — passed in `94924dac` run 2 (3 registry entries, 7 manifests) |
| A4 | Real local model response | Engineering | `corepack pnpm test:local-ai:real` | **COMPLETE** — passed in `94924dac` run 2 (Ollama 0.32.1, smollm2:135m) |
| A5 | Apple Silicon dev package builds | Engineering | `corepack pnpm package:mac:dev` | **COMPLETE** — passed in `94924dac` run 2 (ad-hoc dev signature) |
| A6 | Packaged desktop smoke (arm64) | Engineering | `corepack pnpm test:packaged-desktop:arm64` | **COMPLETE** — passed in `94924dac` run 2 |
| A7 | Packaged browser-agent benchmark | Engineering | `corepack pnpm benchmark:browser-agent:packaged:arm64` | **COMPLETE** — 50/50 in `94924dac` run 2 |
| A8 | Canonical app install path | Operator | `corepack pnpm install:mac:dev` then `open -a Kestrel` | **PARTIAL** — procedure documented in [ai-tinkerers-demo.md](ai-tinkerers-demo.md); operator must run on presentation Mac |
| A9 | Market / release honesty gate | Engineering | `corepack pnpm audit:market` | **COMPLETE** — passed in `94924dac` run 2 |

---

## B. Hero pillars (demo story)

| # | Pillar | Requirement | Owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| B1 | **Do This For Me** | Read-only inspect → approve → local edit → verified test evidence | Both | Ten-minute path in [ai-tinkerers-demo.md](ai-tinkerers-demo.md); `pnpm test:desktop-approvals` | **PARTIAL** — automated smokes pass when verify runs; needs on-stage rehearsal with disposable checkout |
| B2 | **What Should I Do** | Contextual New Tab: greeting, widgets, suggested actions, bounds sync | Engineering | #624; `apps/desktop/src/renderer/components/browser/new-tab.test.ts`; `new-tab-widgets.test.ts` | **COMPLETE** in repo — operator should rehearse populated vs cold profile |
| B3 | **It Remembers How I Work** | Remember → confirmation → New Tab widget → Life → Memory → new chat → recall receipt | Engineering | #625, #633; `MemoryRecallBadge.tsx`, `MemoryRecallReceiptLine.tsx`, `memory-recall-receipt.ts` | **COMPLETE** in repo — operator must run memory beat once on presentation profile |

---

## C. First-task and onboarding

| # | Requirement | Owner | Evidence | Status |
| --- | --- | --- | --- | --- |
| C1 | **Try a first task** auto-sends read-only prompt (no paste) | Engineering | `apps/desktop/src/renderer/first-task.ts`; `pnpm test:desktop-fresh-profile` | **COMPLETE** (#623) |
| C2 | Prompt uses `tools.search` (no project) or `workspace.list` + read (with project) | Engineering | `FIRST_TASK_PROMPT` in `first-task.ts` | **COMPLETE** |
| C3 | No network, browser, OAuth, or approvals on first task | Engineering | Prompt contract in `first-task.ts` | **COMPLETE** |
| C4 | Cold 9B first turn **1–2 min** expectation surfaced in UI | Engineering | `FIRST_TASK_SLOW_MODEL_NOTICE` in `first-task.ts` | **COMPLETE** |
| C5 | Operator warms model within 10 min of stage time | Operator | Readiness warm-up in [ai-tinkerers-demo.md](ai-tinkerers-demo.md) | **NOT COMPLETE** — requires rehearsal |
| C6 | Fresh-profile setup smoke | Engineering | `pnpm test:desktop-setup`, `pnpm test:desktop-fresh-profile` | **COMPLETE** when verify runs |

---

## D. Memory demo surfacing

| # | Requirement | Owner | Evidence | Status |
| --- | --- | --- | --- | --- |
| D1 | `remember that …` explicit capture parsed | Engineering | `packages/shared-types/src/memory-capture.ts` | **COMPLETE** |
| D2 | In-thread confirmation after capture | Engineering | Life/memory UI; agent-core memory path | **PARTIAL** — verify in live chat during rehearsal |
| D3 | **Recent memories** widget on New Tab | Engineering | `NewTabWidgets.tsx`, default widget set | **COMPLETE** (#625) |
| D4 | Memory recall badge on New Tab | Engineering | `MemoryRecallBadge.tsx` | **COMPLETE** (#625) |
| D5 | Life → Memory shows confirmed preference | Operator | Memory beat step 4 in [ai-tinkerers-demo.md](ai-tinkerers-demo.md) | **NOT COMPLETE** — operator rehearsal |
| D6 | New chat injects shared context when enabled | Both | Settings → Memory; `MemoryRecallStatus` | **PARTIAL** — mechanism exists; model may not always cite memory verbatim |
| D7 | In-chat **recall receipt** on assistant replies when shared context was used | Engineering | #633; `MemoryRecallReceiptLine.tsx`, `formatMemoryRecallReceipt()` | **COMPLETE** in repo — operator should call out receipt in memory beat step 5 |

---

## E. Contextual New Tab home

| # | Requirement | Owner | Evidence | Status |
| --- | --- | --- | --- | --- |
| E1 | Time-of-day greeting without leaking URLs/titles | Engineering | `new-tab.ts`, `new-tab.test.ts` | **COMPLETE** |
| E2 | Optional model-refined greeting via `new-tab-greeting` IPC | Engineering | `NewTabPage.tsx` | **COMPLETE** |
| E3 | Widget layout defaults include recent-memories | Engineering | `new-tab-widgets.ts`, `DEFAULT_NEW_TAB_WIDGET_IDS` | **COMPLETE** |
| E4 | Widget bounds sync across layout classes | Engineering | #624; `new-tab-widgets.test.ts` | **COMPLETE** |
| E5 | Suggested actions from history (credentials stripped) | Engineering | `suggestedAgentActions` in `new-tab.ts` | **COMPLETE** |
| E6 | Operator profile has enough history for compelling widgets | Operator | Browse/disposable project before demo | **NOT COMPLETE** |

---

## F. Operator blockers (explicitly open)

| # | Blocker | Owner | What's needed | Status |
| --- | --- | --- | --- | --- |
| F1 | **Apple signing** | Operator | Developer ID cert, notarization, `macos-release` GitHub environment — see [public-release-operator-checklist.md](public-release-operator-checklist.md) | **NOT COMPLETE** — demo uses ad-hoc dev build only |
| F2 | **On-stage rehearsal** | Operator | Full ten-minute path + memory beat + first task on presentation Mac with venue timing | **NOT COMPLETE** |
| F3 | **Google OAuth** | Operator | Bundled Desktop client verification or BYO client — not required for primary demo path | **NOT COMPLETE** — optional for demo |
| F4 | **Crash reporting** | Engineering / Operator | No remote crash aggregation by default; local diagnostic export from Readiness only — see [external-observability.md](external-observability.md) | **NOT COMPLETE** for production; **acceptable** for demo if local diagnostics suffice |

---

## G. Presentation-day operator checklist (Sai)

Run in order on the **presentation Mac** the morning of the demo:

- [ ] `git fetch` && checkout presentation commit (`80baae38` or later on `main`)
- [ ] `corepack pnpm install --frozen-lockfile`
- [ ] Stop any local `dev:desktop` watcher; clear `kestrel-electron-dev.lock` if present (**required** — `verify:meetup` now fails fast via preflight guard if either is still active)
- [ ] `corepack pnpm verify:meetup` — **must pass**; preflight prints stop/clear instructions on failure; if a desktop smoke fails once after a clean preflight, retry once; if persistent, file engineering issue before relying on browser tools on stage
- [ ] `corepack pnpm install:mac:dev` && `open -a Kestrel`
- [ ] **Readiness** — protected store, database, local runtime, model route, packaged app all green
- [ ] Warm local model (short chat) within 10 minutes of stage time
- [ ] Disposable project checkout on disk with dependencies cached
- [ ] Explicit memory capture **on** in Settings → Memory
- [ ] Rehearse: first task → edit path **or** memory beat → New Tab home
- [ ] Confirm offline fallback path (no Wi-Fi dependency for primary story)
- [ ] Export local diagnostic from Readiness; confirm no secrets in export

---

## Sprint close (engineering handoff → operator)

**Engineering sprint closed at `35782c1d`.** Repository gates A1–A7 and A9, hero pillars B2–B3,
first-task contract C1–C4/C6, memory surfacing D1/D3–D4/D7, and New Tab home E1–E5 are
**COMPLETE** on the engineering Mac. No further P0 engineering blockers identified for the
primary offline demo path.

**Do not mark the product shippable for Stanford until all of the following PASS on the
presentation Mac:**

1. **F2 — On-stage rehearsal** — full ten-minute path, memory beat, and first task with venue timing.
2. **Presentation Mac `verify:meetup`** — must pass at commit `35782c1d` (or later on `main`) after
   stopping any `dev:desktop` watcher and clearing `kestrel-electron-dev.lock`.
3. **F1 — Apple signing** — only if distributing beyond ad-hoc dev build; demo may proceed with
   `install:mac:dev` ad-hoc signature when rehearsal is green.

**Morning-of (Sai, presentation Mac):**

1. `git fetch` && checkout `35782c1d` (or latest `main` if a docs-only follow-up merged).
2. `corepack pnpm install --frozen-lockfile`
3. Stop `dev:desktop`; clear `kestrel-electron-dev.lock` if present.
4. `corepack pnpm verify:meetup` — must pass; retry once after clean preflight if a smoke flakes.
5. `corepack pnpm install:mac:dev` && `open -a Kestrel`
6. Readiness all green; warm local model within 10 min of stage time.
7. Disposable project on disk; explicit memory capture on; rehearse first task **or** memory beat.

Optional surfaces (Google OAuth F3, remote crash reporting F4, Honcho remote memory) remain
out of scope for the primary stage story.

---

## H. verify:meetup history

| Commit | Date | Result | Notes |
| --- | --- | --- | --- |
| `b5031ef0` | Aug 29, 2026 | **PASS** | Baseline before memory surfacing merge |
| `20f7662e` | Aug 29, 2026 | **FAIL** | `pnpm verify` stopped at `test-desktop-browser.mjs:935` — `browser.visible-screenshot` returned `failed` instead of `verified` |
| `458bb8a6` | Aug 29, 2026 | **FAIL** (run 1, ~70s) | `pnpm verify` → `test:desktop-browser` — `No active user browser view is attached` at `test-desktop-browser.mjs:378` |
| `458bb8a6` | Aug 29, 2026 | **FAIL** (run 2, ~101s) | `pnpm verify` → `test:desktop-browser` — `Detached tab did not leave the source window` at `test-desktop-browser.mjs:1089` |
| `94924dac` | Aug 29, 2026 | **FAIL** (run 1, ~95s) | `pnpm verify` → `test:desktop-setup` — timeout waiting for `just finished Kestrel setup` (dev watcher lock likely active) |
| `94924dac` | Aug 29, 2026 | **PASS** (run 2, ~198s) | Full `verify:meetup` after #629 browser-smoke fix; includes packaged smokes and benchmark |
| `7a9f97fe` | Aug 29, 2026 | **Superseded** | Engineering snapshot after #633; meetup re-run at `1ce93d0e` |
| `1ce93d0e` | Aug 29, 2026 | **PASS** (~198s) | Full `verify:meetup` on `main` after #634 checklist merge; preflight clean; 998 unit tests; packaged smokes + 50/50 benchmark |
| `8757ffff` | Aug 29, 2026 | **FAIL** (~0.3s) | Preflight only — dev watcher + Electron dev lock still active; cleared `/var/folders/.../T/kestrel-electron-dev.lock` and killed `electron-vite dev`, then re-ran |
| `8757ffff` | Aug 29, 2026 | **PASS** (~198s) | Full `verify:meetup` on `main` after #636 Writing Studio profile panel fix; preflight clean; 1001 unit tests; packaged smokes + 50/50 benchmark |
| `80baae38` | Aug 29, 2026 | **PASS** (~196s) | Full `verify:meetup` on `main` after #638 usage policy settings loading/error fix; preflight clean after killing stray `dev:desktop`; 1001 unit tests; packaged smokes + 50/50 benchmark |
| `35782c1d` | Aug 29, 2026 | **Docs only** | #639 records engineering gate at `80baae38`; no code delta; sprint-close operator handoff |

**Engineering note:** #629 stabilized browser attach/detach. #631 added an automated preflight that blocks when `electron-vite dev` or the product-scoped Electron dev lock is active — kill `dev:desktop` and clear `/tmp/kestrel-electron-dev.lock` before gating. Latest engineering meetup **PASS** at `80baae38` (~196s). #632 hardened persona Command Center opening in desktop smokes. #633 adds a bounded in-chat recall receipt when shared life context is injected. #636 fixes Writing Studio profile panel showing dual loading/error states. #638 fixes Usage policy settings showing loading text alongside a load error.

---

## Related documents

- [AI Tinkerers / Stanford live-demo runbook](ai-tinkerers-demo.md) — on-stage script and beats
- [Public release operator checklist](public-release-operator-checklist.md) — signing, OAuth, clean-machine proof
- [Market release](market-release.md) — full internet distribution gate
- [Memory system](memory-system.md) — architecture behind the memory beat
