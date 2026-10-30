# Native Chromium release evidence

The native candidate gives Chromium ownership of the window, tab strip,
navigation, extension lifecycle, and Chrome Web Store permission sheets. It
loads the existing React Kestrel Home, Settings, sidebar, and conversation UI
from a private first-party MV3 extension. The agent companion uses Chromium's
side panel. There is no AppKit window reparenting, clipped duplicate shell, or
Electron process in this path.

## Run and verify

```sh
corepack pnpm dev:desktop:chromium
corepack pnpm build:native-chromium-host
corepack pnpm test:chromium-ui
KESTREL_NATIVE_TEST_APP="$PWD/.tmp/native-chromium-host/Kestrel.app" \
  corepack pnpm test:chromium-native-auth
KESTREL_NATIVE_TEST_APP="$PWD/.tmp/native-chromium-host/Kestrel.app" \
  corepack pnpm test:chromium-desktop
KESTREL_NATIVE_TEST_APP="$PWD/.tmp/native-chromium-host/Kestrel.app" \
  corepack pnpm test:chromium-default-launch
# Requires an already-installed Ollama model that supports tools.
KESTREL_NATIVE_TEST_APP="$PWD/.tmp/native-chromium-host/Kestrel.app" \
KESTREL_TEST_LOCAL_MODEL="your-installed-model:tag" \
  corepack pnpm test:chromium-first-run
```

Development uses an isolated durable profile under
`~/Library/Application Support/Kestrel Native/Development`. The test commands
own disposable profiles and remove only those profiles on exit. Neither path
opens or imports the existing Electron profile. `dev:native-extensions` remains
an isolated extension workbench, rather than the desktop UI.

The portable credential broker no longer imports Electron. Electron supplies
its own secure-storage adapter explicitly; native development uses the
already-opened native profile key. `test:chromium-provider-store` runs the
bundled Node/runtime to verify encrypted credential persistence, secret-free
summaries, revocation, no second database key, and preservation of a real Core
conversation across provider storage and restart. This storage foundation does
not by itself prove native provider setup or public Keychain parity. The full
workspace unit suite has 1,725 passing tests at this checkpoint; typecheck,
native desktop/authentication smokes, and retained desktop setup/CLI safety
checks also pass. All remote checks passed at `777df42d` before this change.

For the live official marketplace canary, run:

```sh
KESTREL_NATIVE_TEST_APP="$PWD/.tmp/native-chromium-host/Kestrel.app" \
KESTREL_TEST_REAL_CHROME_WEB_STORE=1 corepack pnpm test:chromium-desktop
```

After `OWNED_CHROMIUM_STORE_READY`, inspect the visible candidate, choose
**Add to Chrome**, review Chromium's permission sheet, and choose **Add
extension**. This installs JSON Formatter only in the test's disposable
profile. The test observes Chromium's actual extension manager, closes the
entire app, restarts the same test profile, and requires the extension to
remain enabled. It also requires the installed extension to parse and render
an actual JSON response both before and after restart. It records target window IDs and runtime evidence under
`.tmp/chromium-desktop-evidence/`. An installed extension alone is not proof
of functional behavior or future updates.

## Native trust boundary

Ordinary pages do not receive `window.kestrel`, a CEF preload, or a native
query handler. Only the exact first-party document and top frame may connect
to the worker. Shared schemas validate renderer requests in both the worker
and Node broker.

The broker accepts its bundled native messaging executable only after macOS
kernel peer inspection confirms its UID, executable path, and owning browser
PID. The native-host manifest permits only the first-party extension origin.
A fresh per-launch secret signs a fresh challenge as an additional check
against unpacked-extension identity spoofing. The worker reads the private
launch configuration anew for every challenge, rather than importing a secret
into Chromium's persistent worker module cache. Shutdown removes this secret.
Delayed responses from previous connections cannot authenticate, disconnect,
or resolve requests on a newer connection. Sent actions fail explicitly after
a disconnect and are never replayed automatically.

One standalone Node Agent Core owns the encrypted development state. Pipes,
frames, pending requests, handshake time, and request time are bounded. The
native profile has a process lock before the generated UI is staged.

## Evidence and remaining gates

On 2026-10-28 the disposable native candidate passed actual Home and Settings
rendering, a real Core snapshot, native tab operations, ordinary-page bridge
isolation, full Core session restart, and clean shutdown. The live Store run
installed JSON Formatter `0.10.2` (`bcjindcccaagfpapjjmafapmmgkkhgoa`) with
Home, Settings, and Store sharing one Chromium window, then verified it was
enabled after a full restart. This evidence applies to the tested candidate,
not automatically to later builds or the installed canonical app. The
functional JSON rendering checks also passed before and after restart.
Native keyboard New Tab, Close Tab, zoom, and Kestrel's own panel collapse
control were exercised on screen. Home presents one conversation surface
while Chromium's companion is open.

The full native build, native authentication and restart smokes, workspace
TypeScript checks, and all 1,700 unit tests passed. An additional focused
regression run passed 25 tests, including browser-free module imports and
exact Store-origin matching. The initial dependency audit found vulnerable
Zod and website Next.js versions; these are updated to Zod 4.6.6 and Next.js
16.4.1, including the older transitive Zod copy. The production audit now
reports no known vulnerabilities. The full local `pnpm verify` command passed
at the prior checkpoint, including website and Electron compatibility flows;
that is separate from proving full native product parity. Remote CodeQL and
packaged desktop checks passed at `92293718`; Core CI stopped at its full
development dependency audit with 25 advisories. Vite, Vitest, the retained
Electron compatibility dependency, undici, and fast-uri are now patched too;
the full local audit reports zero vulnerabilities. All remote checks passed
at `063756b1`, including CodeQL, Core/website/security, and the packaged
desktop job. Later changes require fresh checks.

Native builds compile the peer inspector against headers from the same
checksum-verified Node archive as the bundled runtime. CI runs the new
Chromium desktop and native authentication smokes against its exact native
candidate, in addition to the historical host probes.

Core now routes visible tab listing, creation, navigation, selection, closing,
history, and download metadata through the authenticated native worker. The
visible tab tools exclude protected Kestrel and browser pages. The live Core
canary verified that an unapproved open request creates no tab, an approved
request opens and navigates a real Chromium tab, closing removes that exact
tab, and even an approved request cannot close the Kestrel UI. Cancellation,
disconnect, timeout, and single-owner response matching have focused tests;
sent operations are never replayed automatically. The focused native suite
now has 65 passing tests. Browser tab identities live in Chromium session
storage; a stale tool target cannot silently alias a different tab when Chrome
reuses numeric tab IDs after a full restart.

Core's current-context tool and the existing UI context request now read an
HTTP(S) main document through Chromium's scripting API in its isolated world.
The worker pins the main document ID before execution and checks that same ID
and URL afterwards, including same-URL navigation. It excludes editable and
private content, never reads form values, redacts credential-like text, and
removes URL queries and fragments before returning context. Core separately
validates and redacts the result. The live native canary verifies public text,
headings, links, sensitive field metadata, page-world isolation, and absence
of fixture secrets from both the UI and Core results. This does not yet read
cross-origin child frames or provide interaction references.

All 1,712 workspace tests and workspace TypeScript checks passed after these
changes. The native desktop canary also passed page reading, tab tools,
approval enforcement, durable restart, and clean shutdown on the new build.

Closing the last native window now leaves Agent Core running. Dock activation,
New Window, and Settings can create a fresh Chromium window; quitting still
owns the broker, Core, and browser shutdown sequence. The development
launcher's SIGTERM follows that same clean Quit path. To exercise window
recovery visibly, run `KESTREL_TEST_NATIVE_WINDOW_LIFECYCLE=1` with the desktop
canary, close the candidate's last window at its prompt, and reopen it using
the native app controls. The canary requires the exact same broker/relay/Core
PIDs before and after reopening and the saved conversation to remain visible.
This flow passed with the native close control and app reactivation. The
normal canary also exercises real Core history and download-list contracts.

Core now validates tab, history, and download metadata independently of the
browser host. It removes credential-bearing query/fragment values, rejects
privileged and credential-embedded URLs, and redacts text before returning
those observations to the agent. Malformed and oversized responses fail with
a fixed error rather than reflecting host data. All 1,716 workspace tests pass.
The live canary downloaded a real file using Chromium's download manager,
verified the exact bytes in its disposable profile, and verified that Core's
tab/history/download results omit the fixture URL secret. Test connections
use Playwright's `noDefaults` option so its download, focus, and media overrides
do not replace the native browser behavior under test.

The native desktop now uses the shared standalone Node Core supervisor,
rather than the historical one-shot relay. Core startup, bounded crash
recovery, request settlement, browser cancellation, and shutdown use the same
tested supervisor as the existing desktop. Core stdout is excluded from the
framed host protocol, and the native runtime bundle rejects Electron imports.
The live native canary killed only its verified Core child, observed a new
Core PID under the same relay, retained the same browser/Home and conversation,
and successfully used the existing Chromium tab after recovery. Native
authentication and clean child/secret shutdown passed with this supervisor.
The focused supervisor/native regression run passed 76 tests. In-flight
requests fail on interruption; recovery does not automatically replay actions.

The full local `pnpm verify` run passed at `6aeb89f8`. Its first attempt found a
payment test comparing a three-digit CVV against the entire serialized result;
the same digits can occur in a random field ID. The test now deliberately
creates that collision and checks emitted field values, while retaining blank
CVV and blocked-fill assertions. Both the focused autofill flow and the complete
verification run passed.

Native request deadlines now share Core's existing execution budgets. Agent
tasks retain their bounded 30-minute budget and transcription retains 125
seconds. The worker separately bounds initial connection setup and the outer
layers leave room for Core's cancellation response. Clock-based regressions
verify that authenticated and initially queued requests survive the old
40–45-second cutoff without replay. All 1,720 workspace tests, 69 focused native
tests, workspace TypeScript checks, a fresh native build, native authentication,
and the real native desktop/Core-recovery canary passed. This is transport
evidence; a full native provider-driven workflow is still a release gate.

The native first-party UI now routes provider account creation, updates,
removal, credential summaries/storage/revocation, and vendor CLI enablement
to the portable provider host. Provider changes acquire an idle-Core guard
before persisting anything; concurrent edits and active/background tasks
reject changes. Core stops before the accepted mutation and restarts with
the same database/key. A rejected mutation restores the previous runtime.
Existing vendor routes persist only their detected executable and enablement;
the selected vendor child receives its original home while Agent Core keeps
its private home. Ambient API credentials are never imported.

The visible native Settings canary added a loopback provider with an encrypted
header, discovered its model, and sent a prompt from Home. The real standalone
Core streamed and persisted the answer in the existing conversation UI. A
second held provider request finished after a concurrent credential change was
rejected without saving it. Account settings and the conversation survived a
full app restart. The opt-in `KESTREL_TEST_REAL_CODEX=1` canary also enabled the
existing official ChatGPT/Codex login through Settings, discovered entitled
models, and received a real `gpt-5.6-luna` response from the Home composer.
Receipts for candidate executable `5f4f1473` are retained in
`.tmp/chromium-provider-evidence-5f4f1473/` and
`.tmp/chromium-Codex-evidence-5f4f1473/`. The full unit suite now passes 1,735
tests. This does not verify every new sign-in/local-model flow, public
Keychain protection, or the installed canonical app.

Home now hands new tasks and conversation selection to the actual native
companion when it is open. The private extension uses a bounded, same-origin,
window-specific channel with validation, acceptance receipts, duplicate
suppression, and no persisted/replayed actions. Home waits for acceptance
before clearing a prompt. A busy companion rejects a competing prompt and
Home preserves that draft. The native canary verifies a Home task rendering
inside the actual Chromium side-panel target, then holds a real provider call,
rejects a competing draft, and requires the original task to finish. It also
passes full app restart. This was verified on candidate `00ed37ae`; the complete
unit suite now has 1,741 passing tests and workspace typecheck passes.

The live Chrome Web Store canary was repeated on that same `00ed37ae`
candidate after provider and companion integration. Chromium's real permission
sheet installed JSON Formatter `0.10.2`; it rendered an actual JSON page before
and after a complete restart. Home, Settings, and Store all belonged to native
window `1137455833`, with companion target
`A4AE3205F1926D3A19614DCE901017D0`. The combined provider, busy-task, download,
Core recovery, Store, and restart receipt is retained under
`.tmp/chromium-store-companion-evidence-00ed37ae/`. The canonical installed
Electron app and its existing user data remain preserved pending cutover.

### Native input and normal launch checkpoint

Candidate executable `5c1a9c91` passed real Core accessibility snapshots,
trusted Chromium click/type/key/wheel input, selection changes, consumed/stale
reference rejection, same-URL document replacement rejection, sensitive-field
refusal, and compressed screenshots decoded and independently checked in Core.
It also passed the provider/companion task, download, crash-recovery, and restart
canary. Evidence is retained in
`.tmp/chromium-actions-provider-evidence-5c1a9c91/`. Screenshots refuse editable,
private, embedded, and ambiguous content rather than exposing it. A review also
found that attributes past the traversal limit could hide private markers; such
nodes and descendants now fail closed, with regression coverage.

No-argument launch now selects the real native desktop and a private durable
Default profile, rather than opening the historical extension workbench.
Existing unrecognized data is preserved, and creating a separate profile needs
an on-screen choice. A test-only private temporary profile avoids touching the
user's real data. The no-argument smoke verified an authenticated worker/Core
bridge, first-party document load, durable key, restart, and clean shutdown;
document load alone does not prove React rendered. The first-run canary checks
the actual setup screens and a real subsequent task without setting onboarding
flags. Fresh-profile acceptance passed on 2026-10-29: all five rendered setup
screens, installed-model discovery and live verification, a guided task with a
real tool result, a separate Home prompt, and the persisted reply after a full
restart. The receipt and screenshots are in
`.tmp/native-first-run-evidence-cxGvhF/`; its complete-bundle fingerprint is
`92026063798d7967935d9a2244da70d27b4a7aed893a864eb8817472090ab917`.

Native sign-in now has guarded start/cancel handling through the official
provider flow and opens its approved provider URL in the native browser.
Deterministic tests cover cancellation, cleanup, busy-state protection, and
managed accounts; a new interactive login has not yet been visibly exercised.
Installed Ollama models are shown as choices separately from configured routes.
Local setup requires confirmed tool support and a real `/api/chat` response;
a text-generation response alone no longer establishes readiness for the guided
first task. Automatic runtime installation/model downloads remain unavailable.

Retirement acceptance now additionally requires a complete-bundle fingerprint,
separate gate receipts, and unchanged supporting artifacts. These are reviewed
attestations, not cryptographic proof that a workflow happened. The installer
also validates the staged copy against the evidence and its release signature
before moving any installed app. The current canonical on-screen gate still
requires a staged cutover/rollback implementation; `native-cutover-plan.mjs`
only describes that plan and makes no changes. No complete manifest has been
asserted for this candidate. The canonical installed app remains unchanged.

Release acceptance still requires the complete native product workflow:

- Provider sign-in and credential storage, local models, workspace/file
  operations, settings, approvals, and agent execution on the new host.
- Full Core browser automation beyond the verified visible tabs, snapshots,
  actions, and screenshots: isolated browsing,
  downloads, autofill, recovery, and functional extension/update
  checks on this exact window architecture.
- A tested, explicit profile transfer and rollback path that preserves the
  existing user profile and credentials.
- Packaged candidate validation and visible verification after updating the
  single canonical `/Applications/Kestrel.app`.
- Developer ID signing and notarization for public macOS distribution. This
  Mac currently has no Apple Developer account/certificate provisioned.

Unsupported native requests fail explicitly. The existing installed app and
its data remain preserved while these gates are implemented; the migration
must not be called release-ready from a binary or Store canary alone.

### Native workspace and isolated recovery checkpoint

The native workspace host reuses the existing project/grant store. Settings
opens a real Cocoa folder picker over a private Core sideband; renderer input
cannot supply the selected path. Adding, removing, renaming, and editing
project instructions use the idle-Core configuration guard. Existing grants
are loaded at startup; unavailable paths remain listed. No user folders or
existing profiles are implicitly granted or imported.

The background browser backend now creates windowless Alloy renderers inside
the same native Chromium process, with a fresh nonpersistent request context
per session. They create no visible tabs or stock browser windows. Live checks
cover cookie/localStorage separation from the user and other sessions, origin
allowlists, trusted input, consumed references, viewport changes, AX snapshots,
and screenshots decoded independently by Core. Authentication handoff,
background downloads, and desktop automation remain separate parity gaps.

Core shutdown/recovery uses a private reset barrier. An additional live check
keeps an isolated page actively emitting requests while terminating only the
owned Core child. It exposed a synchronous `CloseBrowser` callback releasing
the manager before its shutdown method returned. Shutdown now retains its
implementation for that entire call stack. The rebuilt candidate passed:
the old page stopped running, a new Core recovered, and a fresh isolated page
worked without restarting the visible browser. This receipt is retained at
`.tmp/chromium-active-isolated-recovery-evidence-fixed/`; its complete-bundle
fingerprint is `35e001692c9f480e7345384b3131fc63a8949467f5c99e1c09f4b147295551f0`.

To repeat the native folder, upload, isolated recovery, and real Store checks:

```sh
KESTREL_NATIVE_TEST_APP="$PWD/.tmp/native-chromium-host/Kestrel.app" \
KESTREL_TEST_NATIVE_WORKSPACE=1 \
KESTREL_TEST_NATIVE_ISOLATED_AUTOMATION=1 \
KESTREL_TEST_REAL_CHROME_WEB_STORE=1 corepack pnpm test:chromium-desktop
```

At the picker marker, select only the disposable `workspace-fixture` path
printed by the test. At the Store marker, review the actual native permission
sheet. The automated checks require Core to read the granted file, upload its
exact synthetic bytes while refusing an existing file outside that grant,
retain the grant after full restart, and deny reads after revocation. The
Store check requires functional JSON formatting before and after restart,
one window for Home/Settings/Store, and the real Kestrel companion. Receipts
include a complete-bundle fingerprint checked again before success.

The full unit suite at this checkpoint passed 1,858 tests across 256 files,
and workspace TypeScript checks and the native build passed. Those results
are distinct from full `pnpm verify`, exact-head remote CI, public signing,
profile transfer/rollback, and canonical installation acceptance.

Visual inspection also found that granting a folder from Settings left other
Kestrel pages' Projects sidebars stale. Successful workspace mutations now
broadcast bounded project metadata over the authenticated worker connection;
the renderer validates that event and updates each page. The live workspace
canary additionally requires the project in both Home and Settings before
continuing, and its removal after revocation. Final units passed 1,861 tests
across 256 files, and final TypeScript checks passed.

The first broad verification run exposed a retained-host compatibility issue:
secret-field redaction clears some rich AX properties to an empty string. Core
now accepts exactly that redacted form, continues rejecting nonempty scalar
properties, and preserves the Sensitive field marker when other properties
are present. The focused privacy regressions and all 50 browser benchmark
workflows passed. The first aggregate verification run stopped at the original
regression; aggregate rerun and final on-screen sidebar evidence are separate
checks.

The final workspace event canary passed with both the Settings grant row and
Home/Settings sidebars showing the renamed project. It uses a clearly marked
pre-granted disposable fixture to isolate metadata broadcasts; it does not
replace the separately recorded real Cocoa picker check. Its final 21-phase
CI-equivalent run also includes provider Settings, an actual streamed Home
task, a rejected provider mutation while busy, isolated active-page recovery,
workspace upload and containment refusal, full restart, and revocation.
The receipt is `.tmp/chromium-final-ci-variant-evidence/receipt.json`, bound to
complete bundle `5f9bf76ca1e4c7b9fdb1481cec278bd917b20f93ccdc8a1db2aec85106b7bf79`.
CI now enables these isolated/workspace fixture checks alongside providers.

Fresh first-run setup was repeated successfully on bundle `b264bff1` at
`.tmp/native-first-run-evidence-P2HmF7/`: all five screens, a verified installed
Ollama model, the guided tool task, a separate Home reply, zero renderer errors,
and conversation persistence after restart. These exact-build receipts remain
separate from the real Store proof on bundle `35e00169`; repeat the interactive
Store flow on a final release bundle before asserting its release gate.

Installer recognition now includes the explicitly supported native bundle ID.
The generic installer rejects that native source unless native cutover is
explicitly accepted; the existing candidate evidence/signature checks still run
before replacement. Focused installer/hygiene checks passed 12 tests. The final
full unit run passed 1,863 tests across 256 files and TypeScript passed. Aggregate
verification then stopped at the retained Electron tab-interaction hover
preview. The remaining checks were run separately: 19 passed, while the broader
Electron browser check failed at the same preview condition. The Mac was
confirmed locked and previews require a focused owner window. Both failures
remain recorded for rechecking after unlock; aggregate verification is not
reported as fully passed. Generated verification screenshots were preserved
under `.tmp/native-verification-generated-screenshots/`.

### Navigation during native input

A real isolated link click exposed an unsafe synchronous `CloseBrowser` call
inside CEF's navigation callback. Session invalidation is now immediate while
the actual close is deferred. Deferred tasks release their callbacks after
execution, and a rejected CEF close-task post falls back to the macOS main queue.
Enter now includes Chromium's character data; native key-down metadata alone
did not submit a form. Pointer/key pairs are queued once to the pinned widget.

Navigation overlapping an unacknowledged gesture never proves success. The
isolated host retains both acknowledgments, waits for the allowed document to
load, then returns an explicit uncertain/no-replay result. The same session can
provide a fresh read-only observation. Same-document success requires both
acknowledgments and a fresh document check. Visible-tab input likewise rechecks
the pinned document after the pair; cancellation/timeout tests retain no replay.
An independent read-only review confirmed the earlier false-success finding was
resolved. The navigation-during-press regression and 26 native input tests pass.

The 23-phase provider/workspace/isolated canary passed on complete bundle
`116f488008441f7529b285710f3fc9ead44b2261312f5b2cadeac285d220f1f5`;
receipt `.tmp/chromium-gesture-final-ci-evidence/receipt.json` records the link
and Enter navigation acknowledgments as failed/uncertain while independently
proving arrival, isolated cookie/storage continuity, fresh observations, active
Core crash recovery, full restart, and clean shutdown. CI includes the form
check. All 1,864 unit tests and workspace TypeScript checks passed at this
checkpoint. The separately developed attachment host is not yet integrated.

GitHub diagnostics were recovered through the connected GitHub tool. Exact
head `6f4b18331093abda4fe85785cdc7728ef090c9d4` passed the Desktop/packaged
arm64 job, including its browser benchmark and packaged tests. Its Core job
failed at `test:chromium-host`: the older Playwright host returned a flat AX
array instead of Core's structural `{ nodes }` contract. That host now emits
the required shape, with a regression that validates its output through the
actual Core normalizer while retaining secret/hidden-content rejection. The
three focused host tests and full browser/provider/form/approval smoke passed
locally. Fresh remote checks are required for the correction.
