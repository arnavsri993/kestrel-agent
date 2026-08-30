# UI Audit Handoff

**For:** Frontier implementation / design specialist models  
**From:** Reconnaissance audit (2026-08-30)  
**Repo:** `arnavsri993/kestrel-agent`  
**Branch audited:** `main` @ `2a100086` (includes merged PR #673)  
**Audit branch:** `codex/ui-audit-reconnaissance`

---

## What this package is

A **read-only** inventory of Kestrel's current desktop UI: surfaces, screenshots, code map, reference principles, and advisory opinions. **No redesign was implemented.**

```
artifacts/ui-audit/
├── baseline/
│   ├── wide/      # 1440×900
│   ├── normal/    # 1280×800
│   └── compact/   # 640×760
├── capture-manifest.json   # machine-readable shot index (94 images)
├── SURFACE_MATRIX.md       # every surface, route, file, states, gaps
├── IMPLEMENTATION_MAP.md   # tokens/components → files, blast radius
├── REFERENCE_NOTES.md      # Apple Design / Sonner / Vaul / FTE principles
├── CURSOR_UI_REVIEW.md     # scores, preserve/remove/recompose, top 15 issues
└── HANDOFF.md              # this file
```

**Regenerate screenshots:** `pnpm capture:ui-audit` (requires `pnpm --filter @kestrel/desktop build` first)

---

## Product in one paragraph

Kestrel is an Electron desktop app (macOS primary, Windows secondary) combining a **real browser**, a **persistent agent sidebar**, and **specialist tools** (Life, Work, Settings, etc.) opened as `kestrel://` browser tabs. Setup is a 5-stage onboarding gate. The product loop is *ask → scope → act → approve when consequential → verify*. Visual direction today is **dark graphite monochrome** with matte surfaces, though DESIGN.md and live CSS diverge in places.

---

## Architecture essentials

| Layer | Location | Notes |
|---|---|---|
| Main process | `apps/desktop/src/main/` | Window, overlays (calc/password/payment), IPC |
| Renderer shell | `apps/desktop/src/renderer/App.tsx` | Setup, workspace, settings, inline pages, conversation |
| Routing | `utility/browser-app-pages.ts` | `kestrel://{id}` tab pages |
| Browser | `components/browser/BrowserWorkspace.tsx` | Web + new tab + app pages in tabs |
| Agent | `components/browser/AgentSidebar.tsx` | Always-mounted conversation |
| Nav | `components/browser/KestrelSidebar.tsx` | Primary sidebar |
| Tokens | `renderer/styles.css` `:root` | **Live source of truth** (not DESIGN.md hex) |
| Motion | `motion.css` + `motion/react` | CSS + React animation split |

---

## How to read the screenshots

1. Start with `baseline/normal/workspace-new-tab.png` — default workspace
2. Compare `wide/` vs `compact/` for the same filename — reflow behavior
3. Setup flow: `baseline/normal/setup-01-welcome.png` → `setup-05-ready.png` (8 shots)
4. Settings: `settings-*.png` in each viewport folder (8 sections × 3 viewports)
5. Life: `surface-life-calendar.png`, `surface-life-people.png`, `surface-life-memory.png`
6. Interaction extras: `modal-keyboard-shortcuts.png`, `workspace-model-selector-open.png`, `workspace-task-settings-open.png`
7. A11y: `compact/compact-reduced-motion.png`, `compact-reduced-transparency.png`

**Not captured:** web pages, file tabs, overlay windows, streaming agent, pending approvals (fixture exists in tests), error/loading shells, organize-tabs dialog.

---

## DESIGN.md — how to treat it

Read `DESIGN.md` but **do not treat all visual locks as binding**. Classification in `CURSOR_UI_REVIEW.md`:

- **Keep:** approval safety, accessibility, provenance honesty, reduced motion, no fake metrics
- **Supersede allowed:** exact hex values, blur prohibition vs live vibrancy, sage Life colors vs monochrome, rigid geometry preservation, outdated nav item list

Update `DESIGN.md` in the implementation phase after direction lock.

---

## Reference principles (don't copy appearance)

| Source | Take | Skip |
|---|---|---|
| Apple Design skill | Interruptible motion, pointer-down feedback, spatial consistency, type optical sizing | Glass everywhere, iOS sheets on desktop |
| Sonner | Ephemeral status discipline | New dependency without need |
| Vaul | Drawer physics reference | Unmaintained package |
| Frontend Taste Engineer | Audit methodology, state matrices, screenshot verification | Greenfield marketing site patterns |

Full detail: `REFERENCE_NOTES.md`

---

## Highest-impact work (advisory ranking)

1. Unified **page scaffold** for all `kestrel://` app pages
2. **Toolbar/tab density** and address bar focus
3. **Settings IA** — reduce heading duplication and scope-switcher friction
4. Consolidate **`.button` + `.ui-button`**
5. Clarify **browser ↔ agent** spatial relationship in layout
6. Reconcile **DESIGN.md ↔ styles.css** tokens
7. **Windows** opaque chrome + Ctrl shortcuts
8. **Motion pass** — interruptibility, trigger-anchored popovers

Full scores and preserve/remove lists: `CURSOR_UI_REVIEW.md`

---

## Code edit order (suggested)

See `IMPLEMENTATION_MAP.md` — tokens → ui primitives → shell → browser chrome → composer → specialist pages → motion → platform chrome.

**High blast radius files:** `styles.css`, `App.tsx`, `browser.css`, `kestrel-sidebar.css`, `agent-panel-layout.css`

---

## Tests & capture to run after changes

```bash
corepack pnpm --filter @kestrel/desktop build
corepack pnpm capture:ui-audit
corepack pnpm test:desktop-layout
corepack pnpm test:desktop-setup
corepack pnpm test:desktop-life-context
corepack pnpm test:desktop-approvals
```

Fix `scripts/capture-desktop.ts` Browser nav (use brand button) when touching capture infra.

---

## Distinctive character to protect

- Provenance-visible **Life** model (time/people/memory)
- **Approval-forward** agent with real edit/reject/recover
- **Browser-native** home (not a dashboard)
- **Command center** power-user launcher
- **Quiet monochrome instrument** — not generic AI styling

---

## Open PR / sync note

PR #673 (`codex/workflow-skill-review-handoff`) was **merged** to `main` before this audit. Local audit work is on `codex/ui-audit-reconnaissance` branched from updated `main`.

---

## What the next model should do

1. Read this file + skim `SURFACE_MATRIX.md`
2. Review screenshots in `baseline/` (wide/normal/compact)
3. Read `IMPLEMENTATION_MAP.md` before any edit
4. Propose **2–3 design directions** (FTE methodology) — do not implement yet unless asked
5. Revise `DESIGN.md` to match chosen direction
6. Implement in scoped PRs with `capture:ui-audit` diff evidence

**Do not:** delete approvals, add purple gradients, glass-by-default, macOS Settings cosplay, or Vaul dependency.
