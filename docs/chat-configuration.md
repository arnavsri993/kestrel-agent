# Conversational agent configuration

Kestrel treats self-configuration as a versioned transaction, not as permission
for the model to rewrite its running process. A user can ask for a change in
ordinary chat. The agent must inspect the registered configuration surface,
stage an exact candidate, explain its effect and risk, show the diff and
isolated checks, and cross a fresh approval boundary before anything becomes
live.

Requests that do not fit the typed data plane are still chat-routable. They use
the existing isolated repository workflow: inspect the source and repository
instructions, create a focused worktree, make the bounded code change, run the
relevant checks, present the diff, and publish an unmerged pull request. Kestrel
does not patch its running protected core in place.

## Control plane and editable data plane

The editable document is schema-versioned in
`packages/shared-types/src/configuration.ts`. Its initial surface covers:

- behavior and personality instructions;
- the additive user-owned prompt layer;
- visible or denied tools and stricter approval rules;
- workflow turn limits;
- conversation density and change evidence;
- explicit memory capture, shared recall, and improvement thresholds;
- hosted-integration fallback behavior; and
- locale, timezone, explanation, and review cadence settings.

`AgentConfigurationManager.registerSurface` is the extension point. A subsystem
registers human-facing metadata for paths owned by the current typed schema and
may add deterministic validators. It cannot create an untyped escape hatch or
claim a protected path. Schema evolution adds new document fields and migration
logic first, then registers their chat surface and isolated checks.

The following remain outside the editable document:

- safety and policy risk floors;
- authentication, identity, and managed-policy verification;
- credential entry, secret storage, and secret brokering;
- the one-time approval mechanism;
- workspace and process isolation;
- version integrity, verification, audit, and recovery; and
- the code that enforces this separation.

The inspection tool returns both the editable catalog and these protected
boundaries. If a request crosses a boundary, the agent must state why it was
rejected and offer the closest safe registered setting, native credential flow,
or isolated source-change route.

## Transaction lifecycle

```text
natural-language request
  -> inspect registered surfaces and protected boundaries
  -> translate to bounded JSON Patch
  -> clone current immutable version
  -> validate schema, secrets, policy, recovery, and registered subsystems
  -> serialize and parse the candidate again
  -> persist proposal, exact diff, digest, checks, and audit event
  -> explain while live state remains unchanged
  -> fresh one-time user approval
  -> compare base version and exact preview
  -> repeat isolated validation
  -> append encrypted known-good version and atomically move the head
  -> encrypted read-back verification
  -> report active version and conversational undo target
```

`agent.config.plan` may stage a proposal but never changes the live document.
Every proposal records its base version and SHA-256 digest. An intervening
configuration change makes the proposal stale; the apply attempt is rejected
and audited rather than rebased silently.

`agent.config.apply` and `agent.config.rollback` use `approvalMode: "always"`.
A session-wide or global allow rule cannot satisfy them. Approval is bound to
the exact blocked execution, session, tool name, and input. A caller cannot
manufacture approval by setting an `approved` field on a new tool request.

Rollback first produces an exact restoration preview. Approval creates a new
version whose document matches the selected immutable known-good version.
Nothing is deleted, so undoing a rollback is another ordinary restoration.

## Persistence, history, and recovery

Migration `008_agent_configuration.sql` adds one encrypted journal for
configuration versions, proposals, audit events, and self-improvement
proposals. The active head is persisted in encrypted private runtime state.
Version application commits the new version, proposal status, audit record, and
head comparison in one SQLite transaction.

On startup, the manager verifies the active document against its schema and
digest. If the head is missing or invalid, it selects the newest valid
known-good version and records the recovery action. If no valid known-good
version exists, ordinary agent execution fails closed instead of silently
starting with an unverified configuration.

Audit records are append-only at the manager boundary. Initialization, staging,
application, rejection, stale-plan supersession, rollback, recovery, and
improvement detection have explicit action types. Secrets and message content
are not part of the configuration journal.

## Self-improvement

The ambient monitor reads bounded local execution metadata: tool name, status,
count, and time window. It does not read chat messages, tool inputs, tool
outputs, or error text. When a tool repeatedly fails beyond the configured
threshold, Kestrel creates a deduplicated improvement proposal with content-free
evidence and a specific recommended patch.

An improvement is never self-authorizing. It begins in `proposed`, can be
staged through the same isolated planner, and needs the same exact-diff,
one-time approval, apply verification, history, and rollback path as a
user-requested change. Rejecting its staged apply also dismisses the linked
improvement.

## Chat tools

- `agent.config.inspect`: current document, registered surfaces, protected
  boundaries, chat-routable capabilities, and the source-change route.
- `agent.config.plan`: isolated candidate, exact diff, checks, risk, and
  persisted proposal.
- `agent.config.apply`: freshly approved atomic apply and live read-back.
- `agent.config.history`: immutable versions and proposal states.
- `agent.config.rollback-preview`: exact known-good restoration diff.
- `agent.config.rollback`: freshly approved restoring version and read-back.
- `agent.config.audit`: append-only configuration audit.
- `agent.config.improvements`: pending and prior improvement proposals.
- `agent.config.scan-improvements`: deliberate local metadata-only scan.

Standard sessions always retain the configuration and recovery tools even when
the user tightens ordinary tool visibility. A custom agent with a strict tool
scope keeps that scope for normal work; an explicit configuration or recovery
request adds only the protected configuration tools for that turn.

## Desktop interaction

Configuration tool messages render as a restrained change ledger within the
conversation. A staged plan is labeled “preview only,” can disclose the exact
diff and checks, and remains visually distinct from the approval control.
Applied and restored versions announce verified status and provide a
“Prepare undo” action that puts the restoration request into the composer; it
does not execute an undo on click. Long diffs are bounded and wrapped, keyboard
focus remains visible, verification is available without color, and live
announcements follow the configured accessibility preference.

## Verification contract

The focused test suite covers:

- no live mutation during staging;
- encrypted persistence across restart;
- immutable rollback history;
- schema, secret, protected-path, recovery, and registered-validator rejection;
- altered previews and stale base versions;
- mandatory one-time approval and forged-approval rejection;
- content-free failure monitoring and no self-application; and
- the full natural-language inspect, plan, explain, approve, apply, verify, and
  undo-option path through a deterministic model provider.

These checks prove the local architecture and packaged development behavior.
They do not turn an ad-hoc-signed build into a notarized public release.
