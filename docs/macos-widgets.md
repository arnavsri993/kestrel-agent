# macOS widgets

Kestrel ships a native WidgetKit extension inside packaged macOS builds. It
offers three intentionally quiet widgets:

- **Focus** — what Kestrel is working on, whether it needs you, and a direct
  route back to the Agent surface.
- **Queue** — pending approvals and active workers, with a direct route to
  review consequential actions.
- **Pulse** — today's model use, the selected route, active workers, and
  connection health.

The widgets are read-only. Kestrel publishes a small derived snapshot to
`group.com.kestrel.desktop/widgets.json` when the local core starts and when a
new workspace snapshot arrives. The snapshot contains status, bounded focus
labels, counts, model display metadata, and cost totals; it does not contain
prompts, message bodies, credentials, project paths, or tool output. The file
is written atomically with owner-only permissions.

## Add the widgets

1. Install or build a packaged Kestrel app.
2. Open the macOS widget gallery from **System Settings → Desktop & Dock →
   Widgets** (or the desktop context menu) and search for **Kestrel**.
3. Add **Focus**, **Queue**, or **Pulse** in the size that fits your desktop.

Selecting a widget opens Kestrel through its existing `kestrel://` deep-link
route. The app remains the authority for approvals and actions; a widget never
approves, starts, or cancels work.

## Build and verify locally

Packaging invokes `scripts/build-macos-widgets.mjs` from the Electron
`afterPack` hook. It compiles the Swift source with the system `swiftc`,
embeds `KestrelWidgets.appex` under `Contents/PlugIns`, and signs the nested
extension with the configured macOS identity. A macOS 13 SDK or newer and the
Swift toolchain from Xcode Command Line Tools are sufficient for the local
build:

```bash
corepack pnpm package:mac:dev

codesign --verify --deep --strict \
  release/mac-arm64/Kestrel.app/Contents/PlugIns/KestrelWidgets.appex
plutil -p \
  release/mac-arm64/Kestrel.app/Contents/PlugIns/KestrelWidgets.appex/Contents/Info.plist
```

The development app is ad-hoc signed, so it is local validation rather than
release evidence. Public distribution still requires a Developer ID identity,
notarization, and an Apple Developer team with the
`group.com.kestrel.desktop` App Group registered for both the host app and the
widget extension. Do not call the widgets distribution-ready until the signed
and notarized artifact has been tested in the macOS widget gallery.
