# Agent workspace simplification

## Product brief

The Agents route should answer three questions immediately: which agents exist, what each one is doing, and where to continue. The default view is therefore a calm, scan-friendly list built from the same privacy-filtered runtime projection as the spatial map. Agent names, delegated task names, status, workspace, and recent activity are real runtime data; no inferred progress or synthetic metrics are shown.

## Design thesis

Make Agents feel like a dependable work roster: compact enough to scan, spacious enough to read, and explicit about every action. Use Kestrel's graphite surfaces, one continuous list, strong text hierarchy, restrained status color, and visible keyboard focus. Keep motion to existing state feedback. The Universe remains available as an optional Map view and mounts only while visible so its camera can fit the actual viewport.

The first viewport contains one destination title, one short count, search, a List/Map switch, and the two primary creation actions. Avoid starfield decoration in List view, floating card grids, icon-only primary actions, speculative agent labels, and duplicate side panels.
