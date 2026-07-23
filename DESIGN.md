# Workstrand design brief

## First-run model and safety setup

- Operating mode: `existing-redesign`, page-sized first-run workflow inside the desktop product.
- Product mandate: a nontechnical user should be able to understand the local safety boundary, connect at least one real model route, optionally add a second credential for failover, automatically install a device-appropriate local model or take an explicit manual path, and reach a truthfully verified ready state without reading documentation.
- Verified capability boundary: protected OpenAI and Anthropic primary/backup API credentials form real provider pools; Gemini is supported through an API key; a pinned official Ollama runtime can be checksum-verified and installed into Workstrand's private macOS app data without administrator access; existing Ollama installs remain available through manual setup; Codex and Claude subscription routes rely on vendor-owned authenticated CLIs; OpenClaw and Hermes settings can be dry-run imported. Workstrand does not import browser cookies or OAuth tokens, and the setup assistant is system-instructed never to ask for secrets in chat.

### Selected system lock

- Thesis: setup should feel like a calm guided workbench—one consequential choice per page, plain-language consequences beside each action, and a visible model stack that makes redundancy understandable without exposing infrastructure jargon.
- Density profile: `dense-app` within the model library; `sparse-editorial` on the welcome, warning, and finish pages.
- Type pair: preserve native New York/ui-serif for decisive page headlines and the Workstrand name; macOS system sans for explanatory copy and controls; SFMono only for model IDs, sizes, and provider evidence.
- Type scale: welcome 50/52, step title 34/38, section title 18/23, body 13/20, control 12/17, evidence/meta 9/14.
- Spacing scale: 4px base; shell 8/12/16/20/28/40; large-page rhythm 56/72.
- Color roles: preserve warm graphite canvas, cocoa-charcoal rail/header, parchment primary text, mushroom secondary text, restrained terracotta focus/action, green connected/installed state, amber warning state, and red only for errors.
- Material: flat warm matte planes with ruled rows; only the current choice and warning acknowledgement receive a contained surface. Avoid a card catalog where simple rows communicate better.
- Primary composition: a persistent four-step rail shows location and completed work; the content plane holds one headline, one support paragraph, and the current task. Model setup uses three honest groups: accounts, local models, and reference-product import/custom coverage. The local pane has one dominant automatic action, one manual fallback, visible download/proof progress, and the full model library below.
- Motion roles: state continuity through a short horizontal/opacity step transition; feedback through hover/press/focus. Reduced motion changes steps without travel.
- Persistence: current step and safe non-secret selections survive a reload; completion is stored only after the final page. Credentials remain in macOS secure storage and are never copied into browser storage.
- State coverage: first/returning setup; warning unchecked/acknowledged; credential loading/saving/configured/error; zero/one/two accounts; provider verification; automatic runtime unsupported/detecting/downloading/checksum-verifying/installing/starting; model downloading/verifying/ready/cancelled/error; manual setup collapsed/expanded; existing versus managed Ollama; device recommendation; optional setup skipped; final incomplete/ready; setup-assistant handoff; back navigation.
- Avoid list: five-page feature tour, technical setup checklist before trust, OAuth/browser-cookie claims, treating ChatGPT subscriptions as API keys, fake provider connectivity, claiming an exhaustive remote model catalog, blanket macOS permission prompts, provider logo wall, pill forest, and a dashboard first viewport.
- Why this is not generic: the flow visualizes Workstrand’s real provider pool and local-device fit as one understandable stack, while the warning and finish states expose the exact approval, cost, privacy, and unsupported-auth boundaries.

### Rendered refinement and state evidence

- Captures inspected: 1320×860 welcome, warning, account stack, local model library, broader provider coverage, and final readiness states; 640×760 compact provider-coverage state.
- Three highest-impact weaknesses fixed: account setup initially used overly technical subscription language and undersized support text; the “set up models later” action remained visible after a valid account stack existed; the final promise that setup could be reopened from Settings had no working entry point.
- Final behavior: warning acknowledgement gates progress and persists across reload; secure credentials never enter local storage or chat; two OpenAI account slots persist through the macOS credential broker and become one logical provider pool; the automatic path downloads a pinned Ollama 0.32.1 archive from the official GitHub release, enforces byte count and SHA-256, rejects unsafe archive entries, installs and runs it on loopback from owner-only app data, pulls the selected model with streamed cancellable progress, and requires a real local response; the manual path remains explicit; completion can remain an honest model-less local preview; Settings reopens the guide without deleting credentials.
- Runtime evidence: deterministic manager tests cover successful install/start/model/live-verification, checksum failure cleanup, and unsupported-platform fail-closed behavior. The Electron setup test exercises step persistence, warning gating, two stacked OpenAI credentials, automatic/manual controls, setup-assistant handoff, provider tabs, 640px reflow and overflow, completion, and Settings re-entry. Capture automation checks desktop/compact overflow, reduced motion, focus visibility, and renderer console/page errors.

## Workstrand daily-work entry — Codex replacement direction

- Operating mode: `existing-redesign`, page-sized desktop product change.
- Product mandate: Workstrand should be the default place the user brings coding, research, automation, file, and agent work. The first useful path is `choose a project → describe the outcome → inspect progress → approve consequential actions → receive evidence`.
- Verified capability boundary: the runtime already supports persistent workspace-scoped conversations, model and provider routing, file and shell tools, Git/worktrees/PRs, web and browser work, approvals, checkpoints/retry, artifacts, orchestration, plugins, MCP, skills, terminal, ACP, and editor integrations. This change exposes that union; it does not claim hosted infrastructure or bypass missing credentials.
- Rename boundary: `Workstrand` becomes the human-visible product name. Existing `kestrel` package scopes, IPC channels, protocol, Keychain service, data paths, and local-storage keys remain compatibility identifiers until a separately tested migration changes privileged identity without orphaning user data.

### Selected system lock

- Thesis: Workstrand should feel like opening a trusted workbench, not configuring an AI request—one calm project-aware composer is primary, while routing, lifecycle, and extension machinery stays close but progressively disclosed.
- Density profile: `dense-app` with a calm central reading and composing measure.
- Type pair: native New York/ui-serif for the Workstrand name and time-aware greeting; macOS system sans for controls and conversation; SFMono only for paths, hashes, usage, and execution evidence.
- Type scale: greeting 40/46, page title 36/42, conversation 14/24, controls 12/17, evidence/meta 9/14.
- Spacing scale: 4px base; shell 8/12/16/20/24; conversation 8/12/20/32/52.
- Color roles: preserve warm graphite canvas, cocoa-charcoal rail, parchment text, mushroom secondary text, restrained terracotta focus/action, green verified state, and semantic red error/destructive state.
- Material: flat warm matte planes; the composer is the one lifted work surface. Project context is grouped by rhythm and rules, not another card.
- Primary composition: a time-aware greeting, one outcome-led support line, a persistent labeled project selector, one composer, and terse capability starters. The project can be granted in place. Advanced execution routing sits below the composer and defaults to automatic.
- Motion roles: state continuity through the existing short page crossfade; direct feedback through hover/press/focus. No new ambient motion. Reduced motion removes the crossfade.
- Progressive disclosure: core completion requires only project choice when file access is needed and a natural-language request. Manual provider/model choice, checkpoints, token/cost detail, and extension administration remain available without becoming prerequisites.
- State coverage: no granted project, project picker cancelled, project added, automatic routing, manual routing incomplete/ready, no configured provider at run time, streaming, steering, approval, retry, checkpoint, and task history.
- Avoid list: onboarding as a feature tour, provider/model fields as the first task, capability-card dashboard, fake terminal chrome, unsupported “better than Codex” claims, hidden workspace scope, invisible labels, pill forests, and renaming privileged identifiers without migration.
- Why this is not generic: Workstrand’s entry surface is organized around a real permissioned project and the full evidence-backed work loop, rather than a decorative chat prompt or a developer-themed dashboard.

## Desktop product redesign — conversation first

- Operating mode: `existing-redesign`, page-sized desktop product change.
- Supplied constraint: the application should feel as immediately familiar as Codex, ChatGPT, Claude, and Claude Code; orchestration belongs in the background.
- Verified product facts: Workstrand is a high-frequency local-first personal agent; its deterministic preview includes proactive opportunity detection, personal context, explicit approval, audit history, connections, and settings.
- Reversible assumptions: a warm dark appearance is preferred over pure black; the conversation/composer is the primary task; recent threads are more useful in the main rail than dashboard modules; background work needs only a concise status until it requires a decision.

### Candidate directions

1. **Warm conversation canvas — selected.** A cocoa-charcoal sidebar, warmer graphite work plane, recent conversations, a centered editorial greeting, one quiet composer, and progressive disclosure for task setup. The ChatGPT reference informs the overall conversation geometry and the Claude reference informs warmth and reduction; neither is treated as a reconstruction target.
2. **Operator split view — rejected.** Persistent right-side jobs, memory, cost, and evidence would keep the machinery visible and compete with the conversation.
3. **Proactive task inbox — rejected.** Makes detected work primary and open-ended conversation secondary, contradicting the requested ChatGPT/Codex-like entry point.

### Selected system lock

- Thesis: Workstrand should feel immediate without feeling severe: a subtly darker warm-charcoal rail frames a soft graphite conversation canvas, while an editorial greeting and one restrained composer make the starting point unmistakable and keep Workstrand-specific setup, approvals, and local status quietly available.
- Density profile: `dense-app` with a calm central reading measure.
- Type pair: native New York/ui-serif for the greeting, page titles, and Workstrand wordmark; the native macOS system sans for interface and conversation; SFMono/monospace only for hashes, usage, and evidence metadata. This creates an editorial focal point without loading a webfont.
- Type scale: welcome 40/46, page title 36/42, body 14/23, UI 13/18, meta 10/14.
- Spacing scale: 4px base; shell 8/12/16/20/24; conversation 12/20/32/56.
- Color roles: warm graphite conversation canvas, darker cocoa-charcoal sidebar, lifted charcoal interactive surface, parchment-white primary text, mushroom-gray secondary text and separators, one restrained terracotta action/focus family, green only for verified/healthy state, and semantic red only for destructive/error states.
- Material: flat warm matte planes with one lightly lifted composer and quiet selected rows; no pure black, glass, gradient, glow, bevel, or decorative card stack.
- Primary composition: the 18% sidebar follows familiar AI-app order—New chat, product tools, then chat history—while the main pane holds one centered readiness line and one composer around 55% of available width; task setup collapses below it until needed.
- Motion roles: state continuity through a short page crossfade; feedback through native hover/press/focus. No ambient animation. Reduced motion removes the crossfade.
- Spatial intent: the wide new-task canvas isolates the composer as the one primary task; the conversation measure controls reading length; bottom space reserves a stable location for the composer and one background status without creating a second dashboard.
- Minimalism intent: warm negative space and low-contrast boundaries keep the greeting and composer legible as one task boundary; required setup remains one keyboard-reachable disclosure directly below the composer.
- Desktop performance budget: renderer JavaScript at or below 1 MB uncompressed and CSS at or below 44 KB for this preview, with no new runtime dependency or webfont asset.
- Avoid list: copying ChatGPT or Claude logos and wording, pure-black planes, dashboard home, permanent diagnostics rail, colorful status taxonomy, assistant message cards, pill forest, glowing AI chrome, prompt-card grid, hidden focus, motion-dependent state, and ornamental layers.
- Retrieved guidance applied: `ia.one-primary-task`, `direction.content-before-chrome`, `direction.systemic-distinctiveness`, `anti.card-everything`, `anti.decorative-signal-noise`, `responsive.recompose-not-shrink`, `layout.source-order`, `content.front-load-meaning`, `color.non-color-cues`, and `form.preserve-user-work`.
- Why this is not generic: the familiar conversation geometry and calm editorial tone are adapted around Workstrand’s real workspace/provider setup, local-agent state, approval queue, and evidence surfaces instead of becoming a branded ChatGPT or Claude imitation.

This reference-led warm conversation system supersedes the earlier pure-black, light, and control-room directions below. The marketing-site direction remains unchanged.

### Rendered refinement and state evidence

- References inspected: supplied ChatGPT desktop screenshot at 2940×1664 established the conversation geometry; supplied Claude desktop screenshot at 2864×1860 established the warmer charcoal tonal range, restrained surfaces, and editorial greeting. Both are directional rather than pixel-accuracy targets.
- Captures inspected: 1320×860 onboarding, collapsed new chat, expanded task setup, empty persisted conversation, and approval; 760×760 compact new chat.
- Earlier ChatGPT-led weaknesses fixed: the composer occupied too much of the main pane; the voice action sat beside the attachment button rather than at the trailing action edge; the setup disclosure used a competing explanatory sentence instead of a quiet state label.
- Warm-system refinement fixed: pure-black planes made the application feel severe; the tools heading repeated the Workstrand brand and interrupted familiar sidebar scanning; the readiness line retained too much of the earlier reference's voice. The final pass uses layered warm charcoals, unlabelled primary tools followed by a Chats section, a time-aware editorial greeting, and a quieter prompt.
- State coverage: startup loading and core retry; new task; response loading, answer, and safe retry error; pending/executed/rejected approval; empty approvals; paused/working/waiting/idle agent labels; disabled future connector controls with explicit status; destructive reset confirmation.
- Runtime verification: real Electron onboarding, new-task/setup disclosure, persisted conversation navigation, approval navigation, compact reflow, keyboard focus from prompt to Voice, reduced-motion navigation, page-level overflow check, and console/page-error collection.
- Production measurement: 980.19 KB renderer JavaScript and 41.24 KB CSS; no desktop webfont assets and no new runtime dependency.

## Operating mode and evidence

- Operating mode: `autonomous-zero-brief-build`, applied as an existing product-marketing redesign.
- Build mode: targeted redesign of the existing static website; preserve the desktop product, architecture boundaries, generated-media provenance, and working design tokens.
- Supplied facts: installable Electron app; local-first personal memory; proactive opportunity discovery; explicit approvals; verified actions; teacher scheduling and DJI troubleshooting scenarios; macOS-first signed DMG architecture; static website; no public agent or fal runtime; GitHub publishing later.
- Creative assumptions: `Workstrand` is a reversible working name; the first usable release is a deterministic local vertical slice with mocked provider adapters, not a claim that production connectors, signing, or notarization are complete. "Proper website" means a complete, trustworthy product story and usable preview rather than a wholesale visual reset.

## Retrieved evidence before redesign lock

- Core UX and integrity: `ia.one-primary-task`, `content.earn-every-line`, `integrity.truthful-proof`, `direction.content-before-chrome`, `delivery.definition-of-done`.
- Direction and responsive: `anti.hero-empty-scale`, `layout.intentional-negative-space`, `responsive.input-agnostic`, `architecture.progressive-enhancement`.
- Accessibility and motion: `a11y.keyboard-complete`, `component.focus-contract`, `motion.explain-causality`, `motion.interruption-safe`, `motion.reduced-motion-equivalence`, `motion.audit-by-system-leverage`.
- External source catalog: `magic-ui`, `aceternity-ui`, and `react-spring` were rejected because their returned license status was unresolved and their visual posture did not fit this high-trust product. `craftwork`, `saasframe`, `page-flows`, and `copywritingexamples` were retained as inspiration-only catalog references; no code, assets, copy, tokens, or layouts were adapted.
- Classifier conflict: the exact prompt classifier misread the plugin URI as conceptual-art content. That inference was rejected in favor of inspected repository facts and the correctly routed redesign workflow: product-marketing, high trust, intensity 3, medium-low motion.

## Candidate directions

### A — Signal dossier (selected)

- Composition: left-anchored product promise paired with one dominant operational dossier; the numbered signal path becomes the page's evidence spine.
- Identity: preserve the acid signal, charcoal field, cool paper, cut-corner mark, precise rules, and honest product scenes.
- Content shape: outcome → worked scheduling decision → scoped memory → approval boundary → local architecture → release gate.
- Tradeoff: needs disciplined copy reduction so technical proof does not become a dense dashboard.

### B — Quiet personal desk

- Composition: warm editorial narrative around planner pages and document fragments.
- Identity: softer paper, graphite, stamped annotations, and a humanist serif.
- Tradeoff: approachable, but it weakens the inspectable control-system identity and risks an undifferentiated AI-brochure aesthetic.

### C — Architecture ledger

- Composition: system boundary map, compact capability table, policy matrix, and release checklist first.
- Identity: grid paper, mono labels, terse technical detail, minimal atmosphere.
- Tradeoff: credible for evaluators but delays the personal outcome and makes the website feel like documentation rather than product marketing.

The plugin comparison ranked Signal dossier first (37), ahead of Architecture ledger (27) and Quiet personal desk (23). Human review confirmed that result because it best preserves product truth, identity, and the first-time visitor's reading sequence.

## Product and user

- Product type: installable personal AI operator and its separate download website.
- Primary user and job: a privacy-conscious individual who wants useful multi-step work prepared or completed without repeatedly coordinating every step.
- Trust/risk level: high trust, potentially high consequence; every external action is evidence-backed, policy-checked, and auditable.
- Device and environment: macOS 13+ first; Windows architecture retained; desktop application plus responsive static website.
- Known constraints: renderer has no Node access; personal memory remains local by default; website is presentation-only; temporary name must be centralized.
- Assumptions to verify: real Gmail/Calendar OAuth configuration, Developer ID identity, notarization credentials, update host, public download URL, GitHub URL, Intel test hardware, and final product name.

## Design thesis

Workstrand is an inspectable signal dossier where one prepared decision moves from context to approval to verification, using acid-yellow threadwork across charcoal and cool paper without techno-mysticism, noisy dashboards, or hidden autonomy.

## Why this is not generic

The identity is built around one real scheduling decision and a single inspectable signal thread that connects notice, memory, plan, approval, and verification—not a gradient hero, feature-card parade, or fake chat window.

## Direction

- Density profile: `dense-app` for the desktop; `product-marketing` for the website.
- Composition: website first viewport contains the Workstrand wordmark, one headline, one support line, one CTA group, and one dominant operational canvas; desktop uses a narrow command rail and one primary work plane.
- Spacing scale / section rhythm: 4px base; app 8/12/16/24/32; website 12/20/32/56/88/144.
- Typography: Bricolage Grotesque variable for display (72/64, 52/56, 36/42, 28/34); IBM Plex Sans for body (18/30, 16/25, 14/21, 12/18); IBM Plex Mono for evidence and timestamps.
- Color roles: `paper #eceee7`, `surface #f7f8f3`, `ink #17201d`, `muted #69726c`, `line #c8cec5`, `night #101713`, `signal #d7ff52`. Signal is the sole accent family.
- Material / surface language: matte instrument panels, fine rules, precise cut corners, rare translucent overlay only when it denotes a real modal boundary.
- Imagery/iconography: abstract signal fields and honest React-rendered interface states; no robots, brains, generic cyberpunk, fake readable generated UI, mascots, or stock people.
- Motion intensity and roles: medium-low. Focal: one signal line resolves across the hero. State: the local approval demo transitions between prepared, editing, approved, and reset states. Feedback: controls compress and confirm. Reduced motion renders the signal resolved and changes state without travel or spring effects.
- Familiarity vs. originality: familiar navigation, buttons, lists, and dialogs; original composition and signal-thread grammar.
- Patterns intentionally avoided: purple/indigo gradients, glow stacks, centered three-card hero, pill forests, fake metrics/testimonials, universal scroll reveal, decorative bento, fake terminal, always-running activity indicators, inaccessible cinematic text.

## System lock (before catalogs)

- Existing system to preserve or extend: none; shared tokens will be authored once and reused by desktop and website.
- Tokens and component strategy: CSS custom properties plus small, typed React components; native semantics first; Motion is the only motion library.
- Responsive strategy: desktop app supports a compact 920px window and rail collapse; site reflows at content-led boundaries around 980px and 700px; no hidden required content.
- Accessibility target: WCAG 2.2 AA intent, keyboard-complete flows, visible focus, reduced-motion alternatives, non-color status cues, 44px touch targets on mobile.
- Performance budget: website initial page under 180KB compressed JavaScript excluding framework runtime, poster-first media, no render-blocking video, at most one visible ambient video, zero generation/runtime API calls from the browser. Final static export measured 230,569 gzip bytes across all JavaScript including Next/React runtime; the chunk containing the Workstrand page and interaction code measured 45,027 gzip bytes. The largest media asset is the 250,517-byte hero poster.

## States and acceptance criteria

- Desktop states: first-run guidance, ready, observing, working, awaiting approval, approved, rejected, completed, paused, offline, error/retry, permission denied, saving/saved, reset confirmation.
- Website states: media available/unavailable, reduced motion, local demo prepared/editing/approved/rejected/reset, download unavailable, GitHub unavailable, mobile navigation open/closed, narrow/short viewports. Loading, network error, offline, and permission states are pruned from the approval preview because it has no request, persistence, permission, or backend; it cannot enter those states. The media component falls back to a still asset instead of exposing a dead loading/error surface.
- Acceptance: teacher event becomes an evidence-backed Monday recommendation; send/create actions cannot occur before approval; approval executes exactly once; memory and audit trace update; DJI response retrieves prior context and avoids repeated advice; public site has no agent API or fal runtime; production builds and tests pass.

## Catalog pulls and source-use ledger

- Thesis-derived queries: `react precise editorial signal-path state continuity reduced motion`; `instrument-panel marketing motion task progression evidence approval`.
- Sources consulted: focused plugin corpus plus the bounded source candidates listed above. Network research was not required.
- What was adapted vs ignored: only the already-installed Motion API and original project components are used. Catalog visuals remain inspiration-only; glow, particle, parallax, bento, marquee, and template skins are rejected.

## Rendered refinement (mandatory)

- Baseline captures: `artifacts/frontend/initial-desktop.png` and `artifacts/frontend/initial-mobile.png`.
- Baseline weaknesses: the hero promise was reusable by many proactive-AI products; the primary navigation emphasized a download that does not exist; preview controls looked actionable but did nothing; the mobile navigation hid the information architecture; several sections repeated the same autonomy claim.
- Structural fixes: replaced the hero with a Workstrand-specific promise and honest primary action, added functional local prepared/editing/approved/rejected states, exposed native mobile navigation, reduced duplicate copy, and preserved the release boundary.
- Pass-one captures: `artifacts/frontend/pass1-desktop.png`, `artifacts/frontend/pass1-mobile-clip.png`, `artifacts/screenshots/website/revised/homepage-desktop.png`, and `artifacts/screenshots/website/revised/homepage-mobile.png`.
- Three highest-impact pass-one weaknesses: the outlined desktop release link competed with the hero focal point; memory-orbit and ledger annotations were too small on mobile; the native mobile menu stayed open after same-page navigation and could cover the target section.
- Fixes implemented: reduced the release link to a quiet underlined navigation action; increased mobile annotation, ledger, security, and footer type; closed the mobile details menu when a section link is chosen. A separate component review also found and fixed disappearing focus across approval-state transitions.
- Revised captures: `artifacts/screenshots/website/revised/homepage-desktop.png`, `artifacts/screenshots/website/revised/homepage-mobile.png`, and `artifacts/screenshots/website/revised/approval-approved.png`.
- Second-pass outcome: not needed. The revised page passes the brand test, keeps the first viewport to one promise/action/product plane, and does not match the default AI cluster.
- Remaining product limitations: real OAuth providers, signed release infrastructure, public URLs, and Intel release verification depend on credentials, hardware, and publishing decisions.

## Daily-readiness extension

- Operational focal point: the desktop app now has one Readiness surface that answers “can I rely on this for a real task?” before exposing secondary detail.
- Status hierarchy: local core and configured model route are blocking; project scope, macOS permissions, a verified backup, and packaged-build status are visible but only become blocking when the intended task needs them.
- Recovery material: backups are calm, explicit operations rather than background magic. Workstrand stops the local core, copies only owned state (not project folders), hashes every file, and reports the verified destination.
- First-run integrity: setup performs a live provider/local-service account probe after a route is configured, while preserving an honest local-preview path when no model is available.
- Finder-launch continuity: detected vendor subscription routes are presented as explicit local account choices with enable/disable state, instead of relying on invisible shell environment flags.
- Motion and access: no new motion role was added; readiness uses persistent text, symbols, and color together, remains keyboard-operable, and reflows to one column.
