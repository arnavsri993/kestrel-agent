
# Google Antigravity Context Sheet — Kestrel

> Purpose: Give this document to Google Antigravity (or another
> repository-aware coding agent) before asking it to continue Kestrel work.
>
> Freshness: This snapshot was written on 2026-08-14 in America/Chicago.
> Branches, pull requests, installed artifacts, provider availability, and
> uncommitted UI work can change. Treat this as an orientation layer, not a
> substitute for inspecting the live repository.

## 0. Short version

Kestrel is a local-first macOS desktop agent whose browser is a first-class
product surface. It uses Electron, React, TypeScript, a separate
utility-process agent core, encrypted SQLite, validated IPC, explicit policy
gates, and verified delivery.

Browser and Agent are equal top-level destinations:

- Browser owns user tabs, pages, history, downloads, search, and browser
  context.
- Agent owns durable tasks, conversations, projects, approvals, tools,
  workspaces, recovery, and evidence.
- The two lifecycles stay independent. New Tab is not New task.
- The conversation remains mounted while the user navigates between primary and
  specialist destinations.

The product promise is:

> Your AI answers. Kestrel gets it done.

The product should feel like a quiet, trustworthy Mac instrument: not a generic
AI dashboard, not a flashy chatbot, and not an unrestricted autonomous
browser. Read-only work can flow. Consequential actions remain visible,
approval-aware, idempotent, and verifiable.

Repository:

    /Users/arnavsrivastava/Documents/Agent

GitHub repository:

    https://github.com/arnavsri993/kestrel-agent.git

Default branch: main.

---

## 1. Instructions for the receiving agent

Before editing:

1. Read the root instructions at
   /Users/arnavsrivastava/Documents/Agent/AGENTS.md.
2. Read the relevant sections of README.md, DESIGN.md, docs/architecture.md,
   docs/ai-native-browser.md, docs/permissions.md, docs/data-model.md, and
   SECURITY.md.
3. Inspect the live Git state:

       cd /Users/arnavsrivastava/Documents/Agent
       git status --short --branch
       git branch -vv
       git log -8 --oneline --decorate
       git diff --stat
       git diff --name-only

4. Preserve existing user work. Do not use git reset --hard, git clean, broad
   restore commands, or screenshot cleanup commands unless the owner explicitly
   asks and the exact paths are known.
5. Separate the requested change from pre-existing dirty work. Stage only files
   or hunks that belong to the requested task.
6. For desktop work, keep exactly one Kestrel development Electron session
   running. Use corepack pnpm dev:desktop. Do not launch a second Electron
   process or a separately packaged Kestrel app while the watcher is active.
7. Do not treat source edits, a unit-test pass, or a screenshot as proof that
   the packaged product works. Run the relevant runtime, packaged, and visual
   checks.
8. Never put API keys, OAuth tokens, passwords, cookies, private keys, local
   memory, or other secrets in prompts, source files, logs, commits, docs, or
   pull requests.

If this sheet conflicts with the live repository, the live repository and root
instructions win.

---

## 2. Current repository snapshot

Observed on 2026-08-14:

- Checkout: /Users/arnavsrivastava/Documents/Agent
- Remote origin: https://github.com/arnavsri993/kestrel-agent.git
- Default branch: main, tracked by origin/main
- Current branch: codex/edge-inspired-home-screen
- Current HEAD: d1240ee, Fix desktop channel configuration handoff
- Inspected origin/main: e607256, Prevent duplicate Kestrel desktop app instances
- Current branch was one commit ahead of the inspected origin/main.
- No remote branch named codex/edge-inspired-home-screen existed at inspection.
- The worktree is dirty.
- Node requirement: 22.12 or newer.
- Package manager: Corepack plus pnpm 11.15.1.
- Target platform: macOS 13 or newer; development packaging focuses on Apple
  Silicon arm64.

The worktree is not clean. The dirty state is not automatically a list of
files that belong to the next task.

### 2.1 Current in-progress UI work

The branch name and dirty diff indicate an in-progress Edge-inspired / more
personal Kestrel home-screen exploration. Current source changes include:

- packages/shared-types/src/contracts.ts
  - Adds UserBrowserSettings.newTabBackground with the allowed values
    graphite, meadow, dawn, and paper.
- apps/desktop/src/main/browser-tab-store.ts
  - Adds graphite as the persisted default.
- apps/desktop/src/main/browser-tab-store.test.ts
  - Covers the new default/schema behavior.
- apps/desktop/src/renderer/components/browser/new-tab.ts
  - Adds typed background options, history-derived frequent-site grouping,
    stable site initials, and deterministic accent selection.
- apps/desktop/src/renderer/components/browser/new-tab.test.ts
  - Covers origin grouping, recent URL selection, and stable glyph metadata.
- apps/desktop/src/renderer/components/browser/NewTabPage.tsx
  - Replaces the sparse old new-tab view with a local search/address field,
    frequent tabs, recommendations, and personalization entry.
- apps/desktop/src/renderer/components/browser/BrowserSettings.tsx
  - Adds NewTabPersonalization, which writes through the browser controller.
- apps/desktop/src/renderer/components/browser/AgentSidebar.tsx
  - Adds active personality display, collapse behavior, recent chats, and a
    task-history path.
- apps/desktop/src/renderer/components/browser/BrowserToolbar.tsx
  - Adds a visible chat/agent toggle in browser chrome.
- apps/desktop/src/renderer/components/browser/BrowserWorkspace.tsx
  - Wires the new browser controls and new-tab callbacks.
- apps/desktop/src/renderer/App.tsx
  - Adds persisted agent-sidebar visibility, recommended prompt handoff,
    settings routing, and the existing mounted conversation wiring.
- apps/desktop/src/renderer/browser.css
  - Adds the current home-screen visual exploration, responsive rules, and
    reduced-motion/reduced-transparency behavior.

There are also modified generated PNGs below:

    /Users/arnavsrivastava/Documents/Agent/artifacts/screenshots/desktop/

Treat those as generated/pre-existing until path-by-path provenance is proven.
Do not stage them by default.

### 2.2 Current WIP verification questions

Do not assume the home-screen exploration is complete. Verify:

- Existing browser state files migrate safely when newTabBackground is absent.
- The setting round-trips through BrowserTabStore, the main process, the
  validated renderer request, and the visible new-tab page.
- All four backgrounds remain legible and do not undermine Native Graphite.
- Frequent tabs use only local durable browser history and never invent sites,
  leak unsafe URLs, or create a second persistence system.
- Search/address submission still uses the existing normalized navigation path.
- Recommended prompts create a new task without orphaning the mounted
  conversation, losing approvals, or creating an empty task record.
- Sidebar collapse does not hide a focused descendant from assistive
  technology, interrupt a stream, or remove the only route to the agent.
- Browser and Agent remain independent primary surfaces.
- Compact width, keyboard focus, reduced motion, reduced transparency,
  forced-colors/high contrast, and console errors are checked in the app.
- New CSS does not turn Kestrel into a decorative gradient/glass/bento
  interface.

The current diff has focused unit coverage, but still needs focused desktop
browser smoke and actual visual inspection.

---

## 3. Product identity and thesis

### 3.1 What Kestrel is

Kestrel is a local-first, user-owned personal agent for macOS. The user states
an outcome in one conversation. Kestrel chooses a configured model/provider
route, uses bounded tools, pauses for consequential actions, and presents
evidence of what happened.

It is simultaneously:

1. A capable user browser with persistent tabs, history, downloads, search,
   browser settings, current-page context, and native browser chrome.
2. A durable agent workspace with conversations, tasks, project scope,
   approvals, tools, plans, schedules, activity, and recovery.

The browser is not merely a tool panel next to AI chat. The agent is not merely
chat hidden inside a browser.

### 3.2 What Kestrel is not

- Not a hosted cloud control plane.
- Not an unrestricted autonomous browser or a promise of general web
  automation.
- Not a generic productivity dashboard with fabricated metrics.
- Not a provider-owned identity or secret vault.
- Not a public release yet.
- Not permission to silently import private memories, cookies, credentials, or
  page instructions into model context.
- Not permission to label deterministic development adapters as real accounts.

### 3.3 Trust model

The user owns the data, model access, workspace grants, connectors, and
approvals.

    read/analyze/draft
            ↓
    bounded tool execution
            ↓
    policy classification
            ↓
    plain-language approval when consequential
            ↓
    idempotent execution
            ↓
    read-back verification and evidence

External content—including web pages, emails, documents, plugin resources, MCP
output, and model output—is untrusted data. It may inform a draft. It may not
grant permission, widen policy, authorize a purchase/send/delete, reveal a
secret, or rewrite Kestrel's system boundary.

---

## 4. User-facing information architecture

Primary destinations:

| Destination | Purpose | Invariant |
| --- | --- | --- |
| Browser | Persistent user tabs and pages | Browser chrome, tabs, history, downloads, and page context stay obvious and functional |
| Agent | Durable task library and agent workspace | Reuses encrypted runtime sessions; never fabricates productivity metrics |
| History | Local browser history search/reopen/clear | Clearing history does not silently clear tabs, cookies, downloads, or site data |
| Downloads | Download progress, completion/failure, Finder reveal | Reveal only completed, verified local files |
| Settings | Connections, browser, general, privacy, permissions, providers, memory, pets, skins, observability, reset | Consequence and recovery copy stays truthful |
| More / command center | Searchable grouped launcher for specialist surfaces | Every destination routes correctly; exact selectors matter in smoke tests |

The stable agent conversation stays mounted beside the main destination. Do not
unmount it merely because the user navigates to Browser, Agent, History,
Downloads, Settings, or a specialist route. Streams, cancellation, steering,
and approvals must remain coherent.

New Tab and New task are separate:

- New Tab creates/focuses a browser tab.
- New task starts a fresh agent draft and creates a durable session only when
  the first message is sent.
- Opening a tab does not create or replace a conversation.
- Starting a task does not alter browser tabs.

Stored runtime titles may contain compatibility names such as Main session.
Map that to the visible General label at display time rather than rewriting
persisted history.

Specialist surfaces retained behind More include work, approvals, plans,
activity, artifacts, research, opportunities, life context, memory, people,
calendar, extensions, pets, skins, observability, external secrets, and
configuration. Preserve their empty, loading, busy, error, provenance,
verification, and recovery states.

---

## 5. Runtime architecture and process boundaries

The critical flow is:

    sandboxed React renderer
        → validated preload bridge
        → Electron main process
        → CoreSupervisor / typed request broker
        → Agent Core utility process
        → encrypted SQLite, provider adapters, connector adapters, tools

The user browser WebContentsView lives in the main process. It can send
bounded, explicitly untrusted page context toward the utility process; it does
not merge with autonomous browser sessions.

### 5.1 Renderer

The renderer owns presentation state only. It has no Node.js, filesystem,
database, Keychain, raw credential, or direct network authority. It renders
React components, manages small UI-local preferences where appropriate, and
calls typed preload methods.

### 5.2 Preload

File:
 /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/preload/index.ts

The preload uses contextBridge and ipcRenderer. It validates requests/events
with shared Zod contracts. Do not expose arbitrary Electron APIs or a generic
IPC/eval escape hatch.

### 5.3 Main process

The main process owns:

- BrowserWindow lifecycle and single-instance behavior.
- Native WebContentsView user-browser embedding and bounds synchronization.
- Narrow renderer IPC handling.
- Notifications, tray, deep links, launch-at-login, updater channel, and
  native folder/file pickers.
- macOS safeStorage credential-broker interactions.
- External-browser OAuth coordination.
- Starting, stopping, and supervising the utility process.

Important files:

- /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/main/index.ts
- /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/main/core-supervisor.ts
- /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/main/core-request-lifecycle.ts
- /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/main/user-browser-service.ts
- /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/main/electron-browser-service.ts
- /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/main/browser-tab-store.ts
- /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/main/credential-broker.ts
- /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/main/single-instance.ts

### 5.4 Utility process / Agent Core

File:
 /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/utility/index.ts

The utility process starts AgentCore and bridges bounded browser-backend
requests. It owns the sensitive runtime:

- Encrypted sessions and messages.
- Agent loop, context compaction, checkpoints, forks, cancellation, and
  resumable approval pauses.
- Provider/model adapters and routing/audit metadata.
- Memory, life context, people, schedules, opportunities, connectors, and
  workflows.
- Policy evaluation, tool catalog, idempotency, and verification events.
- MCP, skills, plugins, browser automation, web access, code intelligence,
  remote execution, and ACP/editor bridges.

The renderer never talks to Agent Core directly. Every cross-process message
must be schema-validated, bounded, and explicit.

---

## 6. Repository map

    /Users/arnavsrivastava/Documents/Agent/
    ├── apps/
    │   ├── desktop/       Electron main, preload, utility, React UI, packaging
    │   ├── cli/           Terminal and ACP entry points
    │   └── website/       Static Next.js marketing/download site
    ├── packages/
    │   ├── agent-core/    Agent loop, runtime, providers, tools, connectors, memory
    │   ├── database/      SQLite migrations, encrypted records, adapters
    │   ├── encryption/    AES-256-GCM field encryption helpers
    │   ├── policy-engine/ Deterministic policy and untrusted-content rules
    │   └── shared-types/  Zod contracts, IPC schemas, product identity
    ├── scripts/           Browser/desktop smoke, capture, release, assets, security
    ├── docs/              Architecture, data, browser, threat, OAuth, release docs
    ├── artifacts/         Generated evidence/screenshots; stage intentionally only
    ├── website-media/     Approved media briefs/manifests/provenance
    ├── DESIGN.md          Authoritative Native Graphite and surface design
    ├── README.md          Product overview and developer paths
    ├── SECURITY.md        Security invariants
    ├── CONTRIBUTING.md    Owner-maintained preview rules
    └── AGENTS.md          Desktop/Git workflow instructions

### 6.1 Renderer map

- apps/desktop/src/renderer/App.tsx
  - Root state, onboarding, runtime conversation, shell routes, settings,
    deep-links, and legacy specialist surfaces.
- apps/desktop/src/renderer/styles.css
  - Global tokens, focus behavior, and general shell rules.
- apps/desktop/src/renderer/browser.css
  - Browser-first shell, sidebar, tabs, toolbar, new tab, command center,
    secondary surfaces, and responsive overrides.
- apps/desktop/src/renderer/browser/useUserBrowser.ts
  - Typed user-browser requests/events and native-bounds synchronization.
- apps/desktop/src/renderer/components/browser/BrowserWorkspace.tsx
  - Browser surface and WebContentsView host geometry.
- apps/desktop/src/renderer/components/browser/AgentSidebar.tsx
  - Stable conversation rail, task history, current-page context, navigation,
    and live agent status.
- apps/desktop/src/renderer/components/browser/AgentWorkspace.tsx
  - Durable task library with project/status/recency/approval/recovery context.
- apps/desktop/src/renderer/components/browser/BrowserToolbar.tsx
  - Address/search, back/forward/reload, page context, agent toggle,
    history/download/menu controls.
- apps/desktop/src/renderer/components/browser/TabStrip.tsx
  - Horizontal/vertical tabs, keyboard navigation, selection, close, new tab.
- apps/desktop/src/renderer/components/browser/NewTabPage.tsx
  - Current home/new-tab surface.
- apps/desktop/src/renderer/components/browser/new-tab.ts
  - Current WIP history grouping and background option helpers.
- apps/desktop/src/renderer/components/browser/BrowserSettings.tsx
  - Browser settings and current new-tab personalization.
- apps/desktop/src/renderer/agent-workspace.ts
  - Pure task-row mapping/filtering/status logic.
- apps/desktop/src/renderer/runtime-session-state.ts
  - Runtime session/stream state helpers.

App.tsx is large and contains legacy surfaces. Extract narrowly coupled
helpers/components only when it improves safety; do not perform a broad rewrite
just because the file is large.

### 6.2 Core/package map

- packages/agent-core/src/agent-loop.ts
  - Provider-neutral session loop, context, streaming, tools, approval pauses.
- packages/agent-core/src/runtime.ts
  - Durable sessions, runs, messages, tool executions, checkpoints, cancellation.
- packages/agent-core/src/providers/
  - OpenAI, Anthropic, Gemini, Ollama, compatible HTTP, Codex app-server,
    and subscription adapters.
- packages/agent-core/src/model-orchestration.ts
  - Task-aware routing/model-role/reasoning/Fast-mode decisions.
- packages/agent-core/src/browser-context.ts
  - Bounded page context assembly and untrusted labeling.
- packages/agent-core/src/browser-automation.ts
  - Isolated autonomous-browser backend contract and action boundaries.
- packages/agent-core/src/web-tools.ts
  - Visible-browser and web-tool installation/validation.
- packages/agent-core/src/memory.ts
  - Encrypted memory lifecycle, provenance, tombstones, correction/forgetting.
- packages/agent-core/src/life-context.ts
  - Calendar/people/memory context model and bounded explainable retrieval.
- packages/agent-core/src/connectors.ts
  - Connector boundaries, verification, idempotency, and development adapters.
- packages/database/src/index.ts
  - Database open, migrations, and persistence adapters.
- packages/encryption/src/index.ts
  - AES-GCM primitives.
- packages/policy-engine/src/index.ts
  - Approval levels and untrusted-content rules.
- packages/shared-types/src/contracts.ts
  - Zod schemas/types for runtime, browser, settings, IPC, responses, events.
- packages/shared-types/src/identity.ts
  - Stable compatibility identity for app ID, protocol, data directory, Keychain,
    and updates.

---

## 7. Browser subsystem: exact boundaries

### 7.1 User-visible browser

The user browser uses Electron WebContentsView inside the main BrowserWindow
with the persistent partition:

    persist:kestrel-user-browser-v1

Browser state is stored locally under the Kestrel user-data directory in
browser/state.json with owner-only permissions. Persisted state includes tab
metadata, safe URLs, history, download metadata, and settings. It does not
persist live view objects as the source of truth.

Current caps and behavior:

- Up to 32 open tabs.
- Up to 8 live WebContentsView instances; inactive views may be discarded and
  recreated.
- Up to 5,000 history entries.
- Up to 500 download records.
- History retention: none, 7, 30, 90, or 365 days.
- Session restore is configurable.
- User tab state and agent conversations have independent lifecycles.
- Main-process content bounds must be synchronized whenever browser layout
  changes.

### 7.2 Address/search normalization

File:
 /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/main/browser-tab-store.ts

The sanitizeBrowserUrl and normalizeBrowserAddress paths enforce:

- Only HTTP and HTTPS navigation.
- No embedded username/password credentials.
- Curated typed search engines, not arbitrary user URL templates.
- Direct URLs remain direct URLs; do not route them through search accidentally.
- Credential-like query/fragment values are removed before renderer state,
  durable browser metadata, or agent-visible context.
- Actual native navigation may use the complete safe URL while persisted and
  model-visible values stay sanitized.

Curated engines currently include DuckDuckGo, Google, Bing, Brave Search,
Ecosia, Startpage, Yahoo Search, Kagi, Qwant, Mojeek, Baidu, and Yandex.

### 7.3 Permissions, popups, downloads

The persistent user-browser session denies Electron permission checks and
permission requests by default.

A narrowly scoped popup allowance can convert one popup into a managed tab only
during the immediate user gesture that requested it. It is consumed once and is
not authorization for later script behavior.

Downloads go to a Kestrel-owned local directory. Finder reveal is available
only after completion and an existence check. Clearing history does not clear
cookies/site data, open tabs, or downloads.

### 7.4 Autonomous browser sessions

Agent-created sessions use separate ephemeral Electron partitions and explicit
origin allowlists:

- No cookie/storage merge with the user browser.
- Context isolation and no Node integration.
- Web security enabled.
- DevTools disabled.
- Navigation outside normalized allowed origins is refused.
- Authentication handoff may show the isolated window but does not merge
  credentials into user tabs.

### 7.5 Browser-to-agent context

The Current page toggle is renderer-local, stored under
kestrel:browser-context, and on by default unless disabled. When enabled, the
active user tab contributes a bounded snapshot only to the current request:

- Title, safe URL, description, capture time.
- Selected text up to 20,000 characters.
- Visible text up to 40,000 characters.
- Up to 60 headings, 100 links, and 60 visible forms.
- Viewport and scroll position.
- An agent-side context budget of about 16,000 characters after labeling.

The context is labeled untrusted_browser and explicitly says not to follow
page instructions, reveal credentials/cookies, or treat page content as
approval. It is not automatically committed to Memory.

### 7.6 Agent-visible user-browser tools

The core can inspect or operate the visible user browser through typed tools:
list tabs, bounded current-page/AX/screenshot context, local history,
downloads, tab selection/creation/closing, navigation, and page actions.

These are sensitive tools. Read-only inspection is distinct from clicking,
typing, navigation, tab mutation, and auth handoff. Mutating operations remain
subject to Kestrel's normal policy/approval path. Page text, links, forms,
history titles, download names, AX data, and screenshots are reference
material—not instructions or credentials.

---

## 8. Agent runtime and persistence

The encrypted runtime session is the source of truth for agent work. Do not
create a parallel localStorage, JSON, or renderer-only task database for
conversations, approvals, status, or productivity metrics.

Runtime sessions support:

- Create, list, search, open, resume, fork, checkpoint, restore, cancel, retry.
- Encrypted structured messages and monotonic per-session ordering.
- Streamed assistant deltas and typed runtime events.
- Tool execution records and model-call audit metadata.
- Approval pauses that survive restart.
- Workspace grants scoped to canonical allowed roots.
- Context compaction and hierarchical workspace instruction loading.
- Idempotency keys and expected-content checks for mutations.
- Activity, evidence, and recovery state instead of synthetic success metrics.

Workspace tools can list, read, search, load instructions, and atomically
create/update/delete UTF-8 files only within a canonical user-granted root.
Paths reject parent traversal, symlink escapes, home-wide grants, and root
ambiguity. Sensitive deletion needs approval. Shell commands run through an
allowlisted argv runner without a shell, with bounded output,
timeout/cancellation, and Seatbelt restrictions. Git status/diff and approved
isolated worktrees use the same boundary.

True PTYs and restart-persistent background processes are not complete product
capabilities; do not imply they are.

### 8.1 Provider/model routing

The runtime is provider-neutral. It has wire adapters for OpenAI Responses,
Anthropic Messages, Gemini GenerateContent, OpenAI-compatible hosted routes,
and local Ollama.

Optional Codex subscription access uses the official read-only app-server route.
Claude subscription access remains an isolated text-only CLI invocation. Kestrel
remains the tool and approval authority.

A provider/model must not be labeled connected until a configured credential or
local server passes a live read-back/health check. Provider-call audits store
provider/model/timing/token metadata but not prompts, responses, or credentials.

Automatic routing considers model family, reasoning effort, Fast mode, latency,
risk, tool use, deterministic coverage, and budget headroom. Do not replace it
with a provider-first guess or the first listed local model.

### 8.2 Connectors and integrations

The repository contains bounded implementations/contracts for:

- Gmail and Google Calendar through user-owned external-browser PKCE OAuth,
  encrypted refresh records, in-memory access tokens, revocation, live
  verification, and approval-gated sends/events.
- Deterministic development adapters that are visibly labeled and never claim
  to be connected accounts.
- Optional 1Password, Bitwarden Secrets Manager, and discrete-argv command
  helper sources; resolved values are memory-only.
- Optional Honcho remote memory, disclosure-gated and off by default.
- Content-free OTLP/Prometheus observability, off by default.
- Signed plugins, MCP, Agent Skills metadata discovery, and ACP editor clients.
- Pets, skins, rich widgets, event applications, media artifacts, workflows,
  and schedules behind approval/idempotency boundaries.

Changing a connector requires evidence for permission boundaries, idempotency,
read-back verification, and failure/retry behavior.

---

## 9. Data model and security invariants

### 9.1 Canonical state

- SQLite is canonical for encrypted agent/runtime data.
- Browser tabs/history/settings are canonical in BrowserTabStore's local state.
- Embeddings/search indexes are replaceable indexes, never the source of truth.
- Memory deletion is tombstoned before optional secure cleanup.
- Schema changes require a forward migration under
  /Users/arnavsrivastava/Documents/Agent/packages/database/migrations/.
- Zod contracts in packages/shared-types are the boundary for external,
  model-produced, renderer, main, utility, and connector structures.

### 9.2 Encryption and secrets

- Sensitive memory/runtime fields use AES-256-GCM with per-record IV and tag.
- The database key is supplied through the main-process credential broker and
  protected by Electron safeStorage.
- The key is never written into the database or renderer state.
- Agents must never ask users to paste secrets into chat.
- Secret entry belongs in protected native fields or provider-owned OAuth/CLI
  login surfaces.
- Credentials are never read back into UI state or logs.
- FAL_KEY is development-only and must never enter product runtime or a public
  website bundle.

### 9.3 Approval levels

| Level | Meaning |
| --- | --- |
| 0 | Read-only analysis and drafts |
| 1 | Reversible local/tentative changes, configurable |
| 2 | External communication; approval by default |
| 3 | Sensitive submissions; explicit review every time |
| 4 | High-consequence action; strong confirmation and reauthentication |

Policies are scoped by capability, connector, relationship, recipient, and
purpose. Persistent allow rules remain visible and revocable. External content
cannot create or widen an allow rule.

### 9.4 macOS permissions

Request permissions at use, not in blanket onboarding. Selected folders are
explicit allowlists. Accessibility, Screen Recording, microphone, camera, and
Apple Events stay off until a capability invokes them. Launch at Login is
opt-in and the UI distinguishes preference from actual macOS registration.

---

## 10. Design and interaction language

DESIGN.md is the authoritative design specification. The current desktop
system is Native Graphite.

### 10.1 Visual rules

- Quiet Mac instrument; one current task or page is visually primary.
- Matte graphite planes, thin rules, restrained sage signal, aluminum ink.
- Sparse/welcoming setup and new task; comfortable dense-app rhythm elsewhere.
- Preserve the 4px base and common 8/12/16/20/24/32px rhythm.
- Use semantic native buttons, fields, lists, headings, landmarks, and status
  regions.
- Selected/focused controls use restrained sage tint and visible ring.
- Warning, error, success, provenance, confidence, and approval states need
  text/icon/shape cues in addition to color.
- Support copy is earned: explain consequence, provenance, privacy, recovery,
  or an empty state.
- Do not add a second visual system or framework to polish one route.

### 10.2 Source tokens

Source of truth:
 /Users/arnavsrivastava/Documents/Agent/apps/desktop/src/renderer/styles.css

Important current tokens:

- canvas: #1c1c1e
- sidebar: #151517
- surface: #2b2b2e
- surface-strong: #3a3a3d
- panel: #242426
- ink: #f5f5f7
- muted: #c0c0c5
- faint: #98989e
- line: #3a3a3e
- line-strong: #59595f
- signal: #82c68f
- signal-deep: #a6d8ae
- brand: #b7d68a

Consume these roles instead of hardcoding unrelated values.

### 10.3 Avoid

- Neon, glow, excessive blur, heavy bezels, fake terminal chrome.
- Decorative glass as the primary material.
- Floating bento/card catalogs, pill forests, rainbow provider palettes,
  ornamental badges, ambient AI visuals, or unproven image assets.
- Navigation labels that duplicate page headings.
- Invented totals/scores/AI-magic statuses.
- Removing functionality to make one surface look simpler; use progressive
  disclosure and More/command center.

### 10.4 Motion/accessibility

- Motion is interruptible and usually 100–220ms.
- Reduced motion removes travel, scale, blur, and pulse while retaining meaning.
- Reduced transparency replaces blurred/translucent chrome with opaque surfaces.
- Focus remains a visible 2px sage ring.
- Horizontal tabs use Left/Right; vertical tabs use Up/Down; Home/End work in
  both. aria-orientation must match.
- Keep Cmd/Ctrl+L, Cmd/Ctrl+T, Cmd/Ctrl+W, Cmd/Ctrl+Tab,
  Cmd/Ctrl+Shift+Tab, and Cmd+N for New task.
- Never hide the currently focused or active conversation with aria-hidden.
- Do not use color as the only state indicator.
- Do not introduce page-level horizontal scrolling; recompose compact layouts.

---

## 11. Current home-screen continuation brief

If the task is to continue codex/edge-inspired-home-screen, use this brief:

> Make Kestrel's new tab feel like a calm, useful local home rather than an
> empty browser dead end. Let the user search/open a site, see a small
> history-derived frequent-tab row, start a useful agent task, and optionally
> personalize appearance. Preserve browser security, navigation normalization,
> durable history, independent Browser/Agent lifecycles, Native Graphite
> hierarchy, and accessibility. Do not add cloud imagery, arbitrary remote
> assets, a new persistence layer, or fake personalization data.

Current implementation intent:

- Four typed appearance options, graphite as the migration/default value.
- Frequent sites grouped by URL origin from existing browser history.
- Most recent useful URL/title retained per origin.
- Non-HTTP(S) or malformed history ignored fail-closed.
- Stable deterministic accent from hostname; no fetched favicon/external request.
- Recommendation cards pass explicit prompts into the existing New task path.
- Personalization writes through browser.updateSettings.

Acceptance checks:

1. Fresh profile has a usable search/address field and does not claim frequent
   tabs exist before history exists.
2. Populated profile groups repeated visits by origin and orders by visit count
   then recency; malformed input never crashes the surface.
3. Search and direct URL navigation preserve existing behavior and safe URL rules.
4. Background selection survives restart and changes only the new-tab surface.
5. Settings opens directly from new tab and selected state is accessible.
6. Recommendation CTA opens a fresh task with its intended prompt and creates no
   blank task record.
7. Sidebar collapse/expand is a UI preference, not a runtime-session mutation.
8. Active personality display is truthful and falls back to Kestrel only when no
   selected personality resolves.
9. WebContentsView bounds stay correct after sidebar collapse, window resize,
   tab-layout changes, and route changes.
10. Visual QA passes at supported desktop dimensions, compact width, reduced
    motion, reduced transparency, keyboard-only navigation, and no console
    errors.

Judgment points:

- DESIGN.md discourages decorative gradients/glass. Variants must remain
  readable and subordinate to Native Graphite.
- The sidebar is structurally mounted so the conversation stays stable. Verify
  screen-reader visibility, focus, and layout before considering unmounting.
- Browser history is untrusted input. Never render it as executable HTML or use
  it as an arbitrary navigation template.
- Settings defaults are migration behavior. Do not make the field required
  without handling old state.json files.

---

## 12. Development and verification commands

Run commands from:

    cd /Users/arnavsrivastava/Documents/Agent

Install and start the one desktop watcher:

    corepack enable
    corepack pnpm install
    corepack pnpm dev:desktop

Main changes restart Electron, preload rebuilds, and renderer changes use Vite
HMR. Leave the watcher running after desktop source changes when a current app
session exists.

Website:

    corepack pnpm dev:website

Focused checks for browser/UI work:

    corepack pnpm typecheck
    corepack pnpm test -- apps/desktop/src/main/browser-tab-store.test.ts apps/desktop/src/renderer/components/browser/new-tab.test.ts
    corepack pnpm build:desktop
    corepack pnpm test:desktop-smoke
    corepack pnpm test:desktop-browser
    corepack pnpm test:desktop-fresh-profile
    corepack pnpm assets:verify

The exact Vitest invocation may be adjusted to current package scripts; report
the actual output.

For UI changes:

    corepack pnpm capture:desktop

Inspect captures at actual size. Check loaded, empty, busy, error, approval,
recovery, compact, keyboard-focus, reduced-motion, and reduced-transparency
states. A screenshot without runtime/console inspection is not sufficient.

Broad non-paid gate:

    corepack pnpm verify

This includes typecheck, Vitest, reference/market audits, builds, website E2E,
desktop smoke suites, browser/setup/fresh-profile and specialist checks,
packaged CLI, editor checks, and production-secret scanning.

Full Apple Silicon live-demo/package gate:

    corepack pnpm verify:meetup

Development packaging:

    corepack pnpm package:mac:dev
    corepack pnpm test:packaged-desktop:arm64

Optional local install:

    corepack pnpm install:mac:dev
    open -a Kestrel

The development app is ad-hoc signed, uses a development bundle identity and
disabled-update channel, and intentionally preserves the canonical Kestrel
data/Keychain identity until a tested migration exists. It is not proof of
Developer ID signing, notarization, clean-machine Gatekeeper acceptance, public
updater hosting, or a public release.

---

## 13. GitHub publishing workflow

The repository is owner-maintained, but completed changes normally publish
through an unmerged pull request unless the owner explicitly says not to.

Rules:

1. Never commit directly to or push directly to main.
2. Use a focused codex/ branch.
3. Inspect remotes, branch tracking, authentication, default branch, and
   existing PRs before publishing.
4. Preserve unrelated dirty changes and stage only intended paths/hunks.
5. Run relevant validation before opening the PR.
6. Reuse an existing PR for the branch; do not create duplicates.
7. Do not merge unless explicitly asked.
8. Mention validation limits, generated artifacts, and packaging boundaries in
   the PR description.
9. If GitHub auth, permissions, destination, or remote is unavailable, finish
   safe local work and report the exact blocker. Do not invent a fork/repository.

Useful checks:

    git status --short --branch
    git diff --check
    git diff --stat
    git branch -vv
    gh auth status
    gh pr list --repo arnavsri993/kestrel-agent --state open

---

## 14. Honest product/release boundaries

Do not overstate these facts:

- Public Google OAuth app verification and bundled client registration are not
  complete. Users can connect their own Google Desktop OAuth client through the
  documented PKCE flow.
- The current macOS development artifact is ad-hoc signed, not Developer ID
  signed and not notarized.
- Public update hosting and a public download are not complete release proof.
- Browser extensions, bookmarks, profile import/sync, cross-device sync,
  private browsing, site permission manager, and browser-specific per-action
  approval receipts are follow-up scope.
- True PTYs, restart-persistent background jobs, full Git publishing,
  Streamable HTTP protocol hosts, plugin dependency resolution/marketplace
  distribution, peer-agent messaging, production browser backends/channels,
  and OS-woken automation remain bounded or unfinished.
- Development Gmail/Calendar/model/update adapters stay visibly labeled until
  their real account/configuration checks pass.
- A passing local test suite is not a public distribution claim.

---

## 15. High-value documents

Consult the relevant document before changing its surface:

- README.md — product capabilities, developer paths, package/release commands.
- DESIGN.md — authoritative Native Graphite design, IA, copy, motion,
  accessibility, browser/agent direction.
- docs/architecture.md — process boundaries, runtime/tools, extension/browser
  contracts.
- docs/ai-native-browser.md — user/autonomous browser split, trust, browser QA.
- docs/data-model.md — canonical data, encryption, migrations, implemented-vs-
  target table discipline.
- docs/permissions.md — approval levels and macOS permission boundaries.
- docs/threat-model.md — security threats and defensive assumptions.
- docs/google-workspace-oauth.md — OAuth, refresh storage, revocation, Gmail/
  Calendar boundaries.
- docs/local-ai-setup.md — pinned local runtime installation and live proof.
- docs/macos-distribution.md — packaging/signing/notarization boundaries.
- CONTRIBUTING.md — owner-maintained preview and evidence requirements.
- SECURITY.md — renderer, secrets, OAuth, encryption, and release invariants.

All are under:
 /Users/arnavsrivastava/Documents/Agent

---

## 16. Definition of done

### Scope and source of truth

- Requested behavior is implemented in the existing architecture.
- No second persistence system was introduced for data already owned by
  runtime/database/browser state.
- New cross-boundary data has a Zod contract and bounded size/shape.
- Schema changes migrate old state safely and have focused tests.
- Unrelated user changes and generated artifacts remain untouched.

### Product and UX

- Browser and Agent remain equal, understandable, and independently usable.
- New Tab and New task remain distinct.
- The primary action is obvious without removing advanced functionality.
- Copy is concise and truthful about privacy, provenance, approval, recovery,
  and empty/loading/error states.
- Native Graphite hierarchy and existing tokens are respected.

### Safety

- External content remains untrusted.
- No secret is requested, persisted, or exposed through chat/renderer/logs.
- Consequential actions use the existing policy/approval boundary.
- Mutations have idempotency and read-back verification where applicable.
- Browser profile boundaries and URL sanitization remain intact.

### Accessibility and runtime

- Semantic controls, labels, status roles, keyboard paths, and visible focus
  work.
- Compact layouts do not introduce page-level horizontal scrolling.
- Reduced motion and transparency preserve meaning and usability.
- The one running development app reflects current source through HMR/restart.
- No uncaught renderer/main/utility console errors appear in the tested path.

### Evidence and publishing

- Focused unit/type checks pass.
- Relevant desktop/browser smoke checks pass.
- UI changes have actual rendered inspection/capture.
- Packaging smoke runs when desktop behavior or release paths change.
- git diff --check passes.
- Only intended files are staged.
- The focused branch is pushed and an unmerged PR is opened/reused unless the
  owner explicitly requested local-only work.
- The final report says exactly what was verified and what remains unverified.

---

## 17. Suggested first response after inspection

After reading this sheet and inspecting the live checkout, report briefly:

1. Branch/commit and dirty paths found.
2. Whether the work is safe to continue in place or needs an isolated worktree.
3. The smallest implementation/verification plan.
4. Tests and real app/package evidence you will run.
5. Any blocker that cannot be discovered or resolved locally.

Do not claim the task is done until the actual repository, running app, and
packaged artifact evidence support the claim.
