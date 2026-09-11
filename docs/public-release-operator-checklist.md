# Public release operator checklist

Use this after merging the public-release preparation PR. The repository gate
(`pnpm verify`, `pnpm audit:market`) must pass before any distribution step.

## 1. Apple Developer ID signing and notarization

The `macos-release` GitHub environment is created. Add these **secrets** in
GitHub → Settings → Environments → `macos-release` (never paste them in chat):

| Secret | Purpose |
| --- | --- |
| `CSC_LINK` | Developer ID Application certificate (base64 `.p12`) |
| `CSC_KEY_PASSWORD` | Password for the application certificate |
| `CSC_INSTALLER_LINK` | Developer ID Installer certificate (base64 `.p12`) |
| `CSC_INSTALLER_KEY_PASSWORD` | Password for the installer certificate |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from [appleid.apple.com](https://appleid.apple.com) |
| `APPLE_TEAM_ID` | 10-character Team ID from [developer.apple.com/account](https://developer.apple.com/account) |

Obtain certificates from [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list).
Export both certificates as `.p12`, base64-encode, and store only in GitHub
secrets. Restrict the environment to stable version tags (`v*`) and require a
reviewer before signing jobs run.

## 2. GitHub Releases update feed

The desktop updater is pinned to the public `arnavsri993/kestrel-agent` GitHub
repository and the stable `latest` release channel in the packaged app. The
tag workflow publishes `latest-mac.yml`, the updater ZIP, and its blockmap
alongside the public DMG. Make the matching GitHub release public only after
the signed artifact and clean-machine checks pass.

For the website distribution gate, set the repository variable:

- `KESTREL_UPDATE_URL` —
  `https://github.com/arnavsri993/kestrel-agent/releases/latest/download`
  (this verifies the GitHub-hosted feed for the website; it does not control
  the desktop updater)

After a successful tagged release workflow, host or reference the DMG, manifest,
and checksums at stable HTTPS URLs.

## 3. Website and download gate

Set GitHub repository variables (repository → Settings → Secrets and variables → Actions):

| Variable | Purpose | Current state |
| --- | --- | --- |
| `PUBLIC_PUBLISHER_NAME` | Verified legal or product name | Set to `Kestrel` |
| `PUBLIC_SUPPORT_EMAIL` | Public support address | **Set manually** before verified release |
| `PUBLIC_SITE_URL` | Canonical HTTPS site root | Set to GitHub Pages URL |
| `PUBLIC_PRIVACY_URL` | Privacy route | Set to GitHub Pages `/privacy` |
| `PUBLIC_SUPPORT_URL` | Support route | Set to GitHub Pages `/support` |
| `PUBLIC_RELEASE_COMMIT` | Full lowercase SHA of the tagged release | Set after tagging |
| `NEXT_PUBLIC_RELEASE_STATUS` | `verified` only after clean-machine proof | Defaults to `development` |
| `NEXT_PUBLIC_RELEASE_VERSION` | Semantic version matching the signed DMG | Set after tagging |
| `NEXT_PUBLIC_DOWNLOAD_URL` | HTTPS URL to the signed `.dmg` | Set after release workflow |
| `NEXT_PUBLIC_RELEASE_MANIFEST_URL` | HTTPS URL to `release-manifest.json` | Set after release workflow |
| `NEXT_PUBLIC_RELEASE_CHECKSUMS_URL` | HTTPS URL to `SHA256SUMS` | Set after release workflow |
| `KESTREL_GOOGLE_OAUTH_CLIENT_ID` | Bundled Desktop OAuth client (optional) | Set after Google verification |

The website remains in development preview until `NEXT_PUBLIC_RELEASE_STATUS=verified`
and all artifact URLs are reachable and mutually consistent.

## 4. Bundled Google OAuth (optional but recommended)

In [Google Cloud Console](https://console.cloud.google.com/):

1. Create or select a project (for example `kestrel-public`).
2. Enable **Gmail API** and **Google Calendar API** (APIs & Services → Library).
3. Configure the **OAuth consent screen** (External, app name Kestrel, support
   email, privacy URL `https://arnavsri993.github.io/kestrel-agent/privacy`).
4. Create an OAuth client: **Desktop app** type. Copy the client ID suffix
   ending in `.apps.googleusercontent.com`.
5. Set repository variable `KESTREL_GOOGLE_OAUTH_CLIENT_ID` in GitHub (Settings
   → Secrets and variables → Actions → Variables). The release workflow passes
   this into packaged builds; no client secret belongs in the desktop app.
6. Submit for Google verification when using sensitive Gmail/Calendar scopes
   in production.

Until verification completes, users can still connect with their own Desktop
OAuth client through **Connections → Google Workspace**.

## 5. Clean-machine proof

On a clean Apple Silicon Mac:

1. Download the DMG through a browser (not a developer copy).
2. Open through Gatekeeper and install to `/Applications`.
3. From a checkout of the candidate commit, run
   `KESTREL_DESKTOP_EXECUTABLE=/Applications/Kestrel.app/Contents/MacOS/Kestrel corepack pnpm test:desktop-smoke`.
   The `test:packaged-desktop:arm64` shortcut targets the repository artifact,
   not the installed app. Keep automated test data isolated from the real profile.
4. Complete first-run setup and one verified read-only task.
5. Export a local diagnostic report from **Readiness** and confirm it contains
   no prompts, credentials, or personal memory.

## 6. Candidate, update verification, and publication

1. Merge the reviewed preparation PR only after explicit merge approval and
   green CI. Freeze the resulting full commit SHA and the stable desktop version.
2. Manually dispatch **macOS release** against a ref pinned to that commit.
   A manual dispatch signs and uploads artifacts but does not publish a release.
   Ensure the `macos-release` environment permits that candidate ref explicitly;
   do not remove signing protection to get a preview build through.
3. Download the workflow artifact and record its SHA256SUMS, manifest commit,
   signatures, notarization/Gatekeeper results, and clean-machine checks above.
4. Before replacing a development installation with stable, test with disposable
   profiles and non-secret fixture credentials. Both channels intentionally use
   `Kestrel` as their runtime/profile name and `Kestrel Safe Storage` as their
   Keychain service, but the bundle IDs differ. Source equality does not prove
   macOS Keychain access across signing identities. If access fails, leave the
   real profile untouched and require an explicit reversible migration plan.
5. Exercise a signed previous-version-to-candidate update on an isolated test
   Mac using the real updater: verify settings/history/fixture credentials,
   interrupted downloads, corrupted artifacts, and installation only after
   normal quit. Keep the production GitHub feed pinned; do not publish a test
   update to customers. Capture the signed source and destination versions and
   proof from a controlled release-feed test environment. A mocked updater test
   is not sufficient. Missing signed predecessor or test environment blocks this gate.
6. Obtain release approval, then push the stable `v<version>` tag at the frozen
   commit. **A tag push automatically publishes after workflow checks pass**;
   do not push it before the candidate and upgrade evidence is accepted. The
   tagged job rebuilds artifacts; verify the actual published bytes again.
7. Derive download URLs from the verified manifest version, using
   `https://github.com/arnavsri993/kestrel-agent/releases/download/v<version>/`
   plus `Kestrel-Apple-Silicon-<version>.dmg`, `release-manifest.json`, and
   `SHA256SUMS`. Set `PUBLIC_RELEASE_COMMIT` to the manifest's exact commit and
   `NEXT_PUBLIC_RELEASE_VERSION` to its version.
8. Run `corepack pnpm audit:market -- --distribution` with the public release
   variables against the published artifacts. Supply `PUBLIC_RELEASE_VERSION`,
   `PUBLIC_DOWNLOAD_URL`, `PUBLIC_RELEASE_MANIFEST_URL`, and
   `PUBLIC_RELEASE_CHECKSUMS_URL` from their corresponding `NEXT_PUBLIC_*`
   repository variables. Require all URLs, metadata, and checksums to agree.
9. Only after that passes, set `NEXT_PUBLIC_RELEASE_STATUS=verified`, dispatch
   **Deploy product website**, and check the deployed download/support/privacy
   links. Verify the final artifact installed at `/Applications/Kestrel.app`,
   not just the build directory.

If post-publication validation fails, keep the website in development state,
stop further rollout, and investigate before changing the update feed. Retain
previous signed artifacts and recoverable profile backups. Never overwrite
release assets or downgrade an existing database as an implicit rollback.

## What remains honest without operator input

- Ad-hoc development builds are not public releases.
- Remote crash aggregation is not enabled by default; users export content-free
  local diagnostic reports from Readiness.
- Product activation and retention analytics are not yet instrumented.

See [market release](market-release.md) for the full gate contract.
