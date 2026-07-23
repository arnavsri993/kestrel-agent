# Persistent Codex app-server runtime

Kestrel can use an existing ChatGPT/Codex sign-in without reading, copying, or
storing its OAuth tokens. When the Codex subscription route is enabled, the
isolated agent core starts one owner-local `codex app-server --stdio` process
and communicates through the stable newline-delimited JSON protocol.

Connections and first-run setup can also initiate the official ChatGPT OAuth
flow. A short-lived account-management app-server receives
`account/login/start` with `type: "chatgpt"`, returns the provider URL for the
system browser, and reports completion through `account/login/completed`.
Codex owns the callback, credential persistence, and refresh. Kestrel accepts
only HTTPS OpenAI/ChatGPT authorization URLs and retains only non-secret status
such as account type, email, and plan label in renderer memory.

References:

- [Official Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Hermes persistent runtime behavior](https://github.com/NousResearch/hermes-agent/blob/8fc278207b0f5b25e567966f9615e1b1737f62af/website/docs/user-guide/features/codex-app-server-runtime.md)

The implementation intentionally negotiates the stable protocol only. It does
not opt into experimental API fields or network transports.

## Lifecycle

- The provider starts lazily and performs the required `initialize` request and
  `initialized` notification exactly once per process.
- `account/read` is the live readiness probe. A discovered executable without a
  signed-in account is not reported as a working model route.
- A successful in-app ChatGPT sign-in enables the Codex route. Cancellation
  calls `account/login/cancel`, terminates the short-lived account process, and
  restores the isolated core without persisting a partial Kestrel preference.
- One durable Codex thread is mapped to each Kestrel session. The first turn
  receives the bounded Kestrel transcript; later turns send only the new user
  text so history is not duplicated.
- The process is shared across concurrent Kestrel sessions. If it exits,
  in-flight requests fail rather than being silently replayed; the next request
  starts a fresh process and resumes its durable thread.
- Core shutdown terminates the process, escalates after a bounded grace period,
  rejects pending requests, and removes the owner-private scratch directory.

## Events, cancellation, and limits

`item/agentMessage/delta` streams directly into the normal Kestrel response
path. `thread/tokenUsage/updated` supplies input, output, cache-read, and
reasoning usage for the existing audit and budget system.

An abort sends `turn/interrupt` when the turn ID is known. Requests and turns
have separate hard timeouts. Individual protocol lines, retained stderr, and
all error text are bounded. Malformed or oversized output terminates the child
instead of entering renderer or prompt state.

## Approval and workspace boundary

Codex app-server is deliberately configured with:

- `sandbox: "read-only"`;
- `approvalPolicy: "never"`;
- network disabled in the per-turn sandbox policy;
- base instructions forbidding commands, file edits, browsing, MCP, and
  approval requests.

Any server-initiated command or file-change approval request is explicitly
declined. Unknown server requests receive a method-not-supported error. This
means Codex supplies persistent model reasoning while Kestrel remains the sole
owner of tool execution, workspace mutation, idempotency, and visible approval.
It cannot use a vendor-side permission prompt to bypass Kestrel policy.

The child receives only a small allowlist of process variables needed for the
vendor-owned login and runtime. OpenAI API keys and unrelated environment
secrets are stripped.

## Verification

`packages/agent-core/src/providers/codex-app-server.test.ts` runs a real JSONL
child fixture and proves one initialization and OS process across two turns,
one durable thread, first-turn transcript handoff, subsequent delta-only input,
streaming, token usage, explicit command denial, and secret stripping.

`apps/desktop/src/main/chatgpt-oauth.test.ts` proves the stable ChatGPT login
request, official authorization-URL boundary, completion notification,
non-secret account status, and provider-secret stripping.

The development verification also performs a no-inference `account/read`
handshake against the Codex binary bundled with the installed ChatGPT app.
