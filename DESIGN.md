# Kestrel design system

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

- Primary navigation is Browser, Agent, History, Downloads, Settings, and More; the
  agent conversation is a stable adjacent surface with New task and Task
  history. Urgent approval status remains visible. Specialist routes are fully
  retained through More and the searchable command center.
- More is a grouped launcher for specialist destinations. It closes after
  navigation and on Escape. Compact windows keep the browser return path and
  place overflow navigation in a bounded scroll region.
- Page headers name the surface directly. Eyebrows are reserved for real state
  or trust boundaries, not decoration. Support copy appears only when it
  explains consequence, provenance, privacy, recovery, or an empty state.
- Settings uses one section navigator and continuous setting rows. Technical
  detail stays in native disclosures; primary choices and current state remain
  visible.

### Edge-inspired home screen (implemented)

The empty user tab is a browser home rather than a dashboard: it keeps the browser's tab strip and address bar in the foreground, gives the durable agent a calm left rail, and makes the next useful action obvious without inventing data.

- **Composition:** the persistent agent rail carries the selected agent name, New task, current-page context, recent chats, the mounted composer, and destination navigation. The browser plane carries the tab strip, address bar, top-right `Chat with {agent}` control, a greeting-led local chat composer, circular Frequent tabs, and exactly three dark recommendation cards with visual thumbnails.
- **Real data:** Frequent tabs are derived from origin-grouped local browser history only. Recommendations open the real mounted agent conversation with a prefilled prompt; they are not fabricated activity or remote personalization.
- **Agent handoff:** the left rail can be minimized and restored from either the rail header or the toolbar button. The state is persisted locally, and focus returns to the new control so the collapse is keyboard-complete.
- **Personalization:** Browser settings exposes four local backdrops—Graphite, Meadow, Dawn, and Paper—under Personalization. The selected `newTabBackground` is part of `UserBrowserSettings`, survives reload, and adds no remote request or runtime image dependency. Meadow uses the checked-in `apps/desktop/src/renderer/assets/new-tab-meadow.svg` landscape illustration; the other choices remain CSS-native fields. This is a scoped home-canvas exception to the browser chrome rule: the chrome stays matte and restrained while the home surface can carry a quiet terrain/paper field.
- **Responsive and access:** the frequent row reduces from six to three, two, and one columns; recommendation cards stack on narrow windows; the home remains scrollable in short windows; controls expose names, pressed state, visible focus, reduced-transparency behavior, and reduced-motion-safe CSS.
- **Why this is not generic:** the Edge reference supplies the familiar browser-home rhythm, but Kestrel's rail, history shortcuts, recommendations, agent identity, and personalization are bound to its actual local browser and durable runtime state rather than copied product modules or generic AI metrics.

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
