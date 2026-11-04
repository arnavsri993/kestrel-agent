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


### Deleted source journals (2026-11-02)

The transfer audit reproduced a stale-evidence replay: deleting a connected
source event cleared its visible tool receipt but left completed and pending
idempotency results able to return its former content. Deletion now reconciles
both journals in the same database transaction, and read/write codecs enforce
the existing source-receipt tombstone so a late producer cannot restore the
content. Startup also reconciles legacy plaintext and protected cache entries.
Unknown metadata and unrelated generic JSON remain unchanged.

The real on-disk regression failed before the fix and passes afterward. It
covers ordinary reads, completed-claim replay, pending claims, late writes,
legacy entries on reopen, and decrypted logical cache rows. This is logical
redaction under the existing encryption policy; it does not claim secure
erasure from old pages, WAL copies or backups. The full suite passed **2,082
tests / 272 files**, workspace typechecking and the full native build passed.

Bundle `35dea182d156ebf852e12d92b29f6af524742a4d4057d36cf9e9e6f98037169a`
passed the 16-phase native settings/window/restart canary, with equal before/
after digests: `.tmp/native-deleted-source-settings-evidence/receipt.json`.
That GUI flow used a new disposable profile and no desktop capture/input; the
on-disk source deletion test used generated database fixtures. Existing user
data, canonical installation and provider logins were untouched. The partial
host profile-transfer primitive remains unintegrated and is not release proof.


### Host-only Core database transfer primitives (2026-11-02)

The database now has host-only semantic export/import primitives for the exact
migration-001-through-018 schema. They run in memory, expose no renderer/Core
request, export no database key and write no plaintext snapshot file. Source
reads use one consistent read transaction; import requires an empty destination
and commits only after foreign-key/integrity checks and semantic readback.
Unknown tables/schema objects, corrupt envelopes, inconsistent indexed payload
metadata, invalid checksums, over-limit input and nonempty targets fail closed.
The current primitive is bounded to 64 MiB and 100,000 total source rows,
including indexes; it rejects excess data without truncation. Large-profile
streaming remains required before this can serve every real profile.

The generated-fixture tests cover all 28 encrypted field families with an
independent destination key and ordinary database readers. Literal non-tool
JSON and unknown tool metadata survive. Runtime and timeline search terms are
rewrapped only if retained in the source, including partial exclusions;
unkeyed timeline links are copied rather than regenerated. Forgotten workspace
documents retain their deletion markers without confusing the newer SQL
version with their older encrypted payload. Source evidence deletion fences
remain effective against late receipt/cache writes after transfer.

Operational claims are excluded. Live runs, active working tasks and leased
jobs are cancelled; live tool records and cached results become cancelled or
uncertain. Unexecuted recommendation approvals lose execution authority, and
unsettled action receipts are reconciled while settled historical evidence is
preserved. These explicit policy changes are counted in the snapshot report.
The source remains unchanged, including active statuses; one test compares its
complete generated SQLite serialization before and after export.

All **53 focused database tests in two files**, including 22 transfer cases,
and database typechecking passed before integration. Recomputed-checksum
attacks against payload/index bindings, source corruption, wrong keys, partial
search-index suppression, nullable/forgotten documents, lifecycle retirement,
row bounds and atomic rollback are exercised. Only generated in-memory or
temporary fixtures were used. No real profile, Keychain item, provider login,
credential or canonical app was read, moved or changed by this work.

This is a database primitive, not a complete profile migration or a cutover
claim. The user-reviewed dry-run/apply/rollback flow, bounded transport for
large profiles, browser data import and protected credential handling or
reauthentication still need implementation and live acceptance. Existing
profiles must not be copied, merged or replaced implicitly. The native
Keychain identity must be allocated for its stable final profile path before
any approved staging/import; renaming a temporary profile changes its account.


Integrated validation passed **2,104 tests in 273 files**, workspace
typechecking and the full native build. The final review preserves prior run/
tool/job diagnostics, recommendation policy text, task progress summaries and
opaque job metadata when retiring live state.
Bundle `b1d941107d073c16ba9b240d1bf7299715748fc5b6f5d7e76e62ecb156840a35`
passed all 16 native settings/window/restart phases, with unchanged before/
after digest (`.tmp/native-profile-transfer-settings-evidence/receipt.json`).
The bundled Core durability/recovery smoke also passed
(`.tmp/native-profile-transfer-core-durability.log`), using an in-memory fake
host-key broker. This is not new real-Keychain or desktop-input evidence. The
public test-profile Settings capture was inspected visually. Both runtime
checks used generated profiles and left the canonical app unchanged.

The [official uBO Lite Store listing](https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh)
was rechecked on November 2: it still lists version `2026.1026.1812`, updated
October 27. The earlier `no_update` result therefore still lacks a real
published-version upgrade. Future update acceptance should retain a generated
Store-installed test profile for an actual later release instead of always
starting with the newest version and deleting that profile immediately.

### Native legacy Core key compatibility (2026-11-02)

The Chromium host now compiles a narrow, decryption-only adapter for Kestrel's
historical macOS database-key envelope. It accepts the broker's wrapped or bare
`v10` format and a canonical 32-byte key; development plaintext requires an
explicit development-transfer choice. Unknown formats, bad padding, malformed
base64, missing passwords and wrong keys fail closed. Owned intermediate
buffers are cleared. Legacy CBC has no authentication, so a caller must also
authenticate source database records before accepting the recovered key.

Compatibility parameters and the fixed `Kestrel Safe Storage` / `Kestrel`
service/account come from the pinned [Electron app-name configuration](https://github.com/electron/electron/blob/v43.8.1/shell/browser/electron_browser_main_parts.cc)
and [Chromium macOS key provider](https://chromium.googlesource.com/chromium/src/+/150.0.7871.250/components/os_crypt/async/browser/keychain_key_provider.mm),
with ciphertext framing from the [Chromium encryptor](https://chromium.googlesource.com/chromium/src/+/150.0.7871.250/components/os_crypt/async/common/encryptor.cc).
The adapter does not implement weak-key or missing-item creation fallbacks.
Its read-only Keychain backend uses a fixed-purpose interface and explicit
noninteractive/user-prompt policy. It cannot enumerate another product's
items, create keys, rewrite the source key file or authorize a migration.
There is no renderer/Core RPC or startup invocation of this adapter yet.

All **23 native compatibility tests** compile the production C++/Objective-C++
with warnings treated as errors and use generated inputs and a fake reader.
They cover canonical and corrupt envelopes, denied development plaintext,
locked/missing/failing readers, explicit prompt propagation and output clearing.
One test creates the actual CredentialBroker envelope, decodes it natively,
authenticates a generated encrypted message through a read-only SQLite handle,
and semantically transfers it under an independent destination key. The source
database and key file remain byte-for-byte unchanged. Decoded fixture keys use
an anonymous test pipe, never stdout/stderr. The real Keychain was not queried.
The normal writable database constructor and broker key getter must not be used
to inspect an existing source during a dry-run because they can migrate it.

Integrated validation passed **2,127 tests in 274 files**, workspace
typechecking and the full native build. Bundle
`da335ab1e363c1b11e01754ae151b4b485fc612844932a128125319bf9415622`
passed all 16 native settings/window/restart phases with unchanged before/after
digest (`.tmp/native-legacy-key-settings-evidence/receipt.json`). Bundled Core
durability/recovery also passed with an in-memory fake host-key broker
(`.tmp/native-legacy-key-core-durability.log`). The public Settings capture was
visually inspected, including corrected approval guidance. These checks used
generated profiles; no capture/input enablement, real-profile transfer,
canonical refresh or new real-Keychain acceptance is claimed. The preceding
head `e9a5aca1920664037da8088e3ef563e07d7f881e` passed both CI runs
`41459957228` and `41459944161`; later heads require their own CI result.

This removes an Electron dependency from a future migration implementation,
but does not complete migration. Read-only legacy source projection must also
enforce deletion fences without startup rewrites, and the reviewed dry-run,
apply, rollback, large-profile, browser and credential paths remain required.

### Read-only legacy deletion projection (2026-11-02)

Two generated on-disk regressions reproduced deleted source text surviving in
an older profile's raw JSON and encrypted journals despite an existing deletion
fence. Export now applies a shared pure redaction codec in memory after source
row/index validation. It removes stale receipt outputs, completed-cache results,
explicitly linked messages and the same legacy unlinked assistant fallback used
by source deletion, then clears affected search eligibility before rewrapping.
Unrelated results, generic JSON, opaque metadata and messages with explicit
unrelated provenance remain intact. No source startup migration is invoked.

Both tests fail before the fix and pass afterward using a read-only SQLite
handle, ordinary destination readers, decrypted destination journal inspection
and byte-for-byte unchanged source files. They cover version-1 raw and
version-2 structured message bodies. All **2,129 tests in 275 files**, workspace
typechecking and the full native build passed. Bundle
`06e3babd66a2d540ca8527ce7ea4e8a4ca67ec304fc1b9d24a1b25761bc1fae4`
passed all 16 native settings/window/restart phases with unchanged digests
(`.tmp/native-readonly-deletion-settings-evidence/receipt.json`), and bundled
Core durability/recovery passed with the fake host-key broker. Generated
fixtures only; the canonical app and real user data remain untouched.

### Retained official Store update fixture (2026-11-02)

The desktop canary can now explicitly retain its generated Store-installed
profile after a clean shutdown and unchanged bundle digest. Use a new evidence
directory for each preparation run; a nonempty directory is rejected before
launch, so an existing checkpoint/receipt cannot be overwritten:

```sh
KESTREL_NATIVE_TEST_APP=.tmp/native-chromium-host/Kestrel.app \
KESTREL_TEST_REAL_CHROME_WEB_STORE=1 \
KESTREL_TEST_KEEP_STORE_UPDATE_PROFILE=1 \
KESTREL_NATIVE_DESKTOP_EVIDENCE=.tmp/new-store-update-evidence \
node scripts/smoke-chromium-desktop.mjs
```

Retention is a fixture-preparation mode, separate from strict extension
acceptance. Every non-update capability must pass, and Chromium management
must report both official IDs as enabled `normal` installations with matching
restart versions. The profile stays under the OS temporary root with its
owned/private directory, fixed marker and mode-0600 test-key checks. Only
metadata is inspected; the key is not read by the checkpoint helpers. Failed
runs still remove their generated profile. The default remains cleanup.

The checkpoint binds the unchanged candidate, exact receipt SHA-256, original
Store provenance and observed versions. `loadRetainedStoreUpdateFixture()`
revalidates the actual directory, marker and key metadata, receipt digest and
versions. A stale saved path is not a live process or verified external wait;
the OS may remove temporary files. This does not weaken the native test-key
guard or satisfy the real-update retirement gate.

The live preparation run on bundle
`06e3babd66a2d540ca8527ce7ea4e8a4ca67ec304fc1b9d24a1b25761bc1fae4`
passed 17 phases. Both aggregate extension-parity phases remain incomplete
solely because Chromium returned `no_update` for uBO Lite `2026.1026.1812`.
Official JSON Formatter `0.10.2` and uBO Lite were installed through their
native Store sheets; functional formatting, same-window extension tab
lifecycle, isolated toolbar popup, disable/re-enable and enabled restart
persistence passed. The popup capture was visually inspected. All owned
processes stopped cleanly. No whole-desktop capture/input was enabled.

Local evidence is `.tmp/native-store-update-fixture-evidence/receipt.json`
with sibling `store-update-checkpoint.json`; the earlier Store receipt remains
untouched. The generated profile was revalidated after shutdown and after a
refused attempt to reuse its evidence directory. All **2,145 tests in 276
files** passed, including 18 fixture/marker tests covering incomplete checks,
strict acceptance, candidate drift, unpacked provenance, missing shutdown,
receipt changes, private-key metadata and a removed temporary profile.
This proves preparation/persistence, not an actual published-version upgrade.

### Offline Core file transfer and protected Node worker (2026-11-02)

The host-only Core transfer now has read-only planning, offline file apply and
read-only recovery verification. Plans contain paths, file/directory identity,
counts, explicit lifecycle exclusions and a consistency digest; no key or
decrypted content is returned. The source must have an authenticated encrypted
record, so a legacy CBC-decoded key is never accepted solely from valid base64.
An empty source uses a separate fresh-profile decision. Source schema/aggregate
limits are checked before integrity scans, and foreign-key validation reads
only its first violation rather than materializing an unbounded error list.

Apply requires the exact reviewed plan and an independent destination key.
It rechecks source identity/content and destination identity, acquires an
exclusive transfer lock, initializes a private staging database, semantically
rewraps and verifies its data, closes and synchronizes it, then publishes the
final filename through a no-replace hard link in the same directory. Existing
databases, SQLite side files, recovery locks, linked sources and nonprivate
directories are refused. Successful cleanup leaves one mode-0600 database with
one filesystem link. Source files are never opened through the writable
Kestrel database constructor, migrated or replaced.

Failures before publication preserve the source and any destination that
appeared concurrently. Failures after publication explicitly report a committed
recovery condition and retain the destination. Cleanup failures have their own
bounded outcome. A process crash can still leave encrypted staging/lock files
requiring explicit recovery; automatic crash adoption/cleanup is not exposed.
Recovery verification authenticates both Core files and checks the original
semantic digest. It refuses changed native data and never deletes later work.
It does not switch applications or activate a profile. The source must be
quiesced by the product before final cutover; a read-only snapshot cannot stop
an unrelated process from writing after verification.

The standalone Node build also packages `host-profile-file-transfer.js`.
Its dedicated anonymous pipes support content-free preview, single-use apply,
cancel and read-only recovery checks. Frames are bounded to 64 KiB and output
backpressure pauses input. Keys travel only over the private pipe, remain in
owned buffers, expire with the pending review/recovery and are cleared on
cancel, replacement, consumed-apply failure, EOF or shutdown. The worker accepts no keys in
argv/env, discovers no profiles, opens no network listener and is registered
with no renderer, model tool, Core RPC or extension API. A plan digest or
`approved` JSON field is not a user-authorization boundary: the future native
caller must hold the plan privately and obtain the person's explicit consent.

All **27 focused tests** passed: 18 file/apply/failure tests and nine worker
lifecycle cases. Fault injection exercises a publication collision, failure
before publication, directory synchronization failure after publication,
staging cleanup failure and a source write during verification. Other cases
cover wrong keys, replaced files, invalid/tampered reviews, expiry, cancellation,
private-worker isolation, replay refusal and preservation of later native work.
Only generated private temporary files and keys were used.

Integrated validation passed **2,172 tests in 279 files**, workspace typechecking
and the full native build. Final bundle
`ca863aac40e292d7ac16fbc3cb71db65371c088213bdf332efbfb3b8a87cf1fb`
passed seven packaged transfer-worker phases over its actual bundled Node
executable, including ordinary destination readers, source byte equality,
both-file recovery, later-work preservation and oversized-frame refusal without
input echo (`.tmp/native-core-file-transfer-current-evidence/receipt.json`).
The same bundle passed all 16 native Settings/window/restart phases with equal
before/after digests
(`.tmp/native-core-file-transfer-current-settings-evidence/receipt.json`) and
bundled Core durability/recovery with the fake host-key broker
(`.tmp/native-core-file-transfer-current-durability.log`). The preceding published
head `7503645ccac863972c0c1c2eb7fa4d37f436fe2e` passed full CI `41468336106`
and PR analysis `41468328751`; the new head needs its own CI result.

This completes a packaged Core file-transfer layer, not the user-facing
migration or rollback flow. The native UI/host launcher, legacy Keychain adapter
connection, stable final-profile key allocation, crash-recovery adoption,
large-profile streaming, older schema handling, browser/credential handling,
application/profile activation and user-reviewed cutover still need completion.
No real profile, Keychain item, credential, vendor login or canonical app was
read or changed; no whole-desktop capture/input was enabled by these checks.

### Reviewed recovery after an interrupted Core import (2026-11-02)

Offline apply now writes a paired private lock and immutable journal before
writing imported records. The journal records the reviewed plan, original
worker PID, unique run ID and exact staging-directory/database identities; the
lock binds its SHA-256. Both are bounded metadata files with mode 0600 inside
the private destination directory. They contain no database keys or decrypted
records. Committed/cleanup errors retain their recovery metadata instead of
discarding the information needed after process death.

The protected Node worker can inspect that journal without keys or database
reads, then hold an expiring opaque recovery review for explicit acceptance.
Recovery refuses a live original owner, mismatched metadata, replaced paths,
unknown staging files, wrong keys, changed source data and later native work.
A separate exclusive reservation prevents overlapping recovery workers. Normal
file APIs still reject hard links; the recovery lane accepts exactly the
journal-bound staged/published pair, authenticates its contents and removes
only its redundant staging link. It can finish a verified stage before
publication, a published two-link database, or finalization after the staging
link was already removed. It returns the same read-only both-file verification
receipt and never activates a profile or deletes the published database.

The new tests kill actual generated Node subprocesses at those three boundaries,
and also immediately after journal persistence. An actual live worker is held
at publication to prove a second worker cannot steal its reservation. Other
cases cover journal-only finalization, tampered metadata/permissions, changed
source data, replaced destinations, wrong keys, single-use private-worker
acceptance and preservation of later native work. Test-only preload code
instruments only the generated destination and kills only its own process;
no crash flag or bypass is added to the production worker.

All **2,191 tests in 280 files**, workspace typechecking and the full native
build passed. The 46 focused cases across four files include 17 subprocess
recovery scenarios and explicit preservation of pre-existing journal/recovery
reservation files.

Bundle `95b3c8d071a9055daaf3044a9d76646ed7eee8d1417af0949de54ef24f7eda5b`
passed all five packaged recovery phases using its actual bundled Node
executable, seven normal transfer phases, all 16 Settings/window/restart phases
and bundled Core durability/recovery with the fake host-key broker. The three
receipts have unchanged before/after digests:
`.tmp/native-interrupted-transfer-recovery-evidence/receipt.json`,
`.tmp/native-interrupted-transfer-apply-evidence/receipt.json` and
`.tmp/native-interrupted-transfer-settings-evidence/receipt.json`.
Only generated temporary Core files and in-memory host keys were used. No real
profile, Keychain, credential, vendor login, canonical installation or desktop
capture/input enablement was involved.

Incomplete/corrupt stages and abandoned recovery-worker reservations are
preserved for a separate review. They are not automatically deleted or adopted.
Explicit cancellation/archive handling and recovery of that second reservation
remain required alongside the native migration UI/launcher, profile activation,
large-profile and credential/browser paths. The preceding head
`607bb22f29ce8e704c8cfded3e48ba943adaed14` passed full CI `41474489827`
and PR analysis `41474480600`; the new head requires its own CI result. This
is interrupted Core import infrastructure, not completed migration or release
acceptance.

### Native conversation transfer and data profile selection (2026-11-02)

The Chromium desktop now exposes **Kestrel → Transfer Conversations & Memory…**
and **Use Previous Data Profile…** in its native application menu. A native folder
picker selects the source explicitly. Its selected path uses `realpath`, avoiding
macOS Foundation shortening `/private/var` into the noncanonical `/var` alias.
Stored selection metadata and internal source directories still reject links.
After a separate read-only review consent,
the fixed-purpose legacy key reader unlocks the selected Core database on a worker
queue. Keys travel only over the bundled transfer worker's anonymous private
pipes; there is no new renderer, Core RPC, tool or user-extension entry point.

The review shows conversation, message, memory and timeline counts plus active
tasks, approvals and scheduled jobs that will be retired. Apply stays disabled
until the person confirms that the source Kestrel instance is closed. Policy
`kestrel-host-profile-transfer-in-flight-v2` also cancels pending, running and
approval-waiting scheduled jobs, preserving their definitions and diagnostics
without retaining authority to execute after import. Browser data, saved
credentials, provider setup files and workspace grants are outside this flow.

A new private destination gets a stable final path and its protected native key
before Core directories are created. Verified publication and both-file recovery
verification precede activation. The browser profile's bounded private
`native-core-profile.json` selects a child beneath `native-core-profiles/UUID`;
the running Core stays bound to its launch profile until normal app restart.
The broker accepts only the owning browser profile or its private native child.
Switching to the previous data profile swaps that selection and preserves the
source, imported profile and later native work. It does not replace the installed
application or undo browser changes.

Selection writes use a private staged file, file sync, atomic rename and directory
sync. A pre-commit failure preserves the old selection. A directory-sync failure
after rename reports that the selection was made but final durability could not
be confirmed. It does not claim that activation remained unchanged. Generated
native tests compile the actual storage/controller module with fixture-only sync
failures and cover safe resolution, links, metadata permissions, changed reviews,
selection/restore and both sync failure boundaries.

The new `test:native-profile-transfer-ui` canary creates only marked OS-temporary
source/browser profiles. Its native test mode refuses a real profile or Keychain
password request. The canary exercises the real picker, review, acceptance,
restart, imported conversation and previous-profile UI, then checks source-byte
preservation, cancelled schedule authority and retained later native work. Its
live acceptance result must be recorded separately; the code alone is not proof
that those UI phases passed.

All **2,207 tests in 281 files**, workspace typechecking and the full native
build passed locally. Bundle
`c2f8826414d91ab8516b64f4d270ee2ac2a50dc76c7fc646621cbc0dba5c434f`
passed seven packaged transfer-worker phases, five process-crash recovery phases,
all 16 native Settings/window/restart phases and bundled Core durability/recovery
with the in-memory host-key broker. Candidate digests were unchanged in all
three receipts: `.tmp/native-profile-ui-final-file-transfer-evidence/receipt.json`,
`.tmp/native-profile-ui-final-recovery-evidence/receipt.json` and
`.tmp/native-profile-ui-final-settings-evidence/receipt.json`. The public Settings
capture was visually inspected. These use generated temporary data and do not
exercise the new native transfer menu. These precede the live-test path fix.

The native picker then reproduced and safely rejected a valid OS-temporary
source because Cocoa had shortened its canonical path. The corrected module
passed **2,212 tests in 281 files**, including 20 native source/selection cases
covering both path spellings, explicit folder aliases and rejection of linked or
readable-by-other-users source data directories. The complete native build passed.

Corrected bundle
`1533c596a3564b0d70893f29b96245edaf5d5f4f49f15b58c866cc441c8a16e1`
passed all five live native transfer/switch-back phases. The actual menu, picker,
development-source consent, counts and initially disabled Apply control were
inspected. Applying the reviewed generated source, restarting Kestrel and opening
its imported conversation displayed the generated message. After creating new
work in the imported profile, the native previous-profile confirmation and a
second clean restart restored the original conversation. The inactive imported
database retained the newer work; its inherited scheduled job was cancelled;
source database/key bytes were unchanged. Both conversation captures were visually
inspected. The receipt is
`.tmp/native-profile-transfer-ui-canonical-evidence/receipt.json`.

The same corrected bundle also passed seven packaged transfer phases, five
process-crash recovery phases, all 16 native Settings/window/restart phases and
bundled Core durability/recovery. The three additional receipts are
`.tmp/native-profile-canonical-file-transfer-evidence/receipt.json`,
`.tmp/native-profile-canonical-recovery-evidence/receipt.json` and
`.tmp/native-profile-canonical-settings-evidence/receipt.json`. All four receipts
have unchanged before/after candidate digests. This is generated-data native UI
acceptance, with test keys and no real Keychain, existing profile, credential,
provider login, desktop capture/input enablement or canonical app modification.

The aggregate `verify` command passed dependency/security audits, typechecking,
unit tests, build, native extension checks, the browser benchmark, website E2E
and initial desktop checks, then stopped at the Electron tab-hover preview
assertion. Its focused recheck passed on the unlocked Mac, and every remaining
aggregate command passed when resumed from that checkpoint, including browser,
autofill, onboarding, recovery, approvals, policy, packaged CLI and production
secret scanning. The original aggregate invocation remains recorded as failed.
Logs are `.tmp/native-profile-ui-aggregate-pinned-verify.log`,
`.tmp/native-profile-ui-tab-hover-recheck.log` and
`.tmp/native-profile-ui-verify-remainder.log`. Test-generated tracked screenshots
were preserved under `.tmp/native-profile-ui-aggregate-screenshots` and their
tracked baseline copies restored.

Incomplete-stage archive/cancellation and abandoned recovery reservation handling
remain unfinished. So do large-profile streaming, older schemas, browser and
credential handling, provider sign-in parity, final enabled-control/restart
acceptance, production signing/notarization and canonical installed-app cutover.
The existing app, real profiles, credentials and provider logins remain untouched.

### Resume a retained official Store update fixture (2026-11-02)

`test:native-store-update-resume` revalidates the existing generated checkpoint,
original receipt digest, private temporary profile and normal Store provenance.
It refuses the canonical app, an occupied evidence directory or an already-used
profile. Before launch it reads only the generated Chrome preference metadata to
establish the active installed versions. It then runs the exact selected native
candidate with the existing test key, without reinstalling extensions, changing
versions, toggling enablement or replacing the original checkpoint.

The canary binds directly to browser-reported CDP targets, avoiding CEF's race
between loaded documents and Playwright automatic attachment. It exercises the
official action extension's own tabs/runtime APIs from its existing options
document, allowing its MV3 background worker to suspend normally.
Restart formatting uses Kestrel's first-party tab API and does not require an
unrelated background worker to remain active. Both contexts keep ordinary user
extensions and web pages isolated from Kestrel's privileged bridge.

```bash
KESTREL_NATIVE_TEST_APP=/absolute/path/to/Kestrel.app \
KESTREL_NATIVE_STORE_UPDATE_CHECKPOINT=/absolute/path/to/generated/store-update-checkpoint.json \
KESTREL_NATIVE_STORE_RESUME_EVIDENCE=/absolute/path/to/new-evidence \
pnpm_config_verify_deps_before_run=false corepack pnpm test:native-store-update-resume
```

Set `KESTREL_NATIVE_STORE_COMPATIBILITY_ONLY=1` to exercise retained official
installations without issuing another Store update query. This still checks
extension functionality, native same-window tab adoption, bridge isolation and
restart persistence. Its receipt records the skipped query and always remains
`incomplete` with exit code 2, even if a version change happens automatically.
It cannot certify upgrade acceptance. Omit the flag for the normal update flow.

Bundle `1533c596a3564b0d70893f29b96245edaf5d5f4f49f15b58c866cc441c8a16e1`
passed all five compatibility phases against the retained Store profile from
bundle `06e3babd66a2d540ca8527ce7ea4e8a4ca67ec304fc1b9d24a1b25761bc1fae4`.
JSON Formatter `0.10.2` and uBO Lite `2026.1026.1812` remained enabled normal
Store installations. A tab created by the official uBO Lite extension stayed in
Kestrel's native window, JSON formatting ran with no privileged web bridge, and
formatting, both installed versions and both existing Core sessions survived a
clean restart. The post-restart formatted JSON capture was visually inspected.
The candidate digest was unchanged in
`.tmp/native-store-resume-final-options-evidence/receipt.json`. The earlier
direct-target worker run also passed the same compatibility phases in
`.tmp/native-store-resume-bound-target-evidence/receipt.json`. Admission checks
also rejected a missing candidate, the canonical app and occupied evidence before
profile launch, preserving existing evidence.

Chrome's update query succeeded with `no_update`; no installed version increased.
The receipt therefore reports `incomplete` and exits **2**, preserving the fixture
for a future published update. Exit **0** requires a genuinely increased normal
Store version plus the compatibility checks; an unsuccessful query or failed
compatibility phase exits **1**. This additional receipt does not replace or relax
the strict retirement validator, and it does not certify a fresh Store install
on this candidate, existing user data, signing or canonical cutover.

### Keep an interrupted preparation and retry separately (2026-11-02)

A failed plan/apply/activation now offers **Keep Files & Start Again**, **Show
Prepared Folder** and **Cancel**. Keeping files confirms that Kestrel's private
transfer worker stopped, preserves the old preparation at its existing canonical
path and opens a new source picker. The next review allocates a separate stable
destination and requires source closure and Apply acceptance again. An active or
previously selected data profile cannot be discarded through this path. The old
files, SQLite recovery metadata and profile key identity remain available for
later review; this action does not move or delete them.

The native host retains an unconfirmed worker instead of dropping its task
handle or starting another transfer. Shutdown checks the launched child's parent
and kernel start time before signalling it, waits for termination and uses a
bounded forced-stop fallback for that same child. Identity mismatch refuses the
signal. Verified imports are selected only after worker termination is confirmed.
Protected pipe deadlines use a monotonic clock. No new renderer, Core, extension
or tool route is added.

The actual native module passed **23 focused cases**, including real subprocess
checks for normal termination, a paused child that ignores termination and a
mismatched start time that must remain unsignalled until fixture cleanup.
All **2,215 tests in 281 files** and the full native build passed.

Bundle `ebde540cfe45b746f71832418c51e873296ba81720ad06dadffacb2058958ba9`
passed eight live preservation/retry phases in
`.tmp/native-transfer-preserved-retry-ui-evidence/receipt.json`. After the first
native review, a test-only preload killed a separate bundled Node transfer worker
immediately before publication, leaving a real encrypted stage and paired
journal/lock in the prepared destination. The app refused to overwrite it at
apply and again during a subsequent review. The native Keep Files action opened
a fresh picker, and the second accepted transfer used a different destination.
The imported conversation appeared after restart; switching back restored the
original conversation and retained later work in the imported profile. The source
database/key bytes, every interrupted database-directory file and its independent
test key were unchanged. A new read-only private-worker inspection still
recognized that original stage for recovery. Both conversation captures were
visually inspected.

The same bundle passed seven packaged transfer phases, five forced-process-death
recovery phases, all 16 native Settings/window/restart phases and bundled Core
durability/recovery. Receipts are
`.tmp/native-transfer-preserved-retry-file-evidence/receipt.json`,
`.tmp/native-transfer-preserved-retry-recovery-evidence/receipt.json` and
`.tmp/native-transfer-preserved-retry-settings-evidence/receipt.json`. All four
receipts have unchanged before/after candidate digests. The test-only crash
preload and new retry mode belong only to the generated fixture; the app has no
crash flag or approval bypass. No real profile, Keychain, credential, vendor login,
canonical app or desktop capture/input permission was changed.

Run the interactive retry test with `KESTREL_TEST_NATIVE_TRANSFER_RETRY=1` alongside
the exact `KESTREL_NATIVE_TEST_APP` and a fresh
`KESTREL_NATIVE_PROFILE_UI_EVIDENCE` directory when invoking
`test:native-profile-transfer-ui`. Ordinary mode retains the original five-phase
workflow. Prepared-profile management and in-place archive/adoption of incomplete
stages or abandoned recovery reservations remain unfinished, along with the
other existing-profile, browser/credential, signing and canonical-cutover gates.

### Native microphone permission and capture lifetime (2026-11-02)

Home and Agent voice capture now use the native macOS microphone authorization
route. The app carries a microphone purpose string and audio-input entitlement.
CEF admits audio-only requests from the owned top-level Kestrel document only
after macOS authorization; other origins retain Chromium's existing permission
handling. The owned document cannot use this path for camera, mixed media or
screen capture. Permission transport budgets allow time for the human prompt.

A shared capture owner prevents concurrent starts, invalidates pending permission
and stream acquisition when the composer closes, and immediately stops a stream
that arrives after cancellation. Agent capture and transcription are scoped to
the selected conversation. Both composers display a requesting state and keep
their microphone button disabled while permission is pending. Closing or changing
the conversation cancels pending capture and prevents a not-yet-dispatched
recording from being sent for transcription. Late transcription results cannot
change the new conversation's draft.

The native build and **2,225 tests in 283 files**, workspace typechecking and two
native system/policy fixtures passed. The policy fixture covers authorized audio,
denied OS authorization, child frames, other documents, camera, screen and mixed
requests. Bundle
`689a29cb4990d6ebfa5dbc537dd825c857a2d175be361ecebbff7145760862e2`
passed five bundled UI cancellation/screenshot phases in
`.tmp/native-voice-mock-remount-evidence/receipt.json`: both Home unmount and real
Agent session switching were exercised with deferred permission and deferred
media. No recorder started and no transcription was dispatched in those cases.
These fixtures mock only their own first-party document; they do not authorize
the operating system or enable real recording.

With explicit user approval, the same bundle passed the six-phase test in
`.tmp/native-voice-approved-capture-evidence/receipt.json`. Its unmocked native
permission route and Chromium media APIs recorded one second, produced 12,568
bytes and ended every audio track. Audio remained in page memory and was
discarded; it was not saved or submitted for transcription. This proves native
capture, not speech recognition or a provider's transcription service. The same
bundle passed all 16 native Settings/window/restart phases in
`.tmp/native-voice-final-settings-evidence/receipt.json`. Candidate digests were
unchanged before and after each run. A separate generated-profile layout check
found no settled widget overlaps after conversation selection or resizing, and
the actual native Home/chat window was inspected on the unlocked Mac. The
installed canonical app remains the previous Electron build.

The complete `corepack pnpm verify` command also passed on this source with the
native candidate explicitly pinned. This includes repository audits, production
dependency audit, typechecking, unit tests, build, native extension checks, browser
benchmark, website E2E, desktop setup/browser/autofill/recovery/approval workflows,
packaged CLI, editor integrations and the production secret scan. Its log is
`.tmp/native-voice-aggregate-verify.log`. Generated tracked screenshots were
preserved separately before restoring their known pre-check copies.

Run `test:native-voice` with the exact noncanonical `KESTREL_NATIVE_TEST_APP` and
a fresh `KESTREL_NATIVE_VOICE_EVIDENCE` directory for the default mocked checks.
CI runs this default mode. Only after specific user approval, set
`KESTREL_TEST_NATIVE_MICROPHONE_CAPTURE=1` to add the one-second real capture;
macOS security prompts must be handled directly by the person. That approval
does not authorize additional recordings or transcription.

The harness also terminates its owned candidate immediately when interrupted,
including while an evaluation or permission promise is pending. Its non-recording
interruption fixture exited with the expected failure code and `INTERRUPTED`
receipt, left no candidate process, and preserved the candidate digest. Evidence
is `.tmp/native-voice-interrupted-evidence/receipt.json`; that deliberate failed
receipt is not counted as a successful capture run.

Onboarding now describes a successful provider probe as a route check; only the
verified local-model path claims a real model response. Authentication status
and model inference remain distinct. The completion gate is unchanged.

CI run `41510928583` for the preceding `57465130` commit never started its desktop
job: GitHub could not acquire a hosted macOS arm64 runner. Its Core/website/security
job passed. Separately, CodeQL aggregation reported 16 annotations also present
on the two preceding inspected heads, despite successful analysis jobs; those
heads did not have fully green required checks. Three annotations concerned
fixtures added by this PR: role reflection into HTML/script and a hostname suffix
check. Fixture roles now come from a literal allowlist, malicious/duplicate roles
are rejected, and DuckDuckGo uses an exact or dot-boundary hostname check. The
focused attack cases pass; remote CodeQL must confirm the new result. The other
13 flagged lines predate the PR merge base; changed data flows were not audited
as part of this comparison. No security check or retirement gate was weakened.

### Bounded voice decoding and private-key redaction (2026-11-02)

Core now validates voice recordings with a canonical padded/unpadded base64
comparison, without the suffix expression that repeatedly rescanned malformed
padding. The decoded 25 MiB limit is checked before allocation. Invalid padding,
garbage, whitespace, URL-safe substitutions and noncanonical end bits are rejected
before transcription-provider dispatch; valid standard encodings preserve their
exact bytes.

Private-key redaction now advances through recognized markers once. Complete
blocks require matching labels. Nested, mismatched or unterminated blocks, and
recognizable private-key headers with missing closing dashes, redact the remainder
conservatively. ASCII whitespace variants are recognized; arbitrary prose and
incomplete PRIVATE/KEY words are outside that recognition policy. Memory capture
uses the shared redactor without a second full-block expression. Per-result token
deduplication and model-visible result limits remain enforced.

The full native build, workspace typechecking and **2,255 tests in 284 files**
passed. Regression cases include long malformed padding, the exact decoded-size
boundary, provider non-dispatch, 40,000 unmatched private-key markers, multiple
valid keys and malformed delimiters with trailing synthetic secrets. The complete
repository `verify` run recorded above passed at the preceding `9b7bd7af` source;
these later Core changes received the unit/type/build and bundled checks below.

Current bundle
`16649a22c19c91d9547cdc7294c9932b94cd72bf28a6d3e07078a018e7b57841`
passed all 26 native workflow phases in
`.tmp/native-core-input-guards-desktop-evidence/receipt.json`: actual Home-to-Core
tasks through a loopback synthetic provider, companion handoff, busy-task and draft
preservation, granted workspace operations and containment refusal, private-field
isolation, native browser input/downloads, Core crash recovery and full restart.
The completed companion conversation was visually inspected. The same bundle
passed all five mocked voice lifetime checks in
`.tmp/native-core-input-guards-voice-evidence/receipt.json`; its rendered Home/chat
capture was inspected. No additional microphone or whole-desktop capture/input
was authorized or performed.

A separate five-phase probe used the actual bundled Node executable, supervisor,
protected IPC and Core service. Only fetch was replaced with an in-memory synthetic
transcription response; every other fetch was refused. Valid padded/unpadded
inputs uploaded the exact four synthetic bytes. Five invalid requests, including
1,000,003 characters of malformed padding, caused no further provider calls. Core
still answered snapshots, redacted complete/nested malformed key content through
the real memory route, and retained the session and two redacted memories after
same-generated-key restart. Its receipt is
`.tmp/native-core-input-guards-probe-evidence/receipt.json`. An initial
assertion-only failure expecting decoder wording for an input rejected earlier by
the service schema is preserved separately. No product code changed for that
correction. All receipts show the unchanged candidate digest; the probe stopped
its owned processes and removed only its generated profile. This does not verify
a hosted transcription service or move any real profile or credentials.

At `9b7bd7af`, both the desktop/package and Core/website/security CI jobs passed.
CodeQL aggregation reported 14 annotations: two fixture findings cleared, while
the recovery-heartbeat fixture still embedded an encoded role in JavaScript.
That endpoint now serves one constant script for every admitted role and reads
the role from its URL at runtime. Both focused fixture tests pass, and all 26
native workflow phases passed again against the unchanged `16649a22` bundle in
`.tmp/native-core-input-guards-constant-pulse-evidence/receipt.json`. Remote CodeQL
must confirm the final result; successful analysis jobs alone do not clear its
aggregate findings.


## Native Knowledge recovery and picker ownership (2026-11-02)

The Memory page now exposes **Agent knowledge and recovery** for the selected
agent. Its existing scoped inspector and explicit restore preview are reachable
from the Memory view. These backups contain eligible standalone knowledge in
the same profile and scope; they do not transfer profiles, credentials, chats,
source history or browser state.

`NativeMemoryRecoveryHost` privately requests Core export/preview and handles
the selected file. Only native save/open operations are renderer-admitted;
direct renderer export/preview requests are rejected at both native ingress
layers. Ciphertext, keys and selected file paths do not return to the renderer.
The host bounds UTF-8 files at 16 MB, refuses final symlinks, hardlinks, changing
files and non-regular objects, and checks file/directory identity through held
handles. New backups use an exclusive 0600 file and file/directory sync. This
is an exclusive direct write, not atomic publication; failures after creation
preserve the incomplete file and report that outcome instead of deleting it.

Fixed-purpose NSSavePanel/NSOpenPanel operations travel over the private dialog
relay. Page ownership cancels both queued and sent recovery requests, closes
the Cocoa panel and ignores late selections. A shared worker predicate covers
plugin and recovery cancellation. A real page-close test caught a plugin-only
gate in the worker connection; the fixed build was tested again on screen.

The latest candidate is
`2fcb3499158dbcafe5269d5d676aef89372348e21fb4e0f2006b4a2ab4d5b360`.
It passed three real native picker/owner/restart phases in
`.tmp/native-knowledge-lifetime-fixed-evidence/receipt.json` and 24 broader native
workflow/window/restart phases in
`.tmp/native-knowledge-lifetime-fixed-workflow-evidence/receipt.json`.
The generated fact was scrolled into the viewport after restart and its capture
was inspected. Candidate digests matched before and after both runs.

The preceding candidate
`2d59a7a5a72f3794b08f13f923f2cadb8677cff1b53fcf382481c362209e1e16`
passed all nine generated-profile recovery phases: actual Cocoa save/open and
cancellation, private encrypted file, existing-record preview/cancel, wrong
scope and damaged-file refusal, explicit missing-record restoration preserving
existing records, and Core inspection after full app restart. Receipt:
`.tmp/native-knowledge-ui-final-evidence/receipt.json`. This was before the
worker cancellation fix; it is not substituted for the latest candidate's
owner-lifetime result. Two earlier harness failures (CEF attachment and exact
wrapped-label matching) and the interrupted failing owner test remain recorded.

The final source passed **2,306 tests in 287 files**, workspace typechecking,
focused host/relay/transport checks and a full native rebuild. The new aggregate
`pnpm verify` run passed audits, typechecks, unit/build/native checks, browser
benchmark, 50 website E2E cases and desktop checks through the file-icon guard,
then stopped at the Electron tab-hover preview assertion. A focused retry also
failed. macOS was subsequently confirmed locked; focus-dependent verification
is pending an unlocked run. The aggregate is not a pass. These tests
used marked generated profiles and test keys, with no real Keychain, existing
profile, microphone or desktop-input access. The canonical installed app has
not been replaced.

Routing prompt budget/list parsing, anchor punctuation trimming and bounded
routing metadata checks now avoid four confirmed polynomial scans. An
independent review found no semantic regression in those replacements. Store
test assertions compare the parsed URL origin rather than a hostname prefix.
Remote CodeQL at `1f3d618a` confirmed that the four polynomial-scan findings
and Store URL-prefix finding cleared. Five fingerprint/password-hash annotations
remain; all four language analyses passed. Core CI is still running and the
desktop job is queued. Packaged CLI, editor integration and the production
secret scan also passed separately after the aggregate stopped. The preceding
head’s Core CI passed and its desktop job was cancelled.

A subsequent source-only email-anchor fix replaces an adjacent polynomial
email scan while preserving its permissive matching grammar, Unicode folds,
word boundaries and partial-TLD continuation. The actual public API matched
the former expression on 50,000 deterministic mixed inputs; a separate prototype
covered 349,623 exact cases and every Unicode scalar. Final source passed
2,314 tests in 287 files, Core typechecking, standalone Core build and Node/Core
smoke. This later Core edit is not yet rebuilt into the native candidate above.

Remaining security work includes embedding fingerprints persisted outside
encrypted payloads, including stale asynchronous embedding writes. Those require a real remediation and migration, not a global
suppression. Native diagnostics/local-profile backup, other native integration
routes, existing-profile/vendor-login acceptance, actual Store version upgrade,
release signing/notarization and canonical cutover remain unfinished.


## Native diagnostic export and current validation (2026-11-02)

The native host now implements diagnostic export from Settings and Readiness
through a fixed-purpose Cocoa Save panel. Core gathers allowlisted app/runtime
metadata and readiness counts; the host writes a new 0600 JSON file. Only a
saved/cancelled result returns to the renderer. Report contents and file paths
stay in the private host. No Finder path or raw provider/error content is
forwarded. The existing Electron adapter remains compatible with the shared
host-neutral envelope builder.

Knowledge backups and diagnostics share the exclusive private-file writer.
It retains the existing final-symlink, identity, ownership, link-count, bounded
write, sync and abort checks. Incomplete files after creation are preserved and
reported honestly. Queued/sent file requests share page-owned cancellation
through worker, broker and Core. The fixed native dialog accepts JSON only;
caller-supplied report content, filename, path or configuration is not admitted.

Current ad-hoc candidate:
`ef5179289355a110e7bbdf7c970d839a2bd26b57c5701ba3e3c0e05cebd40d9f`.

- All four actual Cocoa/UI phases passed: cancel without a false success, save
  a private content-free file with a visible success notice, close the requesting
  Settings tab to dismiss its pending picker, and verify Settings/Core data after
  full restart. Receipt: `.tmp/native-diagnostic-ui-evidence/receipt.json`.
  The saved Settings capture and generated report were inspected.
- Six bundled Node/private Core phases passed with explicitly simulated picker
  replies and permission-status probes: file privacy/projection, cancellation,
  existing-destination refusal, final-symlink refusal, matched cancellation with
  late-selection rejection, and shutdown with no owned workers left. Receipt:
  `.tmp/native-diagnostic-bundled-evidence/receipt.json`. This is protocol proof,
  not an additional Cocoa test.
- Twenty-three broader native workflow/restart phases passed at the same digest:
  `.tmp/native-diagnostic-workflow-evidence/receipt.json`. All receipt digests
  matched, and the candidate digest was checked again after aggregate validation.
- **2,326 tests in 289 files**, workspace typechecking and the full native build
  passed. The new complete `pnpm verify` invocation also passed audits, production
  dependency audit, typechecks/units/build, native extension compatibility, browser
  benchmark, 50 website E2E cases, all desktop workflows, packaged CLI, editor
  integrations and the production secret scan. Log:
  `.tmp/native-diagnostic-aggregate-verify.log`. Strict extension retirement
  acceptance remains separate from these passing compatibility helpers.

The earlier aggregate stopped at tab-hover preview while macOS was locked. The
unchanged focused check passed once unlocked, and the new full run passed.
Eight known generated screenshot outputs were preserved under
`.tmp/native-diagnostic-aggregate-images-after/` before restoring their exact
pre-run baselines from `.tmp/native-knowledge-aggregate-images-before/`.

Remote CI at `c7dc3455` passed its desktop/package job but its Core unit job
skipped 23 profile-selection cases after the fixture compiler exceeded Vitest's
ten-second hook. The compiler already had a 30-second subprocess deadline. SDK
lookup is now bounded at five seconds and this one hook at 40 seconds; runtime
assertions and compiler bounds remain enforced. All 23 focused cases passed
after the change. New-head CI and the five remaining fingerprint findings must
still be resolved; no global timeout or security suppression was added.

All new execution used generated profiles and test keys. Chromium used its
development mock Keychain and Core used its disposable test-key route. There
was no new microphone capture, desktop control, real-profile transfer, provider
login movement or canonical installation. The new build also includes the
subsequent linear email-anchor change described above.

Remaining release scope is unchanged: embedding fingerprint privacy/stale-write
remediation; native local-profile backup and external-secret/Google Workspace
integrations; existing-profile and vendor-login acceptance; large/older-profile
and interrupted-preparation management; an observed published Store upgrade;
production identity/signing/notarization and the canonical Chromium cutover.
Developer ID credentials are unavailable, and `/Applications/Kestrel.app` remains
the existing Electron installation until the full cutover is proven.

## Transient redaction fingerprints (2026-11-02)

Tool-result redaction now uses a random 32-byte HMAC key for each operation,
shared across nested output and error values. Matching values retain the same
numbered placeholder within that operation, including matches across secret
kinds. Separate operations produce unrelated fingerprints. A `finally` block
clears the key buffer on success, truncation and exceptions; unavailable secure
randomness fails closed. This does not claim that all crypto-library memory is
erased or repair the separate persisted embedding fingerprints.

Validation passed 2,331 tests in 289 files, workspace typechecking and a full
native build. Candidate bundle SHA-256:
`1662b3e36098c611f2d10b66fcebf423e57dbd08e16d7b4a4ea5b1f20b780d6e`.
The same bundle passed 23 native workflow phases in
`.tmp/native-redaction-hmac-workflow-evidence/receipt.json`, and six bundled
Core phases in `.tmp/native-redaction-hmac-bundled-fixed-evidence/receipt.json`.
The latter checks repeated redactions and persistence across restarts using
generated fixture data; network transcription responses are simulated. Its
first attempt incorrectly expected numbered placeholders in stored memories,
which intentionally normalize assignments to `[redacted]`; the corrected
assertion passed without an implementation change. No new microphone capture,
real Keychain access or desktop control was performed. The full aggregate
verification pass remains the preceding diagnostic checkpoint above.

Exact-head CI at `96851b32` passed Core after the fixture-hook fix. Desktop CI
passed 49 of 50 browser benchmark workflows, failing session continuity on an
aborted navigation (`-3`). CodeQL still reported the five fingerprint findings
on that preceding commit. Neither current-head CI nor complete release
readiness is implied by these local passes.

## Coherent memory-job transitions (2026-11-02)

Claiming or completing a memory job previously updated SQL fields while leaving
the encrypted payload unchanged. Callers could receive `pending` and attempt
zero after acquiring a lease, and failure handling could skip a running job.
Claims, completion and retry/failure now persist both representations inside
their transaction. Expired leases and exhausted jobs are repaired in bounded
pages. Legacy reads validate unchanged identity fields and project validated
SQL transition metadata without rewriting source bytes; the next transition
repairs the payload. Explicit queue updates, including retry-policy changes,
retain their existing behavior.

Eleven new tests cover acquired state, reopen persistence, retry limits/due
times, more than two pages of expired leases, legacy read-only projection,
identity mismatch, malformed metadata and transaction rollback. All 2,342
tests in 290 files and workspace typechecking passed. The native rebuild passed
23 workflow phases with unchanged bundle digest
`16709dfc9493e7b87f877e0da6173e05f0787e33f3b121dd87edbe79c784754c`.
Receipt: `.tmp/native-memory-job-workflow-evidence/receipt.json`. The generated
provider companion conversation was visually inspected.

Seven actual bundled-Core probe phases passed in
`.tmp/native-memory-job-bundled-evidence/receipt.json`. The new phase runs real
maintenance, inspects all 12 generated jobs after Core stops, decrypts their
payloads using the fixture key and verifies SQL agreement, then verifies the
12 completed jobs retain their status and attempt counts after restart. Fetch
is simulated only for the preceding synthetic transcription phases; no real
microphone, external network, Keychain or user profile is involved. An initial
probe import failed before execution because the workspace root does not
directly depend on SQLite; resolving it through the database package corrected
the harness. All owned Core processes stopped and generated profile files were
removed. A final source-only cleanup restored unchanged queue/getter formatting.

This repairs job-state coherence, not stale-worker fencing or legacy profile
transfer projection. Those remain part of the embedding/privacy and versioned
transfer work; current transfer checksums and recovery policy were not changed.

## Browser benchmark login sequencing (2026-11-02)

The desktop CI failure at `96851b32` came from navigating onward while the
fixture's async login handler was still awaiting its state response. Corpus
1.1.1 (workflow revisions 2 for session continuity and logout) now observes the
authenticated account page before the next direct navigation. This adds a
completion check; it does not retry clicks, ignore aborted navigation or relax
billing/logout predicates. The corpus version and pinned digest changed
explicitly.

A controller-only test wrapper delayed the generated loopback login state
response by 250 ms. The prior workflow failed to reach authenticated billing;
both corrected workflows passed under the same delay. The unchanged full
benchmark then passed all 50 cases, and all 12 benchmark unit/fixture cases
passed. Reports: `.tmp/native-ci-delayed-login-before.json`,
`.tmp/native-ci-delayed-login-after.json`,
`.tmp/native-ci-login-full-benchmark.json`. This change affects benchmark data,
not app runtime code; the native bundle remains `16709dfc…`. Exact new-head
remote CI is still required.

## Memory-job lease authority (2026-11-02)

Every new claim now receives a fresh UUID stored only in its encrypted job
payload. Completion and failure require that exact claim token and an unexpired
lease. Reclaim, retry, exhaustion and completion clear retired authority. A
second connection can reclaim an expired job without allowing the previous
worker to complete or fail its replacement. Maintenance counts only successful
state transitions, and profile transfer clears the token while cancelling a
running job; the source remains unchanged. Legacy jobs without tokens retain
their read compatibility until a new claim supplies one.

All 2,343 tests in 290 files, workspace typechecking and the native rebuild
passed. New coverage exercises expiration, missing/wrong/old tokens and two
database connections; the transfer case checks source authority is preserved
and destination authority retired. Current bundle digest:
`214f83092cc0a765cb9a02436d4354cdc88b65b7f4636bbad3d58fe951807810`.
It passed 23 native workflow phases, seven actual bundled-Core phases
(including 12 completed maintenance jobs retained after restart), seven
packaged transfer phases and five process-death/recovery phases. Receipts:

- `.tmp/native-memory-job-fencing-workflow-complete-evidence/receipt.json`
- `.tmp/native-memory-job-fencing-bundled-evidence/receipt.json`
- `.tmp/native-memory-job-fencing-transfer-evidence/receipt.json`
- `.tmp/native-memory-job-fencing-transfer-recovery-evidence/receipt.json`

All four receipts retain the same before/after digest. The generated provider
conversation screenshot matches the previously inspected complete conversation.
A separate lifecycle attempt reached 20 passing phases but could not perform
the native last-window close because macOS was locked. It timed out and cleaned
up; its failed receipt remains under
`.tmp/native-memory-job-fencing-workflow-evidence/`. The complete 23-phase run
above did not request that lifecycle step. Unlock is pending; current-bundle
window-close/reopen proof is not claimed. The full aggregate pass remains the
earlier diagnostic checkpoint, and the canonical Electron app remains intact.

Job-status fencing does not yet guard the embedding write performed before
completion. Atomic owner-generation, eligibility and result-commit checks,
persisted fingerprint migration and versioned transfer recovery remain required.

Remote CodeQL still reported all five fingerprint findings on `e1e44fe0`,
including the HMAC site. Its
[sensitive-call heuristic](https://github.com/github/codeql/blob/main/javascript/ql/lib/semmle/javascript/security/SensitiveActions.qll#L25-L35)
classifies calls with password-like string arguments as producing password
data; these calls format public numbered redaction placeholders. This explains
the reported source, but does not declare the findings cleared or resolve the
separate persisted-content fingerprint issue. No query suppression or security
gate change has been added.

## Atomic embedding result guards (2026-11-02)

An embedding result previously wrote its vector before job completion checked
lease authority. Core now takes a private snapshot of the claimed job and its
owner before dispatch. The snapshot contains the canonical input text and the
encrypted owner row identity; it is neither persisted nor returned to the
renderer. Within one SQLite transaction, result application rechecks the job
token, lease, owner identity and input, then writes the vector, timeline owner
status and job completion together. Failure rolls back the transaction. A stale
input also prevents fallback-provider dispatch.

Fresh encryption IVs on normal owner writes distinguish same-clock edits,
A-to-B-to-A changes during a pending request, and deletion/recreation of the
same ID. This is deliberately conservative: even a metadata-only owner rewrite
can discard a pending result and require retry. It introduces no SQL migration,
new persistent owner state or transfer-checksum reinterpretation.

All 2,370 tests in 291 files, workspace typechecking and a native rebuild passed.
The new database cases cover all seven owner types, stale/expired claims,
unavailable results and rollback after an owner-write failure. Four actual Core
tests hold a provider request across an edit or delete/recreate and verify that
neither a result nor a fallback dispatch survives the changed input. Initial
fixture failures used an invalid timeline status and omitted foreign-key parent
records; correcting those fixtures left implementation assertions intact.

Current bundle digest:
`0268e2944d8206e4ab8351c04f92aa65cbc75d89d4dd2333ce0fab1caf6ed7f0`.
It passed 23 native workflow phases in
`.tmp/native-embedding-result-workflow-evidence/receipt.json`. The generated
completed provider conversation was visually inspected. Eight actual
bundled-Core phases passed in
`.tmp/native-embedding-result-validated-bundled-evidence/receipt.json`: all 12
generated maintenance jobs matched SQL/encrypted state and retained completion
after restart, and seven actual local vectors matched current owner text,
dimension and owner status. Only the separate synthetic transcription fetch
replies were simulated. Both receipts retain the same before/after digest; all
owned processes stopped and generated Core data was removed.

This guards result application during a request. Completed-job cache identity,
stable owner generations, invalidation of existing vectors after later writes,
transitive source-policy revocation/regrant, legacy fingerprint migration and
versioned transfer/recovery remain unfinished. The five remote CodeQL findings
are not declared cleared. Current native close/reopen acceptance still awaits
unlock, and the canonical Electron installation remains preserved.

## Current bundle verification and retained Store compatibility (2026-11-03)

Full `pnpm verify` passed against the published `cab99a65` application changes:
audits, production dependencies, types, all 2,370 tests, builds, native extension
compatibility helpers, browser benchmark, 50 website E2E cases, desktop flows,
packaged CLI, editor integration and production secret scanning. Strict
extension-retirement criteria remain separate from the compatibility helpers.
Log: `.tmp/native-embedding-result-aggregate-verify.log`. Eight generated tracked
screenshots were preserved under
`.tmp/native-embedding-result-aggregate-images-after/`, then restored to their
exact pre-run baselines from
`.tmp/native-embedding-result-aggregate-images-before/`.

The aggregate rebuilds the native host. Its resulting bundle digest differs
from the earlier `0268e294…` artifact:
`69dd83ca7e4bb5d9775fe5e92e921877a5d0257acc8dc45839f3439a4e3bf246`.
That exact resulting bundle was checked again:

- 23 complete native workflow phases:
  `.tmp/native-embedding-result-post-verify-workflow-evidence/receipt.json`.
- Eight actual bundled-Core phases, including 12 retained completed maintenance
  jobs and seven owner-bound local vectors:
  `.tmp/native-embedding-result-post-verify-bundled-evidence/receipt.json`.
- 24 native workflow phases including an actual last-window close/reopen:
  `.tmp/native-current-window-lifecycle-evidence/receipt.json`. The Mac became
  accessible, the native close control was exercised and Home reopened with the
  same three Core processes. The earlier locked attempt remains a failed run.
- Five retained official Store compatibility phases:
  `.tmp/native-store-current-compatibility-evidence/receipt.json`. Official
  JSON Formatter `0.10.2` and uBO Lite `2026.1026.1812` remained enabled normal
  installations. The official extension created a tab in Kestrel's native
  window, formatted JSON had no privileged bridge, and formatting, both versions
  and every original Core session survived restart. The formatted JSON capture
  was visually inspected.

All four receipts retain the same before/after bundle digest. The Store run used
the new compatibility-only mode: no update query or reinstall, no observed
version upgrade, deliberately `incomplete`/exit 2. Original checkpoint and
receipt were preserved; the generated Store profile remains available for a
future published upgrade. Syntax and all 23 retained-profile/retirement tests
passed for the harness change. Default update behavior and strict retirement
validation are unchanged.

The canonical `/Applications/Kestrel.app` remains the existing Electron app.
Current source/application verification and current Store compatibility are
proven separately from canonical cutover, existing-profile/vendor-login
acceptance, privacy migration, production signing and the still-unobserved
published Store upgrade. No new microphone capture, desktop-control permission,
real Keychain access or real-profile mutation was performed.

## Native app data backup and scoped recovery checks (2026-11-03)

The native Readiness page now creates a verified backup of the active Core
profile's app data. Its native folder picker explains the scope before the
copy starts. Conversations, task records, settings, encrypted Kestrel credential
records, installed plugins and learned skills are included. Browser history,
cookies, website logins, other Core profiles, provider CLI stores, downloaded
models and external project folders are excluded. Only `secure/credentials`
is selected from the secure directory; database keys and credential master keys
are excluded. These backups require the same Mac, original profile path and
original Keychain identity. This is not a complete Chromium-profile backup or
a portable restore/import feature.

The host reserves maintenance before admitting other work, confirms a clean
Core exit, checks source identity and the selected inventory, copies privately,
independently verifies file hashes, syncs files/directories and publishes through
macOS `renameatx_np(RENAME_EXCL)`. A pre-existing destination, including an empty
folder, cannot be overwritten. An error after publication preserves the backup
and reports unconfirmed durability. Interrupted private staging directories are
retained: automatic recursive cleanup cannot safely delete a path that may have
been replaced. The backup never exports its profile key.

Core ownership is retained until an actual process exit. A forced or uncertain
exit cannot authorize a database copy or a replacement Core. Quit interrupts
the existing maintenance stop, first requests orderly service shutdown and then
uses bounded termination if necessary. A completed backup remains available
when Core restart fails. The renderer receives a UUID receipt and file counts;
Finder reveal resolves an encrypted host receipt and rechecks directory identity
instead of accepting a renderer-provided path. Readiness distinguishes the
receipt's folder identity from a new content or restoration check.

The initial focused suite passed 117 checks, and the full unit suite passed
2,427 tests in 294 files. Workspace typechecks and native builds passed. The
bundled backup canary passed 16 phases on artifact
`3da0b588643d018646ad10bf4543bf7972c0d39598e744ede7030226692fecf4`:
`.tmp/native-backup-bundled-recovery-evidence/receipt.json`. Its picker, permission
and profile-key replies are synthetic private-pipe messages; its bundled Node,
Core processes, native publication binding, encrypted SQLite and credential
records are real. It verifies cancellation without restart, concurrent mutation
rejection, clean stop/restart by PID, manifest hashes, decryptable fixture data,
key/browser/model/project exclusions, encrypted receipts, persisted reveal and
replaced-directory refusal. A separate test-only offline recovery to the SAME
generated profile path reopened the original conversation/message and credential
with the original generated key while preserving its pre-recovery Core folder.
That test does not expose a production restore flow or verify a real Keychain.

The first live Cocoa run verified cancellation and visibly created a backup,
but failed on a temporary maintenance error left in the chat panel. The UI now
clears that specific error after a successful post-maintenance refresh and waits
for initial readiness before accepting a backup click. A later attempt was
interrupted when the Mac locked; both earlier receipts remain preserved.

After the Mac became accessible, all five real Cocoa/UI phases passed on the
final candidate digest
`adfe7137d33e9798b09e8c71864f5e4307b17e017775632e3624bf6ffc31639b`:
`.tmp/native-backup-ui-current-evidence/receipt.json`. The observed picker Cancel,
exact generated-folder selection, visible verified receipt, selected Finder
folder and picker dismissal when its owner tab closed were real native actions.
A complete native restart retained the generated Core session and backup. The
created-backup screenshot was visually inspected; the temporary chat error was
absent. Initial workspace activity caused one admission rejection before the
picker; a real UI retry after it settled succeeded, as recorded in the separate
operator observations. No active task or admission guard was bypassed.

The same final candidate passed 16 bundled backup/recovery phases with an
explicit successful receipt at
`.tmp/native-backup-current-receipt-evidence/receipt.json`, seven packaged transfer
phases at `.tmp/native-backup-current-transfer-evidence/receipt.json`, five
process-death recovery phases at
`.tmp/native-backup-current-transfer-recovery-evidence/receipt.json`, and 16 native
browser/Settings phases at
`.tmp/native-backup-current-workflow-evidence/receipt.json`. The final candidate also passed all 26 provider, companion, workspace,
attachment, isolated browser/download, approval, crash and restart phases at
`.tmp/native-backup-current-full-desktop-evidence/receipt.json`. Its completed
companion conversation capture was visually inspected. Five retained official
Store compatibility phases passed at
`.tmp/native-backup-current-store-compatibility-evidence/receipt.json`: both
normal official installations, extension-created native tabs, formatted JSON,
Core sessions and versions survived restart. This compatibility-only run made
no update query; it deliberately remains `incomplete`/exit 2 for upgrade
acceptance. The original retained Store checkpoint was preserved. Each receipt
retains matching before/after bundle digests. Full `pnpm verify` passed again:
`.tmp/native-backup-aggregate-verify.log`. All eight generated tracked screenshots
were preserved under `.tmp/native-backup-aggregate-images-after/` and restored
byte-for-byte from `.tmp/native-backup-aggregate-images-before/`. A final focused
67-check pass and native rebuild cover the final message wording and nonblocking
file opens. Canonical installation, existing-profile acceptance, production
signing and the other release gates remain separate.

To repeat the generated-data checks, set `KESTREL_NATIVE_TEST_APP` to the exact
disposable candidate and run `pnpm test:native-local-backup`. The optional
`KESTREL_NATIVE_LOCAL_BACKUP_EVIDENCE` selects a fresh evidence directory.
`pnpm test:native-local-backup-ui` exercises the real Cocoa panels with an
operator; its `live-state.json` describes each observed action and acknowledgement.

## Native Google Workspace and external secret services (2026-11-03)

The existing Connections and protected secret-source Settings screens now route
through native hosts. Google consent leaves Core running; only the validated,
profile-local opaque secret write or removal uses the idle Core restart barrier.
The native host validates callback origin, host, state and duplicate parameters,
uses PKCE, bounds response streams and network time, and cancels provider work
when its requesting renderer closes. A failed write/restart restores the earlier
opaque record. Disconnect first removes the secret from Core, then attempts a
bounded vendor revocation. An unconfirmed revocation is reported separately from
the completed local disconnect. Quit stops the owned Core promptly and aborts
remaining sign-in/revocation work; no replacement Core may start during shutdown.

External secret configuration saves use an idle settings mutation without
executing a helper or restarting Core. Explicit sync resolves supported names
once and carries those values through that operation's private configuration
context into the restarted Core. It never returns provider values or bootstrap
tokens to the renderer. Source removal restores the ordinary protected-field
precedence. Owned helper processes use argv-only execution, bounded output/time
and cancellation; shutdown also kills a helper that ignores normal termination.
Settings transactions restore earlier opaque configuration and bootstrap records
on failure, and clear stale verification after edits. Cancellation after a
completed transaction preserves its successful outcome instead of claiming that
nothing changed.

Verification metadata is private, bounded, shape-checked and reconstructed with
static public messages. Empty or unknown-only helper output cannot be marked
verified. The native host permits Bitwarden download only through the explicit
install action. Managed publication uses exclusive private files, independent
binary hash/size checks and a readiness marker written last. Existing and
incomplete content is retained. Explicit repair can preserve an incomplete owned
private installation in a new private sibling recovery folder before retrying;
ordinary resolution does not perform that repair. The preservation move uses
ordinary filesystem rename with identity rechecks, not an exclusive native
rename guarantee against another process running as the same user.

Independent read-only review identified an unconfirmed-stop admission gap,
interrupted-install retry failure and misleading late-cancellation responses;
all three have regression coverage. A further close-at-revocation-boundary test
prevents fresh network work after shutdown. An initial aggregate run failed the
native Chrome tab ownership observation. The probe now waits for both real
unfiltered and URL-filtered Chrome queries to agree on the exact tab identity;
strict ownership checks remain in force, with deterministic delayed-registration
and disagreement tests. The failed aggregate log remains preserved at
`.tmp/native-connections-aggregate-verify.log`.

The initial package passed nine actual bundled provider/Core phases and four
native UI phases on bundle
`76bbf5cbb47902480547b663c5ddd8ed766d7bec36361cf15071424fdcab1deb`:
`.tmp/native-connections-bundled-evidence/receipt.json` and
`.tmp/native-connections-ui-evidence/receipt.json`. The UI test ran a generated
local executable, observed no execution on Save and one on Sync, verified
restart persistence and removal, and validated an invalid Google client ID.
Both Settings captures were visually inspected. The bundled test uses the real
standalone Core and profile encryption with simulated Google endpoints and a
loopback callback. No real Google account, external vault, microphone, desktop
permission, Keychain item or existing profile was used. Those receipts precede
the final review fixes; current-artifact verification is recorded separately.
Apple Messages and native login-code insertion remain unavailable; Google tool
support and simulated OAuth do not establish real-account acceptance.


The frozen reviewed source passed 2,491 tests in 298 files, workspace types,
audits, builds, both Chrome tab ownership queries, the browser benchmark and
50 website E2E cases. The second full `pnpm verify` stopped at
`test:desktop-tab-interactions` because its hover preview did not open while the
Mac was locked. The first remaining command, `test:desktop-browser`, met the
same hover boundary. Both failing logs and receipts are retained; this is not
an aggregate verification pass. Subsequent independent commands are recorded
separately. Generated tracked screenshots are preserved and restored byte for
byte, without resetting unrelated changes.

The current artifact is
`796064594207c622bd3f7d86fc870bfac3bc571723e52435d5c66524c9a4fd73`.
All current native receipts retain that same digest before and after:

- `.tmp/native-connections-current-bundled-evidence/receipt.json`: nine provider
  and real standalone-Core phases, using generated keys, simulated provider
  endpoints and an injected helper executor.
- `.tmp/native-connections-current-ui-evidence/receipt.json`: four actual bundled
  Settings phases, with a real generated local executable; Save executes zero
  times, Sync executes once, restart resolves once and removal prevents replay.
  Both captures were visually inspected. These CDP-driven checks do not prove
  physical interaction with the locked Mac or real-account acceptance.
- `.tmp/native-connections-current-backup-evidence/receipt.json`: sixteen bundled
  app-data backup and generated-profile offline recovery phases.
- `.tmp/native-connections-current-workflow-evidence/receipt.json`: twenty-six
  full native desktop phases, including provider and companion tasks, workspace
  access, attachments, isolated browsing and downloads, approval and restart.
- `.tmp/native-connections-current-store-compatibility-evidence/receipt.json`:
  five retained official Store compatibility phases. Both normal extensions,
  formatting, extension-created same-window tabs, versions and Core sessions
  survived restart. No update query, reinstall or published version upgrade
  occurred; the receipt deliberately remains incomplete for upgrade acceptance.

The full verification log is `.tmp/native-connections-reviewed-aggregate.log`;
the focused final review log is `.tmp/native-connections-reviewed-final.log`.
The preceding published `1ca4c4f0` revision passed its Core and desktop/package
CI jobs. Its separate CodeQL check still reports five fingerprint findings;
none has been dismissed or suppressed. Jules advisory review is unavailable
because its API key is not configured. Canonical installation and the remaining
profile, account, signing, privacy and Store-upgrade gates remain outstanding.


The remaining verification commands ran sequentially in
`.tmp/native-connections-tail2/receipt.json`: 18 of 19 passed initially. The
external-secret desktop smoke alone expected the previous dynamic credential
count in a status message. Its assertion now checks the actual sanitized static
message and independently requires the command source to be verified with
exactly the supported `openai` credential ID. The focused desktop smoke passed
without a rebuild or real Bitwarden installation:
`.tmp/native-external-secrets-focused/receipt.json`. Its generated screenshot
was retained and the tracked baseline restored byte for byte. All 19 remaining
commands thus passed individually; the two locked-desktop hover checks still
prevent an aggregate pass claim.

A separate current-artifact official Store update query succeeded with
`no_update`. All five compatibility/restart phases also passed in that run:
`.tmp/native-connections-current-store-update-evidence/receipt.json`. No newer
published version was observed, so upgrade acceptance remains incomplete/exit 2.
The retained generated profile, original checkpoint and bundle digest are
unchanged. No real profile or credential was used.


## Durable embedding owner generations (2026-11-03)

Embedding jobs now identify a durable, random owner generation rather than a
prefix of the owner's text hash. Encrypted profile-local metadata retains a
random MAC key and per-owner generations; new vector content hashes are keyed.
The seven canonical owner writes and deletion/cascade paths rotate generations
on text or direct authority changes, including same-clock A to B to A and
identical-ID recreation. Access scores, unrelated metadata and fresh encryption
IVs retain the generation. A harmless metadata write during provider execution
therefore no longer exhausts the current job's retries. Job lease, canonical
text, keyed hash and current generation still gate atomic result publication.

Core scheduling and scoring use that same generation. Session assignment,
reactivated activity blocks and surviving aggregates after deletion enqueue the
current generation. Ready vectors from a prior generation or legacy vectors
without a generation are excluded from scoring; current local text remains the
fallback. This slice covers direct owner authority, not transitive source/policy
revocation or the remaining legacy fingerprint migration.

Reserved generation metadata is strictly validated on profile export, snapshot
validation and import, including version/shape and owner-key MAC binding to the
copied secret. It is re-encrypted without changing logical values under an
independent destination database key. Constructors and missing-owner reads do
not create records in an empty staging database. Older unchanged snapshots
without the new metadata remain valid. Source writes after a reviewed plan
still require a fresh review; no checksum checks were weakened or projected away.

The isolated implementation passed 2,519 tests in 299 files and all workspace
typechecks. Independent review identified and reproduced three producer and
in-flight lifecycle gaps; each has a regression test. Two full `pnpm verify`
attempts passed audits, types, units, builds, extension helpers, browser benchmark,
50 website cases and the preceding desktop flows, then failed an Electron
hover-preview assertion. Fresh CUA showed an unlocked Mac for these failures.
The preview depends on actual native focus and macOS pointer position; a
browser-level pointer-setup experiment did not resolve it and was removed.
No aggregate pass is claimed. Logs/receipts are retained in
`.tmp/native-generation-aggregate/` and `.tmp/native-generation-aggregate2/`.
All 19 commands after desktop-browser passed individually: the first setup run
completed its assertions but hit ENOTEMPTY during generated-directory cleanup;
its isolated retry passed. Receipts are `.tmp/native-generation-tail/receipt.json`
and `.tmp/native-generation-setup-retry/receipt.json`. Generated tracked images
were preserved and restored to their exact original hashes after every run.

Final artifact
`fbcdd3387e3d41cd96ab9d3fa99b53d90833a3a4861f185422d6f78a5dffc646`
passed these current receipts, each with matching before/after bundle hashes:

- `.tmp/native-generation-final-bundled-evidence/receipt.json`: four real bundled
  Node/Core phases prove completed A to B to A produces a distinct job and new
  current vector, keyed hashes and coherent encrypted/SQL job state, then retains
  the current completed generation across restart and real memory retrieval.
- `.tmp/native-generation-final-workflow-evidence/receipt.json`: all 26 native
  product phases, including providers, companion task completion, workspace,
  attachments, trusted form/link actions, isolated storage and downloads,
  approval enforcement, crash recovery and full restart.
- `.tmp/native-generation-final-transfer-evidence/receipt.json`: seven independent
  key/transfer phases; `.tmp/native-generation-final-recovery-evidence/receipt.json`:
  five process-death/recovery phases.
- `.tmp/native-generation-final-backup-evidence/receipt.json`: sixteen app-data
  backup and generated same-profile offline recovery phases.
- `.tmp/native-generation-final-providers-evidence/receipt.json`: nine bundled
  provider/Connections process phases.

The preceding `79961d37...` artifact separately passed a real Cocoa folder grant
and 20 native phases. Its operator selected only the generated workspace folder;
fresh AX state and the inspected screenshot showed that project and Settings
access entry. The current 26-phase run uses the pre-granted generated fixture;
it does not reuse the earlier Cocoa interaction as current-hash physical proof.
The repeatable packaged Core command is `pnpm test:native-embedding-generations`
with `KESTREL_NATIVE_TEST_APP` selecting the candidate and optional
`KESTREL_NATIVE_GENERATION_EVIDENCE` selecting a fresh evidence folder.

The previously retained Store fixture is no longer present at its OS temporary
path after the Mac restarted. Its old receipts/checkpoint remain preserved;
a current compatibility resume failed before launch with ENOENT and proves no
current Store behavior. The earlier official update query returned no_update,
but neither a current retained-profile check nor a published upgrade is claimed
on this final artifact. Durable test-profile retention and a fresh official
Store baseline are required next. The canonical app remains the existing
Electron installation (currently PID 1028); no real profile, credential,
Keychain item, microphone or desktop-control permission was changed.


The fresh official Store baseline subsequently passed on the same final
`fbcdd338...` artifact. Both real Chromium permission prompts were operated in
the generated profile, first for JSON Formatter and then uBlock Origin Lite.
The complete Store receipt is
`.tmp/native-generation-store-reseed2-evidence/receipt.json`, with matching
before/after bundle hashes. Normal installation, extension-created tabs,
toolbar popup, live management disable/re-enable, function and restart
persistence pass; only an actual published version upgrade remains incomplete.
The new checkpoint is
`.tmp/native-generation-store-reseed2-evidence/store-update-checkpoint.json`.
The previous failed/timeout run and previous missing-profile checkpoint remain
preserved and are not relabeled as successful. A private archive of this
marked, generated profile is being retained separately from macOS temporary
storage; its manifest records that restoration has not yet been tested. The
temporary-root test-key guards remain unchanged.

Current-head CI `41650437331` passed desktop/package validation but failed the
Core unit job because the legacy-key native fixture's beforeAll hook retained
Vitest's 10-second default while its compiler already permitted 30 seconds.
The fixture now bounds each xcrun discovery to five seconds and gives only
that hook 45 seconds for the bounded discovery/compiler budgets plus setup.
The compiler and per-case subprocess limits and all 23 assertions are unchanged.
The exact fixture suite passed locally after the correction; this does not
retroactively make the failed CI run green. A new CI run is required.


### Transitive memory authority and native refresh recovery (2026-11-03)

Embedding jobs, commits, cached vectors, timeline/context retrieval, scoped
memory tools and the legacy workspace projection now resolve the same source
authority graph. Runtime session/message ownership, agent ownership, provenance
membership, source aliases, capture policy and source tombstones contribute
versioned encrypted authority epochs. A same-clock revoke/regrant, removed and
restored provenance edge, or deleted and recreated source cannot revive an old
cached vector. Unknown opaque source labels do not become origin grants.
The resolver fails closed on missing or forbidden edges, cycles, malformed
reserved state, depth, node and byte budgets. Capture pause preserves permitted
local history while denying new embedding work.

Reserved generation and authority records retain strict version/shape/key-MAC
validation during profile transfer. Constructors remain lazy; a source that
changes after a reviewed plan requires a fresh plan. Snapshot checksums and
source revalidation are unchanged. These checks cover represented source
relationships; arbitrary artifact/structured-data strings and provider-specific
network grants are not inferred into graph edges. Persisted legacy fingerprint
migration remains separate work.

Native packaged testing exposed a refresh scheduling gap after transitive
invalidation. Maintenance now alternates bounded primary-key pages of cached
vectors and retained jobs. Each slice considers at most eight records, resolves
one authority graph per record, and yields cooperatively after 25 ms; one
bounded graph may exceed that time slice. Retained jobs let a source restored
before its first vector be rediscovered. Stale dispatch and rejected in-flight
completion also queue the currently permitted generation. Existing dedupe,
lease checks and exhausted-generation retry limits remain authoritative. No
unretained owner is discovered through this scan, and denied/deleted owners
remain ineligible. The database's direct refresh producer now honors the same
exhausted-attempt guard.

The capture-policy glob matcher treats only `*` as a wildcard and rejects an
operation-budget overrun. Both capture ingress and embedding policy use that
bounded matcher. The forget-command punctuation classifier is now a linear
scan, including adversarial matching/nonmatching punctuation tests. Fresh
CodeQL analysis is still required; no findings were suppressed or dismissed.

Final source validation passed **2,573 tests in 302 files** and workspace
typechecks. The preceding `c1787f00` source passed the complete `pnpm verify`
command, including native helpers, browser/desktop workflows, audits, package
CLI and security checks; this is a separate source boundary. A later simultaneous
build/unit run exceeded the depth-fixture timeout and a regression's four-slice
assumption. The regression now allows bounded maintenance progress independent
of machine load; the final complete unit run passed without a native build
competing for CPU. All privacy/budget assertions remain in place.

The ad-hoc native candidate is
`80fe38b16c7d0b7490e2adb86cb3337c8efffe7225b3f6207a3abe45d2c5a8b6`.
Every following receipt has matching before/after candidate digests:

- `native-authority-repaired-workflow-evidence/receipt.json`: **26** native
  product phases, including real Core tasks, companion, workspace fixture,
  attachments, trusted browser/form actions, isolated downloads, recovery and
  full restart. The running Chromium window and existing Kestrel UI were
  inspected through CUA; the completed companion conversation PNG was inspected.
- `native-authority-repaired-bundled-evidence/receipt.json`: **4** real bundled
  Node/Core source-authority phases. Generated records and one valid pending job
  are seeded through source database APIs only while Core is stopped. The real
  Core proves permitted retrieval/embedding, same-clock revoke/regrant replacing
  completed work, private-source exclusion from timeline/tool/workspace, retained
  encrypted user records, and capture-pause history. The sensitive memory tool
  first proves its unapproved call blocked; protected-host approval is then
  explicitly simulated for this generated fixture. This is not proof of a real
  user approval interaction.
- `native-authority-repaired-generations-evidence/receipt.json`: **4** completed
  A/B/A generation, keyed-hash, restart and retrieval phases.
- `native-authority-repaired-transfer-evidence/receipt.json`: **7** independent
  key file-transfer phases; `native-authority-repaired-recovery-evidence/receipt.json`:
  **5** actual process-death/reviewed-recovery phases.
- `native-authority-repaired-backup-evidence/receipt.json`: **16** bundled Core
  app-data backup and generated offline recovery phases.
- `native-authority-repaired-connections-evidence/receipt.json`: **9** bundled
  provider/Connections phases with generated helper/loopback fixtures.
- `native-authority-repaired-store-compatibility-evidence/receipt.json`: **5**
  retained normal official Store extension/function/tab-isolation/restart phases.
  No update query, reinstall, forced version or version-upgrade claim is involved.
  The fresh official Store baseline and native permission prompts were separately
  proven on `fbcdd3387e3d41cd96ab9d3fa99b53d90833a3a4861f185422d6f78a5dffc646`
  by `native-generation-store-reseed2-evidence/receipt.json`. Its private generated
  profile archive was extracted and compared file-for-file, mode-for-mode;
  application restoration from that archive remains untested.

Receipt paths above are under `.tmp/`; commands are
`test:native-memory-authority`, `test:native-embedding-generations`,
`smoke-chromium-desktop.mjs`, `smoke-native-core-file-transfer.mjs`,
`smoke-native-core-transfer-recovery.mjs`, `smoke-native-local-backup.mjs`,
`smoke-native-provider-connections.mjs` and compatibility-only
`resume-native-store-update.mjs`, each with an exact candidate and fresh evidence
directory. Earlier failed fixture attempts are preserved separately.

The canonical `/Applications/Kestrel.app` remains the existing Electron app.
No real profile, credentials, vendor login, Keychain item, microphone or desktop
control permission changed in this verification. Whole Chromium-profile backup,
legacy identifier migration, older/large/interrupted-profile acceptance,
real-profile/browser/credential acceptance, native Messages/login-code insertion,
a published Store version upgrade, production identity/signing/notarization and
canonical cutover remain release work. The absence of an Apple Developer account
is unchanged. This candidate is not a signed/notarized release.


### Legacy identifier preparation and companion test readiness (2026-11-03)

Active Core startup now prepares legacy generation-less embedding rows before
background claims run. This is an explicit activation operation, not a database
constructor, source reader, transfer-plan, import or staging side effect. Each
transaction walks at most eight primary-key records and atomically commits its
strictly versioned encrypted cursor with the converted records. Metadata size
checks run before payload loading: at most 4,000,000 encoded bytes per row and
an 8,000,000-byte selected page. Valid larger aggregate pages advance through a
fitting prefix. The scheduler yields between pages; errors and live leases use
the normal retry interval, avoiding both a busy failure loop and a 15-second
pause for every small page. An unexpired running lease is preserved; a running
legacy job without an expiry remains blocked for explicit recovery.

Legacy job IDs and dedupe values become independent opaque UUID identities;
SQL and authenticated payload bindings are validated before rewriting. Legacy
vector hashes become domain-separated keyed values, while the absent generation
remains absent: no old vector is declared current. Current-generation rows stay
unchanged. Strict retirement markers validate version, opaque identity and owner
binding in database readers and profile transfer.

Cancelled and exhausted legacy work receives a same-status, same-budget guard
for its first eligible current generation, without replacing an existing current
job. Denied owners remain retained and cannot dispatch. If permission returns,
repair binds the terminal guard without reviving work. A subsequent real
correction may create new work for a distinct generation; the previous terminal
guard stays intact. Current cancelled generations also remain terminal in both
refresh producers. No provider runs as part of the conversion itself.

Reader/export snapshots remain unchanged before explicit activation. The exact
transfer checksum and source-revalidation rules are unchanged, and a source
activated after a reviewed plan requires review again. Tests cover interrupted
pages/reopen, indexed/encrypted mismatch rollback, strict forged metadata,
preload byte limits, cumulative page progress, lease preservation, terminal
regrant and later correction. Historical SQLite pages, WAL files and backups
can still retain old hashes; this operation does not claim retroactive erasure.

Final source tests passed **2,595 tests in 303 files**, plus all workspace
typechecks. Full `pnpm verify` for source `5fd495e2` **passed**, exit 0, at
2026-11-03T22:30:47.747Z. The receipt is
`.tmp/native-legacy-aggregate/receipt.json`; the exact native candidate was pinned
throughout and its before/after digest matched. All eight tracked screenshots
were preserved and restored byte for byte. The run includes audits, builds,
native helpers, website checks, all desktop workflows, packaged CLI, editor
integrations and the production secret scan.

Native candidate
`d2b9a39afb02963bff89d15167258f2f48c42487201e51809f6290b4f537efd6`
has matching before/after hashes for:

- **26** full product phases in `native-legacy-final-workflow2-evidence`;
- **4** source-authority and **4** generation phases in
  `native-legacy-final-authority-evidence` and
  `native-legacy-final-generation-evidence`;
- **7** transfer, **5** process-death recovery, **16** Core app-data backup and
  **9** provider phases in the corresponding `native-legacy-final-*-evidence`;
- **5** retained official Store compatibility phases in
  `native-legacy-final-store-compatibility-evidence`, with no update query or
  version-upgrade claim;
- **4** real bundled Node/Core migration phases in
  `native-legacy-formal-bundled-evidence`: stable pre-activation reader/export,
  public legacy identifier neutralization, permission regrant preserving terminal
  budgets, and a genuine later correction followed by restart. Generated source
  fixtures are seeded/edited only while Core is confirmed stopped. The reviewed
  file-transfer plan rejection is covered by database unit tests, not this probe.

All paths above are under `.tmp/` and contain `receipt.json`. The new command is
`test:native-embedding-legacy-migration`. The actual running native window was
observed through CUA with Home, native tabs, Store tab and completed companion;
this remains a generated profile, not the canonical installed app.

Published predecessor `246ef377` passed desktop/package CI, but its Core job
failed when the fixture launched a second companion task after streamed answer
text and before the panel finished returning to idle. The fixture now requires
a persisted completed run and consecutive idle-composer observations before the
next task; the original busy rejection/draft-preservation checks are unchanged.
The first local retry used an unnormalized title with punctuation and failed;
that fixture match was corrected, and all 26 phases then passed. Fresh remote
CI remains required. That predecessor's CodeQL slow-punctuation finding cleared;
one transient HMAC redaction-fingerprint finding remains unresolved and
unsuppressed.

Large/older-profile acceptance beyond these fixtures, missing-expiry recovery,
whole Chromium-profile backup, real profiles/credentials/accounts, an observed
published Store upgrade, native Messages/login-code insertion, production
identity/signing/notarization and canonical cutover remain release work. The
existing `/Applications/Kestrel.app`, user profiles, Keychain and credentials
remain untouched. No new microphone or desktop-control access was used.


### Profile reservation outside the Chromium tree (2026-11-03)

Native desktop startup now acquires an external profile-path reservation before
Core, Keychain bootstrap or Chromium starts. It also retains the existing
in-profile lock for compatibility with earlier native builds. The external
lock lives beside the private canonical profile, so renaming or replacing the
profile directory does not silently admit a second cooperating owner. The held
parent/lock descriptors, named identities, ownership, modes and link counts are
checked. Existing lock files are never truncated or removed. The reservation
is held through broker and Chromium teardown.

This is the first lifecycle requirement for whole-profile backup and recovery;
it does not prove offline quiescence or provide a backup/restore interface.
Future offline operations must revalidate the held reservation immediately
before consequential steps, verify reviewed data and prove clean shutdown of
all owners. Replacing a lock pathname by another process with the same user
identity can invalidate a historic reservation. The operation must refuse that
state rather than treating an earlier successful lock as permanent proof.

Focused native tests passed **11** cases, including separate-process exclusion,
release, an independent profile, profile replacement under the held external
lock, changed parent/lock identities, and unsafe links/modes/content. **Two**
ownership-mismatch cases are skipped without root privileges; the implementation
checks ownership, and no privilege escalation was attempted. The complete source
suite passed **2,606 tests in 304 files**, with those two skipped cases. The
preceding `5fd495e2` full `pnpm verify` pass remains a separate source boundary.

Exact ad-hoc native candidate
`84ae9c2fdc6b2dae180b84a3d7d66b2b710e4a3e795d730753aa48c1c510b8da`
passed these matching-before/after-hash receipts:

- `.tmp/native-profile-fence-bundled-evidence/receipt.json`: **4** actual native
  launch checks. A separately executed native fixture observes the held fence;
  a second real candidate is refused while the first runs; clean process exit
  releases the fence; the same generated profile restarts and releases it again.
  No forced cleanup was used. This does not substitute for the future backup
  controller's stronger Core/Chromium clean-quiescence witness.
- `.tmp/native-profile-fence-workflow-evidence/receipt.json`: **26** full native
  product phases with the existing UI, agents, workspace, browser actions,
  isolated downloads, Core recovery and restart. The completed companion PNG
  was inspected.
- `.tmp/native-profile-fence-store-evidence/receipt.json`: **5** retained normal
  official Store extension/function/tab-isolation/restart phases, compatibility
  only, with no update query or observed version upgrade.

Run `test:native-profile-reservation` with an exact disposable candidate and a
fresh `KESTREL_NATIVE_PROFILE_RESERVATION_EVIDENCE` directory. The fixture uses
only a generated test profile and test key. No real profile, credentials,
microphone or desktop-input access was used; the probe performs no explicit OS
Keychain operation. The canonical installed Electron app remains unchanged.
Whole Chromium-profile backup/restore, same-Mac identity verification, reviewed
replacement, no-replay recovery policy and durable recovery journaling are still
required before claiming that backup feature. The formal profile-transfer and
rollback retirement gate and the other outstanding release gates remain open.

### Native verification-code handoff (2026-11-03)

The existing companion now offers an explicit **Find verification code** control
for a loaded HTTP(S) user tab. Find performs a private field inspection before
searching recent Messages text or the connected read-only Gmail source. The
shared Messages query now correctly subtracts the Apple 2001 epoch, bounds both
ends of the last 30 minutes, excludes future/malformed dates, and limits rows,
output bytes, query time and returned codes. Its sqlite3 child is cancellable.
Attributed-body-only Messages rows are still unsupported.

The selected code travels through a distinct authenticated native host/worker
channel. Generic renderer/browser-tool requests cannot supply an arbitrary code
for this channel. Generic page contexts and browser automation continue to redact
and refuse code fields. The host binds a scan to the active window, native tab,
top-level document, canonical origin and opaque field identity. The isolated
field registry additionally binds the full URL, observable navigation entry,
invalidation generation and field/form semantics. Ambiguous, hidden, disabled,
password and payment fields are rejected. An unrelated tab's navigation does
not revoke this tab's scan.

Use consumes the scan before asynchronous work, rechecks source/account status
and the captured field, and focuses only that field in the already selected
visible document. It checks focus and authority again after synchronous focus
handlers, then emits input/change without a submit click or Enter. A site can
continue from its own event handlers. Blur, observable navigation, cancellation,
known provider mutations, worker loss and restart invalidate retained authority.
Candidates are valid for at most two minutes and are not written to history or
agent messages. Unknown insertion outcomes are not retried automatically.

The manual UI clears codes and rejects late results on close, tab/navigation
change or unmount. Messages settings opens only the fixed native Full Disk
Access pane after an explicit request. No permission is granted automatically.
The protected disposable-key lane alone selects a generated Messages fixture;
the renderer cannot choose a database path or enable that lane.

Current source passed **2,648 tests in 307 files**, with two ownership-mutation
tests skipped without root, and workspace typechecks. The successful full unit
run used `--maxWorkers=4`. Earlier unrestricted runs hit different five-second
database-test timeouts under concurrent build/app load; both affected suites
passed independently, and the complete bounded-concurrency run passed. The new
field test was also converted from node:test to the repository's Vitest runner.
No assertion or timeout threshold was relaxed.

Exact ad-hoc native candidate
`b606fd359ee558240a0c479b0f602262863f231605c280c431125095d377336f`
has matching before/after bundle hashes for:

- `.tmp/native-login-code-final2-evidence/receipt.json`: **6** actual packaged
  phases: public-page bridge/raw-search refusal; generic automation refusal;
  the real companion finding only the recent generated SQLite message; actual
  field fill with input/change and zero submit events; stale navigation refusal;
  restart refusal of an unconsumed candidate. The generated profile was removed
  after clean shutdown. The current native window and visibly filled field were
  also inspected through computer use during the preceding inspection probe.
- `.tmp/native-login-code-workflow2-evidence/receipt.json`: **26** full product
  phases, including existing Home/companion/provider tasks, attachments,
  workspace, trusted browser actions, isolated Enter navigation/downloads,
  recovery and restart. The preceding 25-phase run omitted the opt-in Enter
  navigation flag; this run explicitly includes it.
- `.tmp/native-login-code-store-evidence/receipt.json`: **5** retained official
  Store extension/function/tab-isolation/restart phases, compatibility only.
  The expected result is incomplete/exit 2 because no published-version upgrade
  was queried or observed. This is not fresh-install or update-acceptance proof.

Run `test:native-login-code` with an exact disposable candidate and an empty
`KESTREL_NATIVE_LOGIN_CODE_EVIDENCE` directory. Failed receipts are retained:
the first probe needed to wait for the tab model; private scripting needed JSON
nulls rather than undefined arguments; a refreshed CDP connection needed fresh
page handles; and navigation authority initially used a global revision. A
45-second inspection probe subsequently lost foreground authority before its
next scan. The final probe explicitly focuses its owned page before testing
stale-document rejection; foreground checks remain enforced. The latest full
`pnpm verify` pass is still the separate `5fd495e2` source boundary.

These generated-data checks do not prove real Messages/Full Disk Access or
authenticated Gmail acceptance. Gmail uses the existing Core lookup's 30-second
network bound; host cancellation discards late content but does not abort that
individual child request. Known account changes are rechecked; sources without
an authorization epoch cannot prove an unobserved revoke/regrant race. Navigation
changes with neither a browser event nor a Navigation API entry change are not
claimed detectable. Earlier authority/transfer/backup receipts belong to their
documented older artifacts.

The canonical `/Applications/Kestrel.app` is still the existing Electron app.
Broader existing-profile asset migration/rollback, interrupted preparation and
missing-expiry lease recovery, real account/profile acceptance, a published
Store upgrade, production signing/notarization and canonical cutover remain
release work. Whole Chromium-profile backup is a separate unfinished feature;
it is not an additional named retirement gate. No real Messages database,
credentials, microphone or desktop-input permission was accessed for this batch.

The first current-source aggregate run on `c3910ac7` subsequently failed at
`test-desktop-browser.mjs`'s inactive-tab hover preview assertion. Its receipt is
`.tmp/native-login-code-aggregate/receipt.json`; the candidate hash stayed
unchanged and all eight tracked PNGs were restored byte for byte. A focused
retry reproduced the local failure, while the corresponding CI step passed.
The fixture now explicitly focuses its owned application/window and waits for
the foreground condition that native previews require. The immediate focus
check was itself too early for macOS; the bounded focus wait passed the entire
browser suite, including the unchanged preview, tear-off and restart checks.
The production preview's background-owner refusal and timeout assertions are
unchanged. This diagnoses a test precondition; it does not establish the exact
cause of every earlier hover failure. A fresh aggregate run is required for the
revised fixture.
