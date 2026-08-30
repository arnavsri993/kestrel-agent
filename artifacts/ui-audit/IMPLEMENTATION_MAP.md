# Implementation Map — Visual Systems to Code

**Audit date:** 2026-08-30  
Purpose: show which files own which visual systems so a refinement pass propagates intentionally.

---

## Architecture overview

```
apps/desktop/src/
├── main/           # Electron main process (window chrome, overlays, IPC)
├── preload/        # Bridge APIs
├── utility/        # Shared routing (browser-app-pages.ts)
└── renderer/
    ├── App.tsx              # Shell, setup, settings, inline pages, conversation
    ├── styles.css           # Primary design tokens + most component styles
    ├── browser.css          # Browser chrome
    ├── motion.css           # CSS motion layer
    ├── life-context.css     # Life page
    ├── agent-panel-layout.css
    ├── surface-responsive.css
    └── components/
        ├── ui/              # Shared primitives
        ├── browser/         # Browser + navigation + new tab
        └── [feature].tsx    # Specialist surfaces
```

---

## System map

### Shell & window

| System | Primary files | Notes |
|---|---|---|
| App shell layout | `App.tsx`, `agent-panel-layout.css` | `.ai-browser-app`, agent rail 360px, density classes |
| Window controls | `WindowControls.tsx`, `window-controls.css`, `window-controls-motion.ts` | Triangular traffic lights; pointer proximity motion |
| Startup states | `App.tsx`, `startup-state.ts` | Loading, error, onboarding gate |
| Platform chrome | `main/index.ts` | Frameless/titlebar config; Windows diverges here |

**High blast radius:** `App.tsx` layout classes, `agent-panel-layout.css`

---

### Navigation

| System | Primary files | Notes |
|---|---|---|
| Kestrel sidebar | `KestrelSidebar.tsx`, `kestrel-sidebar.css` | Primary nav, projects, recent tasks |
| Agent sidebar | `AgentSidebar.tsx`, `agent-panel-layout.css` | Persistent conversation host |
| Sidebar state | `agent-sidebar.ts` | Destination enum, review targets |
| Tab strip | `TabStrip.tsx`, `tab-strip-layout.ts`, `browser.css` | Horizontal/vertical modes |
| Command center | `CommandCenter.tsx`, `styles.css` (.command-center) | ⌘K launcher |
| Deep links | `deep-link-route.ts`, `renderer-link-routing.ts` | `kestrel://` routing |
| App page registry | `utility/browser-app-pages.ts` | Canonical page IDs |

**High blast radius:** `kestrel-sidebar.css`, `browser.css` tab styles, `CommandCenter` markup

---

### Design tokens

| Token category | File | Variables |
|---|---|---|
| Surfaces | `styles.css` `:root` | `--canvas`, `--sidebar`, `--panel`, `--surface`, `--overlay` |
| Ink | `styles.css` | `--ink`, `--ink-secondary`, `--muted`, `--faint` |
| Lines | `styles.css` | `--line`, `--line-strong`, `--selected-soft` |
| Actions | `styles.css` | `--solid`, `--solid-hover`, `--on-solid` |
| Type | `styles.css` | `--display`, `--sans`, `--mono` |
| Space | `styles.css` | `--space-*` (4px base) |
| Radius | `styles.css` | `--radius-xs` … `--radius-pill` |
| Shadow | `styles.css` | `--shadow-xs` … `--shadow-lg` |
| Motion (CSS) | `styles.css`, `motion.css` | `--motion-feedback`, `--motion-state`, `--motion-smooth`, `--ease-*` |
| Vibrancy | `styles.css` | `--vibrancy-sidebar`, `--vibrancy-chrome`, `--vibrancy-blur` |
| Focus | `styles.css` | `--focus-ring` |

**Note:** DESIGN.md documents different hex values than live `styles.css` — implementation is source of truth until redesign locks new tokens.

**High blast radius:** `styles.css` `:root` block (entire product recolors)

---

### Typography

| Role | CSS classes / patterns | Files |
|---|---|---|
| Setup display | `.setup-stage h1`, display scale | `styles.css`, `App.tsx` Onboarding |
| Page titles | `.page-header h1`, `.browser-app-page h1` | `styles.css`, per-page |
| Section | `.settings-panel-header h2`, eyebrows | `styles.css` |
| Body / control | `.button`, `.ui-button`, form copy | `styles.css`, `ui.css` |
| Metadata / mono | `.eyebrow`, evidence lines | `styles.css`, `runtime-evidence.ts` |
| Life-specific scale | Calendar time, provenance | `life-context.css` |

**High blast radius:** `styles.css` type scale block; `life-context.css` for Life only

---

### Buttons

| Variant | Implementation | Files |
|---|---|---|
| Legacy `.button` | primary/secondary/quiet/destructive | `styles.css` |
| UI `.ui-button` | `Button` component variants | `components/ui/index.tsx`, `ui.css` |
| Icon buttons | `.ui-button-icon`, toolbar buttons | `browser.css`, `ui.css` |
| Sidebar nav | `.kestrel-sidebar-nav-item` | `kestrel-sidebar.css` |

**Consolidation opportunity:** two button systems (`.button` vs `.ui-button`) — changing both needed for consistency

---

### Inputs

| Type | Files |
|---|---|
| Text inputs | `ui/Input`, `.ui-input`, setup fields |
| Textarea / composer | `#runtime-prompt`, `.ui-textarea`, `AgentSidebar` |
| Selects / toggles | Settings rows, `BrowserSettings.tsx` |
| Search | Command center, library search, address bar |

**Files:** `ui.css`, `styles.css`, `browser.css` (address bar)

---

### Rows, cards, lists

| Pattern | Files |
|---|---|
| `ui/Row` | `components/ui/index.tsx`, `ui.css` |
| `ui/Card` | `ui.css` |
| Settings rows | `.settings-row`, continuous list | `styles.css` |
| Library lists | `BrowserLibrary.tsx` | `styles.css` |
| Life rows | `LifeContext.tsx` | `life-context.css` |
| Empty states | `ui/EmptyState` | `ui.css` |

---

### Menus, popovers, dialogs

| Surface | Files |
|---|---|
| Command center | `CommandCenter.tsx` |
| Model selector | `ModelSelector.tsx`, `model-selector.css` |
| Mention picker | `ComposerMentionPicker.tsx` |
| History popover | `BrowserHistoryPopover.tsx` |
| Organize tabs | `OrganizeTabsDialog.tsx` |
| Keyboard shortcuts | `KeyboardShortcutsModal.tsx` |
| Default browser | `DefaultBrowserPrompt.tsx` |
| Browser toolbar menus | `BrowserToolbar.tsx` |

**Motion:** `motion.css` (dialog/toast keyframes), `motion/react` in dialogs using AnimatePresence

---

### Tabs

| Layer | Files |
|---|---|
| Browser tabs | `TabStrip.tsx`, `browser.css`, `tab-strip-layout.ts` |
| Life view switch | `LifeContext.tsx`, `life-context.css` |
| Settings scope | `.settings-scope-switcher` in `App.tsx` |
| Settings section nav | `.settings-nav` |

---

### Toasts / ephemeral feedback

| Mechanism | Files |
|---|---|
| CSS toast animation | `motion.css` `@keyframes kestrel-toast-in` |
| Inline status | `ui/Status`, conversation status chips |
| Action receipts | `ActionReceiptList.tsx` |

No Sonner dependency today.

---

### Agent composer

| Piece | Files |
|---|---|
| Prompt textarea | `AgentSidebar.tsx`, `#runtime-prompt` |
| Model selector | `ModelSelector.tsx` |
| Mentions | `ComposerMentionPicker.tsx`, `composer-mentions.ts` |
| Task settings disclosure | `App.tsx` RuntimeConversation |
| Config messages | `ConfigurationMessage.tsx` |
| Memory recall UI | `MemoryRecallStatus.tsx`, `MemoryRecallReceiptLine.tsx` |

**High blast radius:** `agent-panel-layout.css`, composer block in `styles.css`

---

### Browser / new tab

| Piece | Files |
|---|---|
| Workspace | `BrowserWorkspace.tsx` |
| Toolbar | `BrowserToolbar.tsx` |
| New tab page | `NewTabPage.tsx`, `new-tab.css` |
| Widgets | `NewTabWidgets.tsx`, `new-tab-widgets.css`, `new-tab-widgets.ts` |
| Bookmarks bar | `BookmarksBar.tsx`, `bookmarks-bar.css` |
| Address suggestions | `address-bar-suggestions.ts` |

---

### Settings

| Piece | Files |
|---|---|
| Shell | `App.tsx` Settings function |
| Browser prefs | `BrowserSettings.tsx` |
| Passwords/payments | `PasswordSettings.tsx`, `PaymentSettings.tsx` |
| External secrets | `ExternalSecretSettings.tsx` |
| Observability | `ObservabilitySettings.tsx` |
| Usage policy | `UsagePolicySettings.tsx` |
| Honcho memory | `HonchoMemorySettings.tsx` |

---

### Setup / onboarding

| Piece | Files |
|---|---|
| Flow | `App.tsx` Onboarding |
| Completion rules | `setup-onboarding.ts` |
| Styles | `styles.css` (.onboarding-*, .setup-*) |

---

### Approvals & safety

| Piece | Files |
|---|---|
| Queue page | `RuntimeApprovalQueue.tsx` |
| Inline card | `ApprovalCard.tsx` |
| Evidence copy | `runtime-evidence.ts` |

**Constraint:** approval UI changes are high-risk; preserve semantic structure

---

### Life surfaces

| Piece | Files |
|---|---|
| Combined page | `LifeContext.tsx` |
| Styles | `life-context.css` |
| Dreaming | `DreamingPanel.tsx` |

---

### Work / kanban

| Piece | Files |
|---|---|
| Kanban | `GoalKanban.tsx` |
| Work page | `App.tsx` Work |

---

### Motion system (dual layer)

| Layer | Files | Used for |
|---|---|---|
| CSS transitions | `motion.css` | Rail width, button hover, route fades |
| Motion library | `motion/react` in `App.tsx`, components | Setup AnimatePresence, layout animations |
| Window control motion | `window-controls-motion.ts` | Pointer tracking |

**Consolidation opportunity:** align `--motion-*` tokens across `styles.css` and `motion.css`

---

## Shared components — modification propagation

| Component / file | Estimated surface count | Risk |
|---|---|---|
| `styles.css` `:root` | 100% renderer | High |
| `components/ui/*` | 40+ surfaces | Medium-high |
| `.button` / `.ui-button` | 50+ | Medium |
| `kestrel-sidebar.css` | All workspace views | Medium |
| `browser.css` | Browser chrome + tabs | Medium |
| `agent-panel-layout.css` | All workspace views | Medium |
| `Icon.tsx` | Everywhere | Low-medium |
| `EmptyState` | 15+ empty paths | Low |

---

## Test & capture infrastructure

| Script | Purpose |
|---|---|
| `scripts/capture-desktop.ts` | Original deterministic capture (needs Browser nav fix) |
| `scripts/capture-ui-audit.ts` | **This audit** — 3 viewports, 94 shots |
| `scripts/ui-audit-helpers.mjs` | Life context seed fixture |
| `scripts/desktop-browser-test-helpers.mjs` | Command center navigation |
| `scripts/test-desktop-*.mjs` | Per-surface behavioral tests |

**Package scripts:** `pnpm capture:ui-audit`, `pnpm capture:desktop`

---

## Recommended edit order for implementation model

1. **Tokens** — `styles.css` `:root` (single source of truth; update DESIGN.md after)
2. **Primitives** — `ui.css` + `components/ui`
3. **Shell layout** — `agent-panel-layout.css`, `kestrel-sidebar.css`
4. **Browser chrome** — `browser.css`, `BrowserToolbar.tsx`
5. **Composer** — agent sidebar styles + `ModelSelector`
6. **Specialist pages** — `life-context.css`, inline pages in `App.tsx`
7. **Motion pass** — `motion.css` + Motion presets
8. **Platform** — `WindowControls`, main process frame on Windows
