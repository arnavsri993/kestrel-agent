# Kestrel desktop redesign synthesis

**Base:** `main` at `524acf82ccf1361bab0db90b8defaf1afb551e4f`
**Mode:** existing-product redesign and design-system consolidation
**Selected direction:** Instrument Workbench, an implementation refinement of
Kimi's Instrument Console

## Evidence-led audit

The 94 supplied captures, a fresh 94-shot renderer run from the exact base,
the source map, and the running Electron renderer agree on the same root
problem: Kestrel has a strong product model and a recognizable graphite
identity, but its active work is not consistently the strongest visual plane.
The shell, individual pages, Settings, and feature components each express
hierarchy differently.

The highest-impact observed defects are:

1. Specialist pages do not share one header, measure, or content grammar.
2. Settings spends most of the available center width on repeated navigation
   and headings. At 1280px, Connections collapses copy into single-word lines.
3. The browser toolbar and crowded tab strip give too many controls equal
   weight, while the persistent agent rail also repeats model/task controls.
4. Work and Readiness use large nested panels for information that should read
   as one continuous operational plane.
5. Empty states, statuses, buttons, inputs, and rows have overlapping systems.
6. At 640px, the content generally reflows, but the browser chrome remains
   visually crowded and the persistent agent capability loses a clear composer
   anchor.
7. The audit capture labelled `workspace-new-tab` can preserve the last
   `kestrel://` tab instead of explicitly opening Browser Home, weakening the
   visual regression signal.

The strongest existing work must remain: browser and agent co-presence, the
approval boundary, Life provenance, command-center navigation, honest local
data, five-stage setup, compact Life agenda, and the triangular macOS window
controls.

## Candidate synthesis

Three variants inside the locked product architecture were considered:

- **Instrument Console:** Kimi's direct direction. It has the lowest risk and
  fixes system inconsistency, but can leave the center plane feeling like the
  same sparse canvas with cleaner components.
- **Instrument Workbench:** keeps Kimi's shell triad and control discipline,
  while making the active browser/page plane visibly primary and making rail
  geometry content-responsive. It best addresses the rendered hierarchy.
- **Browser-led Console:** creates more browser space, but underweights the
  durable agent and gives operational pages an editorial geometry they do not
  share.

Instrument Workbench is selected. This does not reopen Kimi's architecture
decision. It is the strongest realization of Instrument Console after looking
at the real renderer.

## Design thesis

**Kestrel is an instrument workbench: two quiet structural rails frame one
unmistakably active graphite work plane, so the browser or task stays primary
while the agent, approvals, and provenance remain continuously available.**

- **Density:** `dense-app`, with deliberate sparse exceptions for setup,
  Browser Home, a new task, and true empty states.
- **Why this is not generic:** Kestrel's identity comes from the real
  browser-and-agent workbench, its angular mark and controls, and the visible
  approval/provenance loop—not from a dashboard template, accent color, card
  grid, or AI ornament.
- **Type:** platform system typography is intentional for a daily desktop
  instrument, not a marketing identity shortcut. SF Pro/SF Mono lead on macOS;
  Segoe UI Variable/Consolas lead on Windows. Optical sizing, size-specific
  tracking, and tabular evidence carry the character.
- **Material:** matte graphite. Optional translucency belongs only to
  under-scroll structural chrome on macOS. Content is opaque.
- **Avoid:** glass stacks, glow, gradients, card walls, pill forests, ambient
  animation, macOS Settings cosplay, mobile-sheet navigation, tiny gray type,
  duplicated headings, fake metrics, and hue-only state.

## System lock

### Semantic ramp

Components consume semantic roles, never raw colors:

- `canvas`: the outermost window field
- `chrome`: browser and window structure
- `rail`: navigation and agent structure
- `workbench`: the active central plane
- `surface`: a distinct object or continuous row group
- `raised`: composer, approval, selection, or an interaction in progress
- `overlay`: menu, popover, dialog, or transient layer
- `ink`, `ink-secondary`, `muted`, `faint`
- `line`, `line-strong`, `focus`, `selected`, `danger`

The value steps remain monochrome. The workbench is separated from both rails
by value and a single structural edge, not by a giant rounded container.

### Type roles

- display `38/43 700`, setup and Browser Home only
- page title `26/32 680`
- section `16/21 630`
- body `14/21 450`
- control `13/18 560`
- support `12.5/18 450`
- metadata `11.5/15 580`, uppercase only for real state
- evidence `11/16 500`, mono

No visible interface copy is below 11px. Heading tracking tightens as size
increases; body text stays near zero tracking.

### Spacing, shape, and targets

- 4px base; supported rhythm `4, 8, 12, 16, 20, 24, 32, 40, 56, 72`
- controls 8–10px radius; distinct surfaces 12–14px; major setup surface 20px
- no radius on ordinary page grouping or continuous lists
- 32px minimum compact target, 40px normal, 44px primary or consequential
- borders identify inputs, selection, or object boundaries; spacing and
  separators group ordinary content

### Elevation contract

Raised at rest: composer and pending approval. Overlays are raised by nature.
Other elevation is allowed only for a named detail, interaction, spatial layer,
or transient state. Every filled, bordered, shadowed, or rounded wrapper must
name the independent object or relationship it represents.

## Shell and page architecture

### Three-region workbench

- Expanded navigation rail: approximately 216px, allowed to compress before it
  collapses. Browser remains the brand/mark destination.
- Active center: flexible, with a minimum viable work width and an explicit
  workbench value. Browser chrome belongs to this plane.
- Agent rail: approximately 336px at normal desktop widths, allowed to grow for
  conversation reading and compress before compact mode.
- Shell dimension changes must keep the native `WebContentsView` observation,
  bounds synchronization, and visibility contract intact.

At compact width, the navigation rail becomes a 56px labelled-by-accessible-name
icon rail. The agent does not disappear: a bottom agent dock exposes state,
composer entry, and expand/new-task actions. It is a desktop dock, not a
swipe-only mobile sheet.

### Shared PageFrame

Every `kestrel://` page uses one component contract:

1. optional real-state eyebrow
2. one unique page title
3. one consequence/provenance/recovery description
4. optional action cluster aligned with the heading
5. optional local navigation
6. one content region with a declared measure: `reading`, `standard`, `wide`,
   or `full`

Reading/form surfaces use a bounded measure. Operational planes such as Work,
Life, and libraries may expand. Pages never become a rounded card inside the
browser.

### Settings

Settings has one page title and one explicit Browser/Agent scope control. At
wide center widths, section navigation is a quiet local rail beside a minimum
560px content plane. When that relationship stops working, section navigation
becomes a labelled native select/compact toolbar above full-width content.
Navigation copy and panel titles are not repeated as eyebrows.

### Browser and agent chrome

- Browser tools are grouped as navigation, address, page actions, and overflow.
  Infrequent policy/routing controls move out of the always-visible toolbar.
- Tabs prioritize the active tab, retain stable close behavior, and use
  overflow rather than microscopic equal-width glyphs.
- The agent header carries task identity and only the actions that operate on
  the rail. Advanced routing belongs in task settings.
- The composer remains a grounded raised plane with one dominant input and one
  commit action.

## Component vocabulary

- `Button`: `solid`, `bordered`, `quiet`, `destructive`; sizes `compact`,
  `normal`, `decision`. One solid action per decision region.
- `Input` and `Textarea`: persistent labels supplied by the owning field;
  placeholders are examples, never labels.
- `Row`: continuous list primitive with optional icon, description, status, and
  accessory. It owns hover/selected/focus treatment.
- `Card`: only for an independent approval draft, artifact preview, selected
  detail, or interaction object—not ordinary grouping.
- `EmptyState`: cause-specific title, one recovery line, at most one action.
- `Status`: shape plus text; asynchronous updates never steal focus.
- `PageFrame`: shared route scaffold and measure contract.

Legacy `.button` styling is migrated to the shared control vocabulary rather
than kept as a parallel design system.

## Motion grammar

There are only three roles:

1. **Feedback:** pointer-down, keyboard focus, hover/selection; 70–90ms. Feedback
   starts on pointer-down, while commitment remains on activation.
2. **State/orientation:** route, disclosure, tab, menu, and status changes;
   120–180ms, transform/opacity only, same path in and out, origin anchored to
   the trigger.
3. **Direct manipulation:** only elements a person actually drags. Use Pointer
   Events, capture, grab offset, live presentation values, cancellation, and
   velocity handoff. No CSS keyframes for gesture-owned motion.

Dense reading content does not animate into view. Reduced motion preserves the
state change with opacity or an immediate swap. Reduced transparency and
Windows use opaque structural surfaces. Animations never own business state or
delay input.

### Motion quality acceptance gate

Motion is a release-blocking product behavior, not optional finish work. Before
review, manually exercise buttons, tabs and tab lifecycle, browser-tab reorder,
agent-rail expand/collapse/resize, menus, popovers, native selects, command
center, dialogs, approvals, route changes, disclosures, Settings navigation,
model/provider selectors, New Tab, drag/reorder, panels, async state changes,
and compact recomposition in the running Electron application.

For every representative interaction:

1. feedback begins on pointer-down where appropriate while activation remains
   semantic;
2. motion never locks input or delays business-state commitment;
3. reversible paths are interruptible and resume from the current rendered
   value without a jump;
4. enter and exit share a spatial path and overlays originate at their trigger;
5. a near-critically-damped spring is used only where continuous physical
   travel benefits from it, with bounce reserved for justified momentum;
6. direct manipulation uses pointer capture, grab offset, live tracking,
   cancellation, and release velocity where relevant;
7. transform/opacity motion does not shift layout or reduce interaction
   responsiveness; and
8. reduced motion keeps every state change clear and usable.

The gate judges continuity, latency, interruptibility, and physical coherence,
not whether an animation merely exists. Screenshots cannot satisfy it.

## Accessibility and state contract

- Native semantics first; custom composites follow a documented keyboard and
  focus contract.
- Menus, popovers, dialogs, and disclosures define initial focus, traversal,
  Escape, dismissal, and restoration to a surviving trigger.
- Dynamic progress/success/failure uses the correct live-region urgency and
  remains discoverable after the announcement.
- Source order matches reading and focus order across recomposition.
- Every surface can represent initial/loading, empty, populated, interrupted,
  error/retry, offline/disconnected, permission-blocked, disabled, pending
  approval, running, verified, and recovery where the data contract supports
  them.
- Compact, 200% zoom, long content, forced colors, reduced motion, and reduced
  transparency are explicit verification states.

## Reference use

- `emilkowalski/skills` at
  `d23d7f88a2e21c9e4b1418c7abe420f5c1052ba7`: interaction reasoning,
  presentation-value interruption, momentum, spatial paths, type, and access.
- `emilkowalski/sonner` at
  `8e4662b39255120b62138312058f5d77c0139a5e`: bounded transient state,
  update-in-place, paused timers, live-region semantics, and restrained
  stacking. No dependency adopted.
- `emilkowalski/vaul` at
  `3e97aac6a38e4481bade71d7233ed6002e80f9b0`: gesture eligibility,
  pointer capture, scroll conflict, progress-coupled layers, and snap behavior.
  No dependency adopted; renderer-only overlays cannot cover native
  `WebContentsView` siblings.
- `arnavsri993/frontend-taste-engineer` at
  `74756b43c1e8770541df11c8d19f01a51daa3cc4`: existing-redesign method,
  semantic systems, state coverage, accessibility, responsive recomposition,
  and the mandatory capture-refine-recapture gate.

## Completion gate

The redesign is review-ready only after:

1. matched wide/normal/compact captures of every deterministic surface;
2. explicit first-pass identification and correction of the three largest
   visual defects, followed by recapture and inspection;
3. focused shell, browser, setup, Life, approval, and Settings tests;
4. typecheck, build, broad repository verification, package, and packaged smoke
   with honest separation of baseline or external failures;
5. keyboard/focus, reduced-motion/transparency, overflow/zoom, and native-view
   geometry checks;
6. the running-app motion-quality audit above, including representative
   direct-manipulation and interruption checks; and
7. an unmerged pull request from the dedicated implementation branch.
