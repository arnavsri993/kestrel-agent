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

Release acceptance still requires the complete native product workflow:

- Provider sign-in and credential storage, local models, workspace/file
  operations, settings, approvals, and agent execution on the new host.
- Full Core browser automation beyond the verified visible tab primitives:
  snapshots and actions, screenshots, isolated
  browsing, downloads, autofill, recovery, and functional extension/update
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
