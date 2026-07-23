# Threat model

## Assets

Personal memory, OAuth tokens, provider keys, selected files, schedules, messages, approval policy, audit data, browser pairing secrets, and update integrity.

## Trust boundaries

- Renderer content is untrusted and receives no raw secret, filesystem handle, database handle, or arbitrary IPC channel.
- Email, web pages, files, attachments, model output, generated code, and deep-link parameters are untrusted data.
- Tool calls are proposals until validated against the user goal, capability allowlist, path scope, risk level, and approval state.
- The website is public static content and has no path to product memory, connectors, fal, or desktop IPC.

## Primary threats and controls

| Threat | Control |
| --- | --- |
| Prompt injection in an email/page | content origin labels; injection detector; unrelated-tool rejection; approval escalation |
| Renderer compromise | sandbox, context isolation, no Node integration, narrow Zod-validated bridge |
| Secret disclosure | Keychain/safeStorage broker; capability-scoped requests; log redaction; production bundle scan |
| Duplicate external action | operation idempotency keys and read-after-write verification |
| Excessive autonomy/cost | initiative levels, resource governor, depth/task/cost limits, quiet hours |
| Unsafe filesystem access | user-selected roots, normalized path checks, no full-disk scan |
| Malicious update | signed channel metadata, notarization/Gatekeeper release gates, no update during critical operations |
| Local database theft | AES-256-GCM field encryption with a Keychain-protected key; future SQLCipher adapter |
| Orphaned workers | bounded supervision, checkpointing, clean-quit process audit |

## Release caveat

Security architecture and deterministic tests do not equal an independent security audit. Production claims remain gated on packaged-app penetration testing, Apple signing/notarization, connector scope review, and recovery testing.
