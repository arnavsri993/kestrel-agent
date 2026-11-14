# Incremental desktop runtime migration

The current native desktop candidate uses a normal Chromium-owned window and
the existing Kestrel UI as a private extension. See
[Native Chromium release evidence](native-chromium-release.md) for its commands,
security boundary, verified Store behavior, and remaining release gates. The
Alloy and reparented-window probes below are historical implementation work;
their passes do not establish parity for the current desktop candidate.

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

The foreground launcher builds the app into `.tmp`. By default it gives it one
newly-created temporary profile, starts an ephemeral Core, and removes only
that temporary profile after the app exits. `dev:desktop:chromium` selects
`--durable`: the native browser library and Core database persist separately at
`~/Library/Application Support/Kestrel Native/Development`. The Core keeps its
database under `native-core/database/` and a 32-byte database key in a private
`native-core/database.key` file (0600, inside a 0700 directory). This is a
development storage boundary, not hardware-backed or Keychain protection.
Missing/corrupt keys fail without rotating a key or resetting existing data;
linked or non-private key files and linked database paths are rejected.
`test:native-core-durability` proves conversation restoration after normal
restart and relay crash. Core shuts down when the relay's IPC disconnects.
The native launcher never reads, copies, migrates, or writes the
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
End-to-end store installation, update delivery, toolbar action popups, and broad
extension API compatibility are
**not yet verified**. Store pages also displayed a “Switch to Chrome” banner;
reaching a permission dialog alone is not evidence of complete store support.
CEF's upstream [extension management issue](https://github.com/chromiumembedded/cef/issues/3450)
documents Chrome-style management and the remaining programmatic API boundary.

The product-shell user-extension lane is available with
`--kestrel-user-extensions` plus Chromium's `--load-extension=` path. In that
mode the privileged shell uses a separate `shell-privileged` request context
while user tabs share the default Chromium profile that receives loaded
extensions. `corepack pnpm test:native-user-extensions` exercises the persisted
host-port registration, MV3 content scripts and worker messaging, storage and
extension identity across two complete app launches, `tabs.get`, scripting,
and actual declarative network request blocking. It checks bridge presence on
the shell and no content-script injection into the privileged document. It
uses a copied fixture in a path with spaces and quotes and a generated manifest
public key. The registry ID must match Chromium's real key-derived ID, and
neither launch passes `--load-extension`. This still does
not replace `/Applications/Kestrel.app`. Next: durable native-profile ownership,
`ChromiumExtensionRuntime` wiring to `BrowserExtensionManager`, store
install/update/removal tests, and the remaining browser/agent parity gates
before any canonical-app cutover.
The file registration port reports readiness as `not_checked` and rejects a
worker-start verification request: an existing startup entry alone cannot
prove live activation. The browser smoke verifies actual worker execution.

The user-extension smoke loads the real React renderer with a durable test
profile. The privileged request context registers its own bundled-resource
handler: global scheme registration alone cannot serve the app in that separate
context. The smoke checks a mounted React root and a real Core snapshot while
retaining the extension-injection and bridge-isolation checks.
The app renderer and user web tabs explicitly enable CEF's platform
accessibility tree; hidden automation views keep their separate behavior.

### Same-product and extension acceptance

The existing React interface remains the visual and workflow target. Retiring
Electron must preserve onboarding, provider sign-in, local model setup, agents,
tools and approvals, projects/files, settings, browsing, autofill, credentials,
and restart recovery. A mounted renderer and a responding Core do not establish
those complete workflows.

The expanded extension probe exposed an important product-lane limitation:
`chrome.tabs.get` returns the actual Alloy user tab, but `chrome.tabs.query`
does not enumerate it. The same query succeeds in the Chrome-style workbench.
The native host now has a bounded `--kestrel-chrome-extension-view` probe that
keeps the real React Kestrel shell as an Alloy sibling, changes the same
top-level Kestrel window to Chrome style, and gives one user BrowserView Chrome
style with Chromium's toolbar hidden. The user-extension smoke requires
`chrome.tabs.query` to find that real user page while preserving the shell's
separate request context and bridge isolation. The Chrome view must attach
before the Alloy shell, then move above the shell in native painting order;
attaching Alloy first makes CEF reject the later Chrome view. The host checks
that both views report the same actual `CefWindow`, and the smoke captures that
native window with the normal React browser layout. Its disposable profile
skips first-run UI only; it does not establish onboarding or account readiness.
After CEF's default FillLayout runs, the host restores React's reported content
bounds so the Chrome surface cannot cover the tab rail or agent sidebar. The
smoke checks the actual page viewport against those DOM bounds before capture.
The flag is rejected unless
`--kestrel-user-extensions` is also present. It is not enabled by the normal
product launcher and does not touch the installed app or an existing profile.

The older `--kestrel-chrome-extension-view` probe still cannot claim full Chrome
extension support. Do not patch extension JavaScript to fake missing APIs. CEF
allows only one Chrome-style BrowserView in a Chrome-style window, so additional
BrowserViews in that probe stay Alloy. A product cutover
needs a deliberate mapping between Kestrel's React tab rail and Chromium's
single Chrome-style browser surface, plus extension action/popup integration,
before this probe can become the default.
CEF's [runtime-style contract](https://github.com/chromiumembedded/cef/blob/708dc14/include/internal/cef_types_runtime.h)
allows only one Chrome-style BrowserView per Chrome-style window, so switching
each existing sibling Alloy view to Chrome style is not a valid repair.

The opt-in `--kestrel-chrome-tab-model` lane now uses a non-Views, normal Chrome
window and its real TabStripModel. The existing Kestrel React renderer runs as
an Alloy native child in a separate request context in that same NSWindow.
Native browser IDs map to Kestrel's tab rail; real Chrome commands create user
tabs, and extension-created tabs are observed through normal CEF callbacks.
There are no extension JavaScript API shims. A clipped native viewport and
deferred AppKit resize notifications keep Chrome's content and controls inside
React's reported browser bounds, clear of the agent pane.

Run `corepack pnpm test:native-chrome-tab-model` against an explicit candidate
with `KESTREL_NATIVE_TEST_APP=/absolute/path/to/Kestrel.app`. It proves both
Kestrel-created and extension-created tabs share the same Chrome window,
background creation preserves selection, extension updates/removal reach the
React tab model, last-tab close retains Kestrel Home, and an actual
`chrome.action.openPopup` target renders without the privileged bridge. The
native Chrome toolbar remains visible inside the browser region in this
experimental lane. It is not enabled by the canonical launcher. Isolated
automation still uses the older Views path and is not migrated in this mode.

`test:native-user-extensions` writes the observed subset and remaining gaps to
`.tmp/native-user-extension-evidence/compatibility.json`, bound to the tested
executable's SHA-256. `corepack pnpm test:native-extension-parity` runs the same
checks with the normal Chrome tab model and exits nonzero until every required
extension acceptance item has evidence. Kestrel's install/live-toggle flow,
Chrome Web Store installation and updates remain unverified. The older Views
probe continues to report failed tab ownership; the normal model derives that
check from actual create/update/remove behavior. Loading an unpacked fixture
does not establish arbitrary Store compatibility or install/update support.

A disposable-profile test of the official JSON Formatter Store listing reached
Google's "Switch to Chrome" dialog, then stalled on Add to Chrome after choosing
No thanks. It did not reach a native permission prompt or install an extension.
The pinned runtime also disables background extension updates through
`--disable-background-networking`; see Chromium's
[background-update check](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.83/chrome/browser/extensions/chrome_extensions_browser_client.cc#599).
These are release blockers, not evidence of a functioning Store installer.

The retirement gate requires an explicit app candidate and runs strict extension
acceptance against that candidate. Setting `KESTREL_ACCEPT_ELECTRON_RETIREMENT=1`
cannot override a missing or failing extension check. Canonical installation
still requires signing/notarization and the remaining same-product workflow
evidence; the installed app stays in place while any required parity is missing.

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
  automation
- Isolated automation sessions use hidden Alloy BrowserViews with a fresh
  in-memory request context for each session. User-tab cookies/localStorage
  and other sessions' storage remain separate. Context initialization waits
  for CEF's callback and rejects shared storage; a hidden view alone is not
  treated as isolation. Sessions enforce an origin allowlist and answer `create` /
  `navigate` / `snapshot` / `act` / `close` (async navigate completes on the
  target load; snapshot/act use CEF DevTools `Runtime.evaluate` with fixed
  host scripts and `data-kestrel-ref` targets)
- `corepack pnpm test:native-isolated-automation` proves
  create→navigate→viewport→upload→snapshot→act(click)→screenshot→close through
  the Core relay, plus cookie/localStorage separation from a user tab and
  another automation session on the same HTTP origin
- `visible-context` captures bounded visible text, headings, safe links,
  selected text, form descriptions and viewport metadata through CEF. It
  excludes field contents, labels sensitive controls generically and rejects
  a changed page. Core independently validates the shared page-context schema
  and redacts sensitive text and URL query/fragment values before model use
- Profile-sealed credential bootstrap answers `credential-list` /
  `credential-set` / `credential-remove` without Keychain prompts;
  `corepack pnpm test:native-credential-bootstrap` proves set→has→remove
- HTTP(S) `window.open` popups are adopted as sibling Alloy user tabs
- `corepack pnpm package:mac:native` packages the CEF host;
  `install:mac:native` replaces the same canonical `/Applications/Kestrel.app`
  only with explicit retirement acceptance and passing live signing checks.
  It refuses an unsigned/unaccepted cutover without creating a second app
- `test:packaged-native:arm64` uses the selected package directly; the host
  smoke and relay smoke honor `KESTREL_NATIVE_TEST_APP` instead of rebuilding
  an unrelated source artifact

`pnpm-workspace.yaml` `auditConfig.ignoreGhsas` ignores `GHSA-hp3w-g68c-fv3c`
(`sprintf-js` via `electron-builder`) until Electron packaging is removed: no
`>=1.1.4` release exists on npm yet.

## Electron → native profile transfer design

Native Chromium must never silently open, merge, or overwrite the Electron
Application Support profile. Transfer is an explicit, bounded product step:

1. **Dry-run first.** A plan lists categories (settings JSON that is
   non-secret, bookmarks/history/downloads from `browser-library.json` if
   present, instruction files such as `AGENTS.md`, agent/skill trees) with
   source and target paths, checksums, and conflict status. Nothing is written
   until the person approves apply.
2. **No credential copy by default.** Keychain items, OAuth tokens, cookies,
   provider login caches, and the encrypted desktop database stay on the
   source profile. Re-auth or a future dedicated Keychain migration path is
   required; raw-copying encrypted DB + Keychain into another profile is
   rejected.
3. **No overwrite by default.** Conflicts skip unless the person opts into
   overwrite for that category. Sources are preserved; apply is reversible via
   a recoverable backup of the target before mutation.
4. **Containment.** Reject symlinks, binaries, oversized files, and paths that
   escape the declared source/target roots. Changed checksums abort apply.
5. **Separate development profile until cutover.** Shipping default remains
   Electron. Native development uses its explicit isolated profile root.
   Canonical Dock replacement (`KESTREL_INSTALL_NATIVE_CANONICAL=1`) is gated
   on retirement acceptance with live evidence — not on transfer design alone.

Until a tested Kestrel-to-Kestrel restore CLI exists for the Chromium durable
profile, operators keep both profiles untouched and use the supported
reference-product migration CLI only for OpenClaw/Hermes/Codex/Claude Code
imports into an isolated target.

### Developer ID signing + notarization (native Chromium)

Ad-hoc `package:mac:native` is enough for local smokes. Canonical Dock cutover requires a release-signed,
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
- Remaining desktop command surface beyond isolated
  act/screenshot/viewport/upload and visible snapshot/act/screenshot
  (autofill parity, desktop computer use, etc.) on CEF
- Production Developer ID signing + notarization (`check:native-signing`)
- Retargeted desktop smokes against the native binary on a durable profile
- Live acceptance of the profile transfer design above on a real dual-profile
  dry-run/apply (not silent merge)

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
