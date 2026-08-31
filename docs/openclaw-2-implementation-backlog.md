# OpenClaw 2.0 implementation backlog

**Status: FROZEN — 2026-08-31**

This is the bounded backlog for the OpenClaw 2.0 parity pass. The initial
repository and reference audit is complete. This list is frozen after this
file is written; implementation must not grow the scope. Newly noticed
non-critical improvements belong in **Deferred / out of scope** below. Only a
security or data-loss defect discovered during implementation may be added,
and it must be recorded with the reason it blocks release.

## Audit baseline

- Kestrel repository: `/Users/arnavsrivastava/Documents/Agent`
- Implementation worktree: `/private/tmp/kestrel-openclaw-2-parity-20260831`
- Starting Kestrel commit: `f0680133f28408e1bf74f3b0a2989249aeaf7d76`
- Starting implementation branch: `codex/openclaw-2-parity-20260831`
- Primary checkout was left untouched; its pre-existing untracked `index.js`
  remains preserved.
- Host: macOS arm64 (`ProductVersion 27.0`), Node `v24.18.0`, pnpm `11.15.1`.
- `/Applications/Kestrel.app` exists and the real profile contains user data;
  it is outside this pass and must not be reset or replaced.
- Existing baseline checks passed: reference audit, focused Vitest suite
  (159 files / 1,084 tests), typecheck, and market audit.
- The existing readiness and restart Electron scripts were attempted once and
  hung before producing a result; they are retained as an operator/runtime
  boundary, not treated as permission to loop.

## Pinned reference identity

The stable competitive baseline is the official OpenClaw release tag
`v2026.8.1`, documented by OpenClaw as **OpenClaw 2.0**. The tag resolves to
immutable commit
`ea806575e6450e4d1efdfc72c19f04be982a1b9b` (annotated tag object
`4d37fc4b0f86ce372d7cb433d1d939ef04f49322`). The register and verifier must
use this tag and commit, never an unpinned branch or prerelease.

## Frozen implementation backlog

### P0 — release-blocking truth and verification

1. **Create the pinned behavior register.** Add a machine-readable register
   under `docs/` with behavior-level entries for the important stable
   OpenClaw 2.0 macOS single-user outcomes covered by the audit. Every entry
   must carry a stable ID, user-visible behavior, family ID, P0/P1/P2 priority,
   official source URL or tagged source path, pinned tag and commit,
   classification, Kestrel implementation evidence, executable test evidence,
   exact verification command, security/privacy implications, migration
   implications, platform boundary, and notes.

2. **Separate family coverage from behavioral proof.** Keep the existing
   broad capability catalog and page audit as family/reference coverage only.
   The new register must model exact behaviors separately and must not let a
   family-level `implemented` label satisfy a behavior entry without executable
   evidence.

3. **Add a fail-closed verifier and canonical command.** Implement
   `corepack pnpm verify:openclaw2` to validate register shape, unique IDs,
   allowed classifications, pinned release identity, evidence paths, exact
   command references, and the absence of unresolved P0/P1 entries. It must
   run the bounded focused parity/security/migration/recovery/UI Vitest
   evidence set and return non-zero on stale or incomplete evidence.

4. **Add verifier negative coverage.** Test duplicate IDs, unknown
   classifications, stale or mismatched release commits, missing evidence,
   nonexistent evidence/test/command paths, family-vs-behavior confusion, and
   unresolved P0/P1 entries. These tests must use temporary copies or in-memory
   mutations and must not touch user data or the real OpenClaw installation.

5. **Correct the official release documentation.** Update
   `docs/openclaw-readiness-review.md` to identify `v2026.8.1` as the official
   release explicitly described as OpenClaw 2.0, and link the new register and
   verifier. Preserve truthful safer differences, extension contracts,
   platform boundaries, and operator-owned release gates.

### P1 — integration and maintainability

6. **Wire the verifier into repository checks.** Add the package script and a
   CI invocation in the existing core job without replacing or weakening the
   existing full verification gates. Keep expensive packaged and real-provider
   checks separately named.

7. **Make the evidence set reviewable.** Use existing Kestrel runtime,
   security, migration, recovery, memory, model, plugin, widget/media,
   orchestration, and desktop UI tests in the register rather than creating
   parallel subsystems. Add only the small integration fixture/test needed to
   prove the v2026.8.1-shaped OpenClaw switcher path.

8. **Document the verification boundary.** Add concise register/verifier
   usage and classification guidance so future refreshes cannot silently
   promote a capability-family mapping, a mocked result, or an operator gate
   into exact parity evidence.

## Frozen acceptance criteria

- The register is committed, deterministic, valid JSON, pinned to the release
  tag and immutable commit above, and contains no duplicate IDs.
- Every registered behavior has the required provenance, classification,
  implementation evidence, executable test evidence, exact command, and
  boundary fields; all referenced repository paths and commands exist.
- `verified-existing` and `implemented-and-verified` entries have passing
  executable evidence. Safer differences include a written rationale and a
  passing boundary test. Extension entries have a tested extension path.
- The existing family catalog and the exact behavior register are explicitly
  different evidence layers.
- No P0 or P1 entry is `unresolved`.
- `corepack pnpm verify:openclaw2` fails closed for every negative case in item
  4 and passes on the committed register while running its focused tests.
- The stale readiness wording is removed without making claims about bundled
  integrations, native mobile apps, notarization, external OAuth, or other
  operator-owned gates that were not verified.
- No user profile, credentials, source OpenClaw files, generated screenshots,
  package caches, or unrelated dirty work are changed.
- The implementation receives one targeted repair pass and one full
  verification/repair/final-verification sequence, then stops.

## Deferred / out of scope (not backlog items)

- A second broad audit of OpenClaw or tracking a newer/prerelease OpenClaw
  build.
- New product features, vendor-specific integrations, native iOS/Android
  applications, or a copied OpenClaw Gateway/configuration format.
- Reworking already-present session, memory, widget, media, provider,
  orchestration, plugin, migration, backup, or desktop systems solely for
  cosmetic or theoretical parity beyond the evidence register.
- Apple Developer ID signing, notarization, update hosting, external OAuth
  verification, and other operator-owned release gates.
- Repairing the pre-existing hanging Electron readiness/restart harness unless
  the new verifier itself causes a regression.
