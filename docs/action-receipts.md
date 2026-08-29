# Action receipts

Kestrel records one user-facing receipt for every non-read-only runtime tool.
The receipt answers what Kestrel intended, where the change went, which approval
boundary applied, what state it expected and observed, whether independent
verification passed, and whether a tested rollback exists. It is evidence about
the tool journal, not model reasoning or a claim that every external action is
reversible.

## Runtime contract

The utility process writes an `in_progress` receipt before invoking a mutating
handler and upserts that same record as the tool journal advances. Terminal
outcomes are `verified`, `blocked`, `failed`, `cancelled`, `waiting_approval`,
or `uncertain`. An idempotent replay reuses the original tool execution and
receipt instead of creating a second action. A consumed one-time approval
checkpoint remains in encrypted history for audit but is suppressed from the
latest-run desktop list so it is not mistaken for another user-visible action.

Read-only tools do not create receipts. The existing encrypted
`browser_activity_events` ledger remains the specialized browser observation
record; universal receipts summarize the consequential boundary across
workspace, browser, connector, execution, configuration, automation, memory,
media, session, and extension tools.

## Privacy boundary

Receipt payloads are strict Zod objects stored as AES-GCM ciphertext in
`action_receipts`. The plaintext index contains only bounded IDs, outcome, and
timestamps. Builders use tool-descriptor copy and allowlisted destination and
result fields. They do not copy:

- prompts, messages, mail bodies, page text, or arbitrary tool input;
- typed browser text, accessibility trees, screenshots, cookies, or tokens;
- file contents or configuration diffs;
- raw tool errors or provider response bodies;
- URL credentials, fragments, search text, message text, or credential-like
  query parameters.

The desktop receives decrypted receipts only through the validated local IPC
broker and presents them inside the owning task. Session storage is bounded to
500 receipts and follows runtime retention cleanup.

## Verification and uncertainty

`verified` means a registered tool verifier returned a method and SHA-256
evidence digest. A success-looking tool output without that verifier is not
rendered as verified. If the effect may have started but Kestrel lost the
terminal journal or could not confirm the destination, the receipt says
`Outcome uncertain`, offers no completion claim, and instructs the runtime not
to replay the action automatically.

## Rollback boundary

Rollback is `available` only for a registered, tested inverse with a concrete
reference:

- workspace mutations use `workspace.undo` and their encrypted mutation ID;
- applied configuration versions use `agent.config.rollback-preview` and the
  known-good target version, followed by a fresh one-time approval.

Other verified external actions say rollback is unavailable. Prepared local
state and actions that never reached a verified change say rollback is not
applicable. Receipt copy never substitutes a guessed compensating action for a
real inverse.

## Desktop and proof

Completed, failed, and cancelled task outcomes contain a collapsed **Action
receipts** disclosure for the latest run. Expanding it shows action, destination,
approval, verification, and rollback first; expected/observed details are a
secondary disclosure. The configuration-agent desktop smoke covers real plan,
approval, apply, read-back, receipt rendering, raw-input exclusion, and restart
persistence. Database tests separately inspect ciphertext and migration/retention
behavior; runtime tests cover idempotent reuse and workspace undo metadata.

This increment does not provide a global receipt center or promise one-click
undo for services that lack safe inverses.
