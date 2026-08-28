# Kestrel

> Your AI answers. Kestrel gets it done.

Kestrel is a local-first desktop agent for macOS. Describe an outcome in one conversation; Kestrel chooses the route, uses the tools it needs, pauses for consequential actions, and shows the evidence.

## Start here

Requirements: an Apple Silicon Mac (M1 or later) running macOS 13+, Node 22.12+, Corepack, and pnpm 11.

```bash
corepack enable
corepack pnpm install
corepack pnpm dev:desktop
```

The desktop development command owns one Electron instance and watches the
main/preload sources. Main-process changes restart Electron automatically;
renderer changes use Vite HMR, so the running app always reflects the latest
source without starting another copy. The app also enforces a single-instance
lock and focuses the existing window when a second launch is attempted.

Kestrel has one user-facing macOS app. Use the development watcher for live
changes, or use `corepack pnpm install:mac:dev` to replace the existing
`/Applications/Kestrel.app` with the current packaged build. Do not open or
copy a `release/**/Kestrel.app` artifact, create a `Kestrel-release.app`, or
keep versioned Kestrel bundles beside the canonical app; the installer moves
stale bundles to Trash instead of deleting user data.

On first launch, Kestrel checks the local runtime, lets you connect a model only when needed, and opens a clean conversation. Choose **Add project** for folder-scoped work, or describe a question directly. Read-only work can proceed automatically; sending, publishing, deleting, purchasing, and permission changes pause with a plain-language review.

The packaged development build is Apple Silicon and ad-hoc signed. It is useful for local testing, but it is not a public release: Developer ID signing, notarization, update hosting, and a public download are still external release requirements.

## What works now

- Sandboxed Electron/React desktop app with persisted real-agent conversations, provider/model selection, per-task workspace scope, bounded attachments, token streaming and cancellation, restart-safe tool approvals, Memory, Activity, Connections, Settings, tray controls, pause/resume, run-at-login, destructive-reset confirmation, and a daily Readiness/doctor surface.
- Inference-first onboarding with a one-click macOS local-AI path and a separate manual path. The automatic path downloads a pinned official Ollama archive, enforces its expected size and SHA-256, installs it only inside owner-only Kestrel data, starts it on loopback, streams cancellable model progress, and requires a real local response before declaring readiness.
- A setup-assistant handoff can guide API providers, provider-owned OAuth/CLI sign-in, tools, MCP, skills, plugins, channels, automations, and project access. A core instruction forbids asking users to paste secrets into chat; protected native fields and provider-owned login surfaces remain the only supported secret-entry paths.
- The conversation can configure behavior, personality, additive prompts, tools, stricter permissions, workflows, UI, memory, integration boundaries, and general settings through a typed transaction: inspect, stage, diff, isolate-test, approve, atomically apply, verify, and undo. Encrypted immutable versions, an append-only audit, known-good restoration, protected-core separation, and review-only local self-improvement proposals are documented in [conversational agent configuration](docs/chat-configuration.md).
- Advanced Settings can resolve supported provider credentials through the official 1Password CLI, a pinned checksum-verified Bitwarden Secrets Manager CLI, or an argv-only command helper. Bootstrap tokens and configuration are OS-encrypted; resolved values remain memory-only and are passed only to the isolated core.
- Optional external observability sends content-free metrics and sampled lifecycle traces over OTLP/HTTP protobuf, or exposes bounded Prometheus text through the authenticated remote operator route. There is no content-capture setting, public metrics endpoint, or credential read-back.
- Rich outputs include approval-gated fal MiniMax Music 2.6 generation with verified local audio provenance and restart-restored interactive HTML/SVG widgets. Widgets run in an opaque-origin, no-network sandbox without Electron, parent DOM, storage-origin, workspace, or credential access.
- Packaged macOS builds include native WidgetKit **Focus**, **Queue**, and **Pulse** widgets. They expose content-light local status and counts, deep-link back into Kestrel, and never approve or start work; see [macOS widgets](docs/macos-widgets.md).
- Opportunities provides a Cerebral Valley-style event and hackathon application assistant: import an official page, let the local agent research eligibility and draft provenance-labeled answers, review sensitive fields, approve the application, then hand off to an isolated browser agent that pauses before submission and records only a verified receipt.
- A versioned 50-workflow deterministic browser-agent benchmark runs the real Kestrel runtime and Electron browser tools against two loopback fixture origins, verifies completion or safe-stop outcomes from independent server state, and reports false positives, duration, retries, failed attempts, explicit approval grants, scripted recovery, and failure classes. It makes no model call or approval-UI claim, so token, cost, and user-prompt counts remain explicitly unmeasured; see [browser-agent reliability benchmark](docs/browser-agent-benchmark.md).
- On macOS, the visible browser recognizes likely verification-code pages and offers a corner helper plus a native notification. After an explicit **Find code**, it can search read-only Messages on this Mac and a connected Google Workspace Gmail account, then insert a selected code without submitting the page. Only the short code and bounded metadata reach the trusted desktop surface; message bodies stay out of agent context and task history. See [communication code recovery](docs/communication-code-recovery.md).
- Connections supports a user-owned Google Desktop OAuth client through external-browser PKCE and a random loopback callback. Kestrel stores only the encrypted refresh record, rotates access tokens in memory, can revoke the grant, sends through Gmail, performs read-only recent-message lookup for code recovery, and lists or read-back verifies approval-gated Calendar events.
- First-run and daily checks now probe configured model accounts or local services, report local-core/project/macOS-permission/package status, and create a no-overwrite verified backup of encrypted Kestrel state without copying project folders.
- Finder-launched builds detect the official Codex binary bundled with ChatGPT, common Claude Code installs, and OpenCode CLI, then offer a persistent, reversible subscription or local runtime opt-in. Connections can start the official ChatGPT browser OAuth flow through Codex; Codex owns the callback, credential storage, and refresh while Kestrel receives only non-secret account status. Codex uses one long-lived stable app-server connection with durable per-session threads, streamed deltas, interruption, usage accounting, and restart-safe resume; it stays read-only so Kestrel remains the sole tool/approval authority. Claude Code and OpenCode remain isolated text-only CLI invocations. Kestrel stores only the chosen executable path and never copies OAuth tokens.
- Separate utility-process agent core, narrow Zod-validated IPC, encrypted SQLite memory fields, policy gates, idempotency keys, and verification events.
- One encrypted life-context model connects layered/versioned memory, people and relationship tone, unified provider/explicit/inferred/suggested time, bounded explainable retrieval, contradiction handling, lifecycle archival, and Google Calendar synchronization.
- A provider-neutral model/tool runtime with encrypted structured transcripts, deterministic context compaction, forks/checkpoints/cancellation, lifecycle hooks, approval pauses, provider-attempt/token audits, and allowlisted workspace/edit/shell/Git/worktree tools.
- Production OpenAI Responses, Anthropic Messages, Gemini GenerateContent, OpenAI-compatible hosted routes (including Nous, Groq, Mistral, OpenRouter, Cloudflare, xAI, DeepSeek, Together, Fireworks, NVIDIA, Hugging Face, Perplexity, GitHub Models, Cohere, TokenRouter, B.AI, InferX, ZenMux, OpenCode Zen, SenseNova, GMI Cloud, Token Harbor, Cline, Command Code, Kilo, OrcaRouter, and AIHubMix), and local Ollama wire adapters provide streamed text/tool calls, multimodal mappings where supported, provider-specific model IDs, live credential probes, and retryable failover. The optional Codex subscription route uses the stable persistent app-server protocol; Claude uses an isolated text-only CLI call. Neither copies OAuth tokens or exposes Kestrel tools.
- The free-provider setup directory links the requested provider-owned AutoClaw, WorkBuddy, and Antigravity products without pretending their login/session flows are public API-key endpoints. “Free” availability, quotas, account plans, privacy terms, and model IDs can change; Kestrel reports configured and live-verified states separately.
- MCP 2025-11-25 stdio client/runtime-server foundations and Agent Skills-compatible metadata discovery, activation, and contained resource loading. Plugin-declared Node MCP servers can be explicitly connected, enter the catalog as sensitive tools, and remain approval-gated; skill scripts are never implicitly executed.
- Codex-compatible plugin discovery plus an explicit desktop trust lifecycle. Managed bundles require a trusted Ed25519 publisher signature, are staged and re-verified before atomic install/update, can be removed recoverably, and default off. Plugins can also contribute strict declarative desktop dashboard panels with approved live metrics and built-in navigation; no plugin JavaScript, CSS, HTML, network request, or backend route enters the renderer. The installed Camarade bundle is recognized with its real version and capabilities and its actual MCP server passes the same gated runtime bridge.
- Optional Honcho remote memory uses the pinned official SDK for peer cards, session context, semantic search, dialectic reasoning, and conclusions. It is disclosure-gated and off by default; the encrypted local memory remains authoritative, protected credentials never enter prompts or renderer state, message sync excludes system/tool content, and remote output cannot bypass approvals.
- Deterministic development adapters for email and calendar. They are visibly labeled and do not pretend to be connected accounts.
- Auditable automatic execution routing chooses the model family, reasoning effort, and Fast mode per task. The general agent request path invokes only configured adapters and records live provider verification separately from model execution.
- Static Next.js product site with accessible responsive states and provenance-tracked generated/fallback atmosphere.
- Verified ad-hoc-signed Apple Silicon (`arm64`) `.app` packaging (not Developer ID signed and not notarized), plus release automation that can produce signed/notarized DMG and ZIP artifacts once organization-owned credentials are supplied.

Not yet complete: public Google OAuth app verification and bundled client registration, additional mailbox/messaging connectors, Developer ID signing, notarization, a real update host, and a public download URL. Users can already connect their own Google Desktop OAuth client through PKCE for Gmail send, read-only code lookup, and Calendar event access.

## Browser and agent workspace

Kestrel’s default desktop destination is a local user browser beside a stable agent conversation. Browser and Agent are equal top-level destinations: the Browser owns tabs and pages, while the Agent workspace starts, finds, filters, and resumes durable tasks with project, status, approval, and recovery context. Tabs, History, Downloads, session restore, configurable local history retention, address/search navigation, and browser settings are implemented. The optional **Use current page** handoff sends bounded visible-page reference material to the conversation; page content remains untrusted and cannot authorize actions. User tabs use their own persistent browser profile, while autonomous agent browser sessions are isolated and origin-scoped. Consequential browser actions continue through Kestrel’s existing policy/approval path. See [AI-native browser](docs/ai-native-browser.md) for implemented boundaries and follow-up scope, and [browser-agent reliability benchmark](docs/browser-agent-benchmark.md) for the reproducible deterministic evidence boundary.

## Architecture and research evidence

Kestrel is the finalized human-visible product name. Privileged runtime compatibility identity—app ID, protocol, Keychain service, storage directory, and update channel—is centralized in `packages/shared-types/src/identity.ts` and intentionally remains stable so existing encrypted data, credentials, integrations, and update behavior continue to work.

The pinned documentation audit maps all 1,117 Hermes and OpenClaw pages with zero known unmapped pages: 588 bundled core-family mappings, 375 signed extension contracts, and 154 operational references. The paired-node server contract covers location, Talk, wake phrases, and privacy-preserving presence without bundling a mobile app; the host fleet provides hardened one-cell-per-tenant Docker or Podman isolation. See [paired node protocol](docs/paired-node-protocol.md), [gateway networking](docs/gateway-networking.md), and the machine-readable [reference audit](docs/reference-page-audit.json).

The repository also contains a separate, static marketing website. It has no agent endpoint, database, authentication, or fal credential in its public runtime.

The scoped capability union across OpenClaw, Hermes Agent, Codex, and Claude Code is tracked in [docs/parity-matrix.md](docs/parity-matrix.md). All 58 broad catalog families have repository evidence. A separate immutable [1,117-page source audit](docs/reference-page-audit.json) distinguishes native behavior, signed extension contracts, and operational material with zero known unmapped pages; it prevents broad families from being mistaken for proof that every vendor-specific feature is bundled.

Google Workspace setup and its public-release boundary are documented in [docs/google-workspace-oauth.md](docs/google-workspace-oauth.md).
macOS Messages access, verification-page detection, code lookup, insertion, and connector limits are documented in [docs/communication-code-recovery.md](docs/communication-code-recovery.md).
The incremental calendar, people, memory, retrieval, lifecycle, and provider architecture is documented in [docs/unified-life-context.md](docs/unified-life-context.md).
External 1Password, Bitwarden, and command-helper setup and its secret-handling boundary are documented in [docs/external-secret-providers.md](docs/external-secret-providers.md).
OTLP and Prometheus setup, privacy exclusions, and recovery are documented in [docs/external-observability.md](docs/external-observability.md).
The chat configuration transaction, extension registry, protected control plane, version history, recovery, and self-improvement contract are documented in [docs/chat-configuration.md](docs/chat-configuration.md).

Public privacy/support surfaces, store metadata, distribution inputs, signing,
hardware certification, and the fail-closed market gate are documented in
[docs/market-release.md](docs/market-release.md).
The signed-policy contract, MDM PKG rollout, clean-device verification, and
the exact organization-owned deployment inputs are documented in
[docs/enterprise-deployment.md](docs/enterprise-deployment.md).

## Developer paths

The local terminal surface uses the same encrypted database and agent core:

```bash
corepack pnpm cli -- help
corepack pnpm cli -- session create --title "My project" --workspace /absolute/project/path
```

Set `KESTREL_DATA_DIR` to isolate CLI state. Model runs use only explicitly configured provider adapters.

To use ChatGPT plan access without giving Kestrel an OAuth token, choose **Sign in with ChatGPT** in Connections or setup. Kestrel asks the official Codex app-server to open the provider browser flow; Codex persists and refreshes the session, and a successful connection enables the read-only model route. You can also sign in with the vendor's official CLI and enable the detected route manually. Environment flags (`KESTREL_ENABLE_CODEX_SUBSCRIPTION=1` / `KESTREL_ENABLE_CLAUDE_SUBSCRIPTION=1` / `KESTREL_ENABLE_OPENCODE_SUBSCRIPTION=1`) remain available for terminal and automation use. Optional `KESTREL_CODEX_PATH`, `KESTREL_CLAUDE_PATH`, `KESTREL_OPENCODE_PATH`, and corresponding `*_SUBSCRIPTION_MODEL` variables select nonstandard installations or models. Kestrel strips its tool catalog from these routes. Codex uses durable read-only app-server threads; Claude and OpenCode run without session persistence, extensions, or workspace tools.

Build packaged terminal/editor entry points with `pnpm --filter @kestrel/cli build`. The outputs are `apps/cli/dist/kestrel.mjs` and `apps/cli/dist/kestrel-acp.mjs`. `kestrel tui` opens the interactive terminal, `kestrel opencode --setup` generates an OpenCode agent configuration for running Kestrel through OpenCode, while `kestrel-acp` serves stable ACP v1 over NDJSON stdio. Pass `--model` and `--providers`, or set `KESTREL_MODEL` and `KESTREL_PROVIDERS`; provider credentials remain environment-only.

The desktop app uses an isolated local database under the normal macOS application-support directory. Fresh profiles start idle with no imported memories, activity, or approvals. Deterministic teacher-scheduling fixtures are reserved for preview and test surfaces and never represent a connected account or completed external action.

Run the website:

```bash
corepack pnpm dev:website
```

Run all non-paid verification:

```bash
corepack pnpm verify
corepack pnpm test:e2e
corepack pnpm assets:verify

# Run or filter the deterministic 50-workflow browser-agent track:
corepack pnpm benchmark:browser-agent
corepack pnpm benchmark:browser-agent --workflow forms-country-dropdown
```

For the full Apple Silicon live-demo gate, including a real managed local-model
response and a freshly built packaged-app smoke test, run:

```bash
corepack pnpm verify:meetup
```

The event-day sequence and offline fallback are in the
[AI Tinkerers live-demo runbook](docs/ai-tinkerers-demo.md).

Build an ad-hoc-signed development app (not Developer ID signed or notarized).
Its `com.kestrel.desktop.dev` bundle identity and disabled-update channel are
distinct. It intentionally keeps the existing `Kestrel` data directory and
safeStorage Keychain identity until a tested migration can move existing
encrypted history and credentials:

```bash
corepack pnpm install:mac:dev
open -a Kestrel

# Smoke-test the packaged Apple Silicon app:
corepack pnpm test:packaged-desktop:arm64
```

`install:mac:dev` keeps the canonical app at `/Applications/Kestrel.app`, moves other
Kestrel bundles found in common install locations or by Finder/Spotlight to Trash,
and leaves `release/mac-arm64/Kestrel.app` as a non-indexed build artifact only.
It is an in-place refresh of the canonical app, not a second installed version.

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

Read [docs/local-ai-setup.md](docs/local-ai-setup.md), [docs/threat-model.md](docs/threat-model.md), [docs/permissions.md](docs/permissions.md), and [SECURITY.md](SECURITY.md) before changing runtime installation or adding a connector. The current `.app` is an ad-hoc-signed development artifact, not a public release: it is not Developer ID signed and is not notarized. The release workflow requires signing/notarization secrets and must pass Gatekeeper and architecture checks before a public artifact is claimed.

## Naming and compatibility

Kestrel is the finalized human-visible product name. Existing `@kestrel/*` package scopes, `kestrel` IPC channels and protocol, Keychain service, environment variables, CLI command, and data-directory names are intentionally stable compatibility identifiers. Finalizing the visible name does not imply a compatibility-identity migration; any future identifier change would require a separately designed and tested migration that preserves encrypted history, credentials, plugins, editor integrations, and automation entry points.
