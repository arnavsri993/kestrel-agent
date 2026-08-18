# Kestrel beta distribution

Kestrel's public beta installer is a signed and notarized Apple Silicon
`.dmg`. The repository is currently macOS-only; it does not publish a Windows
`.exe`.

## Cut a beta release

1. Change `apps/desktop/package.json` to a new prerelease version such as
   `0.1.0-beta.1`.
2. Commit that version change on `main`.
3. Create and push the matching tag:

   ```sh
   git tag v0.1.0-beta.1
   git push origin v0.1.0-beta.1
   ```

The `macOS beta release` workflow verifies the source, builds arm64 DMG/ZIP/PKG
artifacts, checks their signatures, Gatekeeper result, checksums, release
manifest, and `beta-mac.yml`, then publishes a GitHub prerelease. The release
page is the beta download page; share its `.dmg` asset with testers.

The repository's `macos-release` environment must contain the existing
Developer ID signing, installer, and notarization secrets before the workflow
can publish a usable installer. A local ad-hoc beta build is available for
testing with:

```sh
pnpm package:mac:beta:dev
```

It is not suitable for public distribution.

## What the installed beta does

The packaged beta embeds GitHub's public release provider and selects the
`beta` channel. After Electron is ready, it immediately checks for a newer
published beta without blocking startup, downloads the signed update
automatically, and installs it on quit/reopen. Development builds never
contact the release provider.

The app does not scan a user's drive. Electron's OS-scoped single-instance
lock, using the shared Kestrel user-data directory, prevents duplicate app
processes and focuses the existing window when a second launch is attempted.
