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
