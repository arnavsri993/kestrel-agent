# System architecture

Kestrel is a local-first Electron application with a separately built static website. The product runtime and marketing runtime never share privileged code.

## Process boundaries

```text
Renderer (sandboxed React)
  -> validated preload API
  -> Electron main process
  -> typed request broker
  -> Agent Core utility process
  -> encrypted SQLite / connector adapters / tools
```

The renderer owns presentation state only. Main owns OS lifecycle, notifications, launch-at-login, deep links, secure storage, updates, and narrow IPC. The utility process owns memory, schedules, opportunity scoring, policy evaluation, provider adapters, and audit records. Untrusted content never crosses into tool execution without schema and policy validation.

## Monorepo boundaries

- `apps/desktop`: Electron main, preload, utility entry, and React renderer.
- `apps/website`: static Next.js marketing and download site. It imports no desktop or fal runtime.
- `packages/shared-types`: Zod contracts and product identity.
- `packages/database`: migrations, encrypted record persistence, and query adapters.
- `packages/agent-core`: event pipeline, context resolver, opportunity engine, teacher workflow, verification, and audit trace.
- `packages/policy-engine`: deterministic approval and untrusted-content rules.
- `packages/ui`: shared visual tokens and small presentational primitives.
- `scripts`: manual media generation/processing and release checks; excluded from browser output.

## Vertical slice

A fixture Gmail event is normalized and checked for untrusted instructions. The decision engine extracts Friday/Monday, hybrid context retrieval finds Friday swim, the planner creates a reply/calendar/study task graph, and the policy engine holds external actions at approval level 2. Approval executes idempotent mocked connector calls, reads results back, writes encrypted memory, and appends a complete trace.

## General agent runtime

The core owns a provider-neutral session, model, and tool runtime. Sessions persist independently of the renderer, can be forked, checkpointed, cancelled, and resumed, and keep an auditable tool-execution history. Tool descriptors are typed and filtered per session. Pre-tool, post-tool, and error hooks run inside the utility-process boundary.

Workspace tools list, read, search, load hierarchical instructions, atomically create/update/delete UTF-8 files, and restore encrypted mutation records under a root that the main process has explicitly granted. The Connections screen opens the native folder picker and supports revocation; the owner-only grant store persists canonical paths, rejects filesystem/home-wide grants, and restarts the isolated core with only those roots. Canonical-path checks reject `..` and symlink escapes. Mutations require idempotency keys; sensitive deletion requires approval; optimistic expected-content checks prevent stale overwrites.

Allowlisted commands run without a shell through macOS Seatbelt. Read-only executions deny network and file writes except `/dev/null`; workspace-write executions deny network and writes outside the canonical granted root. Output is bounded and streamed as typed runtime events, timeouts and cancellation terminate the process, and only a sanitized environment reaches the child. Supervised background processes add bounded interactive stdin, status polling, output capture, and stop controls; they are not yet true PTYs or restart-persistent jobs. Git status, diff, and approved isolated worktree creation use the same runner.

Session messages are encrypted at rest. Search indexes store keyed term hashes rather than plaintext transcript content. Runtime events cross utility, main, and preload boundaries through Zod validation.

The user model stores provenance-backed profile, preference, relationship, and boundary proposals in encrypted private state. Inferences never enter model context until explicitly confirmed, prior values are superseded rather than silently overwritten, and sensitive facts are excluded from ordinary prompts by default.

`AgentLoop` restores encrypted structured history, injects hierarchical workspace instructions, compacts oversized context locally, streams model deltas, executes policy-scoped runtime tools, and pauses when a tool needs approval. OpenAI Responses, Anthropic Messages, Gemini GenerateContent, and Ollama use separate production wire adapters behind one interface. Optional Codex subscription access uses one stable JSONL app-server process, durable per-Kestrel-session threads, live account probing, token notifications, interruption, and restart-time thread resume. It is forced read-only with network disabled and declines vendor-side command/file approvals, leaving Kestrel as the sole tool authority. Claude subscription access remains an isolated text-only CLI invocation. Both receive an allowlisted environment without arbitrary secrets. Retryable errors can fall through to the next configured provider with a provider-specific model ID and temporary health backoff. Model-call audits contain provider/model/timing/token metadata but not prompts, responses, or credentials.

The desktop conversation is a real session client. It lists persisted sessions, restores encrypted messages and waiting approvals, selects one canonical granted workspace per task, discovers configured providers, streams deltas across the utility/preload isolation boundary, cancels active streams by UI-generated IDs, and resumes or rejects the same durable run. The native file picker returns only bounded files contained by the selected task root; the core canonicalizes and rechecks every path and size before loading text, image, audio, or document parts.

The extension boundary includes an MCP 2025-11-25 client over newline-delimited stdio and an embeddable JSON-RPC runtime server. MCP tools enter the runtime catalog as untrusted, sensitive tools and cannot bypass approval or idempotency. Agent Skills roots use metadata-only discovery, explicit full activation, and contained on-demand resource reads; bundled script text can be inspected but is never implicitly executed.

The plugin registry understands contained Codex-compatible `.codex-plugin/plugin.json` bundles, including the current Camarade manifest shape. Desktop startup inspects its private plugin directory and the installed Codex Camarade cache, then shows discovered version, capabilities, skill, and MCP declarations in Settings. Plugins default off; user enable/disable is persisted and refreshes contained skill discovery without restart or implicit script execution. Plugin-declared Node MCP servers start only after a separate user action, are constrained to a contained entry point, cannot inject process-loader environment variables, and expose tools through the sensitive approval-gated MCP bridge.

Managed plugin installation has a separate supply-chain boundary. Users explicitly import an Ed25519 publisher key document; bundles include `.codex-plugin/signature.json`; Kestrel hashes every non-signature file with a deterministic length-delimited tree digest, rejects links and special files, enforces file/count/size limits, verifies the signature and manifest/skill structure, stages and re-verifies the copy, then atomically installs or updates it. Prior versions and removals move into a hidden recovery directory that discovery ignores. Publisher keys cannot be removed while one of their managed plugins remains installed. Dependency resolution and a network marketplace are still out of scope.

`TaskOrchestrator` adds isolated delegated runs as persisted child sessions with explicit tool scopes, plus a bounded team worker pool. One-shot and interval schedules are encrypted in private runtime state, execute through the same provider/policy loop, and remain in a durable review queue when a sensitive tool needs approval. Typed workflows can pass one step's verified output into later inputs and resume idempotently after approval without replaying completed mutations.

Network tools require an explicit HTTPS host allowlist, reject private DNS targets and unsafe redirects, bound content types and bytes, label every result untrusted, and enter the normal approval boundary. Administration primitives add checksum-based dry-run migration from reference-product instruction/settings/memory/agent/skill files and encrypted versioned organization policy hooks; neither implies a hosted control plane or SSO.

The code-intelligence boundary is a transport-neutral LSP client with initialize/shutdown, diagnostics, definition, and reference requests. Language-server results are labeled untrusted and the runtime tools require approval; server process discovery and hardened stdio hosting are not yet bundled.

Editor clients connect through the official ACP TypeScript SDK 1.3.0 using stable ACP v1. The bridge negotiates prompt/session capabilities, canonicalizes granted working directories, maps text/image/audio/resource prompt blocks, streams assistant and tool-call updates, honors cancellation, supports session listing/resume/close, and maps sensitive runtime boundaries to native allow/reject permission requests that resume the same durable run. `kestrel-acp` packages this bridge as a real NDJSON stdio host and is exercised as a child process in the verification gate. ACP client filesystem and terminal requests remain workspace-contained and approval-gated, while client-provided stable stdio/HTTP MCP servers bridge into session-scoped tools. Native VS Code and JetBrains clients provide the corresponding task, stream, permission, file, and terminal surfaces; draft ACP v2 remains disabled.

Media generation uses an injected provider contract behind the standard approval and idempotency boundary. Downloads are byte-bounded, signatures and available dimensions are verified, artifacts are atomically written owner-only, and provider/model/request/cost provenance is stored encrypted; no development fal credential or marketing generator is silently promoted into the product runtime.

Browser automation is backend-neutral but requires each backend to create an isolated profile. Core adds per-agent ownership, explicit origin allowlists, bounded action inputs, untrusted accessibility snapshots, and approval-gated navigation/actions. Validated RGBA screenshots feed deterministic pixel comparisons whose hashes and results are encrypted; a production browser binary and richer visual QA gates remain separate packaging work.

Channel ingress requires an adapter-specific HMAC, exact-envelope verification, and external-message deduplication before content enters an encrypted transcript with an explicit untrusted label. Egress uses the ordinary approval/idempotency boundary. Remote supervision uses one-time expiring pairing codes and encrypted, scoped, revocable device tokens; remote responses redact prompts and instructions. Remote execution targets are encrypted and route only allowlisted argv commands through injected, attested Docker/SSH/cluster/serverless backends.

The runtime still lacks true PTY/restart-persistent processes, full Git publishing, arbitrary mid-generation message steering, Streamable HTTP protocol hosts, plugin dependency resolution/marketplace distribution, peer-agent messaging, production browser backends/channels, and OS-woken automation. See [parity-matrix.md](parity-matrix.md).

## Honest boundaries

The first repository version uses development adapters for Gmail, Calendar, notifications, model routing, and update publishing. Model routing is deterministic and independently selects a model role, reasoning effort, and Fast-mode service tier from task complexity, quality sensitivity, latency, risk, tool use, deterministic coverage, and budget headroom. Local rules win when they fully cover a task. Hosted/local model wire adapters exist, but no provider may be labeled connected until a configured credential or local server passes a live read-back check. Real OAuth and subscription authentication remain later milestones.
