# Music generation and interactive widgets

Kestrel implements the two OpenClaw rich-interaction contracts with separate
trust boundaries:

- [OpenClaw music generation](https://github.com/openclaw/openclaw/blob/f9708083f837d5397661a7388bc61cdc3b55daed/docs/tools/music-generation.md)
- [OpenClaw show widget](https://github.com/openclaw/openclaw/blob/f9708083f837d5397661a7388bc61cdc3b55daed/docs/tools/show-widget.md)

## Provider-backed music

Saving a protected fal credential registers `music_generate`. The provider uses
the official `@fal-ai/client` 1.10.1 queue client and the allowlisted
`fal-ai/minimax-music/v2.6` endpoint. The tool supports provider listing, a
10–2,000-character prompt, optional lyrics up to 3,500 characters,
instrumental mode, MP3 or WAV output, and a safe filename.

Generation is a sensitive, non-read-only tool, so normal Kestrel approval and
idempotency apply before the paid call. The current provider price is recorded
as an estimate on the artifact rather than presented as a billing guarantee.

The SDK request supports cancellation. The returned URL must be credential-free
HTTPS on `fal.media` or a subdomain. Redirects are rejected; declared and actual
size are bounded to 100 MB; only MPEG or WAV responses are accepted. Kestrel
downloads the bytes server-side, hashes them, writes them owner-only, and stores
the provider request ID, model, media type, size, and cost estimate in encrypted
artifact provenance. The renderer receives only a bounded local preview, never
the fal key or remote URL.

## Interactive widgets

`show_widget` accepts a short title and at most 256 KB of self-contained HTML or
SVG. It rejects code that tries to replace the host's base or CSP metadata and
wraps the fragment in a Kestrel-owned document with:

- an opaque-origin iframe (`sandbox="allow-scripts"` without
  `allow-same-origin`);
- `default-src`, `connect-src`, `frame-src`, `object-src`, `base-uri`, and
  `form-action` set to `none`;
- only inline script/style and data/blob image/media content;
- no Electron preload, parent DOM, filesystem, workspace, credential, storage
  origin, navigation, or network access;
- host design tokens and keyboard focus styling.

The optional `sendPrompt(text)` bridge requires transient user activation,
rejects empty text, slash commands, and more than 4,000 characters, and can only
post a typed message to the parent. The current Artifacts surface does not
automatically submit that message, so a widget cannot trigger an agent turn or
approval without a future explicit host review flow.

Widgets are encrypted-indexed artifacts and restore after restart. At most 32
are retained per Kestrel session; the oldest scoped widget is removed when the
limit is exceeded. Generated code is never inserted into the React DOM.

## Verification

`packages/agent-core/src/media-artifacts.test.ts` covers approval, provider
schema normalization, trusted-host download, cost/provenance, widget CSP,
metadata replacement rejection, and sandbox output.

`scripts/test-desktop-widgets.mjs` creates a real widget through the runtime
tool, restores it through the normal artifact IPC, clicks it in the sandboxed
frame, verifies its state change, checks the exact sandbox attribute, compact
overflow, console/page errors, and captures
[`artifact-interactive-widget.png`](../artifacts/screenshots/desktop/setup-revised/artifact-interactive-widget.png).
