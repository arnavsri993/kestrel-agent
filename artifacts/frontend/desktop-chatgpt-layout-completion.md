# Kestrel desktop reference-led conversation canvas

## Outcome

Kestrel now uses the supplied ChatGPT image as a visual reference: a near-black navigation rail, uninterrupted black conversation plane, centered readiness line, and one wide charcoal composer. Kestrel branding, persisted tasks, local status, approvals, and real workspace/provider/model setup remain intact.

## Design lock

- Thesis: familiar dark conversation geometry makes the composer immediate while Kestrel-specific setup and approval boundaries stay quietly available.
- Density: dense app with a calm conversation measure.
- Type: native macOS system sans; SF Mono only for machine-readable evidence.
- Motion: short page continuity and native feedback; reduced motion removes the crossfade.
- Why this is not generic: the reference geometry is adapted around Kestrel's local-agent state, real task setup, approval queue, and evidence surfaces instead of copying ChatGPT branding or unsupported controls.

## Reference-led refinement

- Reference: 2940×1664 supplied ChatGPT desktop screenshot, used directionally rather than as a pixel target.
- Before: `artifacts/screenshots/desktop/chatgpt-before/`.
- Final: `artifacts/screenshots/desktop/revised/`.
- Final viewports: 1320×860 onboarding, new task, expanded setup, empty conversation, and approval; 760×760 compact new task.
- Fixed after first capture: composer width ratio, trailing voice-action placement, and setup disclosure hierarchy.
- Second identity pass: not required; the refined screen retained Kestrel identity and matched the supplied composition without branded copying.

## Verification

- `corepack pnpm build:desktop` passed: 980.17 KB renderer JavaScript and 41.08 KB CSS.
- `corepack pnpm typecheck` passed across the workspace.
- `corepack pnpm test`: 137 tests passed across 26 files.
- `corepack pnpm test:desktop-smoke` passed.
- `corepack pnpm test:security` passed.
- Capture verification passed for keyboard focus, reduced motion, console/page errors, and compact horizontal overflow.

## Limits

- This is a responsive adaptation, not a pixel-accuracy claim; Kestrel retains controls that ChatGPT does not expose in the supplied reference.
- Manual VoiceOver and Windows/Linux rendering were not tested.
