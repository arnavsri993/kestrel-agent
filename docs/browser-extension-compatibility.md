# Browser extension compatibility

Kestrel can install selected Chrome Web Store extensions, but it is not
Google Chrome or Microsoft Edge. The Chrome Web Store sees Kestrel's Electron
runtime as a non-Chrome browser, so Google's ordinary **Add to Chrome** control
does not authorize an install. Kestrel deliberately does not spoof Chrome,
modify the store page, or inject a brittle replacement into Google's DOM.

Instead, when a person opens a real Chrome Web Store listing, Kestrel provides
one browser-level **Review & add** action. The action is deliberately separate
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

## Current boundary

The extension subsystem has three layers:

```text
Kestrel browser UI and typed IPC
  -> BrowserExtensionManager and compatibility report
  -> ExtensionRuntime adapter
  -> ElectronExtensionRuntime (shipping desktop) or ChromiumExtensionRuntime (native CEF lane)
```

`BrowserExtensionManager` owns signed-package validation, safe extraction,
review-token lifecycle, persistence, enable/disable/reload, compatibility
analysis, and public record redaction. It has no Electron `Session` dependency.
`ElectronExtensionRuntime` remains the shipping desktop adapter. The native CEF
lane injects `ChromiumExtensionRuntime` with either a legacy startup-registration
port or an opt-in live native port. Chromium-backed compatibility
analysis may emit `chromium_documented` evidence; existing Electron-era reports
are never rewritten in place.

### Live native extension lane

The CEF 152 normal-tab-model host supports `--kestrel-live-extensions` together
with `--kestrel-user-extensions` and `--kestrel-chrome-tab-model`. The trusted
native process owns a private browser-protocol socket pair; it creates no TCP
listener unless debugging is explicitly requested at launch. The renderer can
only list, inspect, install a reviewed package, toggle, reload, or uninstall.
It cannot submit a protocol method, script, package path, or profile path.

The native host seeds denied file access before loading each reviewed package,
then verifies actual Chromium identity, version, path, enabled state, and file
permission. A hidden Chromium management document supplies data-preserving
enable/disable controls without a second visible window or tab. The privileged
Kestrel shell remains in its separate extension-free browser context.

`Check updates` downloads a fresh signed package using the actual native Chromium
version. A newer version requires a new review handle; downgrade attempts are
rejected. Update and uninstall journals prevent a process interruption from
loading new bytes under old permission metadata or resurrecting an uninstall.
Uncertain runtime removal preserves package copies and blocks further changes
until acknowledged recovery. These are reviewed updates; Chromium's background
Store updater remains outside this lane's verified behavior.

The live smoke uses a disposable profile and the real JSON Formatter Store
package. It exercises Kestrel's visible review/install and update controls,
content-script behavior, toggles, reload, storage after restart, uninstall, and
the absence of Kestrel's privileged bridge on extension/user pages:

```sh
corepack pnpm build:native-chromium-host
KESTREL_NATIVE_TEST_APP="$PWD/.tmp/native-chromium-host/Kestrel.app" \
  corepack pnpm test:native-live-extensions
```

The native `storage.sync` namespace has verified local caching across restart;
account and cross-device synchronization remain unavailable. This development
lane does not replace `/Applications/Kestrel.app` or establish arbitrary Store
extension compatibility, production signing, profile transfer, or Electron
retirement. The native parity gate continues reporting its separate gaps.

The normal native development route (`KESTREL_DESKTOP_RUNTIME=chromium corepack
pnpm dev:desktop`) uses this live user-browser lane in its separate durable
native development profile. It does not open the isolated extension workbench.

The current runtime is Electron's persistent user-browser partition. Electron
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
