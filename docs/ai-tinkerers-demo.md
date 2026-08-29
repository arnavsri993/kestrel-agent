# AI Tinkerers / Stanford live-demo runbook

This runbook prepares the local Apple Silicon build for short, code-first demos
(AI Tinkerers St. Louis, August 19, 2026; Stanford presentation, August 2026).
The goal is one visible outcome with real execution, an approval boundary, and
verified evidence rather than a feature tour.

## Hero pillars (on-stage story)

| Pillar | What to show | Sprint evidence |
| --- | --- | --- |
| **Do This For Me** | Scoped local edit → approval → verified result | Core agent loop, approvals, Activity evidence |
| **What Should I Do** | Contextual New Tab home with suggested next actions | #624 contextual new-tab widgets and greetings |
| **It Remembers How I Work** | Explicit memory capture → confirmation → recall on New Tab and in chat | #625 memory demo surfacing |

## Final readiness gate

From a clean checkout of the presentation commit, run:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm verify:meetup
```

That command runs the complete deterministic suite, validates the website
assets, downloads and verifies the pinned managed Ollama runtime, requires a
real local model response, builds the Apple Silicon app, validates its
development signature, and exercises the packaged executable. The build keeps
`release/mac-arm64/Kestrel.app` available for the packaged smoke and benchmark
steps even when `/Applications/Kestrel.app` is already installed.

Install the exact artifact produced by the gate into the one canonical app
location, then open it:

```bash
corepack pnpm install:mac:dev
open -a Kestrel
```

Do not copy the bundle to the Desktop or rename it. The installer keeps
`/Applications/Kestrel.app` as the only user-facing development app and moves
stale copies found in common install locations or by Finder/Spotlight to Trash;
the `release/` bundle stays a non-indexed build artifact.

Kestrel stores the database key as a local file and does not use macOS
Keychain. The desktop app also disables Chromium's Keychain cookie store so
the `Kestrel Safe Storage` prompt should not appear.

In Kestrel, open **Tools → Readiness** and confirm the protected store,
database, local runtime, model route, and packaged app are ready. Open one new
chat and ask the local model to answer a short prompt once; this warms the model
before the audience arrives. On the presentation Mac, the first tool-enabled
9B turn took about 71 seconds and a resident follow-up took about 6 seconds.
Send the warm-up within 10 minutes of going onstage, and repeat it if the slot
is delayed, so Ollama's configured keep-alive does not expire.

## First-value loop (fresh profile + local Ollama)

After setup verification, tap **Try a first task**. Kestrel **auto-sends** a
deterministic read-only prompt (no manual paste required):

- **No project folder:** `tools.search` with `read_only` and a count of active
  tools — proves the agent loop, local model, and tool audit path without
  network or approvals.
- **With a project folder:** `workspace.list` plus `workspace.read` on
  `README.md` or `package.json` — one concrete fact from disk.

The pinned prompt lives in `apps/desktop/src/renderer/first-task.ts`. It
requires **no network, browser, OAuth, or approvals** and ends with one
sentence on what stayed local.

Expect the first local tool turn to take **1–2 minutes** on a cold 9B model;
follow-ups are much faster. Kestrel shows a slow-model notice during the wait.
If nothing changes after **~3 minutes**, cancel and retry once. Do not treat
provider reachability probes as a substitute for this end-to-end first task.

**Rehearsal blockers (operator fixes):**

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Setup never offers **Try a first task** | Model route saved but not live-verified | Re-run local bootstrap; wait for a real response on the Model setup step |
| First task stalls with no tools | Open-ended prompt or model chose browser/network | Use current guided prompt (pinned in `apps/desktop/src/renderer/first-task.ts`) |
| `tools.search` succeeds but no assistant text | Small local model timeout or empty completion | Retry; warm model in Readiness before the slot |
| Repo inspection fails | No project folder granted | Add a disposable checkout via **Add project** before the guided task |
| `verify:meetup` fails on packaging | Stale `/Applications/Kestrel.app` vs `release/` artifact | Run `corepack pnpm install:mac:dev` and reopen the canonical app |

## Contextual New Tab home beat (~90 seconds)

Open a **new browser tab** to land on Kestrel Home. This is the **What Should
I Do** pillar.

1. **Greeting** — A time-of-day greeting uses only coarse local signals (first
   name, visit frequency, time bucket). No URLs, email, or page titles are sent
   for the greeting. A local model may refine the line via `new-tab-greeting`.
2. **Memory recall badge** — Below the greeting, a status line shows whether
   shared memory is on, how many active memories exist, and how many preferences
   are confirmed. When empty but capture is on, it prompts: *Say remember that
   … in chat*.
3. **Widgets** — Default layout includes **Frequent tabs**, **Recent work**,
   **Recent memories**, and **Quick actions**. Widget bounds sync across window
   sizes (#624).
4. **Suggested actions** — Up to five chips derive from recent browsing and
   open agent sessions (credentials stripped). Tap one to open a new agent chat
   with a prefilled, read-only prompt.
5. **Composer** — Type a task to start agent work, or a URL to browse. Task
   settings are one click away.

Rehearse once with a warmed profile so widgets and suggestions are populated.
A cold profile still works but looks sparse until history and memory exist.

## Memory beat (~2 minutes)

This is the **It Remembers How I Work** pillar. Run it after first-task or
between the edit-and-verify path and the closing summary.

**Prerequisites:** Settings → Memory → explicit capture **on**; shared context
injection **on** for the active personality.

1. **Remember** — In any chat, send: `Remember that I prefer concise status
   updates in demos.` Kestrel parses the explicit `remember that …` command
   (`packages/shared-types/src/memory-capture.ts`).
2. **Confirmation** — Point out the in-thread confirmation that the preference
   was stored locally. In **Life → Memory**, the new row shows **Confirmed**
   (explicit capture) with subject and timestamp.
3. **New Tab widget** — Open a new browser tab. The **Recent memories** widget
   lists the captured preference with a Confirmed badge. The memory recall
   badge above the greeting increments active memory count.
4. **Life → Memory** — Open Life from the sidebar, Memory tab. Show provenance,
   confirmation status, and that the record is encrypted local state—not a
   cloud profile.
5. **New chat recall** — Start a fresh agent chat with a prompt that should use
   the preference, for example: `Draft a one-line project status for the
   audience.` When shared context is on, Kestrel may inject the stored
   preference; call out the mechanism, not a guarantee that every model cites
   it verbatim.

If explicit capture is off, the widget shows an empty state linking to
Settings → Memory. Do not improvise a cloud sync story.

## Ten-minute live path

1. Start on **Readiness** for about 30 seconds. Point out that the model and
   agent core are local, and that the evidence is a live diagnostic rather than
   a slide.
2. Open a fresh chat with a disposable project checkout. Ask: `Inspect this
   project read-only. Find one concrete reliability gap, propose the smallest
   fix, and tell me how you will verify it. Do not edit until I approve.`
3. Show Kestrel's selected local model and plan. Keep the discussion on the
   mechanism: scoped workspace access, isolated core, and automatic routing.
4. Approve only the proposed local edit. Let Kestrel apply it and run the
   focused check. Point at the in-thread gate: policy level, selected route,
   idempotency key, and the restart-safe pause in encrypted local state.
5. Open **Activity** and show the verified file/test evidence. The visible
   result should be the changed artifact, the verification method, and the
   evidence hash—not a claim that the task worked.
6. Optional: run the **memory beat** above if time allows.
7. End by asking Kestrel to prepare—but not publish—a concise pull-request
   summary. Explain that sending, publishing, deleting, purchasing, and
   permission changes require a separate approval.

Use a disposable checkout so the audience sees a real edit without risking the
presentation branch or personal data. Do not depend on a cloud account, web
search, OAuth, or an external submission for the primary path.

## Offline fallback

- Keep the verified local runtime and model installed before leaving for the
  venue.
- Keep the disposable project and its dependency cache on the presentation Mac.
- Use a task whose test command requires no network.
- If venue Wi-Fi fails, run the same local edit-and-verify path. External
  connectors are optional and should not be part of the proof.

## Honest boundary

The artifact produced by `verify:meetup` is an Apple Silicon development build
for a local live demo. It is ad-hoc signed, not Developer ID signed or
notarized, and is not an internet-distribution release. Public download and
automatic-update claims remain blocked until the signing, notarization, hosted
artifact, and clean-machine release gates in `docs/market-release.md` pass.

See `docs/stanford-demo-checklist.md` for the full requirement matrix and
operator vs engineering ownership.
