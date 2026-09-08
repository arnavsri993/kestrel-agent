# Instrument Workbench release QA

## Evidence

- **Visual regression pass:** 94 isolated Electron captures at wide, normal, and
  compact widths: `/tmp/kestrel-ui-audit-redesign-20260830-pass4`.
  The representative contact sheet is
  `/tmp/kestrel-ui-audit-redesign-20260830-pass4-contact.png`.
- **Product build:** the desktop renderer and package build use the same
  workbench CSS and Motion contract. The installed development app is the one
  canonical `/Applications/Kestrel.app` bundle.
- **Automated behavior:** `test:desktop-layout`, `test:desktop-browser`, setup,
  personas, workflow reuse, model routing, chat configuration, restart recovery,
  approvals, observability, and the full `pnpm verify` suite exercise the
  interactions below in isolated Electron profiles.

## Interaction and motion audit

| Interaction family | Evidence and acceptance boundary |
| --- | --- |
| Button press/release, loading → success/error | Shared control feedback is short and non-blocking; approvals, setup, chat configuration, and readiness smoke cover focus, recovery, and returned state. |
| Tabs, create/close/reorder, New Tab, drag/reorder | Browser smoke covers independent tabs, rapid lifecycle state, keyboard layouts, horizontal/vertical rails, drag/reorder, and native view routing. Crowded horizontal tabs retain 112px readable targets in a bounded scroll rail. |
| Agent rail expand/collapse/resize | Desktop layout smoke checks current-value resizing, interruption, projected release velocity, viewport clamping, compact dock, and 200% zoom. The spring contract is near critically damped. |
| Menus, popovers, dropdowns, command center | Browser smoke covers tab tools, toolbar menus, omnibox suggestions, and focus/Escape paths. While a renderer overlay is visibly exiting, the native `WebContentsView` remains hidden instead of cutting through it. Command Center and selectors are represented in the UI capture and persona routes. |
| Dialogs, approvals, disclosures, panels | Approval smoke checks initial focus, successful restoration, failure recovery, and rejected promises. Organize Tabs and keyboard-shortcut dialog paths use presence-aware exits. |
| Navigation, Settings, providers/models | Persona, setup, model-routing, workflow-reuse, readiness, observability, and managed-policy smoke cover both settings scopes, compact selection, provider/model controls, and rapid route changes. |
| Compact layouts and reduced motion | Layout/persona smoke and the compact reduced-motion capture check readable recomposition, visible focus, no long-running travel, and useful state feedback. |

## Motion contract

1. Feedback begins on pointer-down where direct feedback makes sense; it does
   not claim an action until semantic activation.
2. State changes commit independently of the visual transition. Reversible
   paths use `AnimatePresence` / Motion state from the live rendered value, so
   a later interaction can interrupt instead of waiting.
3. Menus and popovers scale from their trigger; enter and exit share the same
   spatial path. Native browser pages defer reattachment until the renderer exit
   is complete.
4. Springs are reserved for direct manipulation. `KESTREL_CRITICAL_SPRING` is
   tested near a damping ratio of 1, has no ornamental overshoot, and preserves
   release velocity for the resizable agent rail.
5. Layout is not animated by generic CSS transitions. Transform/opacity owns
   transient motion; compact recomposition has a testable layout boundary.
6. `prefers-reduced-motion` removes travel/scale/tilt while preserving an
   immediate visible state and keyboard/focus continuity.

## Release observations

The final pass specifically caught and fixed two visual regressions before
release: plugin supply-chain actions no longer crush explanatory copy in a
narrow column, and crowded tabs no longer collapse to favicon slivers. The
browser smoke also guards the native-view/renderer-overlay seam through exit,
which screenshots alone cannot prove.
