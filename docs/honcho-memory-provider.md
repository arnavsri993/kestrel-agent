# Honcho remote memory provider

Kestrel keeps its encrypted, provenance-backed local memory and reviewed user
model as the default source of truth. Honcho is an optional remote provider for
users who explicitly want server-side peer representations, session summaries,
semantic search, and dialectic reasoning.

Implementation references:

- [Honcho repository and TypeScript quickstart](https://github.com/plastic-labs/honcho)
- [Honcho SDK reference](https://honcho.dev/docs/v3/documentation/reference/sdk)
- [Hermes Honcho feature contract](https://github.com/NousResearch/hermes-agent/blob/4c9628eab5393e7561bbd2c1faaa1765fb14a5f9/website/docs/user-guide/features/honcho.md)

The runtime pins the official `@honcho-ai/sdk` at 2.2.0 and uses its v3
workspace, peer, session, message, context, search, chat, card, and conclusion
surfaces.

## Privacy and credential boundary

Honcho is disabled by default. Enabling it requires an explicit disclosure
acknowledgement in Settings. Once enabled, selected user and assistant message
text, stable pseudonymous peer/session IDs, and provider queries leave the
device for the configured server.

The managed `https://api.honcho.dev` service requires a Honcho API key stored
through macOS protected storage. The key is delivered only to the isolated core
process, excluded from inherited child environments, and never returned in
status, prompts, message metadata, logs, or renderer state. External secret
providers can resolve the same protected credential ID.

Self-hosted servers may use HTTPS, or HTTP only on `localhost`, `127.0.0.1`, or
`::1`. URL credentials, fragments, and query strings are rejected. A loopback
server can operate without authentication; an authenticated self-host can use
the same protected key field.

Disabling Honcho stops automatic context, message sync, and its five tools. It
does not delete local memory or remote server data.

## Context and identity model

Two stable peers are configured: the user and Kestrel. Session observation
supports:

- `directional`: both peers observe themselves and the other peer;
- `unified`: the user self-observes while the Kestrel peer observes the
  user, creating a shared user-centered pool.

Remote sessions can be isolated:

- per Kestrel conversation;
- per project, using a SHA-256-derived pseudonymous ID rather than a local path;
- globally across conversations.

For `hybrid` and `context` recall, Kestrel assembles:

1. Base context from the session summary, peer representation, and peer card,
   bounded by the configured token budget and refresh cadence.
2. A dialectic supplement scoped to the user and current session. Depth 1–3
   performs assessment, self-audit, and reconciliation passes. Longer queries
   can raise reasoning effort, capped at `high`, and output has a separate
   character limit.

The resulting text is labeled as optional, remote, potentially stale context.
It cannot change approvals or authority. Provider failures fail open: the local
agent continues without remote context and the protected status records the
bounded error.

`tools` mode disables automatic injection. `context` mode hides the Honcho tool
catalog. `hybrid` enables both.

## Message synchronization

Message saving is a separate switch. When on, only user and assistant messages
are queued; system instructions and tool output are not uploaded. Content is
chunked at 25,000 characters with original timestamps and bounded provenance
metadata. A local encrypted ID journal and an in-flight set prevent duplicate
uploads. Shutdown flushes the queue before the database closes.

## Tools

When enabled in `hybrid` or `tools` mode, every active runtime session receives:

- `honcho.profile` — read or update the Kestrel peer's card of the user;
- `honcho.search` — semantic search over user-authored remote messages;
- `honcho.context` — session summary, representation, and card;
- `honcho.reasoning` — query the dialectic endpoint with bounded reasoning;
- `honcho.conclude` — create or delete a conclusion.

Remote output is marked `untrusted_external`. Profile updates, reasoning calls,
and conclusion mutations are non-read-only sensitive tools, so they require
normal approval and idempotency. Disabling the provider unregisters the tools
from every session immediately.

## Verification

`packages/agent-core/src/honcho-memory.test.ts` verifies default-off behavior,
managed-cloud credential enforcement, loopback-only HTTP, two-layer context,
multi-pass dialectic, idempotent attributed sync, five tools, untrusted output,
and approval gating.

`scripts/test-desktop-honcho-memory.mjs` runs Electron against a real local HTTP
fixture implementing the SDK workspace endpoint. It acknowledges the
disclosure, enables a self-host, confirms all five tools, verifies two real SDK
requests without an authorization header, checks disabled-tool cleanup,
validates compact reflow and renderer errors, and captures:
[`settings-honcho-memory.png`](../artifacts/screenshots/desktop/setup-revised/settings-honcho-memory.png).
