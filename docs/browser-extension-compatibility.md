# Browser extension compatibility

**Extensions → Open Chrome Web Store** opens a tab in the existing Kestrel
window, keeping its tab rail and agent controls. Store listings offer
Kestrel's **Review & add** flow below. Full native Chromium extension support
inside that window is not complete; opening a separate stock Chromium window
does not satisfy that integration.

An experimental native compatibility browser remains available under browser
Settings → Web extensions and add-ons → **Compatibility browser — separate
window**. It has a separate persistent profile. Its extensions operate only on
pages in that separate window. It is a compatibility tool, not Kestrel's normal
Store flow. Existing browser data, extension records and credentials are
preserved and are not transferred. Its pages receive no Kestrel bridge, agent
tools or provider credentials.

The embedded browser can also install selected Store packages, with a narrower
compatibility surface. The Chrome Web Store sees Kestrel's Electron
runtime as a non-Chrome browser, so Google's ordinary **Add to Chrome** control
does not authorize an install. Kestrel deliberately does not spoof Chrome,
modify the store page, or inject a brittle replacement into Google's DOM.

Instead, when a person opens a real Chrome Web Store listing, Kestrel provides
one browser-level **Review & add** action. This action is deliberately separate
from the store page and follows this path:

```text
real Chrome Web Store URL or extension ID
  -> signed CRX3 download and identity verification
  -> bounded extraction into a temporary review directory
  -> manifest and bounded source analysis
  -> native declared-access and compatibility review
  -> explicit confirmation using a single-use review handle
  -> durable install in the persistent user-browser profile
  -> runtime registration/startup observation
  -> reload observation on the next Kestrel browser start
```

An install is not a compatibility claim. A package may have a valid Chrome Web
Store signature and still depend on a Chrome API that Electron does not expose
or that Kestrel has not yet verified.

## Embedded extension boundary

The extension subsystem has three layers:

```text
Kestrel browser UI and typed IPC
  -> BrowserExtensionManager and compatibility report
  -> ExtensionRuntime adapter
  -> ElectronExtensionRuntime today
```

`BrowserExtensionManager` owns signed-package validation, safe extraction,
review-token lifecycle, persistence, enable/disable/reload, compatibility
analysis, and public record redaction. It has no Electron `Session` dependency.
`ElectronExtensionRuntime` is the only adapter that calls Electron's extension
and service-worker APIs. A future `ChromiumExtensionRuntime` can implement the
same small runtime boundary without changing the installer, stored report, or
management UI.

The embedded runtime is Electron's persistent user-browser partition. Electron
only supports unpacked extensions and requires extensions to be loaded again at
startup, so Kestrel persists its verified package record and reloads it when
that profile starts. No Kestrel agent, memory, file, native IPC, or privileged
API is exposed to a browser extension merely because it is installed.

## What Kestrel assesses

Before confirmation, Kestrel records:

- declared `permissions`, `optional_permissions`, host permissions, and
  optional host permissions;
- manifest version, background page/service worker, content scripts, commands,
  action, side panel, declarative-net-request, externally-connectable,
  web-accessible resources, minimum Chrome version, incognito setting, content
  security policy, and unrecognized manifest keys;
- bounded static references to `chrome.*` or `browser.*` APIs, plus dynamic
  access and scan-limit warnings; and
- runtime evidence for registration, readiness, service-worker startup,
  continued loading, and restart persistence. Content-script, storage, action,
  and host-permission behavior remain explicitly **not checked** until Kestrel
  can observe them without fabricating a result.

The source scan is intentionally conservative: it has file and byte budgets,
does not follow symlinks, and labels dynamic access or truncated coverage as
unknown. It is evidence, not an audit of arbitrary extension code.

## Capability registry and states

The Kestrel-owned registry uses `full`, `partial`, `emulated`, `unsupported`,
and `unknown` capability statuses. It is based on Electron's documented
extension API surface and Kestrel's own runtime observations. It is not a
promise that an entire Chrome namespace works just because one method does.

Examples today include:

| Capability | Current assessment |
| --- | --- |
| `chrome.runtime.sendMessage`, `chrome.runtime.connect`, `chrome.scripting`, `chrome.webRequest`, `chrome.storage.local` | Documented support |
| `chrome.tabs.query`, `chrome.tabs.update`, `chrome.management` | Partial support |
| `chrome.storage.sync`, `chrome.storage.managed` | Unsupported |
| `chrome.identity`, actions, commands, context menus, declarative net requests, cookies, downloads, history, bookmarks, notifications, side panel, and other unverified surfaces | Unknown until Kestrel has evidence |

Kestrel shows a package one of the following states:

| State | Meaning |
| --- | --- |
| **Verified** | This version passed every currently applicable runtime check, including a persistent-profile reload. It is not a claim that every feature of the extension has been exercised. |
| **Expected compatible** | Observed requirements are documented as supported, but Kestrel lacks complete runtime evidence for this exact package. |
| **Partial** | The package uses a capability with a known limitation. Installation may still be offered when it is safe, with the reason shown. |
| **Unsupported** | A required capability is documented as unavailable, or the package fails startup. Kestrel does not install a package that is already known to be unsupported. |
| **Not yet verified** | Kestrel cannot confidently classify one or more requirements. The review explains why instead of treating the install as success. |

The Extensions settings surface lists the name, version, source, enable state,
declared access, compatibility evidence, relevant findings, reload/remove
controls, and an extension ID in developer diagnostics. Normal users receive
sanitized failures; native paths and runtime internals stay out of the UI.

## Security and profile boundaries

Only a real Chrome Web Store listing URL or a 32-character extension ID enters
the store flow. Kestrel fetches the CRX3 through the store endpoint, verifies
the signed key and derived extension ID, caps download/extraction sizes,
rejects malformed paths, encrypted archives, ZIP64, duplicate paths, symlinks,
and containment escapes, and injects the verified key into the durable manifest
identity. The opaque review handle expires after five minutes and can be used
once; it cannot substitute a different package after the person reviewed it.

Store packages are installed under Kestrel's owner-only browser extension
directory. The renderer receives no package filesystem path. Local unpacked or
file installations are development-only and remain separate from the signed
Web Store route.

## Migration path

The migration target is **not** a Chromium rewrite in this increment. The
runtime boundary exists so a native Chromium adapter can later replace the
Electron adapter. That adapter must earn any improved compatibility status with
its own documented behavior and runtime evidence; it must not silently upgrade
old reports. Until then, the Extensions subsystem is **abstracted,
Electron-backed, and dual-backend-ready**, not Chromium-owned.

## Verification scope

To exercise the normal Store route against the canonical installed app:

```bash
KESTREL_DESKTOP_EXECUTABLE=/Applications/Kestrel.app/Contents/MacOS/Kestrel \
  KESTREL_TEST_REAL_CHROME_WEB_STORE=1 corepack pnpm test:desktop-extension-store
```

This canary uses a disposable profile and checks the actual native window IDs,
Kestrel's tab rail and agent sidebar, signed-package review and installation,
and enablement after a full app restart. Its receipt records the installed
`app.asar` hash and explicitly identifies the Electron runtime. Evidence stays
under `.tmp/kestrel-store-window-evidence/`; no personal profile is modified.
The navigation sidebar follows Kestrel's normal page layout and the agent panel
remains accessible beside the Store. This is separate from native Chromium
extension-parity verification.

Focused unit coverage uses disposable temporary profiles and synthetic signed
CRX3 fixtures to exercise content scripts, action/background declarations,
Manifest V3 service workers, storage, context menus, declarative net request,
tabs, messaging, dynamic/unknown APIs, explicitly unsupported storage, token
reuse, malformed records, and restart persistence. The browser smoke can
optionally exercise a live Chrome Web Store package when
`KESTREL_TEST_REAL_CHROME_WEB_STORE=1`; that is a live integration canary, not
a replacement for deterministic local tests. Live package availability and
Google's delivery service are external dependencies, so a passing local test
does not claim permanent third-party compatibility.

## Native browsing and live Store verification

The packaged Apple Silicon app includes the separate compatibility browser.
Availability and startup errors are visible inside its explicit browser
Settings disclosure. Normal Store navigation stays inside Kestrel and does not
launch that browser.

Run the live Store canary after preparing the native sidecar:

```bash
node scripts/prepare-native-browser-sidecar.mjs
KESTREL_TEST_REAL_CHROME_WEB_STORE=1 corepack pnpm test:native-web-store
```

This separate-runtime test opens JSON Formatter's official Store listing in a disposable native
profile with mock credential storage and no personal accounts. Complete the
normal **Add to Chrome** flow in that test window within three minutes. The
test checks Chromium's signed Store installation record, its actual enabled
extension registry, bridge isolation, and enablement after a full process
restart without a sideload flag. It saves executable-bound evidence under
`.tmp/native-web-store-evidence/` and removes only its owned test profile after
shutdown. It does not verify system Keychain behavior, update delivery or
compatibility of every Store extension. It does not prove native extension
integration in the existing Kestrel window.

`corepack pnpm dev:native-browser` connects the native CEF Kestrel shell to a
separate Chrome-style CEF browser process. Chrome's own extension manager is
available through **Manage Chrome extensions**. This lane uses isolated temporary
profiles and does not import the Electron extension inventory or change the
installed app. The privileged shell remains extension-free; extension pages and
websites never receive Kestrel's bridge or Core credentials. See
[the runtime migration guide](./desktop-runtime-migration.md#native-shell-with-chrome-extension-browsing)
for commands, current verification scope and remaining cutover boundaries.
