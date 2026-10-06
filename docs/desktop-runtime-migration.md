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
installed Electron profile. Chromium runs with mock Keychain storage and its
background account/update paths disabled, so native startup does not request
Keychain access or launch an authentication flow. Remote pages receive no
Kestrel bridge. Native popup adoption, durable profile/credential storage,
permissions, downloads, extensions, and automation remain deliberately
unmigrated or fail closed.

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

## Native shell with Chrome extension browsing

`corepack pnpm dev:native-browser` now connects the existing Kestrel renderer
and standalone Node Core to an extension-capable Chrome-style browser. This is
an opt-in development lane on Apple Silicon macOS. It does not replace
`/Applications/Kestrel.app` or migrate an existing profile.

The shell and websites run in two CEF browser processes. The Alloy shell keeps
extensions disabled and owns the Kestrel bridge and ephemeral Core. It launches
the exact bundled executable in extension-workbench child mode with a separate
`extension-browser` profile. That child owns Chrome's browser windows, toolbar,
extension manager, permissions UI and extension pages. It has no Kestrel scheme,
renderer bridge, Core relay, provider environment or credential authority.

The shell relays only browser state, create/select/close, navigation,
back/forward/reload/stop and a dedicated extension-manager command over private
inherited pipes. JSON messages have a version, bounded sizes and pending request
limits. Requests expire, canceled renderer queries discard their callbacks, and
late replies from a retired child generation are ignored. All CEF mutations run
on the UI thread. Shell shutdown waits for owned children, with bounded targeted
termination if a child cannot consume EOF, before the launcher removes its
profile.

Pages open in separate native Chrome windows rather than embedded Alloy views.
Kestrel shows this handoff, offers **Show browser window** and **Manage Chrome
extensions**, and receives navigation/title/loading/close updates. Chrome-created
popups are tracked and share the extension browser's isolated profile. The shell
represents these windows as browsing records; full Chrome tab-strip selection,
background-tab creation and product session restore remain incomplete.

Both profiles are temporary and deleted by the development launcher after a clean exit.
A failed or force-killed host preserves its temporary profile for recovery.
Extension storage can survive a browser-child restart within that launch; this
is not durable profile migration. Keychain-backed credential storage, production
provider login, native agent browser tools, Kestrel download/permission policy,
updates/signing and canonical-app cutover remain separate gates. The native
extension manager owns install/review; Kestrel's existing Electron extension
records are not imported or silently marked compatible.

Run `corepack pnpm test:native-browser` to build and exercise the real native
processes with a local MV3 fixture. The fixture checks content scripts, service
worker messaging, storage, tabs queries, action badge state, scripting API
availability and a declarative-net-request block. The smoke also checks shell
navigation, native-manager handoff, popups, typed browser-state validation,
bridge isolation, helper sandbox arguments and shutdown with a suspended child.
It uses test profiles and a local HTTP server; it does not install a third-party
package or prove arbitrary Chrome Web Store compatibility. Screenshots live in
`.tmp/native-browser-evidence`.

A built artifact can be reused by setting `KESTREL_NATIVE_TEST_APP` to its
absolute `.app` path. The native browser smoke follows the workbench smoke in
macOS CI and `verify`, reusing that freshly built artifact.

## Next boundaries

The next native-host slices are durable profile ownership without Keychain
prompt spam, popup/adoption semantics, user-approved permission flows,
downloads/extensions, and the remaining desktop command surface. Each needs a
real process test and an explicit user-data boundary before the canonical app
can move.

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

## Installed native extension browser

The packaged Kestrel app bundles the native browser under
`Contents/Resources/native-browser/Kestrel.app`. It is a signed CEF sidecar,
with no additional installed app or Dock tile. The existing agent/window shell
continues to use Electron; website and extension execution in the native
browser uses Chromium's Chrome runtime directly.

Open **Extensions → Manage Chrome extensions** in the toolbar's Native browser
section, or use the same controls in browser Settings. **Open current page in
native browser** opens an HTTP(S) page there. Chrome owns the native toolbar,
extension permission review, install/remove controls and extension windows.
Existing embedded-browser extensions and browsing data are preserved and are
not imported. Native data lives in a separately marked owner-only persistent
profile below Kestrel's userData; unknown profiles, symlinked managed ancestors
and mock/system storage mode changes are rejected.

The persistent entrypoint accepts only workbench child mode, the persistent
browser flag and its explicit cache path. It rejects mock Keychain, debugger,
sandbox-disabling, renderer/Core and override flags before CEF loads. Persistent
browsing uses upstream Chromium's standard macOS Keychain provider; the pinned
runtime uses Chromium's shared service identity rather than a Kestrel-only key
namespace. The whole profile is not encrypted. Credential storage remains
unverified until a disposable OS-user/VM cookie/password encryption test passes;
existing application credentials and Keychain identity are not migrated.

The Node manager validates the native executable manifest/signature before
launch, uses private bounded typed pipes, strips provider environment variables,
waits for owned child exit and blocks profile deletion until shutdown. Faults
invalidate the connection and escalate TERM/KILL without deleting the profile.
It has no agent, file, credential or arbitrary-evaluation command.

`test:native-browser-manager` exercises this real Node-to-CEF path on disposable
mock profiles: MV3, native manager reuse, extension restart storage, incompatible
profile-mode rejection, ancestor symlink rejection and process shutdown. It does
not prove native Keychain encryption or arbitrary Web Store compatibility.
Canonical installation and real-profile UI verification are separate from these
fixture tests and remote CI.
