# Kestrel production stability audit

## Audit snapshot

- **BASE_SHA:** `2ac8e8732ec46366411267fd37ca18ab6370526a` (`origin/main` at the
  start of the pass and after the final pre-delivery fetch).
- **Final branch HEAD:** recorded in the delivery metadata after the final
  scoped commit; this report is part of that delivery.
- **Branch:** `luna/production-stability-hardening`.
- **Repository:** `https://github.com/arnavsri993/kestrel-agent`.
- **Host:** macOS 27.0 (Build 26A5421a), Apple Silicon `arm64`.
- **Node:** `v24.18.0`.
- **pnpm:** `11.15.1`.
- **Electron:** `43.4.0`.
- **Electron Builder:** `26.15.3`.
- **Source executable:** Electron development executable launched by the
  desktop scripts from this checkout.
- **Packaged executable:**
  `release/mac-arm64/Kestrel.app/Contents/MacOS/Kestrel`.
- **Jules:** not used; no `JULES_API_KEY` was configured in this environment.

Raw command output, screenshots, temporary profiles, benchmark JSON, and
package artifacts are retained under the ignored `.tmp/luna-stability/`
directory and are not committed.

## Findings and disposition

### STAB-001 — P1 — packaged layout gate reported a non-existent collision

- **Symptom:** The packaged layout test failed with `Model and task-settings
  triggers overlap` even though the captured model rectangle ended at `y=621`
  and the Task Settings rectangle began at `y=629`.
- **Exact reproduction:**
  `KESTREL_DESKTOP_EXECUTABLE=release/mac-arm64/Kestrel.app/Contents/MacOS/Kestrel`
  `corepack pnpm test:desktop-layout` on the base checkout. The original
  failure and screenshot are retained in
  `.tmp/luna-stability/github/run-33468177351-failed.log`. The captured
  final packaged layout screenshot is
  `.tmp/luna-stability/final-packaged/fixed-layout.png`.
- **Root cause:** The assertion compared only horizontal coordinates. It could
  call vertically separated controls a collision and did not independently
  assert the intended composer order, row alignment, send-action separation,
  panel bounds, or settled responsive rail state.
- **Fix:** `scripts/test-desktop-layout.mjs` now uses true two-dimensional
  rectangle intersection, retains explicit model → Task Settings → send order
  checks, asserts row alignment and host/composer bounds, synchronizes native
  hit testing, waits for the Agent spring to settle, and exercises supported
  rail breakpoints `[920, 979, 980, 981, 1119, 1120, 1121, 1280, 1440]`.
- **Regression:** Five source and five packaged repetitions passed. A further
  five packaged repetitions passed after the final package build. Evidence is
  in `.tmp/luna-stability/layout-source-repetitions.tsv`,
  `.tmp/luna-stability/layout-packaged-repetitions.tsv`, and
  `.tmp/luna-stability/final-packaged/post-package/layout/`.
- **Result:** Fixed; no product renderer change was needed because the
  recorded rectangles were not intersecting. Final layout runs reported no
  page errors or unhandled promise rejections.
- **Residual risk:** The test validates the supported desktop breakpoint set,
  not every display scale or future font/platform combination.

### STAB-002 — P1 — isolated desktop tests wrote to the real macOS App Group

- **Symptom:** A source layout run emitted `EPERM` while opening
  `/Users/arnavsrivastava/Library/Group Containers/group.com.kestrel.desktop/...
  .tmp`, allowing a test process to reach user-owned widget storage.
- **Exact reproduction:** The warning was observed during the initial source
  layout diagnosis; that pre-fix temporary log was not retained in this
  worktree. The post-fix widget unit test and desktop runs are retained in
  `.tmp/luna-stability/04-widget-test.log` and
  `.tmp/luna-stability/layout-source-1.log`.
- **Root cause:** The main process always derived the widget snapshot path from
  the real home directory, even when desktop smoke tests supplied an isolated
  `KESTREL_TEST_USER_DATA` directory.
- **Fix:** `macWidgetsSnapshotDirectory` keeps normal application runs on the
  real App Group path and routes test snapshots to
  `<KESTREL_TEST_USER_DATA>/mac-widgets`. `apps/desktop/src/main/index.ts`
  passes the test directory only when the test environment supplies it.
- **Regression:** The focused widget bridge suite passed 3/3 tests, including
  normal-path preservation and isolated-path behavior. Final desktop layout
  and smoke gates produced no App Group write warning. Evidence is in
  `.tmp/luna-stability/04-widget-test.log` and the final desktop logs.
- **Result:** Fixed. Existing profiles, databases, credentials, Keychain
  entries, project folders, and normal widget App Group behavior were not
  migrated, reset, or deleted.
- **Residual risk:** The protection is scoped to the documented test
  environment variable; an undocumented harness must opt into the same
  variable rather than relying on implicit isolation.

### STAB-003 — P2 — layout race assertions sampled transient Agent motion

- **Symptom:** The interruption check sometimes reported that a re-open moved
  from `121.859375px` to `284.734375px` and treated expected spring movement as
  an endpoint jump.
- **Exact reproduction:** The prior CI failure is retained in
  `.tmp/luna-stability/github/run-33529069827-failed.log`.
- **Root cause:** The test compared the rendered width two animation frames
  after the input instead of checking the first resumed frame for continuity.
- **Fix:** The test now records the immediate resumed state, checks rendered
  and presented widths against a bounded continuity tolerance, then uses later
  frames only to reject endpoint jumps.
- **Regression:** Source and packaged layout repetitions passed without the
  interruption failure; post-package packaged layout passed 5/5.
- **Result:** Fixed test race; the product spring remains the owner of layout
  motion.

### STAB-004 — P2 — CI action mutability and failure evidence were insufficient

- **Symptom:** CI used floating `@v7` action tags and uploaded only benchmark
  output, making action behavior mutable and packaged/layout failures harder to
  diagnose.
- **Root cause:** Checkout, setup-node, and upload-artifact were not pinned to
  immutable commit SHAs; desktop diagnostics were not collected on every job
  outcome.
- **Fix:** `.github/workflows/ci.yml` pins the actions to immutable SHAs,
  disables checkout credential persistence, retains bounded benchmark reports,
  and adds `if: always()` diagnostics/artifact steps for runner metadata,
  process state, layout evidence, benchmark JSON, Playwright results, and
  failure screenshots. The action SHAs were checked against the public action
  repositories with `git ls-remote`.
- **Regression:** Local source/package gates passed. PR CI is the remote
  validation of this workflow change and is reported separately.
- **Result:** Fixed in the workflow; critical steps remain blocking because no
  `continue-on-error` or global retry was added.

## Validation matrix

All entries below have command output and exit status captured under
`.tmp/luna-stability/`. A zero exit is not treated as a pass when a command
skipped critical work; benchmark reports and desktop output were inspected for
their workflow counts.

| Command | Runs | Result/counts | Duration/evidence |
| --- | ---: | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 1 final | PASS; workspace up to date | `.tmp/luna-stability/09-install-final.log` |
| `corepack pnpm typecheck` | 1 final | PASS; all workspace projects | `.tmp/luna-stability/10-typecheck.log` and final optional log |
| `corepack pnpm test` | 1 final | PASS; 168 files, 1,132 tests | `.tmp/luna-stability/11-test.log` and final optional log |
| `corepack pnpm audit --prod` | 1 final | PASS; no known vulnerabilities | `.tmp/luna-stability/12-audit-prod.log` |
| `corepack pnpm assets:verify` | 1 final | PASS; 3 registry entries, 7 manifests | `.tmp/luna-stability/final-optional/verify-meetup.log` |
| `corepack pnpm audit:settings` | 1 final | PASS; 122 entries, 45 catalog settings, 5 snapshots | final optional log |
| `corepack pnpm audit:references` | 1 final | PASS; 1,117 pages, zero unmapped | final optional log |
| `corepack pnpm verify:openclaw2` | 1 final | PASS; 598 focused tests, 35 exact behaviors, 0 unresolved P0/P1 | final optional log |
| `corepack pnpm audit:market` | 1 final | PASS; Apple Silicon internet release gate | final optional log |
| `corepack pnpm build` | 1 final | PASS; website, CLI, desktop, preload and renderer bundles | final optional log |
| `corepack pnpm benchmark:browser-agent` | 3 final | PASS; 50/50 workflows each | `.tmp/luna-stability/final-source/benchmark-verified/` |
| `corepack pnpm test:e2e` | 1 final | PASS; 50 tests | final optional log |
| `corepack pnpm test:editors` | 1 final | PASS; manifests, syntax, ACP surfaces | final optional log |
| `corepack pnpm test:security` | 1 final | PASS; no credential names or known prefixes | final optional log |
| `corepack pnpm verify` | 1 final | PASS; all chained checks exit 0 | included in `.tmp/luna-stability/final-optional/verify-meetup.log` |
| `corepack pnpm verify:meetup` | 1 optional final | PASS; real Ollama response, package, smoke, benchmark | 257s; `.tmp/luna-stability/final-optional/verify-meetup.log` |
| `corepack pnpm package:mac:dev` | 1 final | PASS; arm64 development bundle and embedded widget verified | final optional log |
| `corepack pnpm test:packaged-desktop:arm64` | 1 final + 1 post-package | PASS; native Sharp, isolated browser tools, bounded receipts | `.tmp/luna-stability/final-packaged/post-package/gates.tsv` |
| packaged desktop layout | 5 + 5 post-package | PASS; every run | `.tmp/luna-stability/final-packaged/post-package/layout/` |
| packaged restart recovery | 10 post-package | PASS; 10/10 | `.tmp/luna-stability/final-packaged/post-package/restart/` |
| packaged workflow reuse | 1 post-package | PASS | post-package `gates.tsv` |
| packaged file-icon guard | 1 post-package | PASS | post-package `gates.tsv` |
| packaged browser benchmark | 3 post-package | PASS; 50/50 workflows each | `.tmp/luna-stability/final-packaged/benchmark-verified/` |
| packaged single-instance | 10 | PASS; second launch exited and first stayed alive | `.tmp/luna-stability/final-packaged/single-instance/` |
| source restart recovery | 10 | PASS; 10/10 | `.tmp/luna-stability/final-source/restart/` |

The optional meetup gate was not simulated: Ollama `0.32.1` and
`smollm2:135m` produced a real local response. The final package verifier also
reported native Sharp, preload, migration, widget, and signature checks.

## Packaged artifact and lifecycle evidence

- **Executable:**
  `/Users/arnavsrivastava/Documents/Agent-production-stability-hardening/release/mac-arm64/Kestrel.app/Contents/MacOS/Kestrel`.
- **Architecture:** thin Mach-O `arm64`; `lipo -archs` returned `arm64`.
- **App bundle:** `com.kestrel.desktop.dev`, development channel, Electron
  `43.4.0`.
- **App.asar SHA-256:**
  `e47ce675cbb2a867eaa6577e92e1f44789a8a1ac1571345cccaad1946ef5025c`.
- **Signature:** ad-hoc hardened-runtime development signature; `codesign`
  reported valid on disk and a satisfied designated requirement. No Developer
  ID identity or provisioning profile was available.
- **Notarization:** skipped by electron-builder because notarization options
  could not be generated. This is an operator-owned release credential
  limitation, not a passing claim for a notarized production artifact.
- **Launch/quit:** source and packaged smoke/layout/restart/single-instance
  runs launched the actual executable, waited for the usable window/bridge,
  and closed without an attributable orphan process.
- **Registration:** the final cleanup scan reported no duplicate Kestrel apps
  and preserved `/Applications/Kestrel.app` as the canonical path.
- **Evidence:** `.tmp/luna-stability/final-packaged/artifact/audit.log` and
  `.tmp/luna-stability/final-optional/verify-meetup.log`.

## Security, privacy, and rollback

- **Secret scan:** production browser secret scan passed in the source,
  OpenClaw, final security, and optional meetup gates.
- **Dependency audit:** `corepack pnpm audit --prod` reported no known
  vulnerabilities.
- **IPC/CSP/preload:** typecheck, desktop build, preload-bundle checks,
  CSP/runtime smoke, packaged CLI, and browser-agent smoke passed.
- **Migration/data safety:** no migration or profile import was performed.
  Existing user data and credentials were left untouched. Test data used
  temporary profiles; widget test snapshots are isolated under the supplied
  test user-data directory.
- **Approval/idempotency:** existing approval, signed-channel, action-receipt,
  and packaged CLI checks passed through the final verify gate.
- **Rollback:** revert the focused PR commit(s). No schema, user-profile, or
  credential format change is included.

## CI and release recommendation

- Keep **Core, website, and security (macOS)** and **Desktop and packaged arm64
  smoke** as required main-branch checks.
- The live branch-protection payload at audit time required one approval and
  conversation resolution but reported no required status checks. Do not merge
  this PR until repository administrators enforce both exact check names above.
- CI action pinning uses immutable SHAs for `actions/checkout@v7`,
  `actions/setup-node@v7`, and `actions/upload-artifact@v7`; checkout credential
  persistence is disabled.
- CI evidence uploads run with `if: always()` but do not make test/build steps
  non-blocking. Artifact paths are bounded and exclude credentials and user
  profiles.
- The release workflow/package checks were exercised locally. Developer ID
  signing and notarization were not exercised because the required operator
  credentials were unavailable.
- **Remote CI:** pending until the delivery PR is opened; the final check rollup
  is reported in the delivery response and PR.

## Remaining risks

1. **Severity: P1, operator-owned — Developer ID/notarization.** User impact is
   that the locally produced app is a valid ad-hoc development bundle, not a
   distributable notarized release. Evidence is the explicit electron-builder
   `skipped macOS notarization` line in the final optional log. Containment is
   to keep this PR out of release publication and perform the signed/notarized
   release job on the release machine. Next action: an operator with the
   repository's signing/notarization credentials runs the installable release
   workflow and validates Gatekeeper/notarization. Owner: operator.
2. **Severity: P2, code/process — future platform/font variants.** User impact
   could be a layout change outside the tested Apple Silicon desktop matrix.
   Evidence is the finite supported breakpoint set exercised by the focused
   test. Containment is the strict geometry/order/overflow contract and CI
   packaged smoke. Next action: add a breakpoint only when the product support
   contract changes. Owner: code.

No unresolved P0 was found. The reproduced P1/P2 items above are fixed or
explicitly assigned; no speculative feature or architecture work was added.
