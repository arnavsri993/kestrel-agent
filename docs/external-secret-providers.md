# External secret providers

Kestrel can resolve supported provider credentials from 1Password, Bitwarden Secrets Manager, or a local command helper when the agent core starts. This is an advanced alternative to saving each API key in Kestrel’s protected native fields.

## Shared boundary

- Only the provider credential names already supported by Kestrel are accepted: OpenAI primary/backup, Anthropic primary/backup, Gemini, Brave Search, and GitHub.
- Bootstrap tokens and source configuration are encrypted with Electron `safeStorage`.
- Resolved provider values are held in memory, passed only to the isolated core process, and never returned to the renderer, chat, logs, status records, or screenshots.
- A protected native credential wins by default. Each source has an explicit “replace protected values” option for users who want the external vault to be the source of truth.
- One failing source never blocks Kestrel startup. Other sources and protected local credentials continue to load, while Settings retains a non-secret error and recovery hint.

## 1Password

Kestrel uses the official `op` CLI already installed and authenticated by the user. It does not download 1Password or sign in on the user’s behalf.

Each Kestrel credential is mapped to a validated `op://vault/item/field` reference. Resolution runs `op read` with discrete arguments and a five-second timeout. The child receives only `HOME`, `PATH`, supported `OP_SESSION_*` variables, and an optional OS-encrypted service-account token.

## Bitwarden Secrets Manager

Kestrel can install the official universal macOS `bws` 2.0.0 release into its private application-data directory. The archive is accepted only from GitHub’s release hosts after its exact 12,371,243-byte size and SHA-256 `67ab9bc345e2ec3b5dfddd116f938fdab79538042623a6bcca5ca0c1b0c42d95` match the pinned manifest.

The user supplies a machine-account access token, project ID, and optional server URL. Kestrel runs `bws secret list <project-id>` with JSON output, then accepts only valid, supported environment-variable names. The access token is never written to the source configuration.

## Command helper

The command source is the compatibility escape hatch for another local vault.

Kestrel stores an executable path and one argument per line. It never evaluates `/bin/sh -c`, command substitutions, pipes, redirects, or shell metacharacters. The helper must finish within the configured timeout and print a bounded `KEY=VALUE` map. Stderr is discarded, empty values are ignored, and unsupported keys never cross into the core.

## Rotation and recovery

Use **Sync and verify** after changing a vault value or token. A successful sync records only the source, resolved Kestrel credential IDs, and time. Removing or disabling a source leaves protected native credentials untouched.
