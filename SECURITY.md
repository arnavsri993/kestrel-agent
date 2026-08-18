# Security policy

## Development status

Kestrel 0.1.0 is a local development preview. Do not use it for high-consequence real-world actions or sensitive production accounts. Gmail and Calendar use the real Google Workspace APIs only after verified user-owned OAuth setup; otherwise their explicitly labeled development adapters remain available for preview data.

## Reporting

Until a public repository and private reporting address exist, do not publish suspected vulnerabilities. Record the finding privately with the affected version, reproduction, impact, and whether local data or credentials may have been exposed. Add the final security contact before publishing the repository.

## Invariants

- The renderer has no Node.js, filesystem, database, Keychain, or raw credential access.
- IPC is narrow and schema validated.
- Agents must never request API keys, OAuth tokens, passwords, session cookies, or private keys in chat. Secret entry is restricted to protected native credential fields or provider-owned OAuth/device-login surfaces.
- Google Workspace sign-in uses an external-browser installed-app flow with PKCE S256, a random loopback port, exact state validation, narrow Gmail-send/Gmail-readonly/Calendar-events grants, encrypted refresh storage, in-memory access-token refresh, live connection verification, and provider revocation. Read-only Gmail lookup is used only for an explicit verification-code scan and returns bounded code metadata, never message bodies, to the trusted desktop surface. See `docs/google-workspace-oauth.md` and `docs/communication-code-recovery.md`.
- The macOS Messages connector reads only the local `~/Library/Messages/chat.db` in read-only mode after the user grants the required Full Disk Access permission. It never sends messages, never gives page content authority over a scan, does not persist scan results to task history, and inserts a selected code only after an explicit user action plus active-tab/domain revalidation. Slack, Discord, Teams, Outlook, and additional mailbox connectors are not yet implemented.
- External secret sources resolve only the seven allowlisted provider credentials already understood by the native broker. Bootstrap tokens and source configuration are OS-encrypted; resolved values remain memory-only and are passed only to the isolated core. 1Password receives validated `op://` references through `execFile`; Bitwarden uses a checksum-pinned universal `bws` release; command helpers use an executable plus discrete argv, never a shell. All subprocesses receive a minimal environment, discard stderr, cap stdout, and have a hard timeout.
- External observability is off by default and has no content-capture mode. OTLP protobuf and authenticated Prometheus exporters operate only on content-free counts and bounded lifecycle metadata; they exclude prompts, responses, tool payloads, errors, identifiers, paths, hostnames, and secret values. Dynamic labels are bounded, Prometheus has a fixed 2,048-series cap, collector credentials are encrypted and write-only, public plaintext OTLP is rejected, and the scrape route requires a paired read-scope bearer token.
- Automatic local-AI setup is explicit and cancellable. It accepts only the pinned HTTPS release URL, exact expected byte count and SHA-256, path-contained link-free archive contents, owner-only install/model directories, and a loopback listener before a real inference verification.
- Sensitive memory content is encrypted with AES-256-GCM; the database key is protected with Electron `safeStorage`.
- External content is untrusted data and cannot rewrite policy or tool permissions.
- External communication pauses for approval by default.
- Executions use idempotency keys and read-back verification.
- fal credentials are development-only and forbidden from public bundles.

Signing and notarization do not make the application logic trustworthy on their own; they establish artifact identity and transport integrity. Release checks remain in addition to runtime boundaries.
