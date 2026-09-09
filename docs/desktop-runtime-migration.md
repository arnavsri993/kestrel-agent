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
corepack pnpm build:desktop
corepack pnpm test:node-core
```

The smoke runner imports the real supervisor without mocking Electron, launches
the built Agent Core with Node, opens a disposable database, requests a validated
workspace snapshot, kills the child, waits for automatic recovery, reads another
snapshot, and shuts down. It uses a temporary home and empty provider configuration;
it does not open the user's profile or require a model account.

The build command still uses the existing Electron-oriented bundler. Passing the
Node smoke proves that supervision and the core process can run without an
Electron host; it does not prove a replacement browser window, packaging system,
credential store or renderer bridge. Packaging may rebuild native dependencies
for Electron, so run the Node smoke before packaging or restore Node-compatible
native dependencies before repeating it.

## Next boundaries

A following slice should separate the utility entry point's parent-port adapter
from core bootstrap, then provide a standalone Node build. A Chromium host still
needs implementations for visible browser views, window lifecycle, secure
storage, permission prompts and renderer transport. Keep each transition backed
by the current desktop adapter and real process tests until its replacement has
been exercised.
