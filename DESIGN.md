# Kestrel design system

## Instrument Workbench — August 2026

This is the authoritative desktop system for the product-wide redesign based
on `main` at `524acf82`. It refines Kimi's selected Instrument Console after
direct inspection of the renderer, 94 supplied captures, a fresh exact-base
capture, and the original Apple Design, Sonner, Vaul, and Frontend Taste
Engineer repositories. The full evidence and decision record is in
`artifacts/ui-redesign/DESIGN_SYNTHESIS.md`.

- **Thesis:** two quiet structural rails frame one unmistakably active graphite
  work plane; the browser or task stays primary while the persistent agent,
  approvals, and provenance remain continuously available.
- **Density:** `dense-app`, with sparse composition reserved for setup, Browser
  Home, a new task, and true empty states.
- **Type:** platform-native variable system typography is an intentional
  desktop-instrument choice: SF Pro/SF Mono on macOS and Segoe UI
  Variable/Consolas on Windows. Page title is `26/32 680`, section `16/21 630`,
  body `14/21 450`, control `13/18 560`, support `12.5/18 450`, metadata
  `11.5/15 580`, and evidence `11/16 500`. Nothing is below 11px.
- **Spacing and shape:** 4px base with `4/8/12/16/20/24/32/40/56/72`. Controls
  use 8–10px radii; meaningful independent surfaces use 12–14px; ordinary page
  grouping has no container radius. Targets are 32px compact, 40px normal, and
  44px for primary or consequential decisions.
- **Color/material:** a semantic monochrome ramp from canvas through chrome,
  rail, workbench, surface, raised, and overlay. Content is opaque. macOS may
  progressively enhance under-scroll structural chrome with blur; Windows and
  reduced-transparency modes are opaque.
- **Page architecture:** every `kestrel://` destination uses one PageFrame with
  an optional real-state eyebrow, one title, one useful description, optional
  actions/local navigation, and a declared reading/standard/wide/full measure.
  Pages are never giant rounded cards inside the browser.
- **Controls:** one Button vocabulary (`solid`, `bordered`, `quiet`,
  `destructive`), one input treatment, one continuous Row, cause-specific
  EmptyState, shape-plus-label Status, and Card only for independent objects or
  layers. The legacy `.button` system is retired rather than restyled in
  parallel.
- **Motion roles:** feedback (70–90ms), state/orientation (120–180ms), and
  direct manipulation only where a person drags. Popovers originate at the
  trigger, reversible transitions use the same path, and gesture motion starts
  from the rendered value. Reduced motion retains feedback with opacity or an
  immediate state swap.
- **Motion quality gate:** buttons, tab lifecycle/reorder, rail resize,
  overlays, command center, dialogs, approvals, routes, disclosures, Settings,
  selectors, New Tab, direct manipulation, async state changes, and compact
  recomposition must be manually exercised in Electron. Feedback begins on
  pointer-down; input never waits for motion; reversal starts from the rendered
  value; enter/exit paths agree; trigger geometry anchors overlays; physical
  travel uses near-critical springs without ornamental bounce; tracked gestures
  preserve grab offset and relevant release velocity; transform/opacity motion
  causes no layout shift; reduced motion remains explicit. Screenshots and the
  mere presence of transitions do not satisfy this release-blocking gate.
- **Responsive:** shell and component breakpoints occur where content stops
  working. The navigation rail becomes a 56px accessible icon rail at compact
  width; the agent remains available through a persistent bottom agent dock.
  Settings moves from local side navigation to a labelled compact section
  control before content becomes narrow. No page-level horizontal scrolling.
- **State/access:** native semantics and visible focus are mandatory. Overlays
  define focus entry, traversal, Escape, and restoration. Every supported
  surface represents loading, empty, populated, error/retry, disconnected,
  disabled, running, approval, verified, and recovery honestly.
- **Avoid:** generic dashboard composition, card walls, glass stacks, glow,
  gradients, pill forests, duplicated headings, hover-only meaning, ambient
  motion, macOS Settings cosplay, mobile-sheet navigation, hue-only state, and
  fake metrics.
- **Why this is not generic:** Kestrel's visual identity is the real
  browser-and-agent workbench, angular brand/control language, and visible
  approval/provenance loop—not a theme, accent color, or component catalog.

## ChatGPT-inspired navigation rail — August 31, 2026

- **Thesis:** make the left rail immediately legible like a familiar chat
  workspace without flattening Kestrel's browser, agent, approval, and local
  project semantics.
- **Order:** `New chat`, `Scheduled`, and `Agent` are the primary destinations;
  folder-backed `Projects` comes next, followed by standalone `Chats`.
  Writing Studio, Approvals, and Capabilities remain reachable in a quieter
  Workspace group, with Settings anchored at the bottom.
- **Customization:** each project can opt into a curated icon and named color.
  These are local presentation preferences keyed by the granted folder path;
  they do not alter workspace permissions, project identity, or encrypted
  runtime data. The palette is decorative and never encodes task state.
- **Interaction:** project rows keep New chat, expand/collapse, and appearance
  customization as separate, labelled controls. The appearance chooser is
  keyboard reachable, closes on Escape or outside press, and persists only
  validated options. Compact mode retains the primary icon rail and hides the
  scrollable project/chat groups to protect the narrow browser viewport.
- **Why this is not generic:** the familiar ordering is adapted around
  Kestrel's actual scheduled work, agent sessions, and folder-backed projects,
  while the graphite ramp and approval boundary remain intact.

## New Tab widget shelf — August 2026

- Thesis: New Tab should offer a calm starting surface, not a dashboard. The
  composer stays dominant; a small curated set of local widgets gives the
  person useful context without making every available source visible at once.
- Default density: Frequent tabs, Recent work, and Quick actions are the
  recommended first view. Bookmarks, Downloads, Open tabs, Pinned tabs, and
  Recent pages remain available through Customize and are all backed by local
  browser or Kestrel data—no fabricated calendar, weather, or task metrics.
- Layout: measured content width uses one, two, three, or four columns. Small
  and medium widgets occupy one column; large widgets span two where space
  allows. Cards are matte and borderless at rest, with descriptions and
  reorder/resize controls disclosed only in Customize mode.
- Interaction: every widget is a real destination or local empty state. Open
  and pinned tabs select an existing tab, history-based widgets navigate the
  current tab, and the catalog is scroll-bounded so adding choices does not
  create page-level horizontal overflow.
- Avoid list: no default widget wall, decorative metrics, remote integrations
  without a source contract, or extra card chrome competing with the composer.
- Why this is not generic: the catalog follows Kestrel's actual browser and
  agent surfaces, while the first view intentionally shows only the three
  things that help a person start or resume work.

## Desktop stability and interaction refinement — August 2026

This pass is a `motion-refinement` and product-wide quality audit, not a new
theme or information architecture. It preserves the current renderer palette,
type, density, routes, and native-feeling shell while tightening behavior that
has drifted after many small changes.

### Visual and motion lock

- Thesis: Kestrel should feel like a quiet Mac instrument whose controls react
  continuously and predictably to the person, never like a sequence of canned
  hover frames.
- Material and color: retain the shipped role-based surfaces and native traffic
  colors. The triangular window controls may darken their inner fill and glyph
  with proximity, but they do not glow, bloom, or introduce a new accent system.
- Geometry and density: preserve existing shell, route, and control dimensions;
  this pass fixes alignment and interaction defects rather than reflowing the
  product.
- Intentional minimalism and spatial intent: the wide center plane belongs to the active browser or
  route-level task, while the narrow persistent agent pane remains a secondary
  action boundary. Empty states use that space to isolate one status and one
  recovery/next action instead of filling it with fake cards; setup screens use
  the same restraint to stage one consequential choice at a time. Compact mode
  recomposes navigation and content rather than shrinking the wide layout.
- Motion role 1 — focal feedback: the triangular window controls track pointer
  position with a small, interruptible tilt and offset while the fill deepens.
- Motion role 2 — state continuity: existing route, tab, menu, disclosure, and
  panel transitions remain restrained and explain state changes.
- Motion role 3 — direct feedback: hover, press, focus, success, and error
  changes stay short and local. No ambient or scroll-reveal animation is added.
- Performance budget and evidence: high-frequency pointer input is coalesced to
  at most one style-update batch per animation frame; geometry is measured
  outside the hot path and invalidated only on real layout changes. Animations
  use transform, opacity, and color only. `test-desktop-layout.mjs` exercises
  the pointer path and 200% zoom overflow budget; a dedicated FPS number is not
  claimed because headless Electron has no stable display clock.
- Accessibility: keyboard focus remains explicit, window controls keep native
  accessible names and hit targets, and reduced motion removes travel/tilt
  while retaining an immediate darker fill and visible glyph.
- Avoid list: no demo-reel motion, spring overshoot, blur trails, perpetual
  loops, layout-shifting hover, hover-only meaning, or ornamental animation on
  dense operational screens.
- Why this is not generic: the signature triangular traffic controls respond as
  one continuous physical cluster while Kestrel's approval, provenance, and
  recovery surfaces remain calm enough for daily work.

## Monochrome — August 2026

This is the authoritative desktop visual system. It supersedes every older
palette, ambient-field, navigation, skin, backdrop, pet, and motion direction
below where they conflict. Kestrel is a black-and-white Mac instrument: simple,
modern, fast, and honest about approval and data boundaries.

### Tokens and type

- Elevation is value-only: canvas `#0a0a0a`, sidebar `#101011`, panel
  `#151517`, surface `#1d1d20`, raised surface `#27272b`, and overlay
  `#303036`.
- Ink is `#f5f5f7`, readable secondary ink is `#cfcfd6`, metadata is
  `#9a9aa2`, and disabled or hint text is `#6a6a72`. White `#f5f5f7` is the
  sole accent and `#0a0a0a` is the ink on solid actions.
- Lines are `rgba(255,255,255,0.06)` and
  `rgba(255,255,255,0.14)`. Selected fill is
  `rgba(255,255,255,0.08)`. Status fill is the raised surface and status ink
  is primary ink.
- Display is `40/46 700`; title is `24/30 700`; section is `16/21 650`; body
  is `14/21 450`; control is `13.5/18 550`; support is `12.5/17 450`; metadata
  is `11.5/15 500` uppercase when it is an eyebrow or status label; evidence
  is `11/15` SF Mono. No interface copy is below 11px.
- Spacing uses the 4px base. Radii are `6/10/12/14/16/24px` plus a true pill.
  Controls are 40px, compact controls and icon buttons never fall below 32px,
  and setup or approval decisions are 44px.

### Surface, status, and component rules

- Five matte planes and real shadows create depth. Content never uses a
  gradient, glow, ambient field, texture, glass effect, or blur. Borders are
  quiet and are not a substitute for elevation.
- White is reserved for the primary action, focus ring, active navigation, and
  the strongest verified state. Every status pairs a filled shape with a plain
  label: check for verified, triangle for approval, loader for running,
  octagon or x for error, and circle or info for neutral state. Hue never
  communicates state because the renderer contains no hue.
- Buttons, cards, rows, inputs, status badges, and empty states share one
  grammar. Static cards have no visible border; interactive cards lift by 1px.
  Rows are at least 52px with inset separators. Inputs focus with a white
  border. Empty states use one 56px monochrome mark, one section line, one
  support line, and at most one action.
- Direct feedback is 90ms and state or route feedback is 140ms. Route entry is
  a 6px rise plus fade. No ambient animation is allowed. A running indicator
  may pulse opacity only, and reduced motion removes travel, scale, spin, and
  pulse while keeping a short opacity or state change.

### Shell and setup rules

- The persistent agent rail is 360px. Its top bar is expand-to-full-chat, New
  chat, centered title with the project name under it, and collapse. Empty
  chats show a centered welcome above the pinned composer. The composer keeps
  the model selector on the left and send plus microphone on the right. Four
  destinations remain: Browser, Agent, Approvals, and Settings. Pending
  approval appears as Review in the rail and as a white dot on Approvals.
  History, Downloads, Settings, and specialist tools open as browser tabs
  rather than covering the workspace. They remain reachable from the Command
  Center, the browser menu, and keyboard commands.
- Browser Home is flat canvas. Its focal point is the 56px composer below a
  40px greeting. Frequent tabs appear only when local history exists.
  Suggestions are exactly three text rows; there are no thumbnails, duplicate
  Home identity, personalization gear, or Frequent-tabs add control.
- Setup keeps the five product stages and the complete safety acknowledgment.
  Progress is five centered 32x4 segments with a metadata label. Welcome and
  Ready are centered, model choice uses three continuous rows, and verification
  remains explicit and live. Flat canvas, concise copy, and one solid primary
  action replace decorative fields and card nesting.

### Compatibility and safety

- The renderer exposes no skin picker, new-tab backdrop picker, accent choice,
  desktop-pet settings, pet overlay, or gradient thumbnail. Legacy IPC,
  persistence fields, and schema values remain dormant for compatibility; they
  do not affect the monochrome renderer and are not presented as choices.
- Approval gates, boundary acknowledgment, consequential-action explanations,
  focus visibility, semantic labels, and recovery paths are never deleted for
  visual simplicity. The renderer must not claim a provider, model route,
  migration, or packaged build is verified without the corresponding live
  evidence.

## Unified life context — July 2026

### Product and architecture

- Operating mode: `design-system` and `component-build` inside the existing
  Electron product. The current encrypted database, agent runtime, provider
  permissions, Google Workspace OAuth, Native Graphite shell, and Memory route
  remain compatible.
- Thesis: time, people, and remembered context form one inspectable life model;
  the calendar is the temporal projection of that model, while every block and
  fact keeps its authority, source, confidence, sensitivity, and correction
  path visible.
- Increment: add backward-compatible structured memory metadata, encrypted
  people and unified-calendar records, deterministic context selection,
  contradiction/lifecycle maintenance, Google Calendar import, and one combined
  Life surface. Apple Calendar, Outlook, richer inference, and destructive
  external edits remain explicit adapter boundaries for later increments.
- Trust: high. Direct user statements outrank agent inference; provider events,
  explicit blocks, inferred routines, and unapproved suggestions never collapse
  into one visual state. Sensitive and restricted records require explicit
  retrieval permission and remain encrypted at rest.

### Visual system lock

- Density: `dense-app`. The week is a ruled time plane, not a set of event
  cards. People and memory use continuous rows with separators.
- Type: preserve SF Pro Display, SF Pro Text, and SF Mono roles from Native
  Graphite. Calendar time, confidence, provenance IDs, and recency use SF Mono.
- Scale: page title `32/38`; week day `13/18`; event title `12/16`; time and
  provenance `10/14`; body and editable values `13/19`.
- Spacing: preserve the 4px base and `8/12/16/20/24/32` operational rhythm.
- Color roles: confirmed provider events use aluminum plus a solid source edge;
  explicit Kestrel events use sage; inferred blocks use a dashed amber edge and
  confidence text; suggestions use a dotted tertiary edge and an approval
  label. Color is never the only distinction.
- Material: matte graphite planes, thin rules, and one selected-detail surface.
  No glow, glass event cards, rainbow provider palette, pill forest, or bento
  dashboard.
- Composition: a compact Life header, one three-way view switch, then one
  dominant work plane. Calendar is the default temporal view; People and Memory
  expose the same underlying records rather than separate mini-products.
- Motion: existing route/state fade and direct control feedback only. Calendar
  data never animates while the user is reading it. Reduced motion removes all
  travel without changing state.
- Compact behavior: below the wide calendar threshold, recompose the week into
  a chronological agenda; do not shrink seven columns or introduce page-level
  horizontal scrolling.
- Accessibility: semantic buttons/forms/lists first, visible focus, text labels
  for source and confidence, logical chronological reading order, destructive
  confirmation, and focus restoration after removal.
- Why this is not generic: the provenance hierarchy is the visual hierarchy—the
  same fact can be inspected as time, person context, or memory without losing
  where it came from or being promoted from inference to truth.

### State and verification contract

- Calendar: loading, first-use, disconnected provider, connected/stale, syncing,
  sync error/retry, empty range, provider-confirmed, explicit, inferred,
  suggested, recurring, conflict, selected detail, compact agenda, and local
  creation.
- People: empty, resolved aliases, relationship/tone facts, sensitive fields,
  conflicting facts, correction, delete-person warning, and deleted.
- Memory: short/mid/long/archive, active/superseded/contradicted/expired,
  confirmed/inferred/suggested, search/no results, correction, provenance,
  related entities/events, usage explanation, and deletion.
- Engineering checks: schema migration and encryption, retrieval minimization,
  sensitivity filtering, contradiction precedence, relationship tone,
  recurring schedule correction, Google normalization/idempotent sync,
  person-scoped deletion, lifecycle archival, renderer typecheck/build,
  keyboard/focus, compact reflow, packaged macOS capture, and no console errors.

## Final Native Graphite system — July 2026 (historical)

This section preserves the design history and feature-specific safety
boundaries. The Monochrome — August 2026 section above is authoritative wherever
palette, navigation, material, motion, or visible customization conflicts.

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

- Primary navigation is Browser, Agent, Writing Studio, Approvals, and Settings;
  the agent conversation is a stable adjacent surface with New task and Task
  history. Urgent approval status remains visible. Browser utilities live in
  the browser menu, while specialist routes remain available through the
  searchable Command Center.
- The browser menu groups familiar tab, history, page-tool, and settings
  actions. It closes after navigation and on Escape. Compact windows keep the
  browser return path and place overflow navigation in a bounded scroll region.
- Page headers name the surface directly. Eyebrows are reserved for real state
  or trust boundaries, not decoration. Support copy appears only when it
  explains consequence, provenance, privacy, recovery, or an empty state.
- Settings uses one section navigator and continuous setting rows. Technical
  detail stays in native disclosures; primary choices and current state remain
  visible.

### Browser Home and persistent rail

The current Home is a flat browser canvas rather than a dashboard. Browser
chrome remains primary, the greeting and hero composer form one focal region,
local Frequent tabs disappear when empty, and exactly three monochrome text
rows open real agent prompts. The persistent 360px rail merges browser context
and current task, caps Recent at three rows, pins the composer, and exposes four
primary destinations. Personalization choices, decorative thumbnails, duplicate
identity, empty-history cards, and redundant approval state are not part of the
renderer.

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
  improve the browser-first navigation and command-center behavior in
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
