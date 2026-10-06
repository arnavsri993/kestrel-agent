# Kestrel control details

## Workspace composition refinement

The second pass treats the whole page as a working surface. A 28px page title,
13px purpose line, shared 32px top inset and bounded page measure replace the
competing title sizes and very long settings rows. Settings uses a compact
section rail, a bounded search field and one inset preference group per panel;
control rows reflow using the pane's actual width, including alongside chat.
Communication style explains the current choice and normal login copy describes
the user's action rather than exposing a system enum.

Memory separates note selection from the document surface and aligns its header
and tab strip to the same inset. Projects has a sized, centered empty state with
a clear folder action instead of a full-width dashed placeholder. Connections
uses expandable app rows. Home's greeting and sidebar typography recede from
the composer; an empty chat now has visible, accessible orientation text.

Verify default and narrow settings, nested configuration panels, note reading
and editing, populated and empty project views, Home at 200% zoom, and live
canonical delivery. Existing synthetic profiles remain separate from user data.

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
- Geometry: fully rounded single-line fields/actions and segmented choices; exact
  square dimensions for circular icon actions; 22px reading/editor surfaces and
  18px menus. Each role uses one shared geometry contract.
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

The full-app finish pass covers Browser/Home, Agent, Memory, Connections, Projects,
Writing Studio, libraries, Settings, onboarding, dialogs and error/empty surfaces.
The address field must be a true pill. Communication style has one pill-shaped
track with inset choices and no inherited button dividers. Toolbar icon actions
must be square circles with optically centered glyphs in selected and idle states.

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

The app-wide review used 174 synthetic desktop/compact surface states, covering
all internal pages, Settings sections, libraries, dialogs and toolbar menus.
It confirmed three remaining system defects: inherited corners/dividers in
segmented controls, mismatched toolbar circle dimensions, and a text Page options
row inheriting an icon aspect ratio. The shared finish layer fixes these and
extends the field/action shape contract to setup, Memory and Settings. Memory
now uses the existing semantic graphite/aluminum tokens; inactive toggles no
longer use an error color. Narrow layouts, native keyboard selection and focus
remain part of the acceptance tests. Reading-width limits remain intentional.

Geometry regression assertions cover address/search capsules, square toolbar
circles, compact Page options rows and divider-free segmented choices. The
production dependency audit also required the source-map-js 1.2.2 maintainer
patch (GHSA-68fv-2mgg-jv7q); the override and lockfile now resolve that patch.
