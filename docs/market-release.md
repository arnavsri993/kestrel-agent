# Apple Silicon internet release

Kestrel ships as a direct download for Apple Silicon Macs. It is not an App
Store application, does not ship an iPhone or Android companion, and does not
support Intel Macs.

## Repository gate

Run:

```sh
pnpm audit:market
pnpm verify
pnpm package:mac:dev
pnpm test:packaged-desktop:arm64
```

The market audit rejects universal, Intel, Mac App Store, mobile, or store-
submission packaging. It requires arm64 DMG and ZIP targets, hardened runtime,
Developer ID signing and notarization steps, Gatekeeper assessment, an exact
arm64 architecture check, checksums, and a release manifest.

## Public endpoints

Deploy the static website over HTTPS and configure:

- `PUBLIC_SITE_URL`
- `PUBLIC_PRIVACY_URL`, ending at `/privacy`
- `PUBLIC_SUPPORT_URL`, ending at `/support`
- `PUBLIC_DOWNLOAD_URL`, pointing to the signed DMG release
- `PUBLIC_RELEASE_MANIFEST_URL`, pointing to `release-manifest.json`
- `PUBLIC_RELEASE_CHECKSUMS_URL`, pointing to `SHA256SUMS`
- `PUBLIC_PUBLISHER_NAME`
- `PUBLIC_SUPPORT_EMAIL`
- `KESTREL_UPDATE_URL`, the stable HTTPS base containing `latest-mac.yml`, the
  ZIP, and its blockmap

Build the website with `NEXT_PUBLIC_PUBLISHER_NAME` and
`NEXT_PUBLIC_SUPPORT_EMAIL` set to the verified operator values. Distribution
mode fetches the deployed site, privacy, and support pages and verifies their
status and Kestrel-specific content.

After the signed workflow, Gatekeeper assessment, notarization validation, and
clean-machine download test pass, build the website with:

- `NEXT_PUBLIC_RELEASE_STATUS=verified`
- `NEXT_PUBLIC_RELEASE_VERSION`
- `NEXT_PUBLIC_DOWNLOAD_URL`
- `NEXT_PUBLIC_RELEASE_MANIFEST_URL`
- `NEXT_PUBLIC_RELEASE_CHECKSUMS_URL`

The download remains disabled when any field is missing, malformed, insecure,
or when the explicit verified status has not been set.

## Signing and notarization

The GitHub release workflow requires:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

It builds arm64 DMG and ZIP artifacts using a Developer ID Application
certificate, submits them for Apple notarization through electron-builder,
validates the stapled ticket, runs Gatekeeper assessment, and verifies that the
packaged executable contains only the `arm64` architecture.

Tagged builds upload the DMG, ZIP, updater blockmaps, electron-updater
`latest-mac.yml`, `SHA256SUMS`, and `release-manifest.json` to the matching
GitHub release. The generic update provider is configured from the explicit
`KESTREL_UPDATE_URL` repository variable instead of relying on a developer's
local Git remote or embedding a private token. The website download control
fails closed unless a semantic version and HTTPS URLs
for the DMG, manifest, and checksums are all present. Stable packaged builds
check the `latest` feed, download signed updates, and notify the user that the
update will install after quit and reopen; development builds never check the
production feed.

## Release decision

A candidate is ready for internet distribution only when:

1. `pnpm verify` passes.
2. The signed/notarized workflow passes on the tagged commit.
3. A clean Apple Silicon Mac downloads the DMG through a browser, opens it
   through Gatekeeper, installs it in `/Applications`, and passes the packaged
   runtime smoke test.
4. The public privacy, support, download, and update paths are live.
5. Rollback and update-channel behavior are verified.

An unsigned local `.app` is development evidence, not a public release.
