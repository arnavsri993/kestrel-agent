# Kestrel agent setup guide

This is the repository-local operating guide for Codex, Claude Code, OpenCode,
and other coding or ACP agents working on Kestrel. Keep the setup experience
short, explicit, reversible, and honest about what the current build can do.

## Before changing anything

- Inspect the current branch, worktree, package scripts, and relevant source
  before editing. Preserve unrelated user changes, screenshots, and artifacts.
- Treat the existing Kestrel profile, encrypted database, credentials, project
  folders, and provider-owned logins as user-owned data. Never reset, overwrite,
  or delete them without an explicit confirmation.
- Never ask a person to paste an API key, OAuth token, cookie, or password into
  chat. Use Kestrel's protected native fields or the provider's own browser/CLI
  sign-in flow.
- Do not call a route ready because a binary, configuration file, or catalog
  entry exists. Run the supported status/probe and report configured,
  reachable, and fully verified as separate states.

## Human setup handoff

When helping someone set up Kestrel, ask one compact choice before presenting a
long list of settings:

1. **Use Codex / ChatGPT plan** — use the official Codex app-server and
   provider-owned sign-in. Kestrel receives non-secret account status and keeps
   its own tools and approval authority.
2. **Use Claude Code** — use the detected official CLI login. The Kestrel route
   is an isolated text-only invocation.
3. **Use OpenCode** — use the detected OpenCode CLI/ACP route. It is also
   isolated from Kestrel's tools and approvals.
4. **Use an API provider** — save the key only in the protected setup or
   Settings field, then verify one route.
5. **Use a local Ollama model** — use the verified local bootstrap or the
   existing local runtime; do not claim readiness until a real local response
   succeeds.
6. **Transfer supported data from an existing Kestrel profile** — show the
   dry-run and approval boundary before moving anything.
7. **Start fresh** — preserve a recoverable backup before any destructive reset.

The normal first-run sequence is `Welcome → Before you begin → Choose a model
→ Model setup → Ready`. Complete one useful route first; defer tools, MCP,
skills, plugins, channels, automations, project access, and advanced policy
until the person asks for them.

For detected Codex, Claude Code, or OpenCode installations, store only the
trusted executable path and the person's enablement choice. Do not copy vendor
OAuth tokens, cookies, browser profiles, shell history, or provider caches into
Kestrel. A provider login is not permission for Kestrel to mutate that
provider, and Kestrel's approval boundary remains authoritative.

## Existing Kestrel data and transfer prompt

If the person mentions another Kestrel install/profile, or the target profile is
not empty, ask this before setup continues:

> Is this a new Kestrel profile, or would you like to transfer supported data
> from an existing Kestrel profile? I can keep the current profile, show a
> dry-run transfer plan, or start fresh with a recoverable backup.

Do not silently merge profiles. A safe transfer must be explicit, bounded,
checksum-verified, no-overwrite by default, and reversible. Do not raw-copy an
encrypted desktop database or Keychain-protected material into a different
profile and call that a migration.

The current migration CLI supports bounded dry-run/apply imports from OpenClaw,
Hermes, Codex, and Claude Code. It recognizes instruction files (`AGENTS.md`,
`CLAUDE.md`, and `HERMES.md`), non-secret settings, memories, agents, and
skills; it preserves the source and rejects links, binary files, oversized
files, containment escapes, and changed checksums. A direct Kestrel-to-Kestrel
restore is not exposed by this CLI yet. If that choice is requested but no
tested product flow exists, say so plainly and leave both profiles untouched.

For a supported reference-product import, always plan first and review the
result with the person:

```bash
# Isolate CLI state while inspecting or importing another product.
export KESTREL_DATA_DIR=/absolute/path/to/temporary-kestrel-cli-state

corepack pnpm cli -- migration plan \
  --product codex \
  --source /absolute/path/to/source-root \
  --target /absolute/path/to/kestrel-import-root \
  > /absolute/path/to/kestrel-migration-plan.json

corepack pnpm cli -- migration apply \
  --plan /absolute/path/to/kestrel-migration-plan.json \
  --approve yes \
  --overwrite no
```

Never infer a source path or import credentials. Ask the person to choose the
source directory, show the categories and conflicts in the plan, and require
explicit approval for apply.

## Setup and validation commands

- Use `corepack pnpm cli -- help` to confirm the local command surface.
- Use `kestrel opencode --setup` when the person specifically wants an
  OpenCode agent configuration; it prints configuration and does not silently
  write secrets.
- For desktop work, run only one `corepack pnpm dev:desktop` watcher. Main and
  preload changes restart Electron automatically; renderer changes use Vite
  HMR. Leave the watcher running after source changes so the open app reflects
  the current source.
- For onboarding or setup changes, run `corepack pnpm test:desktop-setup`.
- For a broad repository change, run `corepack pnpm verify` and distinguish
  focused passes from unrelated baseline or remote-CI failures.
- For desktop renderer changes, build and inspect the packaged app with
  `corepack pnpm package:mac:dev` and, when applicable, run
  `corepack pnpm test:packaged-desktop:arm64`.

Do not merge a pull request or claim a provider, migration, or packaged app is
ready without the corresponding live evidence.
