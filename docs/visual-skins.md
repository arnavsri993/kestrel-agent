# Visual skins

Kestrel skins are presentation-only. A skin can change desktop semantic colors and terminal presentation, but it cannot change personality, prompts, memory, tools, approvals, permissions, layout, fonts, network behavior, or model routing.

## Built-ins

- `workstrand` — warm graphite and terracotta
- `daylight` — light paper and russet
- `mono` — low-distraction grayscale
- `slate` — cool blue-gray

The selected skin is encrypted in Kestrel's private database and applies to new terminal sessions and the desktop immediately. If a selected custom skin is removed or unavailable, Kestrel falls back to `workstrand`.

## Desktop

Open **Settings → Visual skin** to select a built-in, install a custom JSON file, inspect its provenance, or remove a custom skin. Selection is keyboard accessible, exposes `aria-pressed`, preserves visible focus, and reflows without horizontal overflow at compact widths.

Custom files must be regular non-symbolic-link JSON files between 1 byte and 64 KB. The installer rejects malformed JSON, unknown keys, built-in ID replacement, more than 20 custom skins, and color combinations that fail the required text, focus, button, warning, or error contrast.

## Terminal and CLI

Inside the full-screen TUI:

```text
/skin
/skin daylight
```

The first command lists installed skins and the second selects one immediately. Terminal colors, the prompt symbol, response label, tool prefix, and thinking verbs come from the same durable skin definition used by the desktop.

For scripts and lifecycle management:

```sh
workstrand skin list
workstrand skin select daylight
workstrand skin import ./field-notes.json
workstrand skin remove field-notes
```

## Custom format

Custom skins inherit from an installed base. Only the values being changed need to be supplied:

```json
{
  "version": 1,
  "id": "field-notes",
  "name": "Field Notes",
  "description": "My paper-like Kestrel skin.",
  "base": "daylight",
  "colors": {
    "signal": "#7b2f12",
    "brand": "#536b00"
  },
  "terminal": {
    "promptSymbol": "»",
    "thinkingVerbs": ["noting", "checking"]
  }
}
```

Accepted desktop color roles are:

```text
canvas sidebar sidebarHover surface surfaceStrong panel
ink muted faint line lineStrong
solid solidHover solidText
signal signalDeep statusSoft statusInk
healthy warning warningSoft warningInk
danger dangerSoft dangerInk brand
```

Every color is exactly `#RRGGBB`. Terminal ANSI indexes are integers from 0 through 255. Text fields and arrays are length-bounded. The schema is strict: URLs, CSS, scripts, extra keys, and executable hooks are not accepted.

## Verification

`packages/agent-core/src/skins.test.ts` checks built-in contrast, durable selection, strict inheritance, invalid contrast rejection, and deterministic removal recovery. `scripts/test-desktop-skins.mjs` exercises real Electron selection, restart persistence, native-file import, custom removal, focus, light-mode application, compact layout, console errors, and screenshots.
