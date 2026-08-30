# Reference Analysis — UI Audit Inputs

**Audit date:** 2026-08-30  
Sources studied for **principles**, not visual copying.

---

## 1. Apple Design skill (`emilkowalski/skills` → `apple-design`)

### Relevant principles

| Principle | Summary | Kestrel relevance |
|---|---|---|
| Response | Feedback on pointer-down; no artificial latency on input path | Agent composer, tab strip, window controls already aim at this; audit hover-only patterns |
| Direct manipulation | 1:1 tracking, respect grab offset, pointer capture | Tab drag, organize-tabs preview, sheet-like dialogs if added |
| Interruptibility | Animate from presentation value; never lock input mid-transition | Agent rail width transition, command center, modals — prefer spring/Motion over blocking CSS keyframes |
| Springs | Damping ~1.0 default; bounce only after momentum gestures | Window control tilt is focal; don't add bounce to static fades |
| Velocity handoff | Release velocity continues into animation | Bottom sheets, swipe-dismiss panels (if introduced) |
| Spatial consistency | Enter/exit same path; originate from trigger | Command center, model selector popover, keyboard shortcuts modal |
| Rubber-banding | Soft resistance at edges | Scroll regions, drawer limits |
| Materials | Translucent layers over content; heavier blur on larger surfaces | **Tension with DESIGN.md monochrome “no blur” lock** — see HANDOFF classification |
| Typography | Size-specific tracking/leading; hierarchy via weight+size+leading | Kestrel has token scale but inconsistent application across specialist pages |
| Reduced motion/transparency/contrast | Equivalence, not removal of meaning | Already partially implemented; extend to all new motion |
| Design foundations | Purpose, agency, responsibility, familiarity, flexibility, simplicity, craft, delight | Maps to Kestrel’s approval boundary and “quiet instrument” positioning |

### Appropriate for Kestrel

- Short, interruptible state transitions (140–220ms) with opacity/transform only
- Pointer-proximity feedback on window controls (already distinctive)
- Popovers/menus anchored to triggers with matched enter/exit paths
- Dense operational UI with calm motion (no demo-reel)
- Platform-adaptive chrome while keeping content cross-platform
- Typography hierarchy tuned per size band, not one `letter-spacing` globally

### Inappropriate for Kestrel

- Default glassmorphism everywhere (conflicts with product honesty and Windows portability)
- iOS-style sheets as the primary pattern for desktop settings/history
- Bouncy springs on non-gesture UI (menus, settings rows)
- Haptic/sound feedback (not in Electron desktop scope today)
- Literal macOS Settings clone (sidebar + grouped panels is fine; costume is not)

### Implementation implications

- Keep `motion/react` for gesture-capable surfaces; audit CSS `@keyframes` for non-interruptible paths
- Consolidate motion tokens (`motion.css` vs `styles.css` `--motion-*`) into one system
- Add `prefers-reduced-transparency` opaque fallbacks wherever `--vibrancy-*` is used
- Document spring presets for any new drag surfaces (organize tabs, future panels)

### Cross-platform

- `-apple-system` stack is fine as first font in stack with Windows fallbacks
- Material/blur: optional on macOS, opaque on Windows unless performance-tested
- Meta vs Ctrl shortcuts must be documented per platform in `KeyboardShortcutsModal`

---

## 2. Sonner (`emilkowalski/sonner`)

### Relevant principles

- Toasts as **lightweight, non-blocking status** with stack management and swipe-to-dismiss
- Limit concurrent notifications; avoid toast spam during agent tool bursts
- Action button in toast for undo/recovery (agency)
- Position and animation should not obscure approval/composer focal regions

### Appropriate for Kestrel

- Ephemeral success/error for save, copy, backup complete — **if** current inline patterns are insufficient
- Swipe/dismiss and pause-on-hover for long messages
- Stack from edge that doesn't conflict with agent rail (likely top-left or bottom-left away from composer)

### Inappropriate for Kestrel

- Adding Sonner as dependency merely for aesthetics
- Replacing approval surfaces or `ConfigurationMessage` with toasts
- Toast-only error reporting for consequential failures (needs persistent recovery UI)

### Implementation implications

- Kestrel already has `kestrel-toast-in` keyframes in `motion.css` — extend/refine before new dependency
- Any toast system must respect reduced motion and not block approvals

### Cross-platform

- Sonner is web/React — works in Electron renderer on both platforms
- Dismiss gestures: pointer-first; keyboard dismiss required

---

## 3. Vaul (`emilkowalski/vaul`) — reference only, unmaintained

### Relevant principles

- Bottom/side **drawer** with drag-to-close, velocity projection, rubber-band
- Snap points and nested sheets
- Focus trap and scroll locking patterns

### Appropriate for Kestrel

- **Interaction reference** for future mobile-like panels (e.g., compact command palette, optional inspector)
- Velocity projection math for any swipe-dismiss overlay

### Inappropriate for Kestrel

- Production dependency (unmaintained)
- Primary navigation pattern on desktop
- Replacing existing full-page `kestrel://` tabs with drawers

### Implementation implications

- If drawer patterns are needed, implement with `motion/react` + Pointer Events using Vaul’s behavioral spec, not the package
- Desktop: prefer side panels anchored to triggers over bottom sheets

### Cross-platform

- Bottom sheets feel foreign on Windows desktop — use sparingly, compact-only

---

## 4. Frontend Taste Engineer (`arnavsri993/frontend-taste-engineer`)

### Relevant methodology

| Method | Application to Kestrel audit |
|---|---|
| Existing-product redesign mode | This audit — preserve IPC, approvals, routes; refine don't replace |
| Visual audit + screenshot verification | `capture-ui-audit.ts` + 94 baseline shots |
| State matrices | `SURFACE_MATRIX.md` + conversation/runtime states |
| Motion refinement pass | Separate from theme pass; evaluate interruptibility |
| Design-system analysis | `IMPLEMENTATION_MAP.md` token/component map |
| Intentional minimalism | Sparse only where one decision is focal (setup, empty, approval) |
| Candidate direction comparison | Deferred to implementation model; audit supplies evidence |
| Accessibility remediation | Focus, reduced motion, compact reflow gaps flagged |
| Three highest-impact fixes | Per-surface in `CURSOR_UI_REVIEW.md` |

### Appropriate for Kestrel

- Classify task as `existing-redesign` not greenfield marketing site
- Lock `DESIGN.md` updates only after candidate comparison (implementation phase)
- Synthetic capture data (no personal paths) — already in capture scripts
- Production build + packaged smoke as verification gate for visual changes

### Inappropriate for Kestrel

- Autonomous zero-brief “make a website” flow
- Purple gradients, hero cards, bento dashboards (explicitly rejected in product brief)
- Treating classifier output as authoritative over repository reality

### Implementation implications

- Next model should read `HANDOFF.md` → screenshots → `IMPLEMENTATION_MAP.md` before editing
- Run `pnpm capture:ui-audit` after visual changes for regression comparison
- Separate **safety/approval** constraints from **visual** constraints in DESIGN.md (see HANDOFF)

### Cross-platform

- FTE responsive methodology applies to compact reflow (640px) already captured
- Windows verification needs explicit pass in implementation phase (not done in this audit)

---

## Summary: what to steal vs what to avoid

| Steal (behavior) | Avoid (appearance) |
|---|---|
| Interruptible, short transitions | macOS Settings cosplay |
| Trigger-anchored popovers | Glass everywhere |
| Typography scale discipline | Generic AI dashboard tropes |
| Toast/stack discipline for ephemeral status | Decorative metrics widgets |
| Velocity-aware drag where users drag | Unmaintained dependencies (Vaul) |
| Reduced-motion equivalence | Hue-only status encoding |
| Spatial continuity browser ↔ agent | Separate products feeling per tab |
