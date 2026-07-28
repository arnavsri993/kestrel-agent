# Activity pets

Kestrel activity pets are an optional compatibility feature inspired by Hermes Agent. They are cosmetic local status surfaces: pets never enter prompts, consume model tokens, modify tools, or change permissions.

## Desktop

Settings → Activity pet can:

- Search the public approved Petdex manifest.
- Install a chosen sprite atlas and select it.
- Turn the pet on or off.
- Adjust its desktop and terminal scale.
- Select automatic, Kitty, iTerm2, sixel, Unicode, or desktop-only terminal rendering.
- Remove an installed asset.
- Pop the pet into a transparent always-on-top companion window.

The in-window pet reflects idle, wave, running, failed, reviewing, finished, and waiting-for-approval activity. Shift-click pops it out. In the companion window:

- Drag the small top handle to move it.
- Click the sprite for a quick local-agent task.
- Double-click the sprite to show or hide Kestrel.
- Shift-click the sprite to return it to the main window.

The companion position is saved in owner-only application data and restored only when it intersects a current display. Closing it through the window manager also clears the popped-out setting.

Reduced-motion preference freezes sprite animation without removing the text state.

## CLI and TUI

The packaged CLI exposes:

```text
kestrel pets list [query] [--limit N] [--installed]
kestrel pets install <slug> [--select] [--force]
kestrel pets hatch-drafts --concept "..." [--style auto] [--count 4]
kestrel pets hatch --draft <id> --slug <slug> --name "Name" [--description "..."]
kestrel pets select <slug>
kestrel pets scale <0.1-3>
kestrel pets show [slug] [--state idle|wave|run|failed|review|jump|waiting]
                  [--cycle] [--once] [--mode auto|kitty|iterm|sixel|unicode]
                  [--scale 0.1-3]
kestrel pets off
kestrel pets remove <slug>
kestrel pets doctor
```

`pets show` is TTY-only. Automatic mode prefers Kitty, iTerm2, or detected sixel support and otherwise uses a true-color Unicode half-block fallback. The current sixel path intentionally falls back to Unicode because Kestrel does not ship a sixel encoder.

The full-screen TUI supports `/pet`, `/pet list`, `/pet <slug>`, `/pet scale <number>`, `/pet show`, and `/pet off`. `/hatch <description>` (also `/generate-pet`) renders up to four base options in the terminal; `/hatch choose <number> <slug> <display name>` completes the selected pet.

## Download and integrity boundary

Gallery browsing reads the versioned Petdex manifest from `assets.petdex.dev`. Installation:

1. Accepts only `https://assets.petdex.dev/pets/...` assets.
2. Does not follow redirects.
3. Streams with byte and time limits.
4. Parses WebP dimensions without trusting manifest metadata.
5. Accepts only the 8-column current 1536×1872 atlas or legacy 1536×1664 atlas.
6. Writes atomically into an owner-only pet directory.
7. Stores SHA-256, dimensions, source URL, creator, kind, and install time in encrypted state.
8. Rechecks the stored file, digest, and dimensions before returning any renderer data.

If an installed asset fails verification, Kestrel refuses to render it. `--force` performs a complete verified replacement rather than modifying the existing file in place.

Community assets remain owned by their submitters and their licenses vary. Kestrel does not bundle Petdex assets and downloads one only after the user explicitly chooses Install.

## AI hatch boundary

The two-stage hatch uses a configured provider that explicitly supports reference images. Four parallel low-quality square calls create base looks. After the user chooses one, eight medium-quality landscape edit calls ground the animation states on that reference; the left-facing locomotion row is mirrored locally.

Kestrel keys the flat chroma background, isolates each equal pose region, fits it into a 192×208 cell, rejects empty or illegibly small frames, requires idle plus both locomotion directions and waving, requires at least six usable state rows overall, composes the 8×9 sheet locally, encodes lossless WebP, and passes the same byte, dimension, digest, atomic-write, and owner-only storage checks as gallery pets.

The built-in OpenAI route uses `gpt-image-2` and the official Image Edits endpoint. Drafts expire after 24 hours. Reference images are sent only to the selected image-generation provider; they are not inserted into agent chat or memory. The UI identifies the number and quality of calls before generation because provider pricing applies.
