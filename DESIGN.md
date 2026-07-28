# Kestrel design system

## Final Native Graphite system — July 2026

This section is the authoritative desktop visual and interaction specification.
Older sections below preserve feature-specific safety boundaries and design
history. Where an older palette, type scale, material, navigation treatment, or
product name conflicts with this section, this section wins.

### Product position

- Operating mode: `existing-redesign` of the packaged React/Electron desktop
  product. Renderer behavior, IPC, persistence, provider setup, approvals,
  extension contracts, and user-authored skins remain intact.
- Thesis: Kestrel is a quiet Mac instrument that turns an outcome into
  inspectable work. One current task is visually primary; permissions,
  execution state, evidence, and recovery remain nearby without becoming a
  dashboard.
- Product loop: `ask → scope → act → approve when consequential → verify`.
  Setup introduces that same loop and structurally becomes the workspace.
- Density: sparse and welcoming for setup and a new task; comfortable dense-app
  rhythm for conversations, ledgers, settings, and specialist tools.
- Identity: dark Native Graphite, aluminum ink, and a restrained sage signal.
  The angular Kestrel mark and a persistent local-status anchor are the repeated
  motifs. The product must not resemble a generic AI dashboard, developer
  console, Apple clone, or card catalog.

### Tokens and geometry

- Type: SF Pro Display for setup headlines, page titles, and the Kestrel name;
  SF Pro Text for controls and reading; SF Mono only for paths, hashes, model
  IDs, routing, usage, and evidence.
- Scale: setup display `48/50`; workspace greeting `40/44`; page title `32/38`;
  section title `19/24`; body and conversation `14/22`; control `13/18`;
  support `12/18`; evidence `11/16`. Critical explanatory text never uses the
  evidence size.
- Spacing: 4px base with `8/12/16/20/24/32/40/56/72`. Main reading measure is
  760px; setup task measure is 880px; dense ledgers may expand to 1040px.
- Radius ladder: 8px compact controls, 12px grouped rows and buttons, 16px
  elevated composer and transient disclosures, 22px major setup surfaces.
  Circular geometry is reserved for icon actions, status dots, and the mark.
- Controls: 36px minimum compact controls, 40px normal controls, and 44px
  primary/setup actions. One primary action per decision region. Hover,
  pressed, selected, disabled, busy, success, warning, and error states must
  remain distinct without relying on color alone.
- Color roles: canvas `#1c1c1e`; deep rail `#141416`; panel `#242426`; raised
  surface `#2c2c2e`; strong surface `#3a3a3c`; aluminum ink `#f5f5f7`;
  secondary ink `#b8b8bd`; tertiary ink `#8e8e93`; line `#38383b`; sage signal
  `#78b986`; amber only for warning/approval; red only for error/destructive.

### Material and surface grammar

- Content planes are matte and mostly opaque. List-like information lives in
  one continuous surface with subtle separators rather than separate bordered
  cards.
- The composer is the primary elevated work surface. Approval drafts, artifact
  previews, and isolated interactive results may be self-contained surfaces
  because their boundaries carry meaning.
- Transparency and blur are limited to persistent navigation over scrolled
  content, the top drag bar, and transient floating disclosures. They must
  respond to reduced transparency and increased contrast. No content panel gets
  `backdrop-filter` merely for decoration.
- Selected controls use a quiet sage-tinted surface and exact ring, never a
  glowing border or left-edge selection bar. Sage marks focus, verification, or
  the current anchor; it does not color whole screens.
- Shadows are short and low elevation. Gradients, decorative glass, glow,
  floating bento layouts, ornamental badges, pill forests, provider-logo walls,
  fake terminal chrome, and ambient AI visuals are out of scope.

### Information architecture and copy

- Primary navigation is New chat, recent Chats, a single Tools disclosure, and
  Settings. Urgent approval status remains visible. Specialist routes are fully
  retained inside the Tools disclosure and contextual links.
- The Tools disclosure is a transient, grouped launcher. It closes after
  navigation, on Escape, and when Settings or New chat is chosen. Compact
  windows render it as a bounded sheet above bottom navigation with its own
  scroll region.
- Page headers name the surface directly. Eyebrows are reserved for real state
  or trust boundaries, not decoration. Support copy appears only when it
  explains consequence, provenance, privacy, recovery, or an empty state.
- Settings uses one section navigator and continuous setting rows. Technical
  detail stays in native disclosures; primary choices and current state remain
  visible.

### Setup and workspace continuity

- The five stable stages remain Welcome, Before you begin, Choose a model,
  Model setup, and Ready. The progress rail is one row at every supported
  width and should feel like a short path, not five separate forms.
- A shared Kestrel anchor combines the mark, local/private status, and current
  setup state. It remains in a stable composition through setup, then moves into
  the workspace status location when setup completes.
- Each stage makes one decision dominant. Welcome states the promise; Before
  you begin exposes four non-negotiable boundaries with concise summaries and
  optional detail; Choose a model presents three clear routes; Model setup
  progressively discloses provider or model detail; Ready reports verified,
  configured-but-unverified, or preview truthfully.
- Completion is state-driven. The final anchor and primary surface use shared
  layout continuity into the first workspace; no prerecorded transition,
  timeout-gated interaction, or fixed copy is required. If the workspace is
  still loading, the same anchor remains visible rather than flashing an
  unrelated loading screen.

### Motion and accessibility

- Motion role 1 — focal continuity: the shared Kestrel anchor and setup surface
  reposition across setup and completion.
- Motion role 2 — state continuity: brief opacity/position changes for setup
  stages, route changes, and transient disclosures.
- Motion role 3 — direct feedback: hover, press, focus, recording, progress, and
  verified/error state changes.
- Motion is interruptible, usually 120–220ms, and never delays interaction.
  Reduced motion removes travel, scale, blur, and pulse, retaining short fades,
  text, icons, and color/state changes. Reduced transparency replaces blurred
  chrome with an opaque surface. Keyboard focus remains a visible 2px sage ring.

### Functional state contract

- Setup: first and returning visit; all five stages; warning unchecked/checked;
  account, local, and free-account routes; credential loading/saving/configured
  and failure; provider search/selection/planned adapters; automatic local setup
  unsupported/detecting/downloading/verifying/installing/starting/cancelled/
  failed/ready; manual setup collapsed/expanded; live provider verification;
  verified/configured/preview completion; setup-help handoff.
- Workspace: startup/error/retry; new and persisted chat; project absent/granted;
  automatic/manual routing; attachments; recording/transcribing; empty,
  streaming, steering, tool progress, failure/retry, checkpoint, usage, skill
  review, approval pending/approved/rejected/edited, and local agent status.
- Specialist surfaces: loading, empty, selected, busy, disabled, success,
  warning, error, provenance, verification, recovery, compact reflow, keyboard
  focus, reduced motion, and reduced transparency remain representable.

### Implementation plan and expected files

- Consolidate renderer tokens and final component overrides in
  `apps/desktop/src/renderer/styles.css`.
- Introduce the shared setup/workspace anchor, shorten high-volume copy, and
  improve the Tools disclosure and navigation behavior in
  `apps/desktop/src/renderer/App.tsx`.
- Reuse and normalize the existing approval, artifact, dashboard, memory,
  opportunity, work, settings, skin, presence, observability, and secret-source
  components rather than adding a second component system.
- Expand `scripts/capture-desktop.ts` and setup/desktop assertions to capture
  every setup stage, major workspace surfaces, compact layouts, reduced motion,
  reduced transparency, and overflow.
- Inspect three rendered passes, record the largest visible weaknesses, then
  package and smoke-test the actual macOS application.

### Research and source-use ledger

- Apple Human Interface Guidelines, Materials, and accessibility evaluation
  criteria, accessed 2026-07-27: navigation/control layers may use material when
  depth is real; text-heavy content needs stable contrast; reduced motion keeps
  meaning while removing spatial, scale, and blur effects.
- `naplesblue/apple-design-skill` at
  `e81692da299d64b9bf38ae26db2d709fc60c8bf3`, accessed 2026-07-27, MIT:
  direction-only guidance for hierarchy, unified surfaces, purposeful
  material, concise controls, and interruptible same-path motion. No tokens,
  assets, or components copied.
- `justinwetch/HIGAgentSkills` at
  `701151a7b39609b71a58d54de6d86e3500c0c316`, accessed 2026-07-27, no repository
  license detected: summary-only research for macOS density, onboarding,
  sidebars, lists, settings, focus, and motion. Nothing copied or derived
  verbatim.
- Frontend classifier output was treated as non-authoritative because it routed
  this repository-wide product redesign as a marketing/component task. The
  actual repository, user contract, and rendered Electron states establish
  `existing-redesign`, multi-surface product-interface mode.

### Rendered refinement and delivery evidence

- The final evidence set contains 34 screenshots captured from the packaged
  Apple Silicon application in
  `artifacts/screenshots/desktop/final-native-graphite/`: every setup stage and
  route, warning detail, account/local/free provider variants, setup completion,
  workspace continuity, transient Task settings and Tools, every specialist
  surface, every Settings section, compact navigation, reduced motion, and
  reduced transparency.
- Pass 1 joined the setup anchor to its workspace target, removed clipped Tools
  navigation, and replaced the Readiness card cluster with one ruled plane.
  Pass 2 corrected the compact model chooser's squeezed text and control
  geometry. Pass 3 re-ran the complete packaged capture with no page-level
  horizontal overflow, one-row setup progress, bounded disclosures, visible
  keyboard focus, console errors, or long-running reduced-motion animations.
- Sparse space is intentional only in setup, new task, Research, Artifacts, and
  extension empty states: it protects one decision, one composer, or one empty
  outcome. Dense operational surfaces use continuous rows and dividers instead
  of vacant scale or decorative cards.
- Controls remain real application controls, not presentational imitations.
  Setup, model routes, local installation, OAuth entries, Tools navigation,
  task settings, Kanban movement, readiness and backup, secrets, observability,
  memory, skins, plugins, widgets, applications, managed policy, and compact
  reflow are exercised by the desktop suites.
- The redesign adds no runtime dependency, generated media, or heavy UI
  framework. The production renderer is 1,296,287 bytes of JavaScript and
  164,446 bytes of CSS before transport compression. Motion is limited to the
  three roles above and reduced-motion capture rejects any animation that
  remains active beyond 50ms.
- `release/mac-arm64/Kestrel.app` is a 460 MB development bundle. Its renderer,
  native Sharp dependency, and isolated browser tool pass the packaged smoke
  test. Its linker signature is ad hoc with no Team ID; this proves the private
  Apple Silicon build only, not Developer ID signing, notarization, update-feed
  readiness, or public distribution.

Reference parity is deliberately layered, not a claim that every named vendor adapter ships in core. The 1,117-page Hermes/OpenClaw audit separates bundled capability families, signed extension contracts, and operational documentation. Native-node behavior is represented by a tested paired-device extension protocol rather than a bundled mobile app; Kestrel itself is a direct-download Apple Silicon Mac application.

## Public privacy and support surfaces

- Operating mode: `greenfield-build` for two bounded static release routes inside
  the existing marketing system.
- Thesis: legal and recovery content should read like an inspectable ledger, not
  a generic policy template—one decisive promise, numbered boundaries, and no
  invented publisher or support facts.
- System lock: preserve the Bricolage Grotesque/IBM Plex type roles, paper and
  ink palette, ruled material, 4px spacing basis, and lime provenance accent.
  Use sparse editorial density in the opening composition and compact readable
  density in the ledger. No cards, gradients, illustrations, accordions, legal
  theater, or motion beyond existing focus feedback.
- Integrity: distinguish local data, deliberate provider routes, paired-node
  permissions, optional diagnostics, deletion, and external-provider retention.
  State that the preview is not a public service until a real publisher contact,
  signed release, and support channel exist.
- Responsive contract: desktop uses an offset two-column intro and numbered
  reading rail; mobile becomes one headline column with a narrow persistent
  section index. Body type increases on mobile, links retain native semantics,
  and neither route may overflow.
- Why this is not generic: the same flat evidence grammar used by the product
  becomes the legal information architecture, while missing operator facts stay
  visibly release-gated instead of being filled with placeholder claims.

## Apple Silicon download handoff

- Operating mode: `component-build` inside the existing release section.
- Thesis: the installer becomes available only as a three-part evidence set—
  signed DMG, machine-readable manifest, and SHA-256 checksums—so the primary
  action is direct without turning provenance into fine-print theater.
- States: development keeps native disabled controls; a public release requires
  a semantic version and HTTPS DMG/manifest/checksum URLs before rendering
  links. Invalid, insecure, partial, or non-DMG configuration fails closed.
- Hierarchy: the lime action is reserved for the Apple Silicon DMG. Verification
  is the supporting action, architecture and minimum macOS stay adjacent, and
  the release ledger changes from pending to ready from the same validated
  configuration.
- Runtime boundary: stable packaged builds use electron-builder's `latest`
  macOS feed, notify after a signed update downloads, and install on quit.
  Development builds never query the production feed.
- Why this is not generic: download availability is derived from release
  evidence rather than marketing copy, and the artifact's architecture,
  manifest, and checksum remain part of the primary handoff.

## Event and hackathon applications

- Operating mode: `component-build` within the existing dense desktop application.
- Thesis: applications behave like a review desk, not a growth dashboard—one imported opportunity, explicit eligibility evidence, answer-level sensitivity, and a visible consent boundary before browser work.
- Density and material: preserve Kestrel's flat ruled planes, compact native controls, serif focal heading, and 4px spacing rhythm. Avoid cards, completion confetti, competitive leaderboards, and fake acceptance odds.
- State contract: first-use, imported draft, agent preparing, ready, unresolved eligibility, unreviewed personal or sensitive answers, approved, submitted receipt, error, offline/provider unavailable, and compact reflow.
- Motion: existing page crossfade only; all review and approval state changes are immediate and reduced-motion safe.
- Integrity: importing and drafting never means submitted. The assistant cannot attest eligibility, accept legal terms, pay fees, or send externally without a separate explicit approval and verified receipt.
- Why this is not generic: the surface makes provenance and consent the visual hierarchy—sensitive answers carry a danger rule, eligibility is evidence-backed, and the final action describes the browser boundary instead of promising one-click application magic.

## User-authored visual skins

- Operating mode: `component-build` inside the existing dense desktop application and terminal surfaces.
- Product mandate: appearance is a reversible presentation choice, separate from personality, prompts, memory, tools, approvals, and permissions. Kestrel ships coherent built-ins and accepts user-authored JSON without accepting executable CSS or code.

### Selected system lock

- Thesis: one structural Kestrel can wear several legible visual identities. Layout and interaction contracts stay fixed while semantic color roles, terminal accents, prompt symbol, response label, tool prefix, and thinking verbs change together.
- Density profile: preserve the existing `dense-app` shell and flat, ruled Settings rows.
- Type and spacing: preserve native New York/system/SFMono roles and the established 4px spacing scale; skins cannot replace fonts, dimensions, or layout.
- Color roles: every skin supplies the complete semantic set for canvas, sidebar, hover, surfaces, ink hierarchy, rules, primary controls, signal/focus, health, danger, and brand. Import inherits from an installed base, then overrides only named roles.
- Material: matte planes and ruled rows remain structural. The picker is a compact list with a five-color swatch, name, description, provenance, and persistent selected state—not a card gallery.
- Safety boundary: strict versioned JSON, 64 KB maximum, regular non-symbolic-link files, known keys only, bounded text, hexadecimal colors, no URLs/scripts/CSS, at most 20 custom skins, and contrast validation before encrypted persistence.
- State coverage: loading; four built-ins; selected/unselected; immediate preview; persisted restart; valid inherited import; malformed/unknown-key/oversize/symlink/low-contrast rejection; custom selected; custom removal with deterministic Kestrel fallback; terminal session switching through `/skin`; CLI list/select/import/remove.
- Motion roles: no skin-specific animation. Selection changes are immediate, while existing reduced-motion behavior remains authoritative.
- Avoid list: personality coupled to color, arbitrary stylesheet injection, inaccessible novelty palettes, gradients/glow as identity, decorative card grids, remote theme downloads, hidden fallback behavior, and a skin silently changing tools or instructions.
- Why this is not generic: a single versioned skin definition drives both the graphical desktop token system and terminal vocabulary while preserving Kestrel’s verified safety and product-identity boundaries.

### Rendered refinement and state evidence

- Captures inspected: 1320×900 Daylight and inherited Field Notes states plus 640×760 Slate compact reflow.
- Three highest-impact weaknesses fixed: the first integration placed appearance after the destructive reset boundary; theme-independent orange/green/warning literals leaked the Kestrel palette into other skins; and the compact picker needed a two-column recomposition instead of shrinking its three-column desktop row.
- Final behavior: the picker now follows the setup entry near the top of Settings, all operational states consume semantic skin roles, the selected row combines `aria-pressed`, a signal rule, and a quiet status surface, keyboard focus remains visible, custom provenance is explicit, and removal deterministically restores Kestrel.
- Runtime evidence: real Electron tests cover built-in selection, light-mode tokens, restart persistence, native-dialog custom import, inherited overrides, custom removal, focus, compact overflow, console/page errors, and screenshots. Core tests cover built-in contrast, encrypted durable selection, strict inheritance, contrast rejection, and fallback.

## Activity pets and detachable companion

- Operating mode: `component-build` inside the existing desktop, CLI, and TUI surfaces.
- Product mandate: Hermes-compatible activity pets are optional presentation, never model context. A pet may make Kestrel’s state easier to notice, but it cannot change prompts, tools, permissions, memory, cost, or approval policy.

### Selected system lock

- Thesis: a pet is a small ambient status instrument with personality, not a second dashboard. It stays at the edge of the work plane, reflects a closed activity vocabulary, and can detach into a transparent mini-agent window when the user wants it nearby.
- Density and hierarchy: preserve the flat ruled Settings system. The installed pet, provenance, on/off state, pop-out action, scale, and terminal mode form one continuous row; gallery discovery remains a disclosure below it.
- Asset contract: accept only current or legacy Petdex sprite atlases at 1536×1872 or 1536×1664, with eight columns, bounded bytes, exact HTTPS host/path policy, no redirects, and digest plus dimensions rechecked before every render.
- Activity vocabulary: idle, wave, running, failed, reviewing, finished, and waiting for approval. Text status and `role=status` remain available; animation is never the only state signal and reduced motion freezes the frame.
- Desktop behavior: the in-window pet is a transparent edge control; shift-click detaches it. The separate frameless window is always on top, bounded to visible displays, position-persistent, draggable only from its explicit handle, and returns the pet to the main app on close. A single click opens a bounded quick-task composer, double-click toggles Kestrel, and shift-click returns the pet.
- Terminal behavior: CLI and TUI share encrypted selection and scale. Kitty and iTerm2 receive their native inline-image protocols; Unicode half-blocks provide a deterministic true-color fallback. Unsupported or non-TTY output stays off instead of emitting escape noise.
- Ownership: community assets remain owned and licensed by their submitters. Kestrel fetches the public manifest for browsing, downloads only after an explicit Install action, records creator and source provenance, and never republishes the gallery.
- State coverage: no pet; gallery loading/error/empty/results; install/select/remove; enabled/off; seven activity states; reduced motion; scale; current/legacy atlas; corrupt digest; restart persistence; detached/restored/externally closed overlay; quick composer closed/open/error; compact Settings.
- Avoid list: automatic remote downloads, model-visible mascots, decorative card grids, constant attention animation, speech generated without a task event, hidden ownership, arbitrary remote image URLs, silent atlas repair, fake sixel support, and an overlay that steals focus.
- Why this is not generic: one verified Petdex sprite contract drives desktop, detachable overlay, CLI, and TUI state while Kestrel’s local safety and approval boundaries stay structurally unchanged.

### Rendered refinement and state evidence

- Captures inspected: 1320×900 installed Paperclip Settings and 236×278 transparent Paperclip overlay.
- Three highest-impact weaknesses fixed: the first Settings render inherited an error-colored search border, represented the installed pet with initials instead of its verified sprite, and only exposed an idle mascot rather than actual runtime states. The revised UI has a semantic neutral search field, a real digest-verified preview, explicit Pop out/Turn off hierarchy, and event-driven activity rows.
- Overlay refinement: the companion uses one speech label, one sprite focal point, and a quiet drag affordance; the composer appears only on request. Single- and double-click are disambiguated, normal close self-heals persisted state, and the main renderer receives pet-status broadcasts so the pet cannot remain invisibly detached.
- Runtime evidence: a live Electron test searches the approved Petdex manifest, installs Paperclip, verifies its WebP data and scale, persists it across restart, toggles it, detaches it into an always-on-top/all-workspaces window, moves and restores that window, opens the mini composer, returns it to the main app, checks compact overflow, captures both surfaces, and records no console or page errors. Deterministic core tests cover manifest, host, dimensions, digest, persistence, removal, and Unicode/iTerm2/Kitty rendering.

## Declarative dashboard extensions

- Product mandate: signed or locally discovered plugins may contribute useful
  desktop surfaces, but they do not gain a second renderer, an implicit browser,
  or a bypass around Kestrel's tool and approval boundary.
- Thesis: Extensions is a quiet operational index. The plugin supplies bounded
  labels, explanatory text, approved metric source names, and destinations;
  Kestrel owns every rendered element and resolves every live value.
- Hierarchy: one product-level explanation establishes the safety contract,
  each plugin receives one ruled section, and its panels continue as flat rows.
  Metrics are the focal data; actions remain supporting links into existing
  evidence surfaces.
- Contract: versioned strict JSON, 64 KB maximum, 1–12 panels, closed tone,
  metric, and route vocabularies, bounded plain text, and complete rejection on
  unknown or malformed fields.
- Security boundary: no plugin JavaScript, React, HTML, Markdown, CSS, remote
  asset, font, URL, fetch, iframe, WebView, or backend route is loaded. MCP is a
  separate, explicit, approval-gated connection. Managed bundles retain
  Ed25519 publisher verification, staged install, and default-off enablement.
- Responsive behavior: wide panels use a copy/data split; compact layouts
  become a single reading column without horizontal overflow. Semantic tokens,
  keyboard-native buttons, visible focus, reduced-motion behavior, and text
  rendering inherit the native application.
- Evidence:
  `artifacts/screenshots/desktop/setup-revised/dashboard-extension-release-ops.png`;
  the automated desktop flow enables a real isolated fixture plugin, checks
  live metrics, follows a safe route, verifies compact reflow, and rejects
  console/page errors.

## Honcho remote memory

- Product mandate: give users an optional remote relationship-memory provider
  without weakening Kestrel's encrypted local-memory, credential, consent, or
  approval boundaries.
- Thesis: Honcho is a deliberate secondary memory lens, not an invisible
  default. One ruled Settings section explains what leaves the device before
  exposing server, identity, recall, session, observation, cadence, and
  dialectic controls.
- Privacy boundary: the provider is off by default and requires an explicit
  disclosure acknowledgement. The managed API key uses protected native
  storage and never reaches renderer state, prompts, logs, or status output.
  Only selected user and assistant text can sync; system instructions and tool
  output remain local.
- Context contract: encrypted local memory remains authoritative. Remote
  summary, representation, card, search, reasoning, and conclusions are
  bounded, labeled potentially stale and untrusted, fail open, and cannot
  change approvals. Per-session, pseudonymous per-project, and global session
  scopes are explicit.
- Interaction: `hybrid`, `context`, and `tools` modes make automatic injection
  and the five approval-aware tools independently understandable. Disabling
  unregisters the tools immediately without claiming to delete remote data.
- Responsive evidence:
  `artifacts/screenshots/desktop/setup-revised/settings-honcho-memory.png`;
  the Electron flow acknowledges disclosure, enables a loopback fixture through
  the real official SDK, verifies two requests and all five tools, disables the
  provider, checks compact reflow, and rejects renderer errors.

## Rich artifacts

- Product mandate: generated music and interactive results should feel like
  inspectable deliverables, not privileged mini-apps hidden inside chat.
- Thesis: the Artifacts page is the stable handoff surface. Audio uses the
  native player with provider/model/hash provenance; widgets get one bounded
  live canvas plus an explicit `interactive · isolated · network off` boundary.
- Music boundary: the fal credential remains protected, paid generation uses
  normal approval and idempotency, and only a verified local MP3/WAV preview
  reaches the renderer.
- Widget boundary: Kestrel owns the document wrapper, tokens, CSP, storage, and
  retention. The iframe is opaque-origin and script-capable but has no
  same-origin grant, network, navigation, parent DOM, Electron bridge,
  workspace, or credentials.
- Hierarchy: the interactive result is the focal object; title, size,
  provider/model, and truncated digest remain compact supporting evidence.
- Responsive evidence:
  `artifacts/screenshots/desktop/setup-revised/artifact-interactive-widget.png`;
  the Electron flow creates the widget through the actual approved tool,
  restores it through artifact IPC, changes state inside the frame, verifies
  sandbox attributes, checks compact overflow, and rejects renderer errors.

## First-run model and safety setup

- Operating mode: `existing-redesign`, page-sized first-run workflow inside the desktop product.
- Product mandate: a nontechnical user should be able to understand the local safety boundary, choose how Kestrel will run, connect at least one real model route when they want live agent work, optionally add a second credential for failover, automatically install a device-appropriate local model or take an explicit manual path, and reach either a truthfully verified ready state or an honest model-less preview without reading documentation.
- Verified capability boundary: protected OpenAI and Anthropic primary/backup API credentials form real provider pools; Gemini is supported through an API key; a pinned official Ollama runtime can be checksum-verified and installed into Kestrel's private macOS app data without administrator access; existing Ollama installs remain available through manual setup; Codex and Claude subscription routes rely on vendor-owned authenticated CLIs; OpenClaw and Hermes settings can be dry-run imported. A user-owned Google Desktop OAuth client uses external-browser PKCE, encrypted refresh storage, Gmail send, and read-back-verified Calendar tools. Kestrel does not import browser cookies or ask for OAuth tokens in chat.

### Selected system lock

- Thesis: setup should feel like a calm guided workbench—one consequential choice per page, plain-language consequences beside each action, and a visible model route that makes redundancy understandable without exposing infrastructure jargon.
- Density profile: `dense-app` within the model library; `sparse-editorial` on the welcome, warning, and finish pages.
- Type pair: use SF Pro Display for decisive page headlines and the Kestrel name; macOS system sans for explanatory copy and controls; SFMono only for model IDs, sizes, and provider evidence.
- Type scale: welcome 50/52, step title 34/38, section title 18/23, body 13/20, control 12/17, evidence/meta 9/14.
- Spacing scale: 4px base; shell 8/12/16/20/28/40; large-page rhythm 56/72.
- Color roles: use the Native Graphite roles—graphite canvas, deep graphite rail, aluminum primary text, quiet sage focus/connected state, amber warning state, and red only for errors.
- Material: flat graphite matte planes with ruled rows; only the current choice and warning acknowledgement receive a contained surface. Avoid a card catalog where simple rows communicate better.
- Primary composition: a persistent five-step horizontal progress line—Welcome, Before you begin, Choose a model, Model setup, Ready—keeps the complete journey above the task plane and returns the left edge to content. Model setup opens with one three-column source chooser: external providers on the left, a private local agent in the center, and a reviewed open-access directory on the right. The selected source expands below without duplicating the choice into another tab bar. The local pane has one dominant automatic action, one manual fallback, visible download/proof progress, and the full model library below.
- Provider integrity: the external catalog mirrors current OpenClaw and Hermes provider families, but separates Kestrel-native routes from compatible-endpoint and cloud-specific families that still need dedicated adapters. Open Access links only to official provider directories; it never imports shared tokens or claims changing free quotas as guaranteed.
- Native-quality reset: setup uses a quiet macOS assistant composition rather than a provider console. Progress is one compact line, source choices use readable labels and one restrained symbol each, selected detail is disclosed below, and exhaustive compatibility data stays behind a native disclosure control. Body text is never miniaturized to make the catalog fit.
- Motion roles: state continuity through a short horizontal/opacity step transition; feedback through hover/press/focus. The later setup-to-workspace handoff may use a shared visual anchor, but it must remain state-driven rather than a fixed video. Reduced motion changes steps without travel.
- Persistence: current step and safe non-secret selections survive a reload; completion is stored only after the final page. Credentials remain in macOS secure storage and are never copied into browser storage.
- State coverage: first/returning setup; warning unchecked/acknowledged; credential loading/saving/configured/error; zero/one/two accounts; provider verification; automatic runtime unsupported/detecting/downloading/checksum-verifying/installing/starting; model downloading/verifying/ready/cancelled/error; manual setup collapsed/expanded; existing versus managed Ollama; device recommendation; optional setup skipped; final verified/configured/preview states; setup-assistant handoff for every final state; stable step persistence; back navigation.
- Avoid list: five-page feature tour, technical setup checklist before trust, OAuth/browser-cookie claims, treating ChatGPT subscriptions as API keys, fake provider connectivity, claiming an exhaustive remote model catalog, blanket macOS permission prompts, provider logo wall, pill forest, and a dashboard first viewport.
- Why this is not generic: the flow visualizes Kestrel’s real provider pool and local-device fit as one understandable stack, while the warning and finish states expose the exact approval, cost, privacy, and unsupported-auth boundaries.

### Rendered refinement and state evidence

- Captures inspected: 1320×860 welcome, warning, account stack, local model library, broader provider coverage, and final readiness states; 640×760 compact provider-coverage state.
- Three highest-impact weaknesses fixed: account setup initially used overly technical subscription language and undersized support text; the “set up models later” action remained visible after a valid account stack existed; the final promise that setup could be reopened from Settings had no working entry point.
- Automatic-setup refinement: the first render recommended the largest model whose declared minimum equaled total device memory, omitted the pinned runtime version before installation, and left guided post-setup help only on the final screen. The revised system reserves 2–4 GB for the OS/app, exposes Ollama 0.32.1 and exact runtime/model download sizes before consent, and keeps “Finish setup safely” available from every new conversation.
- Final behavior: warning acknowledgement gates progress and persists across reload; secure credentials never enter local storage or chat; the five setup stages persist by stable step ID with legacy numeric recovery; two OpenAI account slots persist through the macOS credential broker and become one logical provider pool; the automatic path downloads a pinned Ollama 0.32.1 archive from the official GitHub release, enforces byte count and SHA-256, rejects unsafe archive entries, installs and runs it on loopback from owner-only app data, pulls the selected model with streamed cancellable progress, and requires a real local response; the manual path remains explicit; the final page distinguishes a verified route, a configured-but-unverified route, and a model-less local preview, with setup help available in all three states; Settings reopens the guide without deleting credentials.
- Runtime evidence: deterministic manager tests cover successful install/start/model/live-verification, checksum failure cleanup, contained internal library symlinks, and unsupported-platform fail-closed behavior. A clean real E2E run downloaded the exact 145,355,166-byte Ollama 0.32.1 archive, matched SHA-256 `346d28fe70f3ef3776e42100f5721510aa35fc07f3733f6629dbb117b1cfede9`, installed its 44 entries, started it with cloud access disabled on loopback, pulled `qwen3.5:0.8b`, and completed a real non-thinking response at a 32K context setting; temporary runtime/model data was removed afterward. Deterministic OAuth tests exercise loopback state/PKCE, narrow grant verification, encrypted refresh storage, access-token rotation, Gmail delivery, provider revocation, and deterministic Calendar create/read-back. The Electron setup test covers the automatic/manual local paths, setup-assistant handoff, Google OAuth entry, compact reflow, and Settings re-entry. Capture automation checks desktop/compact overflow, reduced motion, focus visibility, and renderer console/page errors.

## Kestrel daily-work entry — Codex replacement direction

- Operating mode: `existing-redesign`, page-sized desktop product change.
- Product mandate: Kestrel should be the default place the user brings coding, research, automation, file, and agent work. The first useful path is `choose a project → describe the outcome → inspect progress → approve consequential actions → receive evidence`.
- Verified capability boundary: the runtime already supports persistent workspace-scoped conversations, model and provider routing, file and shell tools, Git/worktrees/PRs, web and browser work, approvals, checkpoints/retry, artifacts, orchestration, plugins, MCP, skills, terminal, ACP, and editor integrations. This change exposes that union; it does not claim hosted infrastructure or bypass missing credentials.
- Rename boundary: `Kestrel` becomes the human-visible product name. Existing `kestrel` package scopes, IPC channels, protocol, Keychain service, data paths, and local-storage keys remain compatibility identifiers until a separately tested migration changes privileged identity without orphaning user data.

### Selected system lock

- Thesis: Kestrel should feel like opening a trusted workbench, not configuring an AI request—one calm project-aware composer is primary, while routing, lifecycle, and extension machinery stays close but progressively disclosed.
- Density profile: `dense-app` with a calm central reading and composing measure.
- Type pair: native New York/ui-serif for the Kestrel name and time-aware greeting; macOS system sans for controls and conversation; SFMono only for paths, hashes, usage, and execution evidence.
- Type scale: greeting 40/46, page title 36/42, conversation 14/24, controls 12/17, evidence/meta 9/14.
- Spacing scale: 4px base; shell 8/12/16/20/24; conversation 8/12/20/32/52.
- Color roles: preserve warm graphite canvas, cocoa-charcoal rail, parchment text, mushroom secondary text, restrained terracotta focus/action, green verified state, and semantic red error/destructive state.
- Material: flat warm matte planes; the composer is the one lifted work surface. Project context is grouped by rhythm and rules, not another card.
- Primary composition: a time-aware greeting, one outcome-led support line, a persistent labeled project selector, one composer, and terse capability starters. The project can be granted in place. Advanced execution routing sits below the composer and defaults to automatic.
- Motion roles: state continuity through the existing short page crossfade; direct feedback through hover/press/focus. No new ambient motion. Reduced motion removes the crossfade.
- Progressive disclosure: core completion requires only project choice when file access is needed and a natural-language request. Manual provider/model choice, checkpoints, token/cost detail, and extension administration remain available without becoming prerequisites.
- State coverage: no granted project, project picker cancelled, project added, automatic routing, manual routing incomplete/ready, no configured provider at run time, streaming, steering, approval, retry, checkpoint, and task history.
- Avoid list: onboarding as a feature tour, provider/model fields as the first task, capability-card dashboard, fake terminal chrome, unsupported “better than Codex” claims, hidden workspace scope, invisible labels, pill forests, and renaming privileged identifiers without migration.
- Why this is not generic: Kestrel’s entry surface is organized around a real permissioned project and the full evidence-backed work loop, rather than a decorative chat prompt or a developer-themed dashboard.

## Desktop product redesign — conversation first

- Operating mode: `existing-redesign`, page-sized desktop product change.
- Supplied constraint: the application should feel as immediately familiar as Codex, ChatGPT, Claude, and Claude Code; orchestration belongs in the background.
- Verified product facts: Kestrel is a high-frequency local-first personal agent; its deterministic preview includes proactive opportunity detection, personal context, explicit approval, audit history, connections, and settings.
- Reversible assumptions: a warm dark appearance is preferred over pure black; the conversation/composer is the primary task; recent threads are more useful in the main rail than dashboard modules; background work needs only a concise status until it requires a decision.

### Candidate directions

1. **Warm conversation canvas — selected.** A cocoa-charcoal sidebar, warmer graphite work plane, recent conversations, a centered editorial greeting, one quiet composer, and progressive disclosure for task setup. The ChatGPT reference informs the overall conversation geometry and the Claude reference informs warmth and reduction; neither is treated as a reconstruction target.
2. **Operator split view — rejected.** Persistent right-side jobs, memory, cost, and evidence would keep the machinery visible and compete with the conversation.
3. **Proactive task inbox — rejected.** Makes detected work primary and open-ended conversation secondary, contradicting the requested ChatGPT/Codex-like entry point.

### Selected system lock

- Thesis: Kestrel should feel immediate without feeling severe: a subtly darker warm-charcoal rail frames a soft graphite conversation canvas, while an editorial greeting and one restrained composer make the starting point unmistakable and keep Kestrel-specific setup, approvals, and local status quietly available.
- Density profile: `dense-app` with a calm central reading measure.
- Type pair: native New York/ui-serif for the greeting, page titles, and Kestrel wordmark; the native macOS system sans for interface and conversation; SFMono/monospace only for hashes, usage, and evidence metadata. This creates an editorial focal point without loading a webfont.
- Type scale: welcome 40/46, page title 36/42, body 14/23, UI 13/18, meta 10/14.
- Spacing scale: 4px base; shell 8/12/16/20/24; conversation 12/20/32/56.
- Color roles: warm graphite conversation canvas, darker cocoa-charcoal sidebar, lifted charcoal interactive surface, parchment-white primary text, mushroom-gray secondary text and separators, one restrained terracotta action/focus family, green only for verified/healthy state, and semantic red only for destructive/error states.
- Material: flat warm matte planes with one lightly lifted composer and quiet selected rows; no pure black, glass, gradient, glow, bevel, or decorative card stack.
- Primary composition: the 18% sidebar follows familiar AI-app order—New chat, product tools, then chat history—while the main pane holds one centered readiness line and one composer around 55% of available width; task setup collapses below it until needed.
- Motion roles: state continuity through a short page crossfade; feedback through native hover/press/focus. No ambient animation. Reduced motion removes the crossfade.
- Spatial intent: the wide new-task canvas isolates the composer as the one primary task; the conversation measure controls reading length; bottom space reserves a stable location for the composer and one background status without creating a second dashboard.
- Minimalism intent: warm negative space and low-contrast boundaries keep the greeting and composer legible as one task boundary; required setup remains one keyboard-reachable disclosure directly below the composer.
- Desktop performance budget: renderer JavaScript at or below 1 MB uncompressed and CSS at or below 44 KB for this preview, with no new runtime dependency or webfont asset.
- Avoid list: copying ChatGPT or Claude logos and wording, pure-black planes, dashboard home, permanent diagnostics rail, colorful status taxonomy, assistant message cards, pill forest, glowing AI chrome, prompt-card grid, hidden focus, motion-dependent state, and ornamental layers.
- Retrieved guidance applied: `ia.one-primary-task`, `direction.content-before-chrome`, `direction.systemic-distinctiveness`, `anti.card-everything`, `anti.decorative-signal-noise`, `responsive.recompose-not-shrink`, `layout.source-order`, `content.front-load-meaning`, `color.non-color-cues`, and `form.preserve-user-work`.
- Why this is not generic: the familiar conversation geometry and calm editorial tone are adapted around Kestrel’s real workspace/provider setup, local-agent state, approval queue, and evidence surfaces instead of becoming a branded ChatGPT or Claude imitation.

This reference-led warm conversation system supersedes the earlier pure-black, light, and control-room directions below. The marketing-site direction remains unchanged.

### Rendered refinement and state evidence

- References inspected: supplied ChatGPT desktop screenshot at 2940×1664 established the conversation geometry; supplied Claude desktop screenshot at 2864×1860 established the warmer charcoal tonal range, restrained surfaces, and editorial greeting. Both are directional rather than pixel-accuracy targets.
- Captures inspected: 1320×860 onboarding, collapsed new chat, expanded task setup, empty persisted conversation, and approval; 760×760 compact new chat.
- Earlier ChatGPT-led weaknesses fixed: the composer occupied too much of the main pane; the voice action sat beside the attachment button rather than at the trailing action edge; the setup disclosure used a competing explanatory sentence instead of a quiet state label.
- Warm-system refinement fixed: pure-black planes made the application feel severe; the tools heading repeated the Kestrel brand and interrupted familiar sidebar scanning; the readiness line retained too much of the earlier reference's voice. The final pass uses layered warm charcoals, unlabelled primary tools followed by a Chats section, a time-aware editorial greeting, and a quieter prompt.
- State coverage: startup loading and core retry; new task; response loading, answer, and safe retry error; pending/executed/rejected approval; empty approvals; paused/working/waiting/idle agent labels; disabled future connector controls with explicit status; destructive reset confirmation.
- Runtime verification: real Electron onboarding, new-task/setup disclosure, persisted conversation navigation, approval navigation, compact reflow, keyboard focus from prompt to Voice, reduced-motion navigation, page-level overflow check, and console/page-error collection.
- Production measurement: 980.19 KB renderer JavaScript and 41.24 KB CSS; no desktop webfont assets and no new runtime dependency.

## Operating mode and evidence

- Operating mode: `autonomous-zero-brief-build`, applied as an existing product-marketing redesign.
- Build mode: targeted redesign of the existing static website; preserve the desktop product, architecture boundaries, generated-media provenance, and working design tokens.
- Supplied facts: installable Apple Silicon Electron app; local-first personal memory; proactive opportunity discovery; explicit approvals; verified actions; teacher scheduling and DJI troubleshooting scenarios; direct-download signed DMG architecture; static website; no App Store app, public agent, or fal runtime; GitHub publishing later.
- Creative assumptions: `Kestrel` is a reversible working name; the first usable release is a deterministic local vertical slice with mocked provider adapters, not a claim that production connectors, signing, or notarization are complete. "Proper website" means a complete, trustworthy product story and usable preview rather than a wholesale visual reset.

## Retrieved evidence before redesign lock

- Core UX and integrity: `ia.one-primary-task`, `content.earn-every-line`, `integrity.truthful-proof`, `direction.content-before-chrome`, `delivery.definition-of-done`.
- Direction and responsive: `anti.hero-empty-scale`, `layout.intentional-negative-space`, `responsive.input-agnostic`, `architecture.progressive-enhancement`.
- Accessibility and motion: `a11y.keyboard-complete`, `component.focus-contract`, `motion.explain-causality`, `motion.interruption-safe`, `motion.reduced-motion-equivalence`, `motion.audit-by-system-leverage`.
- External source catalog: `magic-ui`, `aceternity-ui`, and `react-spring` were rejected because their returned license status was unresolved and their visual posture did not fit this high-trust product. `craftwork`, `saasframe`, `page-flows`, and `copywritingexamples` were retained as inspiration-only catalog references; no code, assets, copy, tokens, or layouts were adapted.
- Classifier conflict: the exact prompt classifier misread the plugin URI as conceptual-art content. That inference was rejected in favor of inspected repository facts and the correctly routed redesign workflow: product-marketing, high trust, intensity 3, medium-low motion.

## Candidate directions

### A — Signal dossier (selected)

- Composition: left-anchored product promise paired with one dominant operational dossier; the numbered signal path becomes the page's evidence spine.
- Identity: preserve the acid signal, charcoal field, cool paper, cut-corner mark, precise rules, and honest product scenes.
- Content shape: outcome → worked scheduling decision → scoped memory → approval boundary → local architecture → release gate.
- Tradeoff: needs disciplined copy reduction so technical proof does not become a dense dashboard.

### B — Quiet personal desk

- Composition: warm editorial narrative around planner pages and document fragments.
- Identity: softer paper, graphite, stamped annotations, and a humanist serif.
- Tradeoff: approachable, but it weakens the inspectable control-system identity and risks an undifferentiated AI-brochure aesthetic.

### C — Architecture ledger

- Composition: system boundary map, compact capability table, policy matrix, and release checklist first.
- Identity: grid paper, mono labels, terse technical detail, minimal atmosphere.
- Tradeoff: credible for evaluators but delays the personal outcome and makes the website feel like documentation rather than product marketing.

The plugin comparison ranked Signal dossier first (37), ahead of Architecture ledger (27) and Quiet personal desk (23). Human review confirmed that result because it best preserves product truth, identity, and the first-time visitor's reading sequence.

## Product and user

- Product type: installable personal AI operator and its separate download website.
- Primary user and job: a privacy-conscious individual who wants useful multi-step work prepared or completed without repeatedly coordinating every step.
- Trust/risk level: high trust, potentially high consequence; every external action is evidence-backed, policy-checked, and auditable.
- Device and environment: macOS 13+ first; Windows architecture retained; desktop application plus responsive static website.
- Known constraints: renderer has no Node access; personal memory remains local by default; website is presentation-only; temporary name must be centralized.
- Assumptions to verify: real Gmail/Calendar OAuth configuration, Developer ID identity, notarization credentials, update host, public download URL, GitHub URL, and final product name.

## Design thesis

Kestrel is an inspectable signal dossier where one prepared decision moves from context to approval to verification, using acid-yellow threadwork across charcoal and cool paper without techno-mysticism, noisy dashboards, or hidden autonomy.

## Why this is not generic

The identity is built around one real scheduling decision and a single inspectable signal thread that connects notice, memory, plan, approval, and verification—not a gradient hero, feature-card parade, or fake chat window.

## Direction

- Density profile: `dense-app` for the desktop; `product-marketing` for the website.
- Composition: website first viewport contains the Kestrel wordmark, one headline, one support line, one CTA group, and one dominant operational canvas; desktop uses a narrow command rail and one primary work plane.
- Spacing scale / section rhythm: 4px base; app 8/12/16/24/32; website 12/20/32/56/88/144.
- Typography: Bricolage Grotesque variable for display (72/64, 52/56, 36/42, 28/34); IBM Plex Sans for body (18/30, 16/25, 14/21, 12/18); IBM Plex Mono for evidence and timestamps.
- Color roles: `paper #eceee7`, `surface #f7f8f3`, `ink #17201d`, `muted #69726c`, `line #c8cec5`, `night #101713`, `signal #d7ff52`. Signal is the sole accent family.
- Material / surface language: matte instrument panels, fine rules, precise cut corners, rare translucent overlay only when it denotes a real modal boundary.
- Imagery/iconography: abstract signal fields and honest React-rendered interface states; no robots, brains, generic cyberpunk, fake readable generated UI, mascots, or stock people.
- Motion intensity and roles: medium-low. Focal: one signal line resolves across the hero. State: the local approval demo transitions between prepared, editing, approved, and reset states. Feedback: controls compress and confirm. Reduced motion renders the signal resolved and changes state without travel or spring effects.
- Familiarity vs. originality: familiar navigation, buttons, lists, and dialogs; original composition and signal-thread grammar.
- Patterns intentionally avoided: purple/indigo gradients, glow stacks, centered three-card hero, pill forests, fake metrics/testimonials, universal scroll reveal, decorative bento, fake terminal, always-running activity indicators, inaccessible cinematic text.

## System lock (before catalogs)

- Existing system to preserve or extend: none; shared tokens will be authored once and reused by desktop and website.
- Tokens and component strategy: CSS custom properties plus small, typed React components; native semantics first; Motion is the only motion library.
- Responsive strategy: desktop app supports a compact 920px window and rail collapse; site reflows at content-led boundaries around 980px and 700px; no hidden required content.
- Accessibility target: WCAG 2.2 AA intent, keyboard-complete flows, visible focus, reduced-motion alternatives, non-color status cues, 44px touch targets on mobile.
- Performance budget: website initial page under 180KB compressed JavaScript excluding framework runtime, poster-first media, no render-blocking video, at most one visible ambient video, zero generation/runtime API calls from the browser. Final static export measured 230,569 gzip bytes across all JavaScript including Next/React runtime; the chunk containing the Kestrel page and interaction code measured 45,027 gzip bytes. The largest media asset is the 250,517-byte hero poster.

## States and acceptance criteria

- Desktop states: first-run guidance, ready, observing, working, awaiting approval, approved, rejected, completed, paused, offline, error/retry, permission denied, saving/saved, reset confirmation.
- Website states: media available/unavailable, reduced motion, local demo prepared/editing/approved/rejected/reset, download unavailable, GitHub unavailable, mobile navigation open/closed, narrow/short viewports. Loading, network error, offline, and permission states are pruned from the approval preview because it has no request, persistence, permission, or backend; it cannot enter those states. The media component falls back to a still asset instead of exposing a dead loading/error surface.
- Acceptance: teacher event becomes an evidence-backed Monday recommendation; send/create actions cannot occur before approval; approval executes exactly once; memory and audit trace update; DJI response retrieves prior context and avoids repeated advice; public site has no agent API or fal runtime; production builds and tests pass.

## Catalog pulls and source-use ledger

- Thesis-derived queries: `react precise editorial signal-path state continuity reduced motion`; `instrument-panel marketing motion task progression evidence approval`.
- Sources consulted: focused plugin corpus plus the bounded source candidates listed above. Network research was not required.
- What was adapted vs ignored: only the already-installed Motion API and original project components are used. Catalog visuals remain inspiration-only; glow, particle, parallax, bento, marquee, and template skins are rejected.

## Rendered refinement (mandatory)

- Baseline captures: `artifacts/frontend/initial-desktop.png` and `artifacts/frontend/initial-mobile.png`.
- Baseline weaknesses: the hero promise was reusable by many proactive-AI products; the primary navigation emphasized a download that does not exist; preview controls looked actionable but did nothing; the mobile navigation hid the information architecture; several sections repeated the same autonomy claim.
- Structural fixes: replaced the hero with a Kestrel-specific promise and honest primary action, added functional local prepared/editing/approved/rejected states, exposed native mobile navigation, reduced duplicate copy, and preserved the release boundary.
- Pass-one captures: `artifacts/frontend/pass1-desktop.png`, `artifacts/frontend/pass1-mobile-clip.png`, `artifacts/screenshots/website/revised/homepage-desktop.png`, and `artifacts/screenshots/website/revised/homepage-mobile.png`.
- Three highest-impact pass-one weaknesses: the outlined desktop release link competed with the hero focal point; memory-orbit and ledger annotations were too small on mobile; the native mobile menu stayed open after same-page navigation and could cover the target section.
- Fixes implemented: reduced the release link to a quiet underlined navigation action; increased mobile annotation, ledger, security, and footer type; closed the mobile details menu when a section link is chosen. A separate component review also found and fixed disappearing focus across approval-state transitions.
- Revised captures: `artifacts/screenshots/website/revised/homepage-desktop.png`, `artifacts/screenshots/website/revised/homepage-mobile.png`, and `artifacts/screenshots/website/revised/approval-approved.png`.
- Second-pass outcome: not needed. The revised page passes the brand test, keeps the first viewport to one promise/action/product plane, and does not match the default AI cluster.
- Remaining product limitations: real OAuth providers, Developer ID signing/notarization, and public URLs depend on credentials and publishing decisions. The unsigned arm64 development app is built and smoke-tested on Apple Silicon.

## Daily-readiness extension

- Operational focal point: the desktop app now has one Readiness surface that answers “can I rely on this for a real task?” before exposing secondary detail.
- Status hierarchy: local core and configured model route are blocking; project scope, macOS permissions, a verified backup, and packaged-build status are visible but only become blocking when the intended task needs them.
- Recovery material: backups are calm, explicit operations rather than background magic. Kestrel stops the local core, copies only owned state (not project folders), hashes every file, and reports the verified destination.
- First-run integrity: setup performs a live provider/local-service account probe after a route is configured, while preserving an honest local-preview path when no model is available.
- Finder-launch continuity: detected vendor subscription routes are presented as explicit local account choices with enable/disable state, instead of relying on invisible shell environment flags.
- Motion and access: no new motion role was added; readiness uses persistent text, symbols, and color together, remains keyboard-operable, and reflows to one column.

## Orchestration board extension

- Design thesis: the board is an execution ledger, not a colorful project-management clone. Durable goal state remains primary; drag-and-drop is only one input path into that state.
- Density profile: `dense-app`.
- Composition: the three-column board is the Work page focal point. Creation, delegation, scheduling, and team configuration remain quieter setup instruments below it.
- Typography and spacing: preserve the desktop display, sans, and mono roles; use the existing 4px base with 8/12/16/24 intervals.
- Color roles: charcoal canvas, matte surface, light ink, muted evidence copy, orange signal for active movement, and green only for verified completion. Status always has a text label and never relies on color.
- Material language: ruled ledger columns and clipped task records with restrained borders. Avoid floating bento cards, rainbow lanes, pill forests, excessive rounding, and decorative shadows.
- Worker-lane contract: child runtime sessions are named execution lanes. Assignment is persisted on the task record, while the goal/task state machine remains the lifecycle authority.
- Interaction contract: pointer drag is a progressive enhancement. Every move is also available through native previous/next buttons; lane assignment uses a labeled native select; successful changes are announced without moving focus.
- State contract: default, hover, focus-visible, dragging, drop target, disabled/loading, empty column, no-worker-lanes, success announcement, and backend error are represented. A failed mutation reloads the durable record rather than leaving optimistic state behind.
- Responsive contract: three ledger columns share one desktop plane; compact windows stack the columns without horizontal page overflow. Touch controls reach 44px at the mobile boundary.
- Motion contract: feedback only. Drag opacity and drop-target emphasis may change without travel; reduced-motion preserves the same state information without transition.
- Why this is not generic: each card stays attached to its durable goal, local session lane, and inspectable lifecycle instead of becoming an interchangeable SaaS task tile.
- Rendered refinement: the first board capture exposed an inaccurate run-ownership subtitle, task controls that were too quiet at normal viewing distance, and an empty-column message with insufficient hierarchy.
- Refinement applied: replaced the ownership claim with lifecycle-only copy, increased task/control legibility, and strengthened the empty record without introducing another accent or panel style.
- Revised evidence: `artifacts/screenshots/desktop/setup-revised/work-kanban.png`; the same deterministic flow verifies keyboard movement and focus restoration, pointer drag, durable reload, compact stacking without page overflow, and reduced-motion behavior.

## External-secret setup extension

- Design thesis: secret sources are a quiet extension of the protected credential boundary, not a competing setup dashboard or a vault browser.
- Density profile: `dense-app`.
- Composition: one Settings ledger row opens a native disclosure containing three source records. Direct protected fields remain the primary personal-computer path; external sources are presented as an advanced rotation and fleet option.
- Type, spacing, color, and material: preserve the existing desktop display/sans/mono roles, 4px spacing base, charcoal ledger rules, orange signal, and text-first status language. No vendor-colored cards or decorative logos.
- Interaction: native `details`, `summary`, `label`, `input`, `select`, `textarea`, and `button` elements. Save/install/sync actions expose distinct pending labels, persistent success text, actionable inline errors, and preserved user input after failure.
- State contract: unavailable binary, needs token, incomplete configuration, configured, installing, syncing, verified, disabled, validation failure, provider failure, and recovery are all representable without relying on color.
- Responsive contract: provider controls are two-column only when their labels and values remain readable; compact windows and zoom stack them in source order without horizontal overflow.
- Motion contract: static by intent except existing button feedback. Reduced motion requires no special substitute because no information moves.
- Why this is not generic: the surface explains the actual Kestrel credential precedence, core-process boundary, pinned Bitwarden installer, and argv-only helper contract instead of presenting three interchangeable integration tiles.

## Desktop refinement — action before ornament

- Thesis: the empty desktop is a launch surface for a real task, not a decorative hero or a vacant chat canvas.
- Density and material: preserve the `dense-app` graphite shell, restrained green status signal, local UI type, and feedback-only motion.
- Primary action contract: project work exposes a visible `Add project` control; project review opens the real folder chooser; conversation-only sessions never claim a project can be attached after creation.
- Starter composition: two ruled, text-led actions replace small generic suggestion pills. Each action names the task and consequence without adding cards, badges, or fake activity.
- Navigation contract: `New chat` has an honest current state and remains reachable with a visible label when the desktop window recomposes to its compact bottom navigation.
- Copy pass: utility headings name the surface or decision directly; supporting lines keep only task, boundary, or recovery information.
- Motion contract: no new role. Existing short page-state feedback remains optional under reduced motion.
- Why this is not generic: Kestrel's first view is organized around a granted local project, a reviewable task sequence, explicit tool scope, and real approval boundaries instead of prompt chips or fabricated workspace content.
