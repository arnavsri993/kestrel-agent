# Kestrel website completion report

## Outcome

The website is now a complete Signal dossier product story: one scheduling decision moves from context to recommendation, approval, and release truth. It uses a `product-marketing` density profile with Bricolage Grotesque display, IBM Plex Sans body, IBM Plex Mono evidence labels, charcoal/cool-paper planes, and one chartreuse signal family.

## Why this is not generic

The page is organized around one real scheduling decision and one inspectable signal thread connecting notice, memory, plan, approval, action, and verification—not a centered gradient hero, feature-card parade, fake chat, or invented proof.

## Evidence

- `corepack pnpm build:website`: passed; static `/` and `/_not-found` generated.
- `corepack pnpm test:e2e`: 44 passed across desktop Chromium and iPhone 13 emulation.
- `corepack pnpm test`: 11 passed.
- `corepack pnpm assets:verify`: 3 media-registry entries passed.
- `corepack pnpm test:security`: production browser secret scan passed.
- Desktop/mobile screenshots: `artifacts/screenshots/website/revised/homepage-desktop.png` and `homepage-mobile.png`.
- Interactive screenshot: `artifacts/screenshots/website/revised/approval-approved.png`.
- Three visual weaknesses fixed: competing release navigation, mobile annotation readability, and persistent mobile-menu overlay.
- Motion roles: focal signal trace; state continuity in the approval preview; direct control feedback. Reduced motion keeps all content and state while removing travel.
- Keyboard/focus: visible focus test passed; approval-state focus moves to the next logical action; skip link and native mobile details navigation are present.
- State/content: prepared, editing, approved, rejected, reset, disabled release, media fallback, reduced motion, and menu open/closed paths are implemented. Backend/network states are inapplicable because the site has no endpoint.
- Performance: all static JavaScript is 230,569 gzip bytes including Next/React; the chunk containing Kestrel page/interaction code is 45,027 gzip bytes; the largest media asset is 250,517 bytes.

## Changes

- Rewrote the hero, navigation, content hierarchy, release checklist, and metadata.
- Turned the approval mockup into an honest local-only interaction with focus-safe transitions.
- Rebuilt responsive composition for desktop and mobile without horizontal overflow.
- Updated production e2e assertions for the new semantics and interactions.
- Locked the redesign rationale in `DESIGN.md` and factual copy in `CONTENT.md`.

## Limits

Production Gmail/Calendar OAuth, signing, notarization, public download/repository URLs, update hosting, and Intel hardware verification remain incomplete and are presented as pending. Screen-reader usability and non-Chromium cross-browser behavior were not manually tested in this run.
