# Workstrand

> Working title. Privileged runtime identity—app ID, protocol, Keychain service, storage directory, and update channel—is centralized in `packages/shared-types/src/identity.ts`. Packaging metadata and human-visible copy remain explicit rename-checklist items because the static site cannot consume runtime identity safely.

Workstrand is a local-first, installable personal agent for macOS designed to replace the daily Codex-style workflow: choose a project, describe the outcome, follow the work, approve consequential changes, and inspect the evidence in one conversation. Its deterministic scheduling and DJI scenarios remain honest preview fixtures, while the real runtime supports persisted repository-aware sessions, tools, research, orchestration, artifacts, extensions, and terminal/editor entry points.

The repository also contains a separate, static marketing website. It has no agent endpoint, database, authentication, or fal credential in its public runtime.

## What works now

- Sandboxed Electron/React desktop app with persisted real-agent conversations, provider/model selection, per-task workspace scope, bounded attachments, token streaming and cancellation, restart-safe tool approvals, Memory, Activity, Connections, Settings, tray controls, pause/resume, run-at-login, destructive-reset confirmation, and a daily Readiness/doctor surface.
- First-run and daily checks now probe configured model accounts or local services, report local-core/project/macOS-permission/package status, and create a no-overwrite verified backup of encrypted Workstrand state without copying project folders.
- Finder-launched builds detect the official Codex binary bundled with ChatGPT and common Claude Code installs, then offer a persistent, reversible text-only subscription opt-in. Authentication stays in the vendor CLI; Workstrand stores only the chosen executable path and never copies OAuth tokens.
- Separate utility-process agent core, narrow Zod-validated IPC, encrypted SQLite memory fields, policy gates, idempotency keys, and verification events.
- A provider-neutral model/tool runtime with encrypted structured transcripts, deterministic context compaction, forks/checkpoints/cancellation, lifecycle hooks, approval pauses, provider-attempt/token audits, and allowlisted workspace/edit/shell/Git/worktree tools.
- Production OpenAI Responses, Anthropic Messages, Gemini GenerateContent, and local Ollama wire adapters with streamed text/tool calls, multimodal mappings, provider-specific model IDs, live credential probes, and retryable failover. Optional text-only Codex and Claude subscription routes use the vendors' authenticated CLIs without copying OAuth tokens or exposing Workstrand tools.
- MCP 2025-11-25 stdio client/runtime-server foundations and Agent Skills-compatible metadata discovery, activation, and contained resource loading. Plugin-declared Node MCP servers can be explicitly connected, enter the catalog as sensitive tools, and remain approval-gated; skill scripts are never implicitly executed.
- Codex-compatible plugin discovery plus an explicit desktop trust lifecycle. Managed bundles require a trusted Ed25519 publisher signature, are staged and re-verified before atomic install/update, can be removed recoverably, and default off. The installed Camarade bundle is recognized with its real version and capabilities and its actual MCP server passes the same gated runtime bridge.
- Deterministic development adapters for email and calendar. They are visibly labeled and do not pretend to be connected accounts.
- Auditable automatic execution routing chooses the model family, reasoning effort, and Fast mode per task. The general agent request path invokes only configured adapters and records live provider verification separately from model execution.
- Static Next.js product site with accessible responsive states and provenance-tracked generated/fallback atmosphere.
- Apple Silicon `.app` packaging and an architecture for universal signed/notarized DMG and ZIP releases.

Not yet complete: production Gmail/Calendar OAuth, Developer ID signing, notarization, a real update host, Intel hardware verification, public download/GitHub URLs, and the final product name.

The scoped capability union across OpenClaw, Hermes Agent, Codex, and Claude Code is tracked in [docs/parity-matrix.md](docs/parity-matrix.md). All 52 current catalog families are implemented, but that engineering result is not a blanket claim that Workstrand is better than every reference product.

## Quick start

Requirements: macOS 13+, Node 22.12+, Corepack, and pnpm 11.

```bash
corepack enable
corepack pnpm install
corepack pnpm dev:desktop
```

The local terminal surface uses the same encrypted database and agent core:

```bash
corepack pnpm cli -- help
corepack pnpm cli -- session create --title "My project" --workspace /absolute/project/path
```

Set `KESTREL_DATA_DIR` to isolate CLI state. Model runs use only explicitly configured provider adapters.

To use an existing vendor subscription without giving Workstrand an OAuth token, first sign in with the vendor's official CLI, then enable the detected route during setup or in Settings. Environment flags (`KESTREL_ENABLE_CODEX_SUBSCRIPTION=1` / `KESTREL_ENABLE_CLAUDE_SUBSCRIPTION=1`) remain available for terminal and automation use. Optional `KESTREL_CODEX_PATH`, `KESTREL_CLAUDE_PATH`, and corresponding `*_SUBSCRIPTION_MODEL` variables select nonstandard installations or models. These routes are text-only: Workstrand strips its tool catalog and the delegated CLI runs without persistence, extensions, or workspace access.

Build packaged terminal/editor entry points with `pnpm --filter @kestrel/cli build`. The outputs are `apps/cli/dist/kestrel.mjs` and `apps/cli/dist/kestrel-acp.mjs`. `kestrel tui` opens the interactive terminal, while `kestrel-acp` serves stable ACP v1 over NDJSON stdio. Pass `--model` and `--providers`, or set `KESTREL_MODEL` and `KESTREL_PROVIDERS`; provider credentials remain environment-only.

The development app uses an isolated local database under the normal macOS application-support directory. Complete the four onboarding screens, then review the prepared teacher-scheduling approval. Approving executes only the development adapters.

Run the website:

```bash
corepack pnpm dev:website
```

Run all non-paid verification:

```bash
corepack pnpm verify
corepack pnpm test:e2e
corepack pnpm assets:verify
```

Build the unsigned Apple Silicon development app:

```bash
corepack pnpm package:mac:dev
open release/mac-arm64/Workstrand.app
```

## Repository map

```text
apps/desktop          Electron shell, renderer, preload, utility process, packaging
apps/website          Static Next.js marketing site
packages/agent-core   Opportunity engine, context resolver, deterministic vertical slice
packages/database     SQLite schema, encrypted records, audit/idempotency storage
packages/encryption   AES-256-GCM field encryption
packages/policy-engine deterministic risk and prompt-injection boundaries
packages/shared-types identity, domain contracts, IPC schemas
website-media         Approved briefs, request manifests, rejected/approved provenance
scripts               capture, fal generation, processing, verification, secret scan
docs                  architecture, data, memory, permissions, threat model, release notes
```

## fal website assets

fal is a development-only asset tool. Credentials are read only from the local `FAL_KEY` environment during a deliberate `--execute` command; they never enter source, the desktop app, or the website bundle. Generation is allowlisted, cost-capped, config-hashed, locked against duplicate execution, downloaded locally, visually reviewed, and published only through the media registry.

Dry run:

```bash
corepack pnpm assets:posters
corepack pnpm assets:hero -- --only hero-signal-wide
```

Paid execution, only after reviewing the brief and estimate:

```bash
FAL_KEY="..." corepack pnpm assets:posters -- --execute
```

Generated output is not treated as evidence of a product video feature. Rejected outputs remain in their manifests for provenance and are not loaded by the site.

## Security and release boundaries

Read [docs/threat-model.md](docs/threat-model.md), [docs/permissions.md](docs/permissions.md), and [SECURITY.md](SECURITY.md) before adding a connector. The current `.app` is a development artifact, not a public release: it is unsigned and unnotarized. The release workflow requires signing/notarization secrets and must pass Gatekeeper and architecture checks before a public artifact is claimed.

## Naming and compatibility

Workstrand is the human-visible working name. Existing `@kestrel/*` package scopes, `kestrel` IPC channels and protocol, Keychain service, environment variables, CLI command, and data-directory names remain compatibility identifiers until a separately tested migration can change them without orphaning encrypted history, credentials, plugins, editor integrations, or automation entry points.
