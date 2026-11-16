# Native application updates: release boundary

Native application updates are **not enabled**. The existing Electron updater
and `latest-mac.yml` target the Electron application and must not be used by
the native Chromium host. The helper in `scripts/prepare-sparkle-native.mjs`
fetches Sparkle 2.10.1 only after verifying its pinned upstream archive SHA-256;
it does not integrate or enable Sparkle in the app. The native build does not
currently contain `SPUStandardUpdaterController` or a Check for Updates menu.

`scripts/native-app-update-config.mjs` provides fail-closed validation for a
separate HTTPS `native-appcast.xml`, an Ed25519 public key, stable release
version, and a positive numeric bundle version. The release pipeline must call
`assertNativeVersionAdvances` against the authenticated previous native release,
and must supply the feed and public key as reviewed configuration. No private
signing key belongs in the source or app; signing should use a CI secret or a
protected file, with no Keychain API requirement.

Before enabling the native updater, integrate and sign the pinned Sparkle
framework, connect its controller to the native menu, and prove that every
Sparkle installation path waits for Kestrel's full orderly shutdown (including
CEF, Core and any profile transfer). Sparkle's standard driver can offer an
immediate install and relaunch, so merely constructing the controller is not
proof of that invariant. Establish native bundle identity/version, signed
appcast production and publication, and isolate the native feed from Electron.

The separate `native-app-update` retirement gate requires a candidate-bound
`native-app-update-canary` supporting artifact. Its schema is implemented in
`scripts/native-retirement-evidence.mjs`; the proof requires two Developer ID
signed and notarized native versions, an HTTPS feed, an orderly upgrade and
restart, and disposable-profile and vault readback. This is an attestation and
must be reviewed alongside its supporting run evidence. Synthetic test fixtures
are not release evidence. A signed isolated two-version run, configured feed,
public key and release signing credentials are still required.
