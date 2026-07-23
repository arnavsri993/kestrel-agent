# Security policy

## Development status

Workstrand 0.1.0 is a local development preview. Do not use it for high-consequence real-world actions or sensitive production accounts. The included email and calendar adapters are deterministic mocks.

## Reporting

Until a public repository and private reporting address exist, do not publish suspected vulnerabilities. Record the finding privately with the affected version, reproduction, impact, and whether local data or credentials may have been exposed. Add the final security contact before publishing the repository.

## Invariants

- The renderer has no Node.js, filesystem, database, Keychain, or raw credential access.
- IPC is narrow and schema validated.
- Sensitive memory content is encrypted with AES-256-GCM; the database key is protected with Electron `safeStorage`.
- External content is untrusted data and cannot rewrite policy or tool permissions.
- External communication pauses for approval by default.
- Executions use idempotency keys and read-back verification.
- fal credentials are development-only and forbidden from public bundles.

Signing and notarization do not make the application logic trustworthy on their own; they establish artifact identity and transport integrity. Release checks remain in addition to runtime boundaries.
