# Stanford demo readiness checklist

**Snapshot commit:** `20f7662e` (`Surface memory on New Tab and chat for demo visibility`, #625)

**Merged sprint:** #617–#625 — reliability, release gates, first-task auto-send,
meetup packaging, read-only first-task, contextual new-tab, bounds sync, memory
demo surfacing.

**Overall verdict:** **NOT COMPLETE** — engineering demo path is largely wired;
operator rehearsal, Apple signing, Google OAuth, and crash reporting remain
open. `verify:meetup` must be re-run and pass on the presentation Mac before
the slot.

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
| A1 | Full `pnpm verify` passes (typecheck, 985+ unit tests, desktop smokes, e2e) | Engineering | `corepack pnpm verify` | **PARTIAL** — failed `test-desktop-browser.mjs` on `browser.visible-screenshot` at `20f7662e` (Aug 29 local run); prior pass on `b5031ef0` |
| A2 | Meetup gate (`verify:meetup`) passes end-to-end | Engineering | `corepack pnpm verify:meetup` | **NOT COMPLETE** — blocked by A1 failure before packaging stage |
| A3 | Website assets validate | Engineering | `corepack pnpm assets:verify` | **COMPLETE** — passed in Aug 29 run before browser smoke failure |
| A4 | Real local model response | Engineering | `corepack pnpm test:local-ai:real` | **NOT RUN** — not reached after A1 failure |
| A5 | Apple Silicon dev package builds | Engineering | `corepack pnpm package:mac:dev` | **NOT RUN** — not reached after A1 failure |
| A6 | Packaged desktop smoke (arm64) | Engineering | `corepack pnpm test:packaged-desktop:arm64` | **NOT RUN** — part of `verify:meetup` |
| A7 | Packaged browser-agent benchmark | Engineering | `corepack pnpm benchmark:browser-agent:packaged:arm64` | **NOT RUN** — part of `verify:meetup` |
| A8 | Canonical app install path | Operator | `corepack pnpm install:mac:dev` then `open -a Kestrel` | **PARTIAL** — procedure documented in [ai-tinkerers-demo.md](ai-tinkerers-demo.md); operator must run on presentation Mac |
| A9 | Market / release honesty gate | Engineering | `corepack pnpm audit:market` | **COMPLETE** — passed in Aug 29 run |

---

## B. Hero pillars (demo story)

| # | Pillar | Requirement | Owner | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| B1 | **Do This For Me** | Read-only inspect → approve → local edit → verified test evidence | Both | Ten-minute path in [ai-tinkerers-demo.md](ai-tinkerers-demo.md); `pnpm test:desktop-approvals` | **PARTIAL** — automated smokes pass when verify runs; needs on-stage rehearsal with disposable checkout |
| B2 | **What Should I Do** | Contextual New Tab: greeting, widgets, suggested actions, bounds sync | Engineering | #624; `apps/desktop/src/renderer/components/browser/new-tab.test.ts`; `new-tab-widgets.test.ts` | **COMPLETE** in repo — operator should rehearse populated vs cold profile |
| B3 | **It Remembers How I Work** | Remember → confirmation → New Tab widget → Life → Memory → new chat | Engineering | #625; `MemoryRecallBadge.tsx`, `NewTabWidgets.tsx` recent-memories; `memory-capture.test.ts` | **COMPLETE** in repo — operator must run memory beat once on presentation profile |

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

- [ ] `git fetch` && checkout presentation commit (`20f7662e` or later on `main`)
- [ ] `corepack pnpm install --frozen-lockfile`
- [ ] `corepack pnpm verify:meetup` — **must pass**; if `test-desktop-browser` fails on screenshot, retry once; if persistent, file engineering issue before relying on browser tools on stage
- [ ] `corepack pnpm install:mac:dev` && `open -a Kestrel`
- [ ] **Readiness** — protected store, database, local runtime, model route, packaged app all green
- [ ] Warm local model (short chat) within 10 minutes of stage time
- [ ] Disposable project checkout on disk with dependencies cached
- [ ] Explicit memory capture **on** in Settings → Memory
- [ ] Rehearse: first task → edit path **or** memory beat → New Tab home
- [ ] Confirm offline fallback path (no Wi-Fi dependency for primary story)
- [ ] Export local diagnostic from Readiness; confirm no secrets in export

---

## H. verify:meetup history

| Commit | Date | Result | Notes |
| --- | --- | --- | --- |
| `b5031ef0` | Aug 29, 2026 | **PASS** | Baseline before memory surfacing merge |
| `20f7662e` | Aug 29, 2026 | **FAIL** | `pnpm verify` stopped at `test-desktop-browser.mjs:935` — `browser.visible-screenshot` returned `failed` instead of `verified` |

**Engineering follow-up:** Investigate flaky or environmental `browser.visible-screenshot` failure before declaring meetup gate green on latest `main`.

---

## Related documents

- [AI Tinkerers / Stanford live-demo runbook](ai-tinkerers-demo.md) — on-stage script and beats
- [Public release operator checklist](public-release-operator-checklist.md) — signing, OAuth, clean-machine proof
- [Market release](market-release.md) — full internet distribution gate
- [Memory system](memory-system.md) — architecture behind the memory beat
