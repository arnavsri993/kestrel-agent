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
