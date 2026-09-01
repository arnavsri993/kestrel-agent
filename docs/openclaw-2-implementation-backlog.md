# OpenClaw 2.0 implementation backlog

**Status: FROZEN — 2026-08-31**

This is the finite implementation backlog for the revision of PR #691. The
35 existing behavior IDs are the complete audit boundary. This file is frozen
now: implementation may not add features or re-open the audit. Newly noticed
non-critical improvements belong only in **Deferred / out of scope**. A new
security or data-loss defect may be added only if it is discovered during
implementation and its release-blocking reason is recorded here.

## Audit baseline and decisions

- Implementation worktree: `/private/tmp/kestrel-openclaw-2-parity-20260831`
- Branch: `codex/openclaw-2-parity-20260831`
- Original PR head before main integration:
  `3822d183b4bf6e2a79d5610c746305bb968b1d6b`
- Integrated `origin/main`:
  `9a1aa4b63c23307c3b977c1712514cff0c4e7630`
- Integration merge base: `9a1aa4b63c23307c3b977c1712514cff0c4e7630`
- OpenClaw reference: `v2026.8.1` (OpenClaw 2.0), immutable commit
  `ea806575e6450e4d1efdfc72c19f04be982a1b9b`.
- The audit reviewed the claimed behavior, implementation paths, test
  assertions, and reachability for all 35 entries. The family catalog and
  workspace-file search were not accepted as exact conversation behavior.
- Confirmed unresolved P0/P1 gaps at freeze time are limited to transcript
  search/privacy, selected-session restoration, structured human input, widget
  pin/provenance/export, and media restart/playback evidence. The existing
  P2 platform/operator boundaries remain disclosed rather than promoted.
- The primary checkout and its unrelated untracked `index.js`, the installed
  Kestrel profile, credentials, source OpenClaw files, and generated artifacts
  are outside this worktree and remain untouched.

## Frozen P0 backlog

1. **Make exact-behavior evidence fail closed.** Add designated
   `behavioralTestEvidence` (or an equivalent evidence level) to the register,
   require it for every verified/implemented exact behavior, ensure each
   designated test is in the focused command, and add negative verifier
   coverage for primitive-only evidence. Keep duplicate-ID, stale-release,
   family-vs-behavior, evidence-path, unresolved-P0/P1, deterministic
   Markdown, and secret-scan gates intact.

2. **Implement local transcript search and retention boundaries.** For
   `oc2.search.local-transcript` and `oc2.search.restart-privacy`, provide a
   local encrypted conversation search flow with normalized Unicode matching,
   bounded previews, conversation/message identity, exact-message navigation,
   restart persistence, forgotten-record exclusion, documented private versus
   incognito policy, and a test proving no provider request occurs.

3. **Diagnose the packaged desktop-layout failure without weakening it.** Run
   `test:desktop-layout` against the integrated current-main baseline and this
   branch. Fix only a deterministic regression caused by this branch and
   validate the actual packaged application; otherwise record exact
   main-versus-branch or environment evidence and do not change assertions.

## Frozen P1 backlog

4. **Add structured human-input requests.** Reclassify
   `oc2.questions.structured-input` from P2 to P1 and implement a run-bound,
   persisted request model with question ID, owning run, prompt/context,
   single- and multi-choice options, free text, distinct Skip, timeout and
   cancellation states. Add inline accessible task UI with keyboard/focus,
   reduced-motion, and narrow-window behavior. Answers must be one-shot,
   stale/cancelled/replaced/completed runs must reject them, restart must not
   revive authority, and consequential actions must still use normal approval.

5. **Persist the selected conversation.** Complete
   `oc2.session.organization` by persisting the selected session identity,
   restoring only an existing eligible session after restart, clearing stale
   identities safely, and retaining the existing browser return path.

6. **Complete widget task-surface behavior.** Complete
   `oc2.widgets.dashboard-export` using the artifact/widget subsystem (not the
   native macOS status snapshot): allow pin/unpin, expose artifact provenance,
   and export the bounded rendered widget view without adding authority. Add
   direct behavioral tests and correct the register evidence.

7. **Prove and harden media persistence/reload.** Complete
   `oc2.media.persistence-reload` with tamper-aware artifact reads, session
   provenance, restart-safe listing/preview, and renderer playback/download
   handling for supported image, audio, video, and document artifacts. Add a
   direct persistence/reload behavioral test.

## Frozen acceptance criteria

- The register remains exactly 35 behavior IDs, valid deterministic JSON, and
  pinned to the release identity above.
- Every registered entry has complete provenance, classification, boundary,
  implementation evidence, test evidence, designated behavioral evidence, and
  an executable verification command. All paths and commands exist.
- `verified-existing` and `implemented-and-verified` entries have a designated
  behavioral test; safer-difference and extension entries retain direct
  boundary/contract evidence. Primitive-only tests cannot satisfy the gate.
- The conversation-search, structured-question, selected-session, widget, and
  media entries are not called verified until their direct tests pass.
- No P0 or P1 entry remains `unresolved` in the committed register.
- `corepack pnpm verify:openclaw2` executes the focused evidence set and fails
  for every frozen negative case without touching user data or an OpenClaw
  installation.
- The generated Markdown remains deterministic and shows priority and
  classification changes.
- No canonical installed app replacement, profile reset, credential change,
  unrelated WIP change, screenshot commit, or package-cache change is made.
- The finite sequence is: one targeted test/repair pass, one full verification
  pass, at most one repair for failures caused by this work, and one final
  verification. Then stop.

## Deferred / out of scope

- A second OpenClaw audit, newer/prerelease reference tracking, or additional
  behavior IDs.
- Cosmetic UI polish beyond the frozen question/search/widget/media criteria.
- New vendor integrations, native mobile applications, copied OpenClaw
  gateway/configuration formats, or unrelated session/memory/provider work.
- Apple Developer ID signing, notarization, update hosting, external OAuth,
  and other operator-owned release gates.
- Repairing a pre-existing or environment-only packaged harness failure when
  main-versus-branch evidence shows it is not caused by this pass.
