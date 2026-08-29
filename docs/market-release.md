# Apple Silicon internet release

Kestrel ships as a direct download for Apple Silicon Macs (M1 and later)
running macOS 13+. It is not an App Store application, does not ship an iPhone
or Android companion, and does not support Intel Macs. Native modules are
rebuilt with a macOS 13 deployment target so a CI build on a newer OS still
runs on Ventura M-series machines.

## Repository gate

Run:

```sh
pnpm audit:market
pnpm verify
pnpm package:mac:dev
pnpm test:packaged-desktop:arm64
```

The market audit rejects universal, Intel, Mac App Store, mobile, or store-
submission packaging. It requires arm64 DMG and ZIP targets for direct download,
an arm64 PKG target for MDM deployment, hardened runtime,
Developer ID signing and notarization steps, Gatekeeper assessment, an exact
arm64 architecture check, checksums, and a release manifest.

The repository gate also requires the mutating-tool action-receipt contract,
encrypted receipt table, typed desktop listing path, and the real configuration
agent smoke to remain wired into `pnpm verify`. That smoke performs a staged and
approved configuration change, waits for independent read-back verification,
opens the task's collapsed receipt disclosure, checks destination, approval,
verification, and rollback copy, proves a raw-input sentinel is absent, and
reopens the same encrypted receipt after an application restart. This is local
development evidence. The ordinary packaged-app smoke separately executes
isolated browser mutations, reads their receipts through packaged IPC, and
proves typed browser text is absent before a signed build can pass.

## Public endpoints

Deploy the static website over HTTPS and configure:

- `PUBLIC_SITE_URL`
- `PUBLIC_PRIVACY_URL`, ending at `/privacy`
- `PUBLIC_SUPPORT_URL`, ending at `/support`
- `PUBLIC_DOWNLOAD_URL`, pointing to the signed DMG release
- `PUBLIC_RELEASE_MANIFEST_URL`, pointing to `release-manifest.json`
- `PUBLIC_RELEASE_CHECKSUMS_URL`, pointing to `SHA256SUMS`
- `PUBLIC_RELEASE_VERSION`, matching the signed artifact version
- `PUBLIC_RELEASE_COMMIT`, matching the full tagged source commit
- `PUBLIC_PUBLISHER_NAME`
- `PUBLIC_SUPPORT_EMAIL`
- `KESTREL_UPDATE_URL`, the stable HTTPS base containing `latest-mac.yml`, the
  ZIP, and its blockmap

The tag workflow also publishes the signed PKG for MDM distribution. The public
download URL remains the DMG; the PKG is for an organization's managed rollout
and must be tested on a clean enrolled device before broad deployment.

The signed-policy contract, required launch variables, policy bounds, and
clean-device rollout sequence are documented in
[enterprise deployment](enterprise-deployment.md).

Build the website with `NEXT_PUBLIC_PUBLISHER_NAME` and
`NEXT_PUBLIC_SUPPORT_EMAIL` set to the verified operator values. Distribution
mode fetches the deployed site, privacy, and support pages and verifies their
status and Kestrel-specific content. It also requires one semantic release
version and cross-checks that version across the DMG filename, schema-v2
release manifest, `SHA256SUMS`, and `latest-mac.yml`. Manifest SHA-256 and
SHA-512 records, updater SHA-512 records, artifact sizes, product, platform,
architecture, distribution mode, and full source commit must agree before the
site can advertise a download. Missing, stale, mixed, or unreachable inputs
fail before a verified release state is built.

The GitHub Pages workflow reads the public release inputs from repository
variables with these names: `PUBLIC_PUBLISHER_NAME`, `PUBLIC_SUPPORT_EMAIL`,
`PUBLIC_RELEASE_COMMIT`, `NEXT_PUBLIC_RELEASE_STATUS`,
`NEXT_PUBLIC_RELEASE_VERSION`,
`NEXT_PUBLIC_DOWNLOAD_URL`, `NEXT_PUBLIC_RELEASE_MANIFEST_URL`, and
`NEXT_PUBLIC_RELEASE_CHECKSUMS_URL`. It always publishes the site as a
development preview until `NEXT_PUBLIC_RELEASE_STATUS=verified` and all three
artifact URLs plus the release version and source commit are supplied. When
that status is `verified`, the workflow maps
those values plus `KESTREL_UPDATE_URL` into the distribution gate and refuses
to build the public-release state unless the site, privacy and support routes,
DMG, manifest, checksums, and updater feed are reachable and mutually
consistent over HTTPS.

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
- `CSC_INSTALLER_LINK`
- `CSC_INSTALLER_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Store these as secrets in the `macos-release` GitHub environment. Protect that
environment with a required reviewer and restrict deployment refs to stable
version tags before enabling the workflow. Source verification runs before the
environment-gated signing job, and the stable workflow rejects prerelease
package versions instead of placing them on the `latest` update channel.

It builds arm64 DMG and ZIP artifacts using a Developer ID Application
certificate and the MDM PKG using a Developer ID Installer certificate, submits
them for Apple notarization through electron-builder,
validates the stapled ticket, runs Gatekeeper assessment, and verifies that the
packaged executable contains only the `arm64` architecture.

Tagged builds verify the assembled bundle before and after the Actions artifact
transfer, then upload the DMG, ZIP, PKG, updater blockmaps, electron-updater
`latest-mac.yml`, `SHA256SUMS`, and `release-manifest.json` to a matching draft
before making it public. Interrupted runs resume only their own commit-bound
draft and revalidate every existing asset. The generic update provider is
configured from the explicit
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
4. If MDM deployment is in scope, a clean enrolled device installs the PKG and
   launches the app under the intended managed policy.
5. The public privacy, support, download, and update paths are live.
6. Rollback and update-channel behavior are verified.
7. A consequential task exposes a privacy-bounded receipt after restart, and an
   uncertain or unverified action is not presented as completed or undoable.

An ad-hoc-signed local `.app` without a Developer ID identity or notarization is
development evidence, not a public release.
