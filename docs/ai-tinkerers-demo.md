# AI Tinkerers live-demo runbook

This runbook prepares the local Apple Silicon build for the AI Tinkerers St.
Louis meetup on August 19, 2026. The demo slot is short and code-first, so the
goal is one visible outcome with real execution, an approval boundary, and
verified evidence rather than a feature tour.

## Final readiness gate

From a clean checkout of the presentation commit, run:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm verify:meetup
```

That command runs the complete deterministic suite, validates the website
assets, downloads and verifies the pinned managed Ollama runtime, requires a
real local model response, builds the Apple Silicon app, validates its
development signature, and exercises the packaged executable.

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
6. End by asking Kestrel to prepare—but not publish—a concise pull-request
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
