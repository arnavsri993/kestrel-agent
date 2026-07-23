# Managed local AI setup

Kestrel has two explicit local-model paths:

1. **Automatic** — on supported macOS builds, Kestrel installs and manages a pinned Ollama runtime inside its own application data.
2. **Manual** — the user installs or starts Ollama independently on `127.0.0.1:11434`, then asks Kestrel to detect it.

Neither path requires a cloud account. Automatic setup never executes a shell script downloaded from the web and never requests an administrator password.

## Automatic lifecycle

`LocalRuntimeManager` performs one resumable user-initiated operation:

1. Detect an already-running Ollama native API.
2. If none is reachable, require the supported `darwin`/`arm64` Apple Silicon target.
3. Download the pinned official GitHub release over HTTPS into an owner-only staging directory.
4. Enforce the manifest byte count and SHA-256 before extraction.
5. Reject archive paths outside the staging root and reject extracted symbolic links whose resolved targets leave that root.
6. Atomically move the verified runtime into `local-runtime/ollama/<version>`.
7. Start `ollama serve` with a minimal environment, a private HOME/model directory, cloud access disabled, and `OLLAMA_HOST=127.0.0.1:11434`.
8. Pull the selected model through Ollama's streaming native API while reporting byte/progress events to the sandboxed renderer.
9. Run a real non-thinking chat completion with a 32K context request.
10. Persist only the model name and verification timestamp, then restart the isolated Kestrel core so automatic routing can use the model.

Cancellation aborts the active network operation. Failed or cancelled runtime staging directories are deleted; an already-verified installed runtime and complete model remain reusable.

On every later Kestrel launch, the main process checks the managed-install marker before starting the agent core. If no Ollama service is already reachable, it restarts the contained runtime, confirms its model list, and only then exposes the local route to automatic model selection. Quitting Kestrel terminates the child runtime it started.

## Pinned manifest

The current manifest is Ollama `0.32.1`:

- URL: `https://github.com/ollama/ollama/releases/download/v0.32.1/ollama-darwin.tgz`
- Bytes: `145355166`
- SHA-256: `346d28fe70f3ef3776e42100f5721510aa35fc07f3733f6629dbb117b1cfede9`
- Expected executable: `ollama` at the archive root

The payload was re-downloaded from the official release on 2026-07-23; its exact size and SHA-256 matched this manifest. Ollama publishes one universal macOS runtime archive, but Kestrel offers and runs the managed path only on Apple Silicon.

The checked archive contains 44 entries and uses relative internal library symlinks. A manifest update requires all of the following in one reviewed change:

- Confirm the release and checksum from the official Ollama repository.
- Update URL, version, byte count, checksum, and expected executable together.
- Inspect the complete archive path/link layout without executing it.
- Run deterministic checksum/path/link failure tests.
- Run a clean real runtime-start and small-model inference smoke test.
- Re-run the packaged desktop and release checks.

The explicit paid-bandwidth smoke command is `pnpm test:local-ai:real`. It downloads the pinned runtime plus Ollama's official 271 MB `smollm2:135m` model into an isolated temporary directory, starts the exact managed service path, pulls the model through the native API, requires a completed chat response, then terminates and deletes the isolated test data. It is intentionally excluded from ordinary CI because it performs a large third-party download.

## Model recommendation

The default recommendation is selected from total device memory while reserving capacity for macOS and Kestrel:

- 16 GB and above: reserve 4 GB.
- 8–15 GB: reserve 2 GB.
- Below 8 GB: recommend only models whose declared minimum fits.

The recommendation is a starting point, not a performance guarantee. The user can choose any exact Ollama model tag through the manual library controls.

## Setup assistant boundary

After one route works, Kestrel can prefill a setup-assistant conversation for API providers, OAuth-backed vendor CLIs, tools/MCP, skills/plugins, channels, automations, and project access.

The agent loop always receives a system-level credential rule:

- Never ask for API keys, OAuth tokens, passwords, session cookies, private keys, or other secrets in chat.
- Direct API-key entry to protected native credential fields.
- Keep OAuth and device login in provider-owned browser or official CLI surfaces.
- Explain what a credential enables and verify only non-secret connection status.

The local model is a guide, not a credential broker and not a bypass around approval or plugin trust policy.

## Recovery

- Re-run automatic setup to reuse a verified managed runtime/model and repeat the live inference check.
- Use **Set up manually** for an independently managed Ollama installation.
- Use Settings → Setup guide to revisit models without deleting credentials.
- Use Readiness to inspect local-core, model-route, project-scope, permission, backup, and package status.
- Use the destructive reset only after typing the product name; it removes Kestrel-owned state and prepares for uninstall.
