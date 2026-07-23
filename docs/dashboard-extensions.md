# Declarative dashboard extensions

Kestrel plugins can add operational panels to the native desktop app without
loading third-party code into Electron's renderer. A contribution is a bounded
JSON document referenced by the plugin's existing `.codex-plugin/plugin.json`.
It becomes visible on the **Extensions** page only while that plugin is enabled.

This is intentionally narrower than Hermes' JavaScript, CSS, and Python
dashboard plugin surfaces. Kestrel preserves the useful extension outcome
while keeping the desktop trust boundary explicit:

- no plugin HTML, JavaScript, React, CSS, remote fonts, or images are loaded;
- no dashboard-defined network request or backend route exists;
- all text is rendered as text by Kestrel;
- metrics can read only the closed source vocabulary below;
- actions can navigate only to a built-in Kestrel page;
- MCP tools remain a separate connection and approval-gated runtime;
- managed plugin bundles still require an explicitly trusted Ed25519 publisher.

## Manifest

Add a root-contained path to the Codex-compatible manifest:

```json
{
  "name": "release-ops",
  "version": "1.0.0",
  "description": "Release operations.",
  "dashboard": "./dashboard.json"
}
```

The target must exist inside the plugin root, be a regular JSON file, and be no
larger than 64 KB. The schema is strict: unknown fields fail discovery instead
of being ignored.

## Contribution format

```json
{
  "version": 1,
  "title": "Release operations",
  "description": "See the delivery boundary and open built-in evidence views.",
  "navigationLabel": "Release Ops",
  "panels": [
    {
      "id": "delivery",
      "title": "Delivery boundary",
      "description": "Live values are resolved by Kestrel.",
      "tone": "accent",
      "metrics": [
        { "label": "Agent", "source": "agent-state" },
        { "label": "Approvals", "source": "pending-approvals" },
        { "label": "Sessions", "source": "runtime-sessions" },
        { "label": "Plugin", "source": "plugin-version" }
      ],
      "items": [
        "Verify the packaged application before publishing.",
        "Keep approval evidence attached to the release."
      ],
      "actions": [
        { "label": "Open readiness", "page": "readiness" },
        { "label": "Review artifacts", "page": "artifacts" }
      ]
    }
  ]
}
```

Bounds:

- `title`: 80 characters; `description`: 320 characters.
- 1–12 panels, each with a stable lowercase kebab-case ID.
- Panel `tone`: `neutral`, `accent`, or `warning`.
- Up to 8 metrics, 12 text items, and 6 actions per panel.
- Text items are plain text, not Markdown or HTML.

Metric sources:

- `agent-state`
- `pending-approvals`
- `model-cost-today`
- `model-budget-daily`
- `active-workers`
- `maximum-workers`
- `runtime-sessions`
- `plugin-version`
- `plugin-capabilities`

Action pages:

- `readiness`
- `approvals`
- `memory`
- `research`
- `artifacts`
- `work`
- `activity`
- `connections`
- `settings`

## Runtime and failure behavior

Discovery resolves the contribution path through the plugin root, checks the
file bound, parses JSON, and validates the complete document before exposing it
through the typed core response. A malformed contribution rejects that plugin
discovery rather than partially rendering untrusted fields.

Disabled plugins remain listed in Settings as having dashboard panels
available, but their contribution is not rendered. Enabling and disabling uses
the same persisted dependency-aware plugin lifecycle as skills and MCP servers.
Navigation buttons change only the current native page; they do not execute a
tool or start an agent run.

## Verification

`packages/agent-core/src/extensions/extensions.test.ts` covers strict parsing,
live summary exposure, unknown-field rejection, and unsafe-route rejection.
`scripts/test-desktop-dashboard-extensions.mjs` creates a real plugin in an
isolated user-data directory, enables it through Settings, verifies live
metrics and safe navigation, checks compact reflow, rejects console errors, and
captures the Extensions page.

Evidence screenshot:
[`dashboard-extension-release-ops.png`](../artifacts/screenshots/desktop/setup-revised/dashboard-extension-release-ops.png).
