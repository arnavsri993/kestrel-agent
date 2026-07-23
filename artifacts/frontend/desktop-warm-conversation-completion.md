# Kestrel warm conversation refinement

## Outcome

The desktop app now uses a warm, layered graphite system rather than pure black. The supplied ChatGPT image remains a loose composition reference and the supplied Claude image informs warmth, restraint, and editorial tone; neither source was reconstructed or copied.

The sidebar now follows the requested familiar AI-app order:

1. New chat
2. Kestrel tools
3. Chats history
4. Connections, settings, and local-agent status

The new-chat canvas uses a time-aware serif greeting, one restrained composer, a quiet task-setup disclosure, and neutral voice/send controls. Kestrel's workspace, provider, approval, local-agent, and evidence behaviors remain intact.

## Render evidence

- Final desktop: `artifacts/screenshots/desktop/revised/today.png`
- Final compact: `artifacts/screenshots/desktop/revised/compact.png`
- Expanded task setup: `artifacts/screenshots/desktop/revised/task-setup.png`
- Approval state: `artifacts/screenshots/desktop/revised/approval.png`
- Conversation state: `artifacts/screenshots/desktop/revised/conversation.png`
- Onboarding: `artifacts/screenshots/desktop/revised/onboarding.png`

The rendered capture checks console and page errors, compact horizontal overflow, keyboard focus from the prompt to Record voice, and reduced-motion navigation.

## Refinement decisions

- Replaced pure black and near-black with warm graphite, cocoa-charcoal, lifted charcoal, parchment white, and mushroom gray roles.
- Replaced the saturated blue action family with restrained terracotta focus/status color and neutral primary actions.
- Added native `ui-serif` / New York display typography without a webfont or runtime dependency.
- Removed the redundant tools heading so sidebar scanning begins directly with the product tools.
- Replaced `Ready when you are.` with a local time-aware greeting and replaced `Ask Kestrel` with `How can I help?` on a new chat.
- Increased the setup disclosure's legibility while preserving progressive disclosure.

## Verification

- Desktop production build passed.
- Typecheck passed across all applicable workspace packages.
- Vitest: 26 files and 137 tests passed.
- Rendered desktop and isolated browser-tool smoke test passed.
- Production browser secret scan passed.
- Renderer output: 980.19 KB JavaScript and 41.24 KB CSS.

## Why this is not generic

The familiar AI conversation hierarchy is paired with Kestrel's real workspace/provider setup, explicit approvals, local-agent state, and evidence surfaces, using a restrained warm editorial system instead of a branded clone or generic glowing chat shell.

## Remaining limits

Manual VoiceOver review and physical Windows/Linux rendering were not performed in this pass.
