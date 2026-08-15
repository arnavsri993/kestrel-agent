# Kestrel for OpenCode

Run Kestrel as an agent inside [OpenCode](https://opencode.ai) using the Agent Client Protocol (ACP).

## Quick Start

1. Ensure `kestrel-acp` is built and available on your `PATH`:
   ```bash
   pnpm --filter @kestrel/cli build
   ```

2. Generate or copy the OpenCode agent configuration into your project root or `~/.config/opencode/opencode.json`:
   ```bash
   kestrel opencode --setup > opencode.json
   ```

3. Start OpenCode in your workspace:
   ```bash
   opencode
   ```
   OpenCode will communicate with `kestrel-acp` over standard I/O (NDJSON stream), allowing you to run Kestrel tasks, workspace tools, approvals, and subagents directly from OpenCode.

## Configuration

In `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/schema.json",
  "agents": {
    "kestrel": {
      "name": "Kestrel",
      "description": "Kestrel local-first desktop and coding agent",
      "command": "kestrel-acp",
      "args": ["--workspace", "."]
    }
  }
}
```
