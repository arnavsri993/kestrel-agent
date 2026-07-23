# Ambient memory and presence

Kestrel implements ambient behavior without hidden social signaling or silent belief changes.

## Commitments

The upstream inferred-commitments experiment is retired. Kestrel therefore treats a commitment as one of two explicit durable objects:

- scheduled work in the encrypted automation queue, with a user-visible title, prompt, schedule, state, and approval boundary;
- a confirmed durable memory with provenance and direct correct/forget controls.

Ordinary conversation does not create a follow-up reminder merely because a future action was mentioned.

## Dreaming

Memory consolidation is off by default. A user can preview it without storing any result, or enable a daily local run (3 AM by default).

Each run has three deterministic phases:

1. **Light** selects active, inferred, unconfirmed memories and excludes restricted records.
2. **REM** groups eligible records into typed themes. It does not promote memory.
3. **Deep** applies a bounded weighted score across importance, confidence, recurrence, recency, source diversity, and conceptual richness.

Passing records become review candidates. They do not change durable memory until the user presses **Promote**. Rejection leaves the source record unchanged. Promotion records its candidate ID, score, provenance count, and review time, then marks the memory confirmed.

The encrypted Dream Diary stores phase counts and a generic summary only. It contains no transcript excerpts, memory content, identifiers, paths, hostnames, provider errors, or credentials. The desktop can show the existing encrypted source memory next to a candidate because the user already has access to the Memory surface.

## Presence

Presence is ephemeral process memory, not durable history:

- supported client modes are `ui`, `webchat`, `node`, and `test`;
- stable instance IDs deduplicate reconnects;
- entries become idle after 60 seconds and expire after five minutes;
- the roster is capped at 200 entries;
- CLI, backend, and probe modes are rejected;
- IP addresses, hostnames, socket addresses, and loopback details are never accepted or stored.

The desktop agent core and renderer send bounded heartbeats. Paired clients can read or update presence at `GET /v1/presence` and `POST /v1/presence` using a read-scope bearer token. The HTTP server does not copy network metadata into the roster.

## Channel progress, typing, and reactions

Channel progress uses a single provider message when the configured adapter supports safe edits:

- `off`, `partial`, `block`, and `progress` modes control which execution phases may create a draft;
- progress text is generated from a closed phase enum and bounded integer counts, so tool arguments, paths, work content, tool output, error bodies, and credentials are not accepted by the API;
- Slack, Discord, and Teams can edit the original message; Gmail and generic webhooks fall back to the final response;
- a final response replaces the draft when safe, while attachments use a separate final delivery;
- a silent final response sends nothing.

Typing policy supports `never`, `instant`, `thinking`, and `message` modes with a configurable 2–30 second refresh interval. Native typing is emitted only where an implemented provider API exists (currently Discord); unsupported channels remain silent instead of simulating presence.

Slack, Discord, and Microsoft Teams adapters also expose approval-gated message reactions through the `channel.react` tool:

- `add` and `remove` require an explicit bounded provider-appropriate emoji;
- `clear` removes only reactions that Kestrel recorded itself, avoiding destructive removal of other participants' reactions;
- `off`, `ack`, `minimal`, and `extensive` policy levels allow zero, one, two, or eight tracked reactions per message;
- provider capability checks fail closed for Gmail and generic webhooks;
- Slack uses `reactions.add`/`reactions.remove`, Discord uses the bot's own reaction endpoint, and Teams uses `setReaction`/`unsetReaction`;
- reaction targets are hashed before the encrypted policy ledger stores the bot's tracked emoji set.

The Settings surface shows how many configured channels support edits, typing, or reactions and persists the full interaction policy in encrypted private state.
