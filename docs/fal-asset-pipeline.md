# fal marketing asset pipeline

fal is a development-only provenance source for optional website atmosphere. It is not a Kestrel feature, is not imported by the website or desktop app, and is never called during build, deploy, page load, or application startup.

The manual pipeline is: approved brief -> allowlisted endpoint -> cost check -> duplicate check -> request -> original download -> review -> processing -> checksum -> registry entry -> public variant. Originals and manifests remain outside the deployed bundle; published variants are poster-first, muted, loop-safe, compressed, and pause offscreen.

`FAL_KEY` may be read only by a deliberate local/CI script. Requests include an asset ID, endpoint allowlist entry, maximum cost, prompt/settings hash, and optional cancellation. Generation scripts are not part of normal `build` or `test` commands. Production bundle scans reject credential names and known secret prefixes.

Endpoint names, schemas, duration/resolution support, and price must be refreshed from live official data before any paid request. Selection and spend are recorded in `website-media/model-selection.json`; unavailable MCP access is recorded honestly rather than replaced with a guessed endpoint.
