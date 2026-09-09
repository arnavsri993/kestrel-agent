# Incremental desktop runtime migration

Kestrel's installed desktop still uses Electron. Chromium is the target browser
engine; a replacement desktop host has not yet been implemented or validated.

## Agent Core supervision boundary

`apps/desktop/src/main/core-supervisor.ts` no longer imports Electron or chooses
how to launch a process. Its required `processFactory` supplies the small
`CoreProcess` contract from `core-process.ts`. The supervisor retains bootstrap,
validated messages, request deadlines, browser cancellation, crash recovery and
shutdown. A future host can use it without loading Electron.

The current desktop entry point supplies `desktopCoreProcess` from
`electron-core-process.ts`. Packaged apps still launch an Electron utility
process; development and the existing explicit Node opt-in still use Node.
Credential filtering stays at that desktop composition boundary. Credentials
needed by Agent Core continue to arrive through protected bootstrap IPC.

`node-core-process.ts` takes an executable, entry path and environment explicitly.
It uses Node child-process IPC with the existing binary codec. It does not choose
a runtime from PATH or inherit the supervisor's environment implicitly.

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

Passing the Node smoke proves core bootstrap, requests and recovery work without
Electron. It does not prove a replacement browser window, credential store or
renderer bridge.

## Next boundaries

A Chromium host still needs implementations for visible browser views, window lifecycle, secure
storage, permission prompts and renderer transport. Keep each transition backed
by the current desktop adapter and real process tests until its replacement has
been exercised.
