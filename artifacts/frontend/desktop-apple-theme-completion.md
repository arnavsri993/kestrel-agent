# Kestrel desktop light-system completion

## Outcome

Kestrel now uses a native-feeling macOS light system: a white conversation canvas, silver translucent sidebar, platform typography, system-blue actions and focus, and green only for healthy local state. Runtime behavior, approval boundaries, copy, and information architecture remain unchanged.

## Design lock

- Thesis: a quiet macOS workspace keeps conversation primary while approvals and local-agent state remain precise.
- Density: dense app with a calm central reading measure.
- Type: native macOS system sans; SF Mono only for machine-readable evidence.
- Motion: short page continuity and native feedback; reduced motion removes the crossfade.
- Why this is not generic: Kestrel uses macOS restraint around its specific local-agent status and approval boundary instead of applying a generic landing-page skin.

## Rendered refinement

- Before: `artifacts/screenshots/desktop/apple-before/`
- Final: `artifacts/screenshots/desktop/revised/`
- Viewports: onboarding, new task, empty persisted conversation, and pending approval at 1320×860; compact new task at 760×760.
- Fixed: dark graphite/lime developer-tool styling; tiny mono runtime labels; one accent overloaded across actions and healthy state.
- Compact verification: no page-level horizontal overflow; keyboard Tab moves from the prompt to the visible Voice focus target; reduced motion preserves navigation.

## Production evidence

- `corepack pnpm build:desktop` passed.
- Renderer: 979.50 KB JavaScript, 40.32 KB CSS, and no emitted desktop webfont assets.
- `corepack pnpm typecheck` passed across the workspace.
- `corepack pnpm test`: 137 tests passed across 26 files.
- `corepack pnpm test:desktop-smoke` passed.
- `corepack pnpm test:security` passed.

## Limits

- The theme was verified in Electron/Chromium on macOS, not Windows or Linux.
- Manual VoiceOver testing was not performed.
