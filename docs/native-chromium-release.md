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
reports no known vulnerabilities. Aggregate `pnpm verify` and remote CI
still require their own completed results; these focused passes do not
establish full native product parity.

Native builds compile the peer inspector against headers from the same
checksum-verified Node archive as the bundled runtime. CI runs the new
Chromium desktop and native authentication smokes against its exact native
candidate, in addition to the historical host probes.

Release acceptance still requires the complete native product workflow:

- Provider sign-in and credential storage, local models, workspace/file
  operations, settings, approvals, and agent execution on the new host.
- Approval-preserving Core browser automation, context extraction, isolated
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
