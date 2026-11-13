# Native canonical installation and acceptance

The first native installation cannot require observations from that same
installed app before it exists. Installation therefore has two acceptance
phases. Neither a staged signature check nor a generic passed receipt is proof
that the canonical app worked on screen.

## Before replacement

Keep the existing `/Applications/Kestrel.app`, profiles and credentials intact
until every pre-cutover requirement passes. Developer ID signing/notarization,
production Core/browser vault evidence, actual extension Store parity and all
other existing gates remain required. Only an **absent**
`canonical-dock-app-on-screen` entry may stay pending. Supplied but malformed
canonical evidence fails preflight; other missing gates are never deferred.

`scripts/check-native-cutover-prerequisites.mjs` implements this separate phase.
`scripts/check-electron-retirement-gates.mjs` remains the full final check and
still requires all 27 gates. The read-only plan reports pre- and post-cutover
requirements separately:

```bash
node scripts/native-cutover-plan.mjs \
  /absolute/path/Kestrel.app /absolute/path/evidence.json
```

The installer still requires both existing explicit acceptance settings,
`KESTREL_INSTALL_NATIVE_CANONICAL=1` and
`KESTREL_ACCEPT_ELECTRON_RETIREMENT=1`, plus
`KESTREL_NATIVE_RETIREMENT_EVIDENCE`. Acceptance settings do not supply evidence.
No caller-selected validation command or timeout override is accepted.

## Installed but not committed

The transaction preserves the exact previous app in its exclusive private
backup, adopts and checks the native app, and registers it. It then writes an
`awaiting-verification` journal and prints the transaction identity. The app is
not yet accepted as a completed installation.

For up to ten minutes, the fixed verifier waits for fresh canonical workflow
observations in the manifest. The observer must actually identify and exercise
the canonical native app, inspect the visible Kestrel workflow, and cleanly
close only that test-owned instance. Keep personal content and screenshots
private; do not publish them to this repository.

The canonical gate wrapper must identify exactly one artifact of kind
`native-canonical-workflow-observation`. Its owned, private JSON record requires:

- `version: 1`, the same `kind`, and `result: "passed"` only after observation.
- Exact `target`, `transactionId`, `transactionPath`, `candidateSha256` and
  `previousSha256` from the installed transaction, plus unchanged
  `candidateSha256After`.
- A fresh `observedAt` after verification began, and the observed `runningPid`.
- Actual checks for `runningNativeIdentity`, `visibleCanonicalWindow`,
  `sameWindowKestrelWorkflow`, `userDataPreserved` and `ownedAppStoppedCleanly`.
- One to four relative screenshot references with SHA256 digests. Each must be
  a private, single-link PNG that fully decodes within the 16-megapixel limit.

The JSON, screenshot and wrapper hashes bind observations to this transaction;
they do not establish that the observer's claims are true or that the pixels
depict the required workflow. Review the real process/window observations and
images. Unit fixtures, generated illustrations, parser tests and old receipts
must never be used as release observations.

Before commit, the installer repeats fixed signing and full retirement checks,
verifies process absence, and rechecks source, installed and previous-backup
fingerprints. This is additional to the initial preflight. It does not migrate
or reset a profile.

## Failure, interruption and recovery

Verification failure, timeout or interruption enters guarded restoration.
Recovery intent is journaled before process or path checks, including after a
commit-write interruption. A running or changed app, changed backup, or uncertain
restoration must leave a nonterminal journal and retained bundles rather than
overwrite them or report success. Another installer refuses pending recovery.

A process crash during verification also leaves the pending journal. The owner
must inspect it and use the existing explicit rollback path. No unrelated app
is killed, and no profile or credential is removed:

```bash
KESTREL_ROLLBACK_NATIVE_CANONICAL=1 \
  node scripts/install-native-chromium-macos.mjs --rollback \
  /Applications/.Kestrel-cutover-backups/TRANSACTION_UUID/transaction.json
```

Filesystem fault-injection tests simulate verification and interruption. They
do not prove actual Developer ID signing, native canonical use or rollback of
the user's installed app. Those live acceptance steps remain separate.
