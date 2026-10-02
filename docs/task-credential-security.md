# Temporary credentials for setup tasks

Kestrel separates a credential's value from the instructions that use it. The
preferred input remains a protected native credential field or the provider's
own sign-in flow. If a person nevertheless includes a recognized credential in
a task message, local detection replaces it with an opaque task reference before
routing, conversation storage, working-memory capture, or model submission.
This is bounded detection, not a guarantee that arbitrary text, images, binary
attachments, or every possible credential format can be recognized.

## Where the data goes

| Data | Purpose | Location | Retention and removal |
| --- | --- | --- | --- |
| Recognized task credential value | One authorized setup task | Volatile Agent Core buffers; no credential file or database write | Buffers are zeroed and references removed on task completion, failure, cancellation, supersession, or after ten minutes. Restart loses references. |
| Opaque task reference and task instructions | Explain and execute the task without revealing the value | Redacted chat, routing, working memory, tool inputs, and receipts | Normal non-secret history retention; references cannot access another task's value. |
| Credential environment | Deliver the value to a specific approved command | Child process environment; never command arguments, shell history, or global `process.env` | One bounded foreground command; Kestrel releases its environment object after execution. Physical erasure of immutable runtime strings is not verified. |
| Command stdout and stderr | Prevent disclosure, including encoded or fragmented values | Discarded before conversion, progress events, snapshots, history, or model context | No output retained by the protected command path. Exit status is reported separately. |
| Cleanup receipt | Tell the person what was actually checked | Non-secret local history and private receipt state | Reports removed count, remaining count, and scope. It never contains the value. |

The `execution.run-with-secrets` tool accepts reference IDs in
`secretEnvironment`, bound to both the session and owning run. It always requires
a fresh one-time approval, including in full-access sessions. References cannot
override PATH, HOME, interpreter/loader controls, or application startup settings.
The existing executable allowlist and workspace sandbox remain in force. Network
access and subprocess creation are denied. This path cannot run arbitrary online
installers or authenticate a provider just because it accepts an API key.
During a protected task, generic process output is also withheld, binary reads
are rejected, and new background processes are blocked, so a later read cannot
forward an encoded copy of the configured value through those paths.

Secret-bearing large pastes remain in the composer instead of becoming plaintext
attachments. Chat titles, optimistic message previews, and tray labels mask
recognized values before truncating or displaying them. Text attachments are
checked at the model boundary; user-owned source files are preserved. Journals
and idempotency records redact structured credential fields as well as known
text patterns. Replay checks cover user and assistant history and checkpoints,
including legacy messages; they do not retroactively erase the original records.
Workspace write, patch, and delete tools reject recognized or currently known
credentials before creating an undo snapshot. Protected commands may change
credential files without an undo snapshot; the destination still needs explicit
disclosure and separate cleanup verification.

## What cleanup means

The app produces its own receipt after checking that the task has no remaining
temporary credential buffers/references. The model is instructed to continue
authorized work through references and not invent deletion or authentication
claims. Pending approvals retain references for at most ten minutes. After expiry
or restart, the operation fails closed; a redacted placeholder or stored provider
key is never silently substituted.

Configuring a CLI may deliberately create a credential file. The agent must
disclose that destination and retention before requesting command approval.
Removing temporary task input does not remove that configuration, revoke the
provider's key, or prove authentication. Those require separately supported
actions and readback evidence. The cleanup receipt also excludes original user
files, clipboard, other apps, provider retention, OS swap/crash dumps, backups,
and forensic erasure from process memory. Existing profiles and credentials are
never globally reset as part of temporary cleanup.

## Validation

Regression tests use synthetic credentials to check isolation, expiry, Buffer
zeroing, partial-allocation cleanup, fresh approval and resume, completion,
failure/cancellation, redacted histories/receipts, title masking, paste protection,
and suppression of split or encoded process output. The macOS integration test
also verifies actual environment delivery and Seatbelt subprocess denial; other
platforms skip that native test.

`pnpm test:desktop-task-secrets` drives the real New Tab composer against a
loopback fixture provider and disposable profile. It checks folder-selection
readiness, opaque model input, one-time approval under Full access, real sandbox
delivery, discarded raw/encoded output, and the checked receipt after reload.
CI runs it against both built and packaged desktop apps. Set
`KESTREL_DESKTOP_EXECUTABLE` to exercise a selected installed app; the test keeps
that app's normal profile and provider credentials untouched.
