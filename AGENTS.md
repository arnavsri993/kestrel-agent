# Desktop development rule

- Keep only one Kestrel desktop development session running. Start it with
  `corepack pnpm dev:desktop`; do not launch a second Electron process or a
  separately packaged Kestrel app while the development session is active.
- Leave the development watcher running after desktop source changes. Main and
  preload changes restart Electron automatically, while renderer changes use
  Vite HMR. If the watcher is not running, restart it before considering the
  change complete so the open app reflects the current source.
