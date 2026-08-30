# Cursor UI Review (Advisory)

**Audit date:** 2026-08-30  
**Scope:** Kestrel desktop renderer on macOS Electron dev build  
**Evidence:** 94 screenshots in `artifacts/ui-audit/baseline/`, source trace, DESIGN.md review

Scores are subjective 1–10 (10 = exceptional modern desktop quality). This document is **one input** to the implementation model, not authoritative spec.

---

## Major surface scores

### Setup / onboarding

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 7 | Clean, restrained; progress rail and typography are coherent |
| Hierarchy | 8 | One decision per stage reads clearly |
| Usability | 7 | Boundary step is thorough; model step can feel long |
| Motion/interaction | 6 | Stage transitions exist; some controls feel web-form static |

**Top 3 improvements**
1. Unify model-setup substates visually (accounts/local/open share layout grammar but drift in density)
2. Make verification state on Ready screen more scannable (verified vs preview vs blocked)
3. Add compact-width setup captures and test one-row progress at 640px consistently

---

### New tab / browser home

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 7 | Calm composer focal point; widget shelf can feel busy when expanded |
| Hierarchy | 7 | Greeting + composer clear; widgets compete when many enabled |
| Usability | 8 | Real destinations, no fake metrics — good product honesty |
| Motion/interaction | 6 | Home animations settle; model selector popover lacks spatial origin polish |

**Top 3 improvements**
1. Tighten vertical rhythm between greeting, composer, and widget shelf
2. Customize mode should feel like edit mode, not a second page layout
3. Reduce duplicate “home identity” between tab title, greeting, and widgets

---

### Browser chrome (tabs, toolbar, address bar)

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 6 | Functional but dense; tab strip crowded at medium widths |
| Hierarchy | 6 | Many equal-weight icon buttons |
| Usability | 7 | Capabilities discoverable; vertical tab mode helps |
| Motion/interaction | 7 | Tab animations present; window controls are distinctive |

**Top 3 improvements**
1. Consolidate toolbar icon sizing and hit targets
2. Clarify sleeping vs active tab visual language
3. Address bar focus state should be unmistakable (known fix branch existed)

---

### Agent sidebar / composer

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 7 | Readable conversation; composer pinned well |
| Hierarchy | 7 | Model selector + send cluster clear |
| Usability | 8 | Persistent agent is the right product bet |
| Motion/interaction | 6 | Rail collapse smooth; inline approvals need focus choreography |

**Top 3 improvements**
1. Empty vs active session states need stronger visual differentiation
2. Task settings disclosure competes with model selector for attention
3. Streaming/tool activity needs calmer progress grammar (less flicker)

---

### Command center (Capabilities)

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 7 | Grouped list works; search field is plain |
| Hierarchy | 8 | Pinned vs grouped destinations clear |
| Usability | 9 | Primary power-user surface — keep investing here |
| Motion/interaction | 6 | Appears centered; could originate from ⌘K trigger |

**Top 3 improvements**
1. Anchor open/close to trigger with matched spatial path
2. Recent/frequent destinations when query empty
3. Compact viewport: ensure keyboard selection visibility

---

### Settings

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 6 | Continuous rows good; scope switcher adds cognitive load |
| Hierarchy | 6 | Nav label vs panel header vs eyebrow sometimes redundant |
| Usability | 7 | Comprehensive; deep sections (connections) are long |
| Motion/interaction | 5 | Mostly static; section changes abrupt |

**Top 3 improvements**
1. Resolve duplicate headings (nav item vs panel title vs eyebrow)
2. Browser vs Agent scope switcher — consider unified IA if possible
3. Collapse advanced sections with clearer progressive disclosure

---

### Life context (Calendar / People / Memory)

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 8 | Dense, ruled-plane aesthetic is distinctive and appropriate |
| Hierarchy | 8 | Provenance visible — product differentiator |
| Usability | 7 | Powerful; learning curve on confidence/source labels |
| Motion/interaction | 6 | Correctly calm; compact agenda reflow works |

**Top 3 improvements**
1. People view selected detail panel spacing
2. Memory search + “show influences” flow needs clearer step hierarchy
3. Disconnect/sync error states need visual design (not captured)

---

### Approvals

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 7 | Serious, readable |
| Hierarchy | 8 | Consequence-forward |
| Usability | 8 | Edit flow tested; inline + page duplication possible |
| Motion/interaction | 5 | State changes functional not fluid |

**Top 3 improvements**
1. Single visual language for inline vs queue approvals
2. Pending state badge on sidebar could be calmer (dot vs count)
3. Post-approve focus restoration (already tested in approvals suite)

---

### Work / kanban

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 6 | Functional columns; feels more “internal tool” than polished |
| Hierarchy | 6 | Many sub-views (goals, delegates, schedules) |
| Usability | 7 | Power users; empty state sparse |
| Motion/interaction | 5 | Card drag if present needs motion audit |

**Top 3 improvements**
1. Kanban column headers and card density normalization
2. Reduce nested cards in work sub-panels
3. Align with Life/Settings row grammar

---

### Specialist pages (Research, Artifacts, Activity, Extensions, Opportunities, Readiness)

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 5–6 | Inconsistent page headers and spacing vs core shell |
| Hierarchy | 5–6 | Some feel like separate mini-apps |
| Usability | 6–7 | Feature-rich; discoverability via Capabilities helps |
| Motion/interaction | 5 | Mostly static |

**Top 3 improvements (product-wide for this cluster)**
1. Shared `browser-app-page` layout template (title, eyebrow, content measure)
2. Unify empty states through `EmptyState` component
3. Reduce one-off CSS per page — route through tokens

---

### Projects workspace

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 6 | Clear structure; visually secondary to agent sidebar |
| Hierarchy | 7 | Project → chat tree logical |
| Usability | 7 | Sidebar duplication with Kestrel sidebar projects section |
| Motion/interaction | 5 | Static |

**Top 3 improvements**
1. Decide single home for project navigation (sidebar vs full page)
2. Visual connection between project color/icon and chat list
3. Empty projects state polish

---

### Writing studio

| Dimension | Score | Notes |
|---|---:|---|
| Visual quality | 6 | Dedicated CSS; not fully aligned with monochrome system |
| Hierarchy | 6 | Many modes/panels |
| Usability | 7 | Niche power feature |
| Motion/interaction | 5 | Needs dedicated motion pass |

**Top 3 improvements**
1. Token alignment with `styles.css`
2. Simplify mode switcher visual weight
3. Composer handoff to agent should feel continuous

---

## Preserve

- **Approval boundary UX** — explicit gates, edit-before-send, recovery paths
- **Persistent agent rail** — browser + agent co-presence is the product thesis
- **Command center** as primary launcher (not a hamburger maze)
- **Life context provenance model** — calendar/people/memory as one inspectable model
- **Monochrome discipline** (directionally) — no hue-as-status, shape + label encoding
- **Triangular window controls** with proximity motion — distinctive without cosplay
- **New tab honesty** — local data only, no fake dashboard metrics
- **Setup safety stage** — non-skippable boundaries with detail disclosures
- **Compact reflow** that recomposes (Life agenda, sidebar collapse) vs horizontal scroll
- **Reduced motion / transparency** handling (extend, don't remove)

---

## Remove

- **Redundant headings** (tab title = h1 = eyebrow repeating same string)
- **Legacy visual systems** still in CSS but dormant in UI (skin picker remnants in schema/CSS comments)
- **Hover-only meaning** anywhere it hides required actions
- **Excessive nested cards** on Readiness and some specialist pages
- **Capture script drift** (nonexistent Browser nav button) — fix to avoid false regression signal
- **Vibrancy without purpose** on panels that don't scroll beneath — adds Windows risk for little gain
- **Orphan settings components** not reachable in nav (`SkinSettings.tsx` etc.) — delete or wire, don't leave ghost UI

---

## Recompose

- **Settings IA** — scope switcher + 8 sections → clearer two-tier or unified list
- **Sidebar vs Projects page** — merge or differentiate roles sharply
- **Browser home widget shelf** — composer-dominant layout with widgets as secondary strip
- **Specialist pages** — shared page scaffold with consistent measure (760–880px reading width)
- **Agent empty states** — welcome, first task, and new task should be one coherent ladder
- **Toolbar** — group related actions; reduce always-visible icon count

---

## Platform-adapt

| Area | macOS | Windows |
|---|---|---|
| Window controls | Custom traffic lights (keep) | Native caption buttons or Fluent-adjacent minimal set |
| Font stack | SF Pro preferred | Segoe UI variable, Consolas for mono |
| Shortcuts | ⌘ labels | Ctrl labels in `KeyboardShortcutsModal` |
| Vibrancy | Optional blur on sidebar/chrome | Opaque surfaces default |
| Menu bar integration | Future: native menu roles | Standard window menu |
| Traffic light position | Left | Right (if custom) or native |

Core **content surfaces** (settings rows, Life, conversation, approvals) should remain cross-platform identical.

---

## Top 15 product-wide UI problems (by user impact)

| Rank | Problem | Impact |
|---:|---|---|
| 1 | **Inconsistent page scaffold** across specialist routes feels like separate apps | Daily disorientation |
| 2 | **Toolbar/tab density** at common widths — crowded, hard to scan | Every browsing session |
| 3 | **Settings heading redundancy** and long scroll in Connections | Setup friction |
| 4 | **Dual button systems** (`.button` vs `.ui-button`) — inconsistent treatments | Subtle untrustworthy feel |
| 5 | **Agent vs browser relationship** not always visually obvious | Core product confusion |
| 6 | **DESIGN.md vs live CSS token drift** — team builds against wrong spec | Implementation waste |
| 7 | **Empty/populated state gap** on many pages (captures show empty only) | First-use dead ends |
| 8 | **Compact composer hidden** but present — narrow window accessibility | Compact users |
| 9 | **Motion not interruptible** on some CSS-only transitions | Quality perception |
| 10 | **Model selector + task settings** compete in composer header | Every prompt |
| 11 | **Projects navigation duplicated** sidebar + page | IA clutter |
| 12 | **Life page class naming** (`legacy-product-surface`) signals unfinished consolidation | Maintainer confusion |
| 13 | **No toast/status system standard** — ephemeral feedback inconsistent | Error recovery |
| 14 | **Windows portability of vibrancy** not designed | Cross-platform ship risk |
| 15 | **Capture/test drift** from UI changes (Browser button) | Regression blindness |

---

## Suggested direction (concise, not implementation)

**“Quiet instrument, sharp hierarchy.”**

- One **graphite elevation ramp** and one **type scale** applied everywhere — retire page-specific one-offs
- **Composer and approval** remain the only elevated surfaces; everything else is matte continuous rows
- **Motion** only explains spatial or state change; 90–180ms default; springs for drags only
- **Navigation**: brand → browser, sidebar → agent/writing/approvals, ⌘K → everything else — document this triad
- **Windows**: same content, different chrome opacity and shortcuts — no feature fork
- **Distinctive Kestrel**: provenance-aware Life, approval-forward agent, browser-native home — not “AI app purple”

Do **not** pursue: glassmorphism default, macOS Settings clone, giant rounded cards, decorative dashboards, AI orb mascots.

---

## DESIGN.md rule classification (for implementation model)

### 1. Enduring product / safety / accessibility

- Approval gates and boundary acknowledgment never removed for aesthetics
- Focus visibility, semantic labels, keyboard paths
- No hue-only status encoding (accessibility)
- Provider/migration verification honesty in UI copy
- Reduced motion/transparency equivalence
- Local-data-only new tab widgets (no fabricated metrics)
- Life provenance hierarchy (confirmed vs inferred vs suggested)

### 2. Implementation constraints

- Electron + React renderer; tab-based `kestrel://` routing
- Single canonical app (`dev:desktop`); no duplicate bundles
- Encrypted DB / credential boundaries in setup copy
- Playwright capture privacy (no homedir leakage)
- 32px minimum compact control hit targets
- 11px minimum type size

### 3. Historical visual decisions (may be superseded)

- Exact monochrome hex values in DESIGN.md (`#0a0a0a` vs live `#0d0e11`)
- “No blur anywhere” vs current `--vibrancy-blur` in `styles.css`
- Fixed 360px agent rail (may flex by breakpoint)
- Native Graphite sage signal colors (superseded by monochrome section but remnants may exist)
- “Four destinations: Browser, Agent, Approvals, Settings” vs current sidebar items
- Browser Home “exactly three suggestion rows” — verify against widget shelf evolution
- New Tab widget shelf section vs older “no widget wall” language — reconcile intentionally

### 4. Contradictory or obsolete guidance

- DESIGN.md **Monochrome** says “no blur” but **Native Graphite historical** allows blur on nav/chrome; live CSS implements vibrancy
- **Monochrome** says white sole accent; **Life Context** section describes sage/aluminum/amber edges for calendar events
- **Desktop stability pass** says “preserve geometry” vs **audit goal** of substantial layout refinement
- **capture-desktop** Browser sidebar button vs actual brand-button navigation
- Skin picker “removed from renderer” but `SkinSettings.tsx` still exists in tree

**Implementation model is explicitly allowed to supersede category 3–4 after deliberate DESIGN.md revision.**
