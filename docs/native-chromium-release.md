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

### Context attachments, native file selection, and controlled downloads

The portable native context host now handles granted-project file search,
pasted-text attachment creation/removal, and file selection through the private
Cocoa sideband. It rejects arbitrary external paths before Core reads a file or
calls a provider. Generated pastes belong to one launch and private directory;
selected workspace files retain canonical grant, identity, size, and media-type
checks. Selection is limited to eight regular project files of at most 10 MB
each. Cancellation, revoked grants, replaced files/directories, escaped paths,
late picker replies, and shutdown have regression coverage. The native renderer
also rejects oversized serialized requests before they can disconnect its
authenticated worker. Core stops before generated attachments are removed.

The file picker shares the existing singleton Cocoa panel and trusted cancel
path. `test:chromium-context-dialog` runs the real bundled Node/Core host with
simulated trusted picker replies. It verified selected file metadata, cancel,
containment, unselected-external-file refusal, pending-picker shutdown, and
generated-file cleanup. This proves the private protocol, not a physical panel
interaction; an unlocked-Mac file-picker check remains required. No existing
user profile or project folder was imported or changed.

Isolated downloads now use fresh private session directories, opaque filenames,
allowed-origin GET/POST requests, a four-active limit, 100-entry history, and
100,000,000-byte per-file/session completion budgets. Actual file identity and
bytes are hashed on CEF's background file thread before completion is published;
worker results are cancellation/generation checked. Close cancels without joining
workers and removes only owned temporary files. Server-provided names, URLs and
local paths are absent from observations. Unknown-length limits use CEF progress
callbacks and are not a hard cap on network or transient disk bytes between
callbacks. Authentication handoff and whole-desktop automation remain open gaps.

The real loopback download check independently read the retained artifact and
verified its bytes/SHA-256, refused an advertised oversized body after a small
sniffing block, kept four transfers active, refused a fifth without hanging
navigation, and cancelled/cleaned all of them when the session closed. The
complete native run also verified that a large paste from Home reached the
protected fixture provider through Core, an unselected external file never
reached it, oversized frames left the connection usable, and project search
refused an ungranted root. The 26-phase receipt is retained under
`.tmp/chromium-context-download-complete-evidence/`, bound to complete bundle
`cae91c3e1926f7c5bbb3cbeeea7223984fb3197206e19ae4b52f915a2dc2246d`.
The private picker protocol receipt is
`.tmp/native-context-dialog-evidence/receipt.json` for that same bundle.
All 1,901 tests across 257 files, workspace TypeScript, and the native build
passed. CI enables these fixture workflows and uploads both evidence folders.

```sh
KESTREL_NATIVE_TEST_APP="$PWD/.tmp/native-chromium-host/Kestrel.app" \
  corepack pnpm test:chromium-context-dialog
KESTREL_NATIVE_TEST_APP="$PWD/.tmp/native-chromium-host/Kestrel.app" \
KESTREL_TEST_NATIVE_PROVIDERS=1 \
KESTREL_TEST_NATIVE_WORKSPACE_FIXTURE=1 \
KESTREL_TEST_NATIVE_CONTEXT_ATTACHMENTS=1 \
KESTREL_TEST_NATIVE_ISOLATED_AUTOMATION=1 \
KESTREL_TEST_NATIVE_FORM_NAVIGATION=1 \
KESTREL_TEST_NATIVE_ISOLATED_DOWNLOADS=1 corepack pnpm test:chromium-desktop
```

### Browser preference ownership, document identity, and OS web links

Native Browser Settings retains Kestrel's existing section navigation, Home
background controls and page-context consent. Chromium-owned preferences open
the actual `chrome://settings` category in the same window with the agent
companion. Native state identifies Chromium preference ownership so Core's
legacy browser configuration cannot overwrite it or display compatibility
defaults as measured preferences. Home searches use Chromium's selected provider
through `chrome.search.query`; the adapter no longer chooses a hardcoded engine.
Home images, shortcuts and widgets persist only their Kestrel-owned fields.
The full-size image allowance is local to the authenticated extension worker;
the native messaging/Core frame limit remains unchanged.

Home and Settings now retain their own document/tab identities while another
tab is active. The mapping uses each extension document's `tabs.getCurrent()`
and session UUID, with stale-read protection; it never guesses by matching URLs.
Duplicate Settings documents are independent. Core and the companion continue
to observe the actual active user tab. Browser state includes tabs from every
window so a background document is not lost when a different window has focus.
The narrow sidebar starts compact unless an explicit preference exists, and
Expand reveals Projects and chats at narrow widths rather than hiding them
behind CSS while claiming to be expanded.

The native app declares HTTP/HTTPS handlers and accepts credential-free OS web
links through a bounded main-thread queue, including links delivered before
worker readiness. Consumed launch arguments are removed before Chromium startup
so they cannot open twice. The authenticated broker serializes delivery, checks
the acknowledgement's owner and ID, and never replays a dispatched link after an
uncertain disconnect. Existing windows receive a native tab. With no window,
Chromium creates one and retains its normal session restoration; Kestrel does
not add another Home to the restored session or deduplicate user tabs.

The physical Cocoa file-picker check exposed a canonical-path mismatch:
Foundation displays `/var/...` where Core's POSIX `realpath` returns
`/private/var/...`. Root validation and selected-file attestations now use POSIX
canonical paths, preserving the component boundary and Core's grant, identity
and size revalidation. The real picker cancellation and selection passed in
`.tmp/native-cocoa-picker-interrupted-evidence/receipt.json` on complete bundle
`4d5180b4e62709b183c64c56ffc129751deb5df062f6ba72b0ffffd45449a5fb`.
That run completed 24 phases before an interrupted process exited at the Store
handoff; it is not a completed Store receipt.

The integrated 30-phase run passed on complete bundle
`1105da83f947a240f96a9acb82e6cc01ac813db276cde1719566ab6f734d3af9`,
including real JSON Formatter 0.10.2 Store installation, Chromium's permission
sheet, actual formatting before/after restart, workspace/provider persistence,
download quotas/cancellation, active-renderer crash recovery and zero renderer
errors. Home, Settings and Store shared native window `1941597296`, as recorded
by `native-web-store-install.windowIds`. Receipts remain local under
`.tmp/chromium-desktop-evidence/`; no canonical installation is implied.

The current source passed workspace TypeScript, 1,915 unit tests across 259
files, the native build, authentication smoke, private picker protocol and
three compiled native URL/path tests. The separate settings canary verifies
actual provider choice, an uploaded 1.23 MB image, restart/removal, independent
Home/duplicate Settings documents, narrow expansion, OS cold/warm links, and
reopening after all windows close while retaining the same Core process/session.
All 12 settings/window phases passed on complete bundle
`add394828f8d071d2d1fdcb72985b52939e9c624922b85f04199a69151ce8cd0`;
the before/after complete bundle digests match in
`.tmp/native-document-recovery-final-evidence/receipt.json`. This run also injects
a transient missing document identity, then a persistent failure, verifies the
bounded error and actual Try again control, and recovers to the real sidebar.
The resolver cancels stale requests and has a ten-second deadline even when a
Chrome API promise never settles. A read-only independent review found no
confirmed resolver/frame issues after checking the native keyboard guard.
Fresh default-profile setup also passed on that complete bundle, using the
already-installed `huihui_ai/qwen3.5-abliterated:9b` model: all five rendered
steps, actual model verification, a guided task with a real tool result, a second
Home response, zero renderer errors and conversation persistence after restart.
The evidence is `.tmp/native-first-run-evidence-aUrYtR/receipt.json`; no runtime
or model was installed, and the existing local daemon was not reconfigured.
CI runs that canary and the compiled URL/path tests in addition to the integrated
native flow. Physical picker and Store acceptance remain explicit interactive
checks, separate from their automatic fixture/protocol tests.

At exact head `19abc76081765f582c1e47256498addccd280dee`, Desktop/packaged arm64
CI passed; Core, audits and the corrected Chromium-host smoke passed before the
native combined job stopped at a viewport-dependent sidebar visibility check.
The narrow sidebar and canary expansion fixes address that observed failure.
Fresh exact-head CI is still required. The GitHub connector became unavailable
during this checkpoint, and Codex Code Review also reports its connection is
unavailable. Neither condition is reported as a green remote check.

These changes do not complete production acceptance for system-default/login-item
setters, public credential protection, whole-desktop automation/authentication handoff, automatic
local-runtime installation, lossless profile transfer, rollback or canonical
cutover. Developer ID/notarization still requires an Apple Developer account.
The existing `/Applications/Kestrel.app`, its profile and unrelated source
changes remain preserved; no Electron-retirement gate is asserted.


### Native window recovery and macOS system requests

Default-browser and launch-at-login requests now reach Cocoa. Default-browser
changes use the asynchronous system consent API, attempt both HTTP and HTTPS,
and read back both handlers. Only one request may remain pending; its timeout
and disconnect messages identify the outcome as uncertain and require checking
System Settings before a retry. Launch-at-login reports the actual
SMAppService status, including required approval, without optimistic state.
The actual Settings row shows errors and disables its switch during a request.
Both mutations require the canonical production identity and a loaded canonical
CEF framework. Development candidates cannot modify those macOS settings.
Production identity, actual OS mutation acceptance and cutover remain pending;
no Mac settings were changed to claim this evidence.

Zero-window native reopen and New Window now use the authenticated worker rather
than CEF startup creation. A real native close/reopen test exposed that a
URL-less Chrome window restores the old Home and creates another Home. The
corrected operation creates one uniquely identified temporary blank tab. It
reuses a restored first-party Home and removes only its still-owned temporary
tab; if no Home is restored it navigates only that temporary tab. Pre-existing
blank, public and duplicate Home tabs are preserved. Changed tab identity/URLs
produce an uncertain result without replay. Extension identity compares the
protocol, host and path explicitly instead of an opaque URL origin.

The final development bundle is
`f3d60a92ffbe1d3912723d601a05deef090ebb7ad384c57257813da0e31ffe0c`.
Its 11-phase native lifecycle run passed actual last-window close, native
reopening with exactly one Home, visible sidebar/Home controls, unchanged Core
processes, persisted conversation and full restart/clean shutdown. Evidence is
`.tmp/native-window-marker-lifecycle-evidence/receipt.json`. All 13 settings
phases also passed on this bundle, including the actual Run at login guard
refusal rendered as an alert with unchanged system readback and switch state;
its before/after bundle hashes match in
`.tmp/native-window-marker-settings-evidence/receipt.json`.

The native build, workspace TypeScript, 1,926 tests across 260 files, native
authentication, injected Cocoa system tests and three compiled URL/path tests
passed. The generic installer now identifies native, Electron and ambiguous
bundle contents independently of their shared production ID and rechecks the
staged copy before moving the canonical app or duplicates. Ten focused
classifier/installer tests passed with owned temporary fixtures. No app was
installed. Fresh-profile setup and visible conversation restoration also passed
on prior bundle `add394828f8d071d2`; the current exact-bundle first-run check is
not inferred from that earlier receipt.

At exact published head `10ed887a53a9a74f7fa0625f29d27065cfb0f2aa`, Desktop CI
failed the automatic narrow-viewport collapse assertion. The sidebar now tracks
viewport changes when no explicit preference exists and retains an explicit
expansion. The expanded Projects section remains visible. The complete local
`test:desktop-setup` run passed these automatic/explicit resize checks. Core CI
passed TypeScript, all 1,915 tests and the source-ingestion benchmark before
full dependency audit failed [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
The production-only audit passed locally. Full audit remains a release gap;
major-version forcing would break legacy minimatch/brace-expansion consumers,
and no blanket advisory exemption was applied. Public GitHub REST supplied
these exact-head logs while connected Code Review remained unavailable.

The same final `f3d60a92ffbe1d39` bundle then passed the complete 30-phase native
flow, including the physical Chromium permission sheet, official JSON Formatter
0.10.2 installation, actual formatting before/after full restart, and
Home/Settings/Store window ID `595895288` with companion target
`E4A4D0563417ED2769F4BE9200AA0CD5`. The retained receipt is
`.tmp/native-window-marker-store-30-evidence/receipt.json`. Provider/project and
conversation persistence, large context paste delivery, unselected-path refusal,
isolated browser/screenshot/download checks and active-renderer/Core recovery
also passed in that run. This is candidate evidence; canonical installation and
public release remain unproven.

The broad local `verify` run passed the production audit, workspace typecheck,
all 1,926 unit tests, settings/reference/product audits, builds, Node Core,
native extension regressions, Core sidecar/browser benchmark, all 50 website E2E
checks, desktop smoke and single-instance checks. It stopped at the desktop
layout fixture, which explicitly saved an expanded sidebar but expected a
forced 56px rail at 920px. The fixture now verifies the actual expanded 216px
layout, collapses through the real control, and verifies compact layout and
200% zoom. The focused complete `test:desktop-layout` passes, including window
controls and Agent navigation. The unexecuted remainder of `verify` is not
reported as passed.


### Backported dependency checks and native health probes

The pinned minimatch 3/5/9/10 APIs now retain compatibility with the existing
brace-expansion 5 override. The modern versions include the upstream bounded
optimizer fix in both module formats. Actual installed consumer tests cover
braces, normal glob behavior, optimizer limits, real glob 7 traversal and ASAR
packing/unpacking; all 18 behavioral checks passed. The development package
build, packaged smoke and packaged layout checks passed. No package was installed.

`audit:dependencies` runs the raw scanner from an isolated lockfile-only
workspace so project or inherited ignore/severity settings cannot hide findings.
It preserves the original advisory output. The one temporary backport policy
accepts only the exact development-only minimatch advisory, reviewed versions,
all 23 known paths and unchanged metadata after checking patch/lock hashes,
installed manifests and source, actual public entrypoint resolution,
brace-expansion identity and the behavioral tests. Unknown findings, altered
paths/versions/configuration, missing patches, source/manifest changes, transport
errors or expiry fail. Evidence checks run even for an empty scanner report.
The exception expires at `2026-12-01T00:00:00.000Z`; the raw registry still reports
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
The live guard and 36 focused policy/compatibility tests pass. Independent review
found and corrected inherited-ignore, empty-report and entrypoint-remapping gaps.
No global advisory ignore was added. The current isolated scanner does not report
the previously ignored sprintf-js finding; that observation is not remediation
proof. CI and release auditing now use this explicit guard.

An incremental pnpm 11.15.1 frozen install reported success but linked unpatched
contents under patch-hash directories. A separately reproduced fresh frozen
install applied all patches. The isolated release worktree retained its old
node_modules in `.tmp/node-modules-before-minimatch-refresh/` and refreshed only
its own dependencies. Consumer-resolved tests and source hashes catch that false
install result rather than trusting directory names. User profiles and the
primary dirty checkout were not touched.

Native `system-readiness` now reaches actual Core, model-route, fixed-loopback
Ollama status and workspace availability probes. It distinguishes configured
routes from live responses and labels timestamped model verification as
historical. Unsupported desktop, backup and production acceptance remain
unverified; the report does not manufacture a ready state. The new standalone
private-Core protocol test passed. Actual Settings diagnostics and the Readiness
page rendered their results on complete bundle
`fdecbcd481850174e820d0ca417a13bb3739ff788e15627b4bac7f806231c27d`.
All 14 settings/window phases passed with matching before/after bundle hashes in
`.tmp/native-readiness-complete-evidence/receipt.json`; its `native-readiness.png`
was visually inspected after actual native activation. Resize assertions now
wait for the applied media-query state before clicking Expand.

The native build, workspace typecheck and all 1,967 tests across 263 files passed
at this checkpoint. Packaged CLI, editor integration contract and production
secret-scan checks passed. The Store canary for this newer bundle reached its
native install handoff but could not accept the sheet because the computer tool
reported a locked Mac. It timed out without observing installation and shut down
its owned processes; evidence is retained in
`.tmp/native-readiness-store-locked-evidence/`. The earlier complete 30-phase
Store receipt remains the `f3d60a92` bundle above. The pending unlock request is
required for a fresh interactive check; no current-bundle Store success or
canonical cutover is inferred from prior receipts.

### Guarded native local setup checkpoint

The native host now supports explicit guided runtime/model setup and custom
model downloads through the existing guarded local-runtime manager. Progress,
cancellation and real chat/tool-capability verification reach the Kestrel UI.
Route selection is committed together with preferences and Core restart;
failure or cancellation restores the prior configuration and stops only a new
managed child acquired by that attempt. Existing external daemons remain owned
by the user. Runtime downloads validate every redirect host and the pinned
release checksum before extracting into an owned staging directory.

Workspace typechecking, the native build and all 1,985 tests across 263 files
passed. The optional `test:chromium-local-setup` requires an explicit candidate
and exact already-installed model, and runs the bundled Node/Core implementation
in a disposable profile. Its six phases passed on complete bundle
`f0608672439cc0b4a4e6bc183edbafeca41f417be6b469ffa17d188d3cdee23b`:
setup verified the existing model, selected the live local route, persisted a
real assistant response, and preserved that route and response after restart.
The external Ollama listener PID and model digests were unchanged after both
stops. Receipt: `.tmp/native-local-setup-evidence-hKij5o/receipt.json`.

This run observed detecting, verifying-model and ready stages only. Managed
runtime installation, model downloads and Ollama runner-descendant cleanup were
not exercised. Preflight and progress monitoring cannot atomically prevent a
pull if another actor removes the model between checking and setup. The current
candidate is separate from the canonical installed app; no profile transfer or
canonical replacement has been performed.

### Locality guards, signed plugins and native settings acceptance

Local setup and the Ollama provider reject advertised or malformed remote-model
metadata in tags, descriptors and chat responses. The provider checks tags and
descriptors before every prompt; detected local choices also require descriptor
confirmation with four concurrent requests and a three-second overall budget.
An explicitly selected local endpoint stays pinned. Existing automatic or
explicit multi-provider routing can use other configured routes; this is not a
network attestation of a daemon that falsifies its metadata.

All 2,012 tests across 264 files and workspace typechecking passed for the
locality checkpoint. The native build and six-phase installed-model setup and
restart canary passed on bundle
`7ad4c21519dc4645591afbb01d7a815ab320365e0dd1270ab93bc67d8b1b80e8`.
Receipt: `.tmp/native-local-setup-evidence-JxNuWV/receipt.json`; the external
Ollama listener and model digests remained unchanged. The separate Store run on
the preceding `f0608672` bundle timed out at its physical installation sheet
while the computer tool still reported a locked Mac. It did not prove installation.

Native plugin settings now use a profile-owned host for public publisher-key
import and signed install/update/remove/recovery. No vendor cache is imported.
Install, enable and MCP connection are separate actions; normal tool approval
still applies. Whole-operation deadlines, origin-port cancellation and rollback
cover settings mutation and Core restart. If rollback cannot acknowledge before
the bounded transport grace expires, the response explicitly reports an uncertain
outcome. A disconnected renderer cannot cancel another renderer's request or an
ordinary agent task. Public documents reject extra/private material. Managed
plugins require signature checks at startup, enable, MCP connection and skill
reads; saved activation is bound to both the host token and verified bundle
identity. Signed out-of-band replacements require renewed activation.

Independent reviews found and corrected cancellation, rollback, public-document,
managed-root, skill-read and activation-binding gaps. All 2,038 tests across 267
files, workspace typechecking and the native Cocoa/Chromium build passed. The
133 focused host/security regressions passed separately. This does not prove a
physical Cocoa picker interaction for plugins.

Complete bundle
`1b44588e15785c0fb51bac750ee14cc9d02679f2eae65c88ecd089dcdb45d12e`
passed all 14 native settings/window phases with matching before/after hashes
in `.tmp/native-browser-settings-evidence/receipt.json`. Improved CI diagnostics
exposed a real uploaded-image preview overlap; its grid sizing and decorative
hit testing are fixed. The real Remove upload click now passes, and the canary
also checks that preview geometry does not cover its text or controls. Its
`home-image.png` was visually inspected.

The same bundle passed `test:chromium-plugins`, which exercises actual bundled
Node/Core using generated signed fixtures and synthetic private dialog replies:
pending-picker cancellation without trust mutation; disabled install; explicit
enable; skill activation; MCP echo blocked before approval and verified after
approval; disconnect; restart persistence; and rejection of a tampered update
without replacing the installed version. The MCP child's executable resolved
to the bundled Node. Candidate hashes matched. Receipt:
`.tmp/native-plugin-core-evidence-iSSRwC/receipt.json`. This is private-Core
protocol acceptance, not physical picker or live plugin-UI acceptance.

At published `6ef57e40`, CI passed the dependency audit but failed native image
removal and a packaged layout assertion that still inferred sidebar width from
viewport size despite an explicit saved preference. The actual image defect is
fixed, and layout checks now assert that saved preference and its corresponding
geometry together. Fresh exact-head CI remains required. Canonical installation,
user-profile transfer, real Keychain protection, whole-desktop execution and
production signing remain incomplete.

The next exact-head CI run (`2cb7b4c5`, run `41367746125`) passed the Desktop
and packaged arm64 job. Core CI passed the dependency audit and all 14 native
settings phases, then found a workspace test clicking a background Home
document. The canary now selects each actual Chromium tab and waits for visible
document ownership before interacting. With the complete CI environment,
including isolation, form navigation, downloads, context and workspace fixtures,
all 26 integrated non-Store phases passed on the unchanged `1b44588e` bundle.
Its receipt is `.tmp/chromium-desktop-evidence/receipt.json`; the smaller prior
run is retained separately in `.tmp/native-plugin-ci-subset-evidence/`.
Current source and packaged desktop layout and packaged smoke also passed.

Additional new-lane Store probes now cover extension-created tabs and model
adoption, the real action-popup target, Chrome's own extension-manager toggle,
update-check status/version and restart persistence. These new Store probes
have only syntax validation while the physical installation sheet remains
unavailable. Missing capabilities are recorded explicitly. Set
`KESTREL_TEST_REQUIRE_CHROMIUM_EXTENSION_PARITY=1` together with the real-Store
flag to make incomplete parity fail the run; a `no_update` check is not reported
as a version upgrade. The existing retirement gate still invokes the older
probe lane, which cannot establish the new Chromium-owned desktop's parity.
It remains fail-closed pending a verified replacement acceptance path.

A worker's automatic pnpm run reinstalled shared linked dependencies. Actual
consumer/backport checks were rerun afterward: all 36 focused tests and the live
audit guard passed, with unchanged source and lockfile. Further worker validation
uses direct tools rather than allowing pnpm to mutate a shared installation.

### Native desktop boundary and actual managed runtime acceptance

CI run `41369466818` is fully green at `2ef88e68`, including both macOS jobs,
native integration, website, CLI, editor, packaged desktop and security checks.

The native desktop-control port now has a dedicated private Core/broker/Cocoa
channel. It defaults off, reads nonprompting OS permission status, and binds
each action to a fresh single-use capture ID, display geometry and foreground
process/window identity. Disabling takes effect before preference I/O and stays
disabled in memory if saving fails; the UI reports that restart persistence
failed. Core resets invalidate capture authority. Permission and target checks
are repeated before native input batches, and interruption after submission
reports an uncertain effect. Unsupported macOS capture versions are unavailable
rather than ready. Managed requests are separate from web/browser-user wire
requests. Public sites do not receive this private surface.

Independent review found and corrected wiring, disable-race and OS-readiness
issues. Root review also bounded preference reads, prevented FIFO blocking,
kept the enforced opt-out error visible and invalidated capture authority after
Core interruption. All 2,054 tests across 269 files, workspace typechecking and
the native build passed. The three changed native translation units also passed
focused syntax compilation. No OS input, screen capture, permission prompt or
enablement was invoked to obtain these results.

Bundle `0b847291f0d51d1aa116b7289da869d80eb6a3e1b8f5c79a65a02bfcb4ca1f62`
passed all 16 actual native settings/window phases, including real owner
permission status, the rendered Off switch, explicit opt-out and opt-out after
restart. Candidate hashes matched in
`.tmp/native-desktop-control-optout-evidence/receipt.json`. Enabled desktop
capture/input and action approval remain unverified until live acceptance.

`test:native-managed-runtime` requires explicit opt-in, an exact development
candidate, a stable external Ollama metadata baseline and at least 3 GiB free.
It passed all seven phases on that same bundle in
`.tmp/native-managed-runtime-evidence-FyYshN/receipt.json`: real pinned vendor
download/checksum/extraction; Qwen3 0.6B download into a private store; actual
server version and model digest/capabilities; a real chat response; restart;
cancellation preserving prior verification; and reaping the owned server and
llama-server descendants. The external port-11434 listener and model digests
were unchanged. The test runtime/model directory was removed after cleanup.
This is direct LocalRuntimeManager acceptance on a private injected loopback
origin, not a bundled-Core/default-port installation claim.

The first run reached real inference but its older runner-name assertion failed;
the pinned Ollama version uses the upstream llama-server subprocess. The corrected
canary records actual process identities and retains that failed receipt in
`.tmp/native-managed-runtime-evidence-TPDuEr/`. Cleanup is not counted as passing
if the test must signal an orphan itself. The successful run required no such
cleanup and preserved the candidate fingerprint.

The protected native Core key channel is integrated in bundle
`255a9b9cbc1b352301960a4617b7234e7ab7685d84a0b5a460ca88f95b294db7`.
Production durable profiles use the Cocoa Security.framework Keychain backend,
with a path-bound account and a private host/broker/Core key exchange. Existing
legacy file-key profiles fail closed pending an explicit migration. Test keys
are restricted to marked, fresh temporary profiles in development candidates;
they are not real-Keychain evidence. The current source passed all 2,060 tests
across 270 files, including the strengthened retirement receipt contract.

The opt-in `test:native-real-keychain` canary passed two actual app starts on
that bundle using a fresh generated profile, the production Keychain route,
and no test or legacy key files. A generated conversation/message survived
restart and decrypted correctly; its unique content was absent from raw SQLite
and WAL bytes. The candidate hash matched throughout. Evidence is in
`.tmp/native-real-keychain-evidence-1793593368970-5c3982ce-b9ed-471f-a449-3c008c88c150/receipt.json`.
The temporary profile was removed. One Keychain item scoped to that generated
profile remains; the canary never exports its value. This proves native Core
key custody and encrypted conversation restart, not transfer of existing
Electron credentials or production signing identity.

The same bundle completed all 34 desktop Store workflow phases in
`.tmp/chromium-desktop-evidence/receipt.json`. Both JSON Formatter 0.10.2 and
uBlock Origin Lite 2026.1026.1812 were installed through their official Store
listings and real Chromium confirmation sheets. Home, Settings and Store shared
one native window with the real Kestrel companion. JSON Formatter transformed
the generated JSON fixture, stopped while disabled in chrome://extensions,
resumed after re-enable and remained functional after app restart. The official
uBO Lite worker created, updated and removed a same-window tab observed by
Kestrel; its real action popup opened and exposed no Kestrel renderer bridge.
Both extensions persisted enabled across restart. Popup imagery is recorded in
`native-extension-action-popup.png`.

The strict extension parity result remains incomplete: five of its six checks
passed, while Chrome's real update check returned `no_update`. That confirms
the current version, not a published version transition. JSON Formatter has no
background worker or toolbar popup; those capabilities are correctly measured
using uBO Lite rather than treated as absent browser support. A failed earlier
expanded canary retained a stale test-client manager handle and left its
throwaway extension disabled; that receipt remains in
`.tmp/native-protected-core-store-stale-harness-evidence/`. The corrected handle
lifecycle passed disable/re-enable and persistence. A subsequent 34-phase run
in `.tmp/native-protected-core-two-store-34-evidence/` isolated the popup's
inactive-window precondition; focusing the real Chrome window resolved it.

Retirement now validates the hashed, exact-candidate Chromium desktop receipt
and its specific Store, tab, popup, toggle and restart evidence instead of
launching the obsolete CEF extension probe. Every other retirement gate,
explicit cutover acceptance and complete bundle fingerprint remains required.
A `no_update`, throttled or failed check cannot satisfy the actual published
upgrade requirement. These results do not replace the canonical Electron app;
whole-desktop enabled capture/input, full profile transfer and rollback, vendor
sign-in parity, production signing/notarization and canonical installation still
need their own acceptance evidence.

Native screenshot persistence was audited before enabled input acceptance.
The three built-in screenshot tools now use the protected tool-execution
AES-GCM envelope. Their completed and pending idempotency journals also use an
unambiguous encrypted codec, preserving normal JSON values and extension
metadata. Legacy logical records are converted in bounded pages; this is not
secure erasure of old SQLite pages, WAL copies, backups or filesystem snapshots.
Those user-owned backups are not removed. Metrics read the stored tool/status
columns so encrypted payloads retain accurate outcome counts.

The privacy change passed all 2,065 tests across 270 files, all 30 database tests
and workspace typechecking. Bundle
`d8b21f0836d6830906ef881b6662625e27dd19f3f15ae7fb882d0abd6e0f5a89`
built successfully and passed private broker/key protocol and durable Core
restart canaries. These two protocol runs use synthetic parent keys, not real
Keychain or GUI evidence. The real-Keychain acceptance above remains bound to
its earlier bundle. The full visible-browser compatibility smoke passed after
rebuilding the desktop, including HEIC conversion; its upload helper now waits
for the exact fixture view instead of choosing an arbitrary first window.

CI run `41388932911` at `282a6053` passed the complete Desktop job. The Core job
then timed out in the standalone readiness fixture: its synthetic parent did
not answer the newly added private permission-status request. The fixture now
answers only the read-only permission request with synthetic unavailable
status, rejects capture/input attempts, and passed on the rebuilt bundle with
its original time budget. This is not a real OS permission query.

The user approved the disposable local capture-and-one-click acceptance test.
Its first actual capture exposed a native focus bug: Chromium's small sharing
indicator appeared ahead of the focused browser in the window-server list. The
test rejected the target bounds before proposing input. No native input has
been verified by that failed receipt; the native focus fix and its live check
remain separate work.


### Native screenshot delivery and approved input acceptance (2026-11-02)

The native focus owner now selects Kestrel's actual key-window number, or a
uniquely matched focused Accessibility window for another app. Chromium's
sharing indicator can no longer replace the input-bound window. Ambiguous or
missing focus fails closed. A compiled C++ fixture exercises the production
selection function, including helper windows, overlapping windows, negative
coordinates, invalid bounds and focused modal windows.

Screenshot tools now retain compact capture metadata in conversation text and
supply validated PNG pixels as an actual image content part. Only the current
run's latest retained observation is rehydrated, only for the requesting
provider and model. Route changes, compaction and expiry cannot replay an old
image. Automatic provider fallback is disabled for that image-bearing request.
Encrypted execution records retain the pixels; ordinary conversation text does
not. Local Ollama rechecks the selected model's image capability before sending
pixels. Its generated tool-call IDs are now unique across completions, avoiding
cross-turn idempotency collisions. A desktop-input run cannot complete until
the final model request has received a distinct screenshot captured after its
last delivered input.

Bundle `32840e893c4d5a78c16842a49d7331be7718b6156470feac38734a3875067fa0`
ran the user's explicitly approved disposable local test. Receipt
`.tmp/native-desktop-computer-canary-6cc053d0-636f-41fb-a23b-bbfebeed206f.json`
records six successful phases: default-off, loopback model configuration,
explicit Settings enablement, a real native companion Allow once decision
followed by one trusted native click changing the generated counter from 0 to 1,
agent post-action capture/model image delivery, and product opt-out/fail-closed
capture. Both model images matched independently read Core execution hashes.
Raw SQLite checks found the screenshot and idempotency envelopes protected and
sampled PNG fragments absent. The stub used a known generated DOM target for
its coordinates; this is platform/image/approval proof, not vision-model
reasoning or unrestricted desktop-task evidence. Images stayed on this Mac.
No image bytes were written into the receipt.

That full receipt remains **failed**: its final restart step reused the prior
launch's DevTools address. The harness now scopes launch output locally. The
separate **restart-only** receipt
`.tmp/native-desktop-computer-canary-68da4e66-7b46-4604-96e3-ae024e81e7b3.json`
passed three clean starts with default-off status on the same bundle. It did
not capture, enable control, issue model completions or input. It does not turn
the earlier failed receipt into a complete single-run pass, nor prove enabled-
then-disabled restart on that earlier test profile. Both generated profiles
were removed and all owned processes stopped; no second click was attempted.
An earlier parser-only attempt also failed before input and cleaned up.

`test:native-desktop-computer` requires an explicit disposable candidate,
reviewed candidate hash and opt-in environment flag. It never enables access
or approves input itself. `--restart-only` is a separately scoped no-input
check. The canonical app and real profiles remain untouched.

Local validation after the selected-model capability check: **2,081 tests in
272 files** and workspace typechecking passed. Full CI at the preceding
published head `acda2d647f1d9271e153ee1e5f0faea3e82ff97e` also passed (runs
`41393665571` and `41393658718`). A rebuilt bundle and subsequent CI are
separate evidence from the input-test fingerprint above. Real published Store
version upgrade, complete profile/credential migration and rollback, vendor
sign-in parity, production signing/notarization and canonical cutover remain
release requirements.

The next bundle,
`1a38007c983a51ea8e2a79a736551289b16c635061e8b200846b5a50fee61a7b`,
passed the complete 16-phase settings/window/restart canary, including the
visible image-model explanation, real macOS permission status, enforced opt-out
and saved off state. Receipt:
`.tmp/native-model-image-settings-evidence/receipt.json`.
This run made no desktop capture/input requests and does not extend the
single-click proof to a second bundle. Completion checks query only desktop
input rows and the current frame, avoiding decryption of all historical image
payloads during ordinary conversation completion.

The final completion-query refinement rebuilt as
`26666290ae4dfaf2d121e1cdbaccc0b2f2360ee43e47de6345ef0904a497c1dc`.
All 2,081 tests/272 files, workspace typechecking and the full native build
passed again. Its full 16-phase settings/window/restart canary also passed:
`.tmp/native-model-image-release-settings-evidence/receipt.json`, unchanged
before/after bundle digest. That current candidate ran only the no-input
settings flow; the approved click remains bound to the earlier fingerprint.
