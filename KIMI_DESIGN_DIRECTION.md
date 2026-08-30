# KIMI_DESIGN_DIRECTION.md

**Status:** Authoritative design direction for Kestrel desktop redesign.
**Basis:** `main` @ `34e1d99` (PR #673, #674, #675 merged), 94 baseline screenshots in `artifacts/ui-audit/baseline/`, SURFACE_MATRIX.md, CURSOR_UI_REVIEW.md, IMPLEMENTATION_MAP.md, REFERENCE_NOTES.md, DESIGN.md, CONTENT.md, and the apple-design skill (`emilkowalski/skills`).
**Audience:** The frontier implementation model. This document is opinionated; engineering judgment applies to realization, not to the direction itself.

---

## 1. Executive design thesis

Kestrel is a **quiet instrument with a sharp hierarchy**: a desktop tool that behaves like well-made test equipment, not an AI theme park. One primary thing is always happening (a task, a page, a document, a queue); everything else is matte, continuous, and visually subordinate. By **default restraint**, the composer and the approval card are the only surfaces that rest elevated — and that rule is the discipline that makes the rest of the system read as designed rather than assembled. It is a default, not an absolute prohibition: additional elevated or material-separated surfaces are acceptable when they clearly communicate hierarchy, spatial layering, transient state, or interaction (see §7.5).

> **Reading note for the implementation model.** "Instrument Console" preserves Kestrel's **product model** — a real browser co-resident with a persistent agent, approvals, and provenance. It explicitly does **not** mean preserving the geometry captured in the current screenshots. Section 2 defines exactly what is locked, and everything not on the locked list — every proportion, scaffold, grouping, and placement — is open for recomposition. Weak screens should be substantially recomposed, and the result must still read unmistakably as Kestrel.

The thesis rests on five commitments:

1. **One scaffold.** Every `kestrel://` page and every Settings section lives on the same page template: eyebrow (optional, for real state only), title, one descriptive line, content on a bounded measure. No page invents its own header grammar, and none are allowed to look like separate mini-apps. The precise geometry of the scaffold is intentionally left to implementation — the rule is that there is exactly one.
2. **One elevation ramp.** Canvas → rail → panel → surface → raised → overlay, value-ordered on a monochrome ramp. Elevation is a meaning-bearing mechanism, used by default only for the composer, approval, and transient/interactive surfaces, unless a stronger case is made.
3. **One motion grammar.** Pointer-down feedback, ~90–180ms state changes, trigger-anchored popovers, springs only for real drags. Motion explains what changed; it never performs.
4. **One control vocabulary.** One button component with four variants (solid, bordered, quiet, destructive), one input treatment, one row treatment. The current `.button`/`.ui-button` duality is the most damaging craft defect in the product.
5. **One truthful state matrix.** Every surface implements loading, empty, populated, error, disabled, approval-pending, and verified. Empty states are one mark, one line, one recovery. No fake metrics, ever.

The design borrows Apple's **interaction reasoning** (immediate feedback, interruptible springs-as-default, spatially anchored popovers, optical typography) while rejecting Apple's **visual vocabulary** (no translucent materials in content, no Settings-app cosplay, no glass, no SF Symbol clones). Kestrel's monochrome graphite is genuinely distinctive for a desktop app; the current problem is not the identity but inconsistent hierarchy. We keep the identity, fix the hierarchy.

---

## 2. Scope contract — what is locked, what is unlocked

This section is normative for the implementation model.

### ARCHITECTURE LOCKED

The following are **not** design choices. They are the Kestrel product model, and any implementation that violates them is wrong regardless of craft quality:

- **Persistent agent capability.** The agent is a durable co-resident surface, not a modal or a page you navigate away from. It may be collapsed/resized/reanchored — but never removed.
- **Browser ↔ agent relationship.** Browser context and agent continuity stay coupled, with the "Current page" context mechanism as honest glue.
- **Navigation concepts.** The triad: brand → browser; rail → agent/writing/approvals/capabilities (+ Settings bottom); `⌘K` → everything else. Specialist tools open as `kestrel://` browser tabs. Command center remains the launcher.
- **Approvals, safety, provenance.** Gates, boundary acknowledgments, edit-before-approve, restart-safe queue, recovery paths, provenance hierarchy of Life (source/confidence/sensitivity/correction), and truth-in-ui for model/provider/migration states.
- **Existing product functionality.** Browser, agent tasks, Life (Calendar/People/Memory), Work, Approvals, Library tools (History/Bookmarks/Downloads), Research, Artifacts, Activity, Extensions, Opportunities, Readiness, Projects, Writing, Settings, Command Center, Setup flow, and all behavioral capabilities behind them.

### LAYOUT / COMPOSITION UNLOCKED

The implementation model is explicitly permitted — and expected — to substantially recompose weak screens. All of the following are unlocked:

- **Rail widths and proportions** (nav rail, agent rail, context panes). The 360px figure is a starting default, not a lock.
- **Page scaffolds** — the unified template's geometry, measure, and header rhythm.
- **Content widths**, bounded or otherwise (the 760/880/1040 guidance below is advisory).
- **Information grouping** and **hierarchy** on any surface.
- **Placement of actions** (primary/secondary clusters, model selector placement, task settings, rail headers, toolbar clusters).
- **New Tab composition.** Greeting/composer/widget logic or geography may be recomposed; honesty constraints stay.
- **Settings composition.** The Browser/Agent scope mechanism, section IA, nav geometry, and density are unlocked; scopes and sections themselves are locked content.
- **Life/People/Memory composition.** Provenance rules stay; the view-switch, header, detail pane, and agenda reflow geometry are unlocked.
- **Work/Readiness composition.** Kanban/goal/delegate/readiness organization; nested-card discipline remains but placement is unlocked.
- **Setup composition.** The five stages are locked; their screen geometry is unlocked.
- **Individual component geometry.** Any component spacemetrics, radii, or alignment may be redone inside the component grammar.
- **Elevation and material.** Any surface may add elevation or material separation if the implementation model can defend in code review that it improves hierarchy, conveys spatial layering, signals transient state, or explains interaction.

Within those unlocked areas, every recomposition must still pass: scaffold uniformity, one button vocabulary, motion grammar discipline, state completeness, and platform-adaptation.

---

## 3. Problems with the current product

Evidence-first. Sources: baseline screenshots and SURFACE_MATRIX/CURSOR_UI_REVIEW.

### 3.1 No shared page scaffold (the highest-impact defect)

`kestrel://settings` opens with an H1 "Preferences" that differs from the tab and the nav item; `kestrel://life/calendar` uses "Life"; `kestrel://work` uses "Plan and track"; `kestrel://readiness` uses "Needs attention"; `kestrel://writing` uses an eyebrow "Writing Studio" plus a tagline. Every leaf page re-invents header geometry, measure, and title style (see `baseline/normal/surface-work.png`, `.../surface-readiness.png`, `.../lifecycle-calendar.png`, `.../surface-writing-studio.png`). Settings nests a second navigation card in the content column (`settings-*.png`) so two independent nav systems coexist 250px apart. This is the daily-disorientation defect and is the highest-priority implementation fix.

### 3.2 Two button systems

`styles.css` defines `.button`; `components/ui/` defines `.ui-button`. The two co-exist with different radius, padding, and state treatment on the same screen. This makes the product feel untrustworthy at the most atomic level.

### 3.3 Toolbar density and icon chaos

The browser toolbar carries 7–9 equal-weight icon buttons plus the "Pragmatic" chip at every width. At 1280px, ~21 tabs display as a wall of near-identical glyphs with one selected close-button. There is no progressive disclosure, no grouping, and no visual weight. The agent rail header repeats the problem at small scale ("New task" title with expand/new/collapse clusters on all corners).

### 3.4 Settings IA collapse

The Browser/Agent scope switcher occupies the most prominent header slot, then Agent scope re-opens an 8-item secondary card. The section list, panel title, and eyebrow ("SETTINGS FOR Agent / AGENT SETTINGS") repeat "Agent" three times in nested headers. Connections renders unconstrained columns, collapsing text to one-word-per-line (`normal/settings-connections.png`). Long-scroll abuse and scope ambiguity follow.

### 3.5 Redundant headings everywhere

Nav label = page H1 = eyebrow = supporting copy. Eyebrows must be reserved for real state or trust boundaries (per old DESIGN.md, which we keep).

### 3.6 Non-uniform treatments of empty and specialist states

Projects empty is a dashed box with action (good). Work empty is a bordered card (acceptable but inconsistent). Approvals uses a full review canvas (correct for the pending item). Readiness composes nested cards-in-cards. Rules "Row at least 52px / inset separators" exist for some lists — library and work surfaces are ad-hoc.

### 3.7 Composer-competition

The composer header carries expand, new chat, "New task" centered title, collapse, model selector ("Auto", "Smart"), microphone, and send — eleven redundant affordances on one 360px strip. Model selector + task settings compete for attention. There is no focus story.

### 3.8 Motion that is CSS-only and non-interruptible in places

`motion.css` keyframes drive route and dialog transitions; in-page state changes often use blocking CSS keyframes. The address-bar flicker bug (PR #675) is what a focus-stealing transition looks like — popovers must be origin-anchored and not steal native viewport overlays. Interruptibility is the target.

### 3.9 Generic AI/thin-template feel

Agent/Tasks, Projects, Writing Studio render on slightly different templates — title+list, icon+list, eyebrow+tagline — that read like dashed-border stock templates. Each feels like "an internal tool page," not Kestrel.

### 3.10 What is too web-like

Settings rows with standalone bordered "Save" pills; segmented Browser/Agent scope cards; floated white primary pill buttons; a search field with a filled pill and magnifier chip; one-off `frontend-taste-engineer` style card layouts. This is web-form layering, not desktop instrument layering.

### 3.11 What is too Mac-specific (risk-on-Windows)

Custom `WindowControls.tsx` traffic lights + `--vibrancy-*` blur tokens on the sidebar and browser chrome. Windows must get opaque chrome, native caption buttons (or an opaque minimal set on the right), Ctrl-based shortcut labels, and Segoe fallback. Today this is partially handled only via `prefers-reduced-transparency`; the divergence must be per-platform, not per-user-preference.

### 3.12 Recomposition needs, not restyling

- Agent empty/new-task/welcome states must merge into a single ladder.
- Settings scope switcher vs. 8-section IA must be recomposed.
- Projects doubles with sidebar Projects section — pick one role.
- Compact mode hides labels (correct) but the composer becomes visually absent though attached — it must always remain the rail's bottom anchor.

---

## 4. Three candidate directions

Three coherent directions, not color variants.

### Direction A — **Instrument Console** (refined status quo)

Refinement of thecurrent shell vocabulary: one scaffold, one ramp, one button vocabulary, one motion grammar, with the triad shell retained. New in the revision: implementation is **free to recompose layout geometry** — rails, measures, grouping, placement — as long as the product model stays and discipline rules apply.

- **Composition:** left nav rail, wide content viewport, persistent agent rail; agent rail is still required, dimensions are renegotiable.
- **Navigation model:** the triad (brand/browser; rail; ⌘K).
- **Agent/browser:** co-primary, explicit "Current page" chip.
- **Density:** comfortable-dense; spacing tokens, min 11px type.
- **Surface/material:** graphite ramp, matte; restrained elevation by-default.
- **Typography:** SF Pro stack, fixed roles.
- **Icons:** `Icon.tsx` registry, geometric, 16/20px.
- **Controls:** one `ui/Button`, four variants.
- **States:** shared `Status` shape+label.
- **Motion:** ~90–180ms, origin-anchored popovers, springs only for drags.
- **Platform:** macOS materials OK under-scroll chrome; Windows opaque.
- **New tab:** composer-dominant with secondary widget shelf; honesty preserved.
- **Settings:** two-tier IA.
- **Approval:** composer-elevated card, one language inline vs queue.
- **Empties:** one mark + title + recovery.

### Direction B — **Editorial Browser** (browser-first restructure)

- **Composition:** rail thins to brand strip, agent becomes a bottom console band (156px, expandable) across the viewport bottom; editorial 720px pages.
- **Navigation model:** tabs are everything; agent sessions become addressable tabs.
- **Agent/browser:** the browser IS the product; agent instruments it.
- **Density:** lighter, editorial; whitespace-forward.
- **Surface/material:** elevated panels more frequent.
- **Typography:** display-forward; taglines allowed.
- **Icons:** larger, feature not chrome.
- **Controls:** pill-forward; fewer controls, more text links.
- **Motion:** slower (200–260ms).
- **New tab:** launcher/editorial-first.
- **Settings:** editorial flow.
- **Approval:** full-screen document review.
- **Empties:** narrative.

### Direction C — **Command Deck** (context-pane restructure)

- **Composition:** left nav rail same; right "context pane" swaps content per surface (Life: related entities; Work: subtasks; Browser: page tools); composer at device bottom.
- **Navigation model:** Command Center promoted to permanent dock.
- **Agent/browser:** context pane geometry negotiates that relation.
- **Density:** variable by pane mode.
- **Surface/material:** elevated right rail with stronger shadow.
- **Typography:** status-dense, mono-forward for evidence.
- **Icons:** status + category variety.
- **Controls:** 32px compact.
- **Motion:** content swap rise + fade, ~180ms.
- **New tab:** launcher-first command center page.
- **Settings:** search-driven.
- **Approval:** center-stage modal.
- **Empties:** action-forward cards with suggestions.

### What distinguishes A from B/C

A is a refinement; B is a browser-first restructure; C is a context-pane restructure. B/C trade the rail to change it; A preserves the triad and attempts full craft discipline. The motivating insights of B/C (composer always anchored; context sensitivity of right pane) are absorbed inside A without abandoning predictability.

---

## 5. Selected direction: Direction A — Instrument Console (composition unlocked)

### Why A beats B and C

1. **Product thesis must survive.** The persistent agent rail is the differentiator. B's "band" and C's "chameleon pane" each downgrade the rail's role — a mistake in product terms. The audit explicitly lists "persistent agent rail" under Preserve.
2. **Familiarity is an asset.** Apple Principle 4: break a familiar pattern only with proof. A devotes full effort to hierarchy, template, and controls — not to inventing a shell.
3. **Cost of B/C is not justified by their wins.** B's editorial measure is wrong for an operational ledger/tool surface. C's context pane creates focus-order and focus-restoration problems.
4. **The real defect list is template-and-craft**, not shell architecture. The highest-impact item (no shared scaffold) is a template problem. A fixes the correct things.
5. **Recomposition is permitted.** Sol is not required to preserve the current geometry: rail width/proportions, tile geometry, header rhythm, hierarchy placement, and component microscopic geometry are unlocked.

Direction A is then developed fully below.

---

## 6. Product-wide layout architecture

### 6.1 Shell triad (per viewport, with geometry negotiable)

- **Left rail (`KestrelSidebar`):** brand row (mark + name), New task primary action, destination list (Agent, Writing, Approvals, Capabilities), Projects section, Recent tasks, Settings bottom anchor. Expanded width guidance ~232px; compact → icon-only. Geometry itself is unlocked.
- **Content viewport:** bounded or flow content per page scaffold (see §6.2).
- **Agent rail (`AgentSidebar`):** default 360px; geometry renegotiable; at compact it collapses to an icon+composer anchor. Never fully hidden.
- **Window chrome:** macOS custom `WindowControls` triangular traffic lights; Windows opaque chrome with native buttons or an opaque minimal set.

### 6.2 Unified page scaffold (the template; terms are loose bounds)

All `kestrel://` pages and Settings sections share this template (owners: `App.tsx` + `styles.css` as `.browser-app-page`):

```
┌─────────────────────────────────────────────────────────┐
│ eyebrow? (real state/trust only)                        │
│ Page title (24/30, weight 700)                          │
│ One-line description (support, ≤ 80 chars)              │
│ ───────────────────────                                 │
│ Content region (hierarchy rules below)                  │
└─────────────────────────────────────────────────────────┘
```

Content measure is deliberately not fixed. Advisory guidance:
- Reading/form surfaces (Settings panels, Writing, Life detail, Approvals): ≈ 760px.
- Wide operational (Library, Work kanban, Life calendar): ≈ up to 1040px.
- Task list, Projects, History/Downloads/Bookmarks/Research/Artifacts/Activity/Extensions/Opportunities/Readiness: ≈ 880px.

These bounds are compositional hints, not geometry locks; implementation may choose per-surface bounds while keeping a single scaffold.

**Eyebrow rules:** uppercase 11.5/15, letterspacing +0.06em, metadata ink. Only for real state ("1 BLOCKING CHECK", "SETTINGS — Agent") — never for duplicated identity.

**Description rules:** one sentence, ≤ 80 chars, support ink. It explains consequence/provenance/recovery, not label repetition.

### 6.3 Agent rail regioning

The rail carries four regions top-to-bottom:
1. **Rail header:** expand + New chat on left, collapse on right, centered task title if any.
2. **Context chip (optional):** "Current page" one bordered row; dismissed via task settings.
3. **Conversation region (flex).**
4. **Composer (auto-sized):** pinned bottom; elevation raised; contains model chip + send cluster; the `Auto ▸ Smart` segmented control shifts into task settings disclosure.

### 6.4 New tab (browser-native home)

Centered measure (guidance ≈ 640px; unlocked): brand, greeting, composer, widget shelf. Composition, including exact greeting and shelf geography, is unlocked for recomposition.

### 6.5 Browser ↔ agent spatial relation

The "Current page" chip is the only explicit tie between browser and agent, never implied-copied. Separation of canvas vs. rail values preserves the distinction.

---

## 7. Design system specification

### 7.1 Color & ramp (monochrome graphite, value-only)

| Token | Role | Value (approx) | Notes |
|---|---|---|---|
| `--canvas` | app canvas | `#0d0e11` | Live value is authoritative |
| `--sidebar` | nav rail | `#101013` | |
| `--panel` | agent rail / settings nav | `#151517` | |
| `--surface` | resting cards/rows | `#1d1d20` | |
| `--surface-raised` | composer/approval | `#27272b` | Elevated default |
| `--overlay` | popovers/dialogs | `#303036` | With shadow-lg |
| `--ink` | primary | `#f5f5f7` | |
| `--ink-secondary` | secondary | `#cfcfd6` | |
| `--muted` | metadata | `#9a9aa2` | |
| `--faint` | disabled/hint | `#6a6a72` | |
| `--line` | separators | rgba(255,255,255,.06) | |
| `--line-strong` | inputs focus | rgba(255,255,255,.14) | |
| `--selected-soft` | selection fill | rgba(255,255,255,.08) | |
| `--solid` | primary action fill | `#f5f5f7` | |
| `--on-solid` | primary action ink | `#0a0a0a` | |
| `--focus-ring` | focus | 2px white | |

Status: filled shapes (check/triangle/octagon/circle) + label; hierarchy by strength of white ink. No hue. No gradient, glow, or blur in content.

### 7.2 Typography

Font stack per platform (owner: `styles.css`) — macOS first: `-apple-system, "SF Pro Text", "SF Pro Display"`; Windows fallback: `Segoe UI, "Segoe UI Variable Text"`; mono `"SF Mono", ui-monospace, Consolas`.

Indicative scale (values are advisory):

| Role | Size/Line | Weight | Tracking | Usage |
|---|---|---|---|---|
| display | 40/46 | 700 | −0.01em | Setup, greeting |
| title | 24/30 | 700 | −0.005em | Page title |
| section | 16/21 | 650 | 0 | In-page section |
| body | 14/21 | 450 | 0 | Conversation, body copy |
| control | 13.5/18 | 550 | 0 | Buttons/inputs |
| support | 12.5/17 | 450 | 0 | Descriptions |
| metadata | 11.5/15 | 500 | +0.06em | Eyebrows/status |
| evidence | 11/15 | 500 | 0 | Mono for paths/hashes/IDs |

No text below 11px. Optical sizing.

### 7.3 Spacing, radii, elevation

- **Spacing:** 4px base; allowed set {4,8,12,16,20,24,32,40,56,72}; tokens `--space-*`. (Scale values unlocked.)
- **Radii:** 6/10/12/14/16/24 + pill; controls default 10px; buttons 10–12px; containers 14–16px; setup 22–24px. (Component geometry unlocked.)
- **Elevation:** default restraint — composer + approval = `--shadow-lg`; overlays/popovers/menus = `--shadow-lg`; other content = none. (Additional elevation ONLY if it clearly communicates hierarchy/layering/transient state/interaction; see §7.5.)
- **Borders:** 1px `--line`; inputs focus `--line-strong`.

### 7.4 Materials (translucency policy)

- **macOS:** `backdrop-filter` allowed only for under-scroll chrome (rails, browser chrome, rail header); reduced-transparency → opaque.
- **Windows / reduced transparency:** opaque; no backdrop-filter.
- **Content:** never translucent; no glass event cards, no ambient field.

### 7.5 Elevation rule (softened by revision)

The default is restraint: the composer and the approval card are elevated at rest, popovers/menus are elevated by nature, and everything else is matte. **Deviation from this default is allowed** when the implementation model can demonstrate, in code review, that elevation or material separation is used to:
1. communicate visual hierarchy (e.g., a specific detail pane that must outrank its container);
2. convey spatial layering (e.g., a drawer or overlay that must read as a separate plane);
3. signal transient state (e.g., a drag preview or an in-flight confirmation);

Elevation must not appear on random content for decoration.

### 7.6 Icons

`Icon.tsx` registry only. Sizes 16 (rows/tabs), 20 (rails), 24 (window controls), 56 (empty state mark). Stroke 1.5. No outline/filled mixing in one view. Hover scale is handled for window controls. Hit targets: compact 32px, normal 40px, primary/setup 44px.

### 7.7 Components summary

Buttons, inputs, rows, cards, popovers, dialogs/sheets, tabs, status, toast — specify in §9.

---

## 8. Motion grammar

Defaults: state ≤ 180ms; pointer feedback ≤ 90ms; drag-anchored springs; everything else is opacity/position. Reduced equivalence required.

| Trigger | Behavior | Tokens/recommendations |
|---|---|---|
| pointer-down | fill-deepen + scale .97 | `--motion-feedback: 90ms ease-out` |
| hover | lift 1px / fill change | `--motion-feedback` |
| focus (keyboard) | ring fade 90ms | `--motion-feedback` |
| route change | 6px rise + fade | `--motion-state: 140ms ease-out` |
| tab switch | fade 90ms | `--motion-feedback` |
| rail collapse | width spring (presentation value) | Motion `spring damping 1.0, response ~0.3` |
| popover open | trigger-origin + fade | anchored transform-origin |
| dialog open/close | center fade/scale | `--motion-smooth: 180ms ease-out` |
| toast | top-edge fade + 30px drop | `kestrel-toast-in` |
| drag | 1:1 track, spring with velocity handoff | Motion `spring damping <1` on flick |
| running indicator | opacity pulse only if that's the sole encoding | gated |

Rules:
1. Motion uses only `transform` and `opacity`. Never `width/height` on content regions except rail width springs.
2. Springs with damping 1.0 default; undershoot only with gesture-preceded momentum.
3. Popovers must animate from their real trigger element coordinates at open.
4. `@keyframes` for gestures/drags forbidden.
5. Reduced motion: opacity cross-fade; rail width swaps instantly; popovers appear without travel.

---

## 9. Component grammar

### 9.1 Buttons (single; `.button`/`.ui-button` retire into `ui/Button`)

Variants: `solid`, `bordered`, `quiet`, `destructive`. Sizes: normal 40, compact 32, primary/setup 44. Exactly one `solid` per decision region.

### 9.2 Inputs

`ui/Input`, `ui/Textarea`, composer, address bar. Default 40px, radius 10, border `--line`, focus `--line-strong`. Placeholders not under `--faint`.

### 9.3 Rows

`ui/Row`: min 52px (advisory), inset separators, title 14/ink, description 12.5/secondary, accessory slot. Hover: `--surface` fill. Selected: `--selected-soft` + ring. No nested cards inside cards.

### 9.4 Cards

`ui/Card` static (no border) or interactive (lift +1px). Legal uses: approval draft, preview/artifact, readiness grouped panel, settings grouped panel. Illegal uses: visual divider, nested cards, marketing hero cards. The "No active goals" dashed box in Work is illegal and must become `EmptyState`.

### 9.5 Empty states

`ui/EmptyState` everywhere: one 56px monochrome mark, one title (equal to the empty thing), one support line (the recovery consequence), at most one action. Fixed measure centered at page or rail width. Replaces all dashed boxes.

### 9.6 Menus, popovers, dialogs, sheets, toast

- **Menus:** 36px item, `--overlay`, trigger-anchored, Escape; focus restoration.
- **Popovers:** anchor from trigger; max 400px scroll-bounded.
- **Dialogs:** max width 640px.
- **Toast:** `ui/Toast`; top-left of content viewport; no overlap of composer.
- **Sheets:** if a drawer pattern is introduced, implement with `motion/react`; Vaul is behavior-reference only (no dependency).

### 9.7 Tabs

Browser tabs: height 36px (advisory); active `--surface-raised` fill; sleeping quiet ink; favicon 16px; close on hover; horizontal overflow with scrolling or vertical mode. Life view switch: icon+label pills. Settings scope: segmented pills with visible label. All share press feedback.

### 9.8 Status

`ui/Status` filled shape + uppercase label, reused from `runtime-evidence.ts`. Approval triangle; verified check; running octagon; error x; info circle; disabled circle outline. Never color-only.

### 9.9 Notifications

Inline status via `ui/Status` or toast. Never toast consequential failures. Approval is a persistent surface.

---

## 10. Platform adaptation contract

### 10.1 macOS

- **Window chrome:** `WindowControls.tsx` triangular traffic lights, left cluster; drag region on top titlebar.
- **Menus:** future native menu roles; today in-app toolbar.
- **Materials:** `--vibrancy-blur 20px` under-scroll chrome allowed; reduced-transparency → opaque.
- **Typography:** SF stack first; mono "SF Mono".
- **Shortcuts:** Meta (⌘) labels; modal shows ⌘K, ⌘/, ⌘F.
- **Traffic light position:** left.

### 10.2 Windows

- **Window chrome:** opaque; native caption buttons (recommended) or a minimal opaque custom set aligned right; triangle cluster removed.
- **Menus:** standard window menu permitted; same in-app toolbar.
- **Materials:** all surfaces opaque; no `backdrop-filter`.
- **Typography:** `"Segoe UI Variable Text", "Segoe UI"`; mono `Consolas`. Fallbacks per platform token in `styles.css`.
- **Shortcuts:** Ctrl labels in the modal; accelerators via platform abstraction.
- **Single renderer:** divergence in CSS tokens + window creation options only.

### 10.3 What cannot differ

Page scaffold semantics, elevation vocabulary, monochrome ramp, component grammar, state matrix, motion grammar values.

---

## 11. Screen-by-screen redesign

For every surface: delete/move/merge/resize/recompose. Owners listed where helpful.

### 11.1 Shell & launch states

- **`shell-loading`:** brand + "Starting Kestrel…" with opacity pulse.
- **`shell-error`:** "Kestrel could not start." + "Try again".
- **`setup-*`:** five stages; progress rail one row at all widths; eyebrow state-name; details disclose with focus restoration.

### 11.2 Primary shell

- **`kestrel-sidebar`:** Move Settings to bottom anchor (done) and Projects/Recent compose in fixed rail regions; compact = icon only; badge on Approvals = octagon count, not giant pill.
- **`agent-sidebar`:** Move model segmented control into task settings; Delete centered "New task" header when conversation exists; rail title shows task title or nothing; recompose empty ladder into a single Welcome+composer state.
- **`browser-chrome`:** Group clusters (nav | address | tools); move "Pragmatic" chip into page menu; address bar solid region; same grammar for vertical tabs.
- **`window-controls`:** macOS keep triangular cluster; Windows native/opaque.
- **`command-center`:** Anchor open from trigger; add Recent/Frequent when query empty; `⌘K` canonical.

### 11.3 Browser & new tab

- **`new-tab-home`:** Recompose with brand → greeting → composer → widget shelf (borderless); suggestions ≤ 3 rows on first view; model selector anchored to chip.
- **`browser-web`:** unchanged; address-bar focus anchored suggestions (PR #675 behavior).
- **`browser-file`:** preview bounded measure; one primary action.
- **`organize-tabs-dialog`:** scaffolded; preview as grouped rows.

### 11.4 App pages

- **`page-agent` (Tasks):** Scaffold title "Agent"; eyebrow status "AGENT · NEEDS APPROVAL"; merge the three status cards into one `ui/Status` line; filter next to search in one row; `ui/Row` items.
- **`page-projects`:** `ui/EmptyState`; sidebar = quick access, page = management.
- **`page-writing`:** Delete eyebrow duplication; title "Writing Studio" (or "Writing"); section numbers as in-page section titles.
- **`page-history` / `page-bookmarks` / `page-downloads`:** `ui/Row` library list; destructive confirmation.
- **`page-readiness`:** No nested cards; grouped rows in one surface; top summary is `ui/Status`.
- **`page-approvals`:** Review panel elevated card; Reject/Edit/Approve at 44px; summary `ui/Status` at top.
- **`page-life`:** three-view switch kept; provenance edges preserved; rename `legacy-product-surface`; agenda reflow in compact; disconnected/syncing states designed (additive).
- **`page-research` / `page-artifacts` / `page-work` / `page-opportunities` / `page-activity` / `page-extensions`:** scaffold + continuous rows; Work kanban: header + cards in one surface.
- **`page-settings`:** scope segmented header (Browser|Agent); eyebrow "SETTINGS — Agent"; fix Connections column constraint; advanced sections get progressive disclosure; destructive ops confirm.

### 11.5 Overlays & aux windows

- **`overlay-calculator` / `overlay-password` / `overlay-payment`:** popover grammar anchored under toolbar.
- **`modal-keyboard-shortcuts`:** per-platform labels via platform tokens; max width 640px.
- **`inline-approval` in conversation:** same approval grammar as queue.
- **`composer-mentions`:** anchored popover above composer.
- **`communication-assistant` / `configuration-message` / `dreaming-panel`:** `ui/Row` patterns; config messages are chat bubbles.

---

## 12. State matrix guidance

Every surface implements:

- **loading**: branded pulse (Life calendar uses its own).
- **empty**: `ui/EmptyState`.
- **populated**: rows / scaffold.
- **error / disconnected**: copy + single recovery.
- **disabled**: `--faint` ink, `--line` border.
- **approval-needed**: triangle + label; never in toast.
- **verified**: check + strongest ink.
- **running**: opacity pulse with non-pulsing reduced-motion alternative.
- **success**: toast if safe; else persistent.
- **warning**: triangle status.
- **danger**: destructive variant.
- **compact**: recompose; never horizontal-scroll page.

The matrix lives in `ui/Status` + `ui/EmptyState` + scaffold.

---

## 13. Accessibility requirements

1. **Focus:** visible ring on every focusable; restoration on dismiss; no `outline:none`.
2. **Keyboard:** full path for rails, tabs, menus, dialogs; Esc dismissal returns focus.
3. **Reduced motion:** media query + equivalence (opacity-only cross-fade).
4. **Reduced transparency:** opaque fallbacks; no required blur.
5. **Contrast:** 4.5:1 body; 3:1 secondary/status.
6. **Screen-reader:** Life compact agenda verified; status shape + label always.
7. **Hit targets:** min 32px compact; 40px normal; 44px primary/decision.
8. **No capture privacy:** synthetic data only.
9. **Hover-only meaning forbidden.**
10. **Text:** min 11px; all-caps limited to eyebrow/status.

---

## 14. Things that must NOT be changed

(Cross-referenced against §2 ARCHITECTURE LOCKED.)

1. Persistent agent capability (co-resident, not modal).
2. Browser ↔ agent relationship and the "Current page" context mechanism.
3. Navigation triad (brand/browser; rail; ⌘K).
4. Approvals, safety, provenance: gates, boundary acknowledgments, edit-before-approve, restart-safe queue, recovery paths, Life provenance model.
5. Existing product functionality: all surfaces and capabilities in §2.
6. Product loop `ask → scope → act → approve → verify` and the five setup stages.
7. Monochrome graphite identity (exact hex values remain unlocked to revision).
8. Local-data honesty: no fabricated metrics.
9. Encrypted DB/credential boundaries and related copy.
10. Command center as launcher.
11. Single canonical app / dev workflow.

---

## 15. Superseded DESIGN.md rules (deliberate; geometry now unlocked)

1. **Exact hex tokens:** Design updates reference ramp; live `styles.css` wins.
2. **"No blur ever":** macOS may blur under-scroll nav/chrome with opaque fallback; Windows/reduced-transparency opaque.
3. **Fixed 360px rail:** defaults to 360; negotiable by breakpoint and recomposition.
4. **"Four destinations":** rail shows Agent/Writing/Approvals/Capabilities + Settings; Browser on brand.
5. **Browser home exactly-three-suggestion rows:** kept as first-view max only.
6. **`SkinSettings.tsx` orphan:** delete (monochrome is the identity).
7. **`capture-desktop.ts` Browser nav:** superseded by brand button navigation.
8. **`legacy-product-surface` class on Life:** rename.
9. **Sage signal remnants:** Life sage/aluminum/amber edges stay — deliberate provenance exception.
10. **"No card chrome" vs `ui/Card`:** governed by §9.4 — legal where the boundary carries meaning.
11. **Any geometry/composition guidance from old DESIGN.md** in the LAYOUT/COMPOSITION UNLOCKED categories is now design advisory, not binding.

---

## 16. Top implementation priorities (ordered)

1. **Unify page scaffold** across all `kestrel://` pages and Settings.
2. **Merge `.button` + `.ui-button` → `ui/Button`.**
3. **Settings IA recompose** (scope segmented header; Connections column fix).
4. **Toolbar clusters** (grouping; move "Pragmatic" chip).
5. **Composer anchor** (model segmented control → task settings; header simplification).
6. **Empty-state & status normalization** (`ui/EmptyState` + `ui/Status`).
7. **Token & component reconciliation** (`styles.css` is source of truth; DESIGN.md republication).
8. **Motion normalization** (springs for rails; anchored popovers; reduced-motion).
9. **Windows chrome** (opaque surfaces; window controls; Ctrl labels; Segoe fallback).
10. **Responsive rail** (collapse rules; composer anchor in compact).

(See `IMPLEMENTATION_MAP.md` for blast-radius before each.)

---

## 17. Final visual-quality acceptance criteria

A PR is visually complete when all of the following hold:

1. **Scaffold:** every `kestrel://` page and Settings section uses the unified template with zero one-off headers.
2. **One button:** zero usages of legacy `.button` or `.ui-button` remaining in renderer (except `ui/Button` variants).
3. **Hierarchy:** page title is unique; eyebrows only name real state; descriptions ≤ 80 chars.
4. **Ramp:** values come from ramp tokens in `styles.css`; no hand-coded hex.
5. **Controls:** sizes fit the 32/40/44 ladder; one solid per region.
6. **Motion:** pointer-down feedback visible; route changes in 90–180ms; springs on gestures; reduced-motion equivalence.
7. **Elevation discipline:** default restraint; any extra elevation/material must be defended as hierarchy/layering/transient-state/interaction, in code review.
8. **Windows:** opaque chrome, control strategy, Ctrl labels, font fallback verified.
9. **States:** every surface implements §12.
10. **Verification:** `pnpm capture:ui-audit` shows scaffold alignment across 3 viewports; `test:desktop-layout`, `test:desktop-setup`, `test:desktop-life-context`, `test:desktop-approvals` pass; packaged arm64 smoke passes.
11. **Docs:** DESIGN.md republished into the successor structure; AGENTS.md updated with the workflow.

---

**This document is authoritative for the direction. Implementation may make engineering choices; it may not re-pick a direction. Permission to recompose layout is explicit in §2.**
