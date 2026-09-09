# Chromium host preview

This is a runtime migration surface for one conversation and real browser tabs,
not a marketing page or a replacement for the full desktop yet.

Design thesis: retain Kestrel's compact graphite workspace, with a quiet sidebar
for conversations and browser tabs, a readable transcript, and a pinned composer.
Use system sans, 14px body, 24px title, 4/8/12/16/24px spacing, dark-gray surfaces,
subtle dividers, pale text and a restrained blue focus indicator. No animation,
gradients, decorative cards or simulated browser content. Native Chromium owns
web tabs; their titles and URLs are untrusted and rendered as text.

The first view explains the temporary profile and provider state. Empty, sending,
cancelled and error states must be explicit. Send and cancel are real core calls.
New conversation, Open tab, Switch tab and Close tab use actual runtime state.
Narrow layouts stack navigation above the transcript. Native labels, visible focus,
keyboard submission and live errors are required. This extends Kestrel's existing
browser/chat geometry rather than introducing a generic dashboard.
