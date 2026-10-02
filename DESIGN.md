# System UI consistency audit — September 16, 2026

Existing React/Electron product audit, across browser chrome, New Tab, sidebar,
Memory, Connections, Agent, settings, libraries, work and utility destinations.
Thesis: one compact graphite work environment with predictable control geometry,
readable content, even surface boundaries and no collisions between controls.
Keep system typography, the 4px spacing rhythm, existing colors and restrained
state/feedback motion. No new dependencies, decorative animation or marketing UI.

- Find is a compact upper-right popover (maximum 360 by 48px), not a row.
  Use a real native child overlay so the live page never moves, resizes or
  becomes a screenshot. Keep one input, count, previous/next and close.
  Test horizontal/vertical tabs, keyboard control and narrow windows.
- Center the compact composer line box vertically; retain expandable editing.
- Sidebar titles fade at the trailing edge without ellipses; retain full labels.
- Widgets have a single even border, without an extra top highlight.
- Field labels, inputs and navigation occupy separate layout rows; empty source
  selectors explain their state. Long titles and narrow pages must reflow.
- Audit with synthetic fixtures at 1440 and 760 pixels, plus 200% zoom and reduced
  motion. Log observed defects, corrections, tested surfaces and remaining limits.
- Why this is not generic: corrections preserve Kestrel's browser/content split,
  native page layering and real scoped work, rather than replacing its interface.

