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
3. Run `corepack pnpm test:packaged-desktop:arm64` against the installed build.
4. Complete first-run setup and one verified read-only task.
5. Export a local diagnostic report from **Readiness** and confirm it contains
   no prompts, credentials, or personal memory.

## 6. Publish

1. Push a stable tag matching `apps/desktop/package.json` version (for example
   `v0.x.y`).
2. Run the **macOS release** workflow on that tag.
3. Make the GitHub release public after artifact verification.
4. Set `NEXT_PUBLIC_RELEASE_STATUS=verified` and redeploy the website.
5. Run `pnpm audit:market` in distribution mode against the live URLs.

## What remains honest without operator input

- Ad-hoc development builds are not public releases.
- Remote crash aggregation is not enabled by default; users export content-free
  local diagnostic reports from Readiness.
- Product activation and retention analytics are not yet instrumented.

See [market release](market-release.md) for the full gate contract.
