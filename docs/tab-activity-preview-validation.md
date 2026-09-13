# Activity-aware tab sleeping and previews

All discard paths share protection for active tabs, agent-pinned operations,
authentication/popup flows, native playback (including muted video), loading,
active downloads, screen capture, and observed page activity. The page observer
reports boolean state only for media tracks, location requests/watches, pending
fetch/XHR, open WebSocket/WebRTC connections, wake locks, and unfinished forms.
Permissions alone are not displayed as current use. Observer installation failure
keeps the tab awake. Arbitrary computation in workers and activity in opaque child
frames are not fully observable; use excluded domains for those applications.

Outgoing HTTP(S) tabs are captured without awaiting capture during switching.
Snapshots are local, bounded to 40 in-memory thumbnails, never stored in browser
session files, and invalidated on navigation. Authentication pages are excluded.
Hover uses a separate unprivileged native window so the current page stays visible.
Activity icons have descriptive hover text. Sleeping tabs show an estimated
renderer working-set saving only when that renderer was exclusive to the tab;
shared or unavailable metrics have no numeric saving. Estimates are not a measured
system-wide RAM delta.

Passwords remain inside the protected vault/main-process path. The native glass
popup is anchored to the trusted Tools button; Tools includes Passwords. Existing
submission comparison skips unchanged credentials and offers an explicit update
for changed values without creating duplicate accounts.

Validation:
- Desktop typecheck and 163 focused service, store, preview, and instrumentation tests passed.
- Real isolated preload activity test passed (boolean-only IPC, media, requests, edits, navigation).
- Real desktop tab test passed: muted playback, pending request/abort, edits/reset,
  sleep/wake, outgoing thumbnail, native hover, conditional rows, dismissal.
- The tab fixture suppresses Playwright's own native capture flag, which otherwise
  protects the inspected page. Production capture protection remains enabled.
- Full verify passed audit, repository typecheck, 1,496 tests, reference/settings
  checks, builds, 50 website tests, desktop smoke/layout/browser/autofill/setup.
  It stopped at a fresh-profile Electron launch timeout; later broad checks did not run.
- Jules advisory unavailable: API key not configured.
- Canonical `/Applications/Kestrel.app` rebuilt and installed with matching app.asar
  SHA-256. Both tab-activity and full autofill desktop tests passed against this
  installed binary with disposable profiles; existing user profile was preserved.
