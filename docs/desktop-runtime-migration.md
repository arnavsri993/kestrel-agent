# Incremental desktop runtime migration

Kestrel's installed desktop still uses Electron for its window and browser host.
Chromium is the target browser engine, but migration is now happening on the
shipping process path as well as in the thin Chromium host: packaged Kestrel
launches Agent Core as a standalone Node sidecar rather than an Electron utility
process. That removes Electron from the long-running agent/core failure domain;
it does not yet replace the desktop window or browser surface.

## Agent Core supervision boundary

`apps/core-service/src/core-supervisor.ts` no longer imports Electron or chooses
how to launch a process. Its required `processFactory` supplies the small
`CoreProcess` contract from `core-process.ts`. The supervisor retains bootstrap,
validated messages, request deadlines, browser cancellation, crash recovery and
shutdown. A future host can use it without loading Electron.

The current desktop entry point supplies `desktopCoreProcess` from
`electron-core-process.ts`. Packaged apps launch the signed Node executable at
`Contents/Resources/agent-core/node/bin/node` with the built service at
`Contents/Resources/agent-core/service/index.js`. Development retains the
existing explicit Node opt-in or Electron utility adapter so normal source
iteration stays fast. Credential filtering stays at that desktop composition
boundary. Credentials needed by Agent Core continue to arrive through protected
bootstrap IPC.

`node-core-process.ts` takes an executable, entry path and environment explicitly.
It uses Node child-process IPC with the existing binary codec. It does not choose
a runtime from PATH or inherit the supervisor's environment implicitly.

## Packaged Agent Core sidecar

`scripts/prepare-agent-core-sidecar.mjs` builds the Electron-free service,
downloads one pinned and checksummed Node 22 Apple-Silicon distribution, and
creates a symlink-free Node dependency tree. Native SQLite and Sharp artifacts
are copied from the Node-compatible workspace installation, never from
electron-builder's Electron-ABI rebuild output. The sidecar carries Node's
license and a provenance manifest. Packaging refuses to continue if that tree
is missing; post-sign verification runs the sidecar's Node executable and checks
that it reports no Electron runtime.

Run the source-level sidecar smoke with:

```sh
corepack pnpm test:agent-core-sidecar
```

It starts the actual bundled Node runtime and service with a disposable profile,
requests a snapshot, kills the child, observes automatic recovery, and reads a
second snapshot. The packaged restart-recovery smoke additionally asserts that
the live Kestrel child command is the resource Node executable and service entry.
Neither check opens or mutates a person's profile.

## Reproducible non-Electron proof

With a supported Node runtime and Node-compatible native dependencies:

```sh
corepack pnpm build:core
corepack pnpm test:node-core
```

The smoke runner imports the real supervisor without mocking Electron, launches
the standalone Agent Core build with Node, opens a disposable database, requests
a validated workspace snapshot, kills the child, waits for automatic recovery, reads another
snapshot, and shuts down. It uses a temporary home and empty provider configuration;
it does not open the user's profile or require a model account.

## Standalone service

`apps/core-service` owns core bootstrap and the Node parent-port transport. Its
esbuild build bundles JavaScript dependencies, leaves native SQLite and Sharp
modules external, copies database migrations, and rejects Electron imports. The
build is independent of electron-vite and emits `apps/core-service/out/index.js`.
The Node host uses that entry with the current workspace's Node-compatible native
dependencies. This is a runnable service artifact, not a self-contained installer.

The desktop utility entry only selects its Electron parent port or Node adapter
and calls the same service bootstrap. No duplicate core implementation exists.
CI runs the Node smoke after the workspace build, before desktop packaging can
rebuild native dependencies for Electron. Packaging may change native module ABI;
restore Node-compatible native dependencies before repeating a Node smoke if needed.

Passing the Node sidecar smoke proves core bootstrap, requests and recovery work
without Electron in the same executable shape that the packaged app uses. It
does not prove a replacement browser window, credential store or renderer bridge.

## Portable renderer and host bridge

The React renderer can be built with plain Vite, independently of
`electron-vite`, using `corepack pnpm build:renderer`. Its shared configuration
owns React compilation, relative asset paths and the renderer CSP nonce. Both
the Electron renderer build and the native CEF renderer build consume it.
Renderer builds reject Electron imports so host APIs cannot creep into the UI
bundle. Electron still owns its main/preload build and the canonical window.

`createRendererBridge` in `@kestrel/shared-types` supplies the same public API,
request validation and event validation for both hosts. It receives a small
`RendererTransport` with request, subscribe and optional readiness signals.
The Electron preload supplies IPC transport and keeps focus, deep-link and
external-intake readiness notifications. Native CEF supplies JSON queries and
subscription cancellation only; the renderer's first bootstrap dependency
installs the shared bridge before app modules evaluate, then removes the raw
transport global. Remote pages and extension contexts receive neither bridge.
CEF retains its immutable query/cancel globals in the trusted shell; the
browser-side exact-frame and URL checks remain the authority boundary.

Malformed events are dropped, unsubscribe is idempotent and queued events stop
after disposal. This extraction does not add runtime validation for the full
`RendererResponse` union; the existing Core supervisor still validates Core
responses separately. Native host command support and profile ownership retain
their existing limits. The static native smoke shell uses the raw transport for
its private `native-host-status` probe, outside the product renderer API.

## Native Chromium desktop host

`apps/native-chromium-host` is the native macOS desktop-host migration lane. It
packages the existing Kestrel renderer with a CEF Chromium browser process and
its renderer, GPU, network, and utility helpers, plus the standalone Node Agent
Core sidecar. It is not a Playwright shell or a second renderer: the full
Kestrel renderer reaches the host through a local-only CEF bridge, and user
browser tabs run as sibling native `CefBrowserView`s in the same window.

Use the native lane directly during development:

```sh
corepack pnpm build:native-chromium-host
corepack pnpm dev:native-chromium-host
corepack pnpm test:native-chromium-host
corepack pnpm test:native-chromium-core-relay
```

The foreground launcher builds the app into `.tmp`, gives it one newly-created
temporary profile, starts an ephemeral Core, and removes only that temporary
profile after the app exits. It never reads, copies, migrates, or writes the
installed Electron profile. Chromium defaults to mock Keychain storage and
disables background account/update paths, so native startup does not request
Keychain access or launch an authentication flow. Provider credentials use a
profile-sealed store under `{isolated-profile}/secure/` (never Electron's
Application Support path or `Kestrel Safe Storage` Keychain service). Real
macOS Keychain / Chromium Keychain is opt-in via `--kestrel-real-keychain` /
`KESTREL_USE_REAL_KEYCHAIN=1` and uses the separate service name
`Kestrel Native Safe Storage` so Electron items are never silently opened.
Remote pages receive no Kestrel bridge.

`build:native-chromium-host` produces an ad-hoc-signed development bundle with
a separate development identity. It does not call `install:mac:dev`, replace
`/Applications/Kestrel.app`, or change the canonical desktop app. A canonical
cutover still requires a separately reviewed profile/credential compatibility
design, production signing/notarization, and proof of the remaining desktop
capabilities. Keep the Electron adapter in place until those replacement
boundaries have been exercised.

## Native extension workbench

Run `corepack pnpm dev:native-extensions` on Apple Silicon macOS to build and
open the same native CEF executable in an opt-in Chrome-style mode, starting at
`chrome://extensions/`. Chromium supplies its toolbar, extension manager,
permission dialogs, and popup windows. Enable Developer mode and use **Load
unpacked** to test a local extension, or follow the manager's Chrome Web Store
link. No Electron process is involved.

This is a compatibility workbench, not a replacement for the installed Kestrel
app. The launcher creates a disposable profile and removes it after exit,
including installed extensions, their settings, and browser sessions. It has no
Kestrel shell, Core relay, custom `kestrel:` scheme, or native message-router
bridge, including in renderer helpers. Combining the workbench flag with the
privileged renderer or ephemeral Core flags is rejected. Mock Keychain and the
existing background-networking restrictions remain enabled. Those flags are
not a network firewall: visiting the store and running extensions can make
network requests. Use test data here, not personal accounts.

`corepack pnpm test:native-extensions` builds the native artifact and checks:

- Chromium's real extension manager displays a locally loaded MV3 fixture.
- A content script sends a message to its service worker and receives a reply.
- `chrome.storage.local` retains an incremented value across page reloads.
- Extension pages render, ordinary popups survive closing their opener, and
  closing the browser exits cleanly.
- Remote pages, extension pages, and even the bundled shell file have no native
  bridge in this mode; renderer/GPU/utility processes remain sandboxed.

This smoke is part of `corepack pnpm verify` and the macOS core CI job so the
extension workbench's defining security and compatibility boundary is checked
by broad local and pull-request validation.

Screenshots are written to `.tmp/native-extension-evidence`. A just-built
artifact can be tested without rebuilding by setting `KESTREL_NATIVE_TEST_APP`
to its absolute `.app` path. The test always creates its own temporary profile
and uses a local HTTP server; it does not install a third-party extension or
require the Web Store to be online.

A manual check on 2026-09-21 opened the real Chrome Web Store and reached the
native permission dialog for uBlock Origin Lite. The dialog was canceled.
End-to-end store installation, update delivery, persisted extensions across
app restarts, toolbar action popups, and broad extension API compatibility are
**not yet verified**. Store pages also displayed a “Switch to Chrome” banner;
reaching a permission dialog alone is not evidence of complete store support.
CEF's upstream [extension management issue](https://github.com/chromiumembedded/cef/issues/3450)
documents Chrome-style management and the remaining programmatic API boundary.

The product-shell user-extension lane is available with
`--kestrel-user-extensions` plus Chromium's `--load-extension=` path. In that
mode the privileged shell uses a separate `shell-privileged` request context
while user tabs share the default Chromium profile that receives loaded
extensions. `corepack pnpm test:native-user-extensions` proves MV3 content
scripts and `chrome.storage.local` on user tabs, bridge presence on the shell,
and no content-script injection into the privileged document. This still does
not replace `/Applications/Kestrel.app`. Next: durable native-profile ownership,
`ChromiumExtensionRuntime` wiring to `BrowserExtensionManager`, store
install/update/removal tests, and the remaining browser/agent parity gates
before any canonical-app cutover.

## Next boundaries

Current native-host progress toward cutover:

- `--kestrel-user-extensions` keeps the privileged shell extension-free while
  user tabs share Chromium's default profile for `--load-extension`
- `ChromiumExtensionRuntime` + file host port persist verified unpack paths for
  startup loading (CEF 152 has no programmatic LoadExtension API)
- `--kestrel-durable-profile` opts into persistent session cookies on the
  isolated user-browser context and writes
  `{isolated-profile}/browser-library.json` for bookmarks, history, downloads,
  and site permissions (never the Electron Application Support profile)
- Bridge commands `browser-toggle-bookmark`, `browser-remove-bookmark`,
  `browser-clear-history`, `browser-set-site-permission`,
  `browser-clear-site-permission`, and `browser-clear-data` mutate that library
- `corepack pnpm test:native-durable-browser-library` proves seed → restart restore
- CEF `DownloadHandler` captures live HTTP(S) attachments into
  `{isolated-profile}/downloads/` and durable library metadata;
  `browser-cancel-download` cancels in-flight items
- `corepack pnpm test:native-download-capture` proves live capture + restart
- Native Core relay forwards `browser-backend-request` to CEF instead of
  fail-closing; host owns `visible-tabs` / `visible-create` /
  `visible-navigate` / `visible-select` / `visible-close` /
  `visible-history` / `visible-downloads` / `visible-context`
- `corepack pnpm test:native-browser-backend` proves relay→CEF visible-tab
  automation including `visible-context`
- Isolated automation sessions use hidden Alloy BrowserViews on the shared
  user-browser request context (separate CEF profiles currently fail on CEF
  152), enforce a per-session origin allowlist, and answer `create` /
  `navigate` / `snapshot` / `act` / `close` (async navigate completes on the
  target load; snapshot/act use CEF DevTools `Runtime.evaluate` with fixed
  host scripts and `data-kestrel-ref` targets)
- `corepack pnpm test:native-isolated-automation` proves
  create→navigate→snapshot→act(click)→close through the Core relay
- Profile-sealed credential bootstrap answers `credential-list` /
  `credential-set` / `credential-remove` without Keychain prompts;
  `corepack pnpm test:native-credential-bootstrap` proves set→has→remove
- HTTP(S) `window.open` popups are adopted as sibling Alloy user tabs
- `corepack pnpm package:mac:native` / `install:mac:native` package the CEF host;
  side-by-side install is the default (`Kestrel Native.app`); canonical Dock
  replacement requires `KESTREL_INSTALL_NATIVE_CANONICAL=1`

`pnpm-workspace.yaml` `auditConfig.ignoreGhsas` ignores `GHSA-hp3w-g68c-fv3c`
(`sprintf-js` via `electron-builder`) until Electron packaging is removed: no
`>=1.1.4` release exists on npm yet.

## Electron → native profile transfer

Native Chromium must never silently open, merge, or overwrite the Electron
Application Support profile. Transfer is an explicit, bounded product step
implemented as `kestrel migration` with `--product kestrel-electron`:

```bash
# Isolate CLI state while inspecting an existing Electron profile.
export KESTREL_DATA_DIR=/absolute/path/to/temporary-kestrel-cli-state

corepack pnpm cli -- migration plan \
  --product kestrel-electron \
  --source /absolute/path/to/Electron/Application/Support/Kestrel \
  --target /absolute/path/to/isolated-native-profile \
  > /absolute/path/to/kestrel-electron-native-plan.json

corepack pnpm cli -- migration apply \
  --plan /absolute/path/to/kestrel-electron-native-plan.json \
  --approve yes \
  --overwrite no
```

1. **Dry-run first.** The plan lists transferable categories (instruction
   files such as `AGENTS.md`, learned skills, non-secret
   `runtime-preferences.json` signals, and a synthesized
   `browser-library.json` converted from Electron `browser/state.json`) with
   source and target paths, checksums, conflict status, and an inventory of
   rejected credential/database paths. Nothing is written until apply is
   approved.
2. **No credential copy by default.** Keychain items, OAuth tokens, cookies,
   provider login caches, `provider-accounts.json`, and the encrypted desktop
   database stay on the source profile. Re-auth or a future dedicated
   Keychain migration path is required; raw-copying encrypted DB + Keychain
   into another profile is rejected.
3. **No overwrite by default.** Conflicts skip unless the person opts into
   overwrite. Sources are preserved; apply writes a recoverable
   `.transfer-backup-*` tree under the target before mutating conflicting
   files.
4. **Containment.** Reject symlinks, binaries, oversized files, and paths that
   escape the declared source/target roots. Changed checksums abort apply.
   Download metadata never claims `canReveal` for Electron filesystem paths.
5. **Side-by-side until cutover.** Development defaults to the Chromium/CEF
   host (`KESTREL_DESKTOP_RUNTIME` defaults to `chromium`). Electron remains
   in-tree via `KESTREL_DESKTOP_RUNTIME=electron` / `dev:desktop:electron` and
   still owns the historical Dock app until retirement. Native installs as
   `Kestrel Native.app` unless `KESTREL_INSTALL_NATIVE_CANONICAL=1` replaces
   `/Applications/Kestrel.app` after retirement acceptance.

Unit coverage lives in
`packages/agent-core/src/electron-native-profile-transfer.test.ts`. Live
acceptance still requires a dual-profile dry-run/apply against a real Electron
profile into an isolated native durable profile before
`KESTREL_ACCEPT_ELECTRON_RETIREMENT=1`.

### Developer ID signing + notarization (native Chromium)

Ad-hoc `package:mac:native` is enough for local smokes and side-by-side
`Kestrel Native.app`. Canonical Dock cutover requires a release-signed,
notarized package:

```sh
# Requires a Developer ID Application identity in the keychain.
export KESTREL_NATIVE_CODESIGN_IDENTITY="Developer ID Application: Example Inc (TEAMID)"

# Optional readiness check (identity + notary credentials only):
corepack pnpm check:native-signing -- --readiness

corepack pnpm package:mac:native:release

# Notary credentials: NOTARYTOOL_PROFILE / KESTREL_NOTARY_PROFILE, or
# APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
corepack pnpm notarize:mac:native

# Full evidence gate (codesign + stapler + spctl):
corepack pnpm check:native-signing
```

Until `check:native-signing` exits 0 against
`release/native-mac-arm64/Kestrel.app`, Electron packaging remains required and
`KESTREL_INSTALL_NATIVE_CANONICAL=1` must not be used for Dock replacement.

Still required before retiring Electron:

- Real Keychain path on a Developer ID–signed durable build (no ad-hoc prompt
  spam); profile-sealed bootstrap is proven for development/cutover
- Website password-vault `visible-autofill` on CEF now probes the page for
  login controls (`not_active` / `not_a_login_form` / `unavailable`) and
  `test:native-browser-backend` asserts the unavailable probe path on a local
  login form. It still cannot fill from a migrated vault (provider credential
  bootstrap is separate and already profile-sealed). Full password-vault
  migration remains pending before claiming autofill parity.
- After every gate has live evidence, `KESTREL_ACCEPT_ELECTRON_RETIREMENT=1`
  unlocks `corepack pnpm retire:electron` to delete Electron packages and
  default desktop runtime selectors to chromium.
- Production Developer ID signing + notarization (`check:native-signing`)
- Retargeted desktop smokes against the native binary on a durable profile
- Live acceptance of `kestrel-electron` transfer on a real dual-profile
  dry-run/apply (CLI + unit coverage exist; silent merge remains forbidden)

## Chromium preview host

`apps/chromium-host` launches sandboxed Chromium through Playwright and the shared
Node core, without Electron. Run:

```sh
corepack pnpm exec playwright install chromium
corepack pnpm dev:chromium
```

The preview has conversations, provider/model selection, cancellation, and real
web tabs. It uses a temporary database and Chromium context; closing its Kestrel
tab deletes the preview data. It never imports the installed desktop profile,
Keychain, or provider login caches. Supported provider environment variables are
explicitly selected in `src/index.ts`; do not enter secrets in chat. With no
provider configured, the shell and web tabs work and Send is disabled.

The conversation bridge is scoped to the local main frame of the original shell
page, with an explicit command allowlist. Remote web pages receive no binding.
The model receives no tools; tools, approvals, browser context, durable profiles,
secure credential setup, download management and native app packaging still need
migration. This is a development preview, not a second installed Kestrel app.

`corepack pnpm test:chromium-host` runs real Chromium and Agent Core against a
local model fixture. It verifies conversation replies, reload, cancellation,
web navigation, bridge rejection, draft isolation and narrow layout. Set
`KESTREL_CHROMIUM_HEADED=1` to run the same checks visibly. Fixture responses
prove integration, not a live provider login or model-quality claim.

The Chromium tab manager owns both explicitly opened tabs and page-created
popups (`target=_blank` / `window.open`). Context page events register each page
once, excluding the privileged shell; navigation and close events refresh the
sidebar. A shared 16-tab limit also applies to popups, and excess pages close.
Closing a tab releases capacity. Remote pages and their popups never receive the
shell binding. Browser history and document navigation remain Chromium-owned.
