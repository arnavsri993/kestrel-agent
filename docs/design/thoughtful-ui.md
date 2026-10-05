# Kestrel control details

## Product and system lock

This is a focused redesign of a frequently used macOS workspace, built with React
and Electron. The primary job is to browse and ask the agent to do useful work.
The existing browser, chat, settings, profile and approval behavior remain the
foundation. The automatic frontend classifier suggested a marketing composition;
the verified desktop product instead requires a dense application layout.

Design thesis: give Kestrel the composure of a native work tool by making the
composer the focal surface, navigation quieter, and every control's state precise.

- Density: dense application, with readable 14–16px controls and compact utility rows.
- Type: existing SF Pro Display and SF Pro Text stacks; no downloaded fonts.
- Rhythm: existing 4px spacing scale; 8–12px inside controls, 16px between groups.
- Color: existing graphite surfaces and aluminum text, with a solid primary action.
- Material: preserve local wallpaper and the existing glass system; remove redundant
  boxed icon treatments rather than adding more layers.
- Geometry: 12px control corners, circular icon actions, existing composer geometry.
- Motion: only existing state and press feedback; no focal animation or dependency.
- Avoid: uniform heavy panels, ornamental badges, floating controls, unlabelled
  loading indicators, multiple focus frames, and font or branding replacements.

Why this is not generic: Kestrel's browser chrome and agent composer share a
quiet control vocabulary, while its local workspace and wallpaper remain visible.

## Component contracts and acceptance

Buttons retain their text and footprint while busy, expose aria-busy, and prevent
duplicate submission. Native disabled buttons retain a distinct muted state.
Keyboard focus is visible without requiring hover. Icon buttons remain square.
Navigation selection uses weight, a surface and an inset edge as well as color.
Widgets group their title and content without putting every icon in another box.
Address suggestions expose one listbox controlled by the combobox, with matching
active-descendant IDs. Existing keyboard selection and Escape behavior are retained.

Desktop, compact windows and 200% zoom must retain operable controls and no horizontal
Home overflow. Reduced motion disables added feedback transitions. High contrast,
forced colors and reduced transparency preserve readable boundaries. Existing
loading, empty, error, permission and approval copy stays truthful.

## Verification and refinement

Use isolated profiles for matching before/after Home, menu and focus captures.
Inspect the three main weaknesses: oversized icon treatments, weak navigation/action
hierarchy, and inconsistent focus/loading feedback. Validate types, the button
state contract, browser keyboard interactions, compact layout and packaged smoke.
Then integrate this focused change with the previously installed development
candidate, reinstall /Applications/Kestrel.app, compare provenance/artifact hashes,
and exercise the visible controls in the preserved user profile.

Evidence stays in ignored .tmp directories; screenshots of the real profile are
never committed. Local verification does not establish remote CI or release readiness.

The screenshot refinement reduced nested icon boxes, clarified rail/action hierarchy,
and made short widget lists content-sized. Source desktop typechecking/build, 32
focused unit tests, UI-details keyboard/focus/loading geometry, narrow/200% reflow,
reduced-motion capture and Settings persistence checks passed. The source comparison
captures are in .tmp/ui-details-before and .tmp/ui-details-after.
