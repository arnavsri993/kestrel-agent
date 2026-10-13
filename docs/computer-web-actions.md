# Computer and web actions

Kestrel's Codex account route can propose tools to Kestrel's agent loop. It
returns a structured decision containing user-facing text and bounded tool
requests. Only the current session's advertised tool names are accepted.
Kestrel owns policy, approvals, idempotency, execution, and the returned receipt.
The Codex child retains its read-only sandbox and disabled vendor approvals.

For websites, prefer Kestrel's browser tools. Use a fresh accessibility snapshot
to find controls, act through `browser.act` or `browser.visible-act`, and check
the returned observation. The visible browser uses the user's existing tabs;
isolated sessions have an origin allowlist. Passwords and authentication codes
stay in the provider's or website's own login surface. Existing recovery guidance
requires fresh observations and forbids automatic replay after an uncertain
effect.

Verified `browser.screenshot`, `browser.visible-screenshot`, and
`computer.screenshot` results reach vision-capable models as image observations.
Conversation history stores a compact receipt; the encrypted execution record
retains the image. Images have a 6 MiB data-URL limit and are untrusted content.
Failed, malformed, oversized, or wrong-trust images are not attached. A newer
user prompt or a subsequent browser/desktop mutation prevents replaying an old
image as a current observation.

## Mac computer control

Enable **Whole-desktop computer use** under **Settings → Agent → Permissions &
sandbox**. Kestrel also needs macOS Screen Recording and Accessibility access.
Its System Events helper must be allowed by macOS to inspect the frontmost app
and send approved input. Status reads do not grant permissions.

The supported desktop controls are clicking, typing, navigation keys, and
single-letter/digit shortcuts with Command, Control, Alt, or Shift. PageUp and
PageDown provide keyboard page navigation. Native wheel, drag, right-click,
and secondary-display selection are not exposed by this implementation.

The desktop sequence is:

1. Call `computer.screenshot` and inspect its image and `desktop.captureId`.
2. Propose `computer.act` with that capture ID and one action. The user reviews
   the action in Kestrel's approval UI.
3. Kestrel verifies that the capture belongs to this task, is less than two
   minutes old, and still refers to the same primary display. It restores the
   exact app process captured before approval and checks its identity before
   input. Each capture permits one action.
4. Take another screenshot to check the visible result. A successful native
   input receipt says input ran; the run cannot be marked complete until a
   subsequent screenshot succeeds.

Screenshots use logical display dimensions so their coordinates map to macOS
points on Retina displays. A changed display, expired/consumed capture, missing
target app, revoked permission, or cancellation stops input. After an error,
observe again before deciding whether another action is needed.

## Validation

Focused unit tests cover the Codex proposal/receipt protocol, approval boundaries,
image delivery and resume, capture ownership, coordinate mapping, keyboard
chords, focus identity, and cancellation. `benchmark:browser-agent` exercises
50 deterministic workflows against local fixtures; it does not measure model
success on arbitrary live websites. Use a real Codex request and a task on the
canonical installed app to verify the account route and user-visible delivery.
