import type { KestrelDatabase } from "@kestrel/database";
import { SkinDefinitionSchema, SkinImportSchema, SkinStatusSchema, type SkinDefinition, type SkinStatus } from "@kestrel/shared-types";

const workstrand: SkinDefinition = {
  id: "workstrand",
  name: "Kestrel",
  description: "Mac-native graphite, aluminum text, and a quiet sage signal.",
  mode: "dark",
  builtin: true,
  colors: {
    canvas: "#1c1c1e", sidebar: "#141416", sidebarHover: "#29292c", surface: "#2c2c2e", surfaceStrong: "#3a3a3c", panel: "#242426",
    ink: "#f5f5f7", muted: "#b8b8bd", faint: "#8e8e93", line: "#38383b", lineStrong: "#515156",
    solid: "#f5f5f7", solidHover: "#ffffff", solidText: "#1c1c1e", signal: "#78b986", signalDeep: "#9bd0a5",
    statusSoft: "#25382a", statusInk: "#b6dfbd", healthy: "#78b986", warning: "#d7b45c", warningSoft: "#3b321f", warningInk: "#f5dda0",
    danger: "#e46c75", dangerSoft: "#351d21", dangerInk: "#f6bec3", brand: "#b7d68a"
  },
  terminal: { accent: 150, muted: 244, success: 108, warning: 179, error: 168, promptSymbol: "›", responseLabel: "Kestrel", toolPrefix: "┊", thinkingVerbs: ["working", "reviewing", "verifying"] }
};

const daylight: SkinDefinition = {
  id: "daylight",
  name: "Daylight",
  description: "A bright paper workspace with cool graphite text and russet focus.",
  mode: "light",
  builtin: true,
  colors: {
    canvas: "#f5f2ea", sidebar: "#e9e4d8", sidebarHover: "#ddd6c7", surface: "#ffffff", surfaceStrong: "#e2dbce", panel: "#eee9df",
    ink: "#242321", muted: "#5d594f", faint: "#706a5e", line: "#d2cabd", lineStrong: "#b8ae9e",
    solid: "#242321", solidHover: "#3a3833", solidText: "#ffffff", signal: "#9b3e1b", signalDeep: "#762b10",
    statusSoft: "#f1d8ca", statusInk: "#762b10", healthy: "#246c40", warning: "#8a5100", warningSoft: "#f6e3ba", warningInk: "#633800",
    danger: "#ac1f2b", dangerSoft: "#f8dadd", dangerInk: "#78141d", brand: "#536b00"
  },
  terminal: { accent: 130, muted: 242, success: 28, warning: 130, error: 124, promptSymbol: "›", responseLabel: "Kestrel", toolPrefix: "│", thinkingVerbs: ["working", "reading", "checking"] }
};

const mono: SkinDefinition = {
  id: "mono",
  name: "Mono",
  description: "Quiet grayscale for recording, focus, and low-distraction work.",
  mode: "dark",
  builtin: true,
  colors: {
    canvas: "#202020", sidebar: "#171717", sidebarHover: "#292929", surface: "#303030", surfaceStrong: "#404040", panel: "#292929",
    ink: "#f2f2f2", muted: "#bdbdbd", faint: "#929292", line: "#3d3d3d", lineStrong: "#575757",
    solid: "#eeeeee", solidHover: "#ffffff", solidText: "#202020", signal: "#c7c7c7", signalDeep: "#e2e2e2",
    statusSoft: "#393939", statusInk: "#eeeeee", healthy: "#a8d5b8", warning: "#d0d0d0", warningSoft: "#393939", warningInk: "#f0f0f0",
    danger: "#ff7070", dangerSoft: "#32191b", dangerInk: "#ffc1c1", brand: "#eeeeee"
  },
  terminal: { accent: 252, muted: 244, success: 250, warning: 248, error: 203, promptSymbol: ">", responseLabel: "Kestrel", toolPrefix: "|", thinkingVerbs: ["working", "reviewing", "checking"] }
};

const slate: SkinDefinition = {
  id: "slate",
  name: "Slate",
  description: "Cool blue-gray surfaces with a clear sky-blue interaction signal.",
  mode: "dark",
  builtin: true,
  colors: {
    canvas: "#1e252d", sidebar: "#171d24", sidebarHover: "#29333e", surface: "#2a3540", surfaceStrong: "#394754", panel: "#252f39",
    ink: "#edf4fa", muted: "#b2c0cc", faint: "#8999a7", line: "#36434f", lineStrong: "#526272",
    solid: "#e8f1f8", solidHover: "#ffffff", solidText: "#17212a", signal: "#5ba7df", signalDeep: "#8cc9f3",
    statusSoft: "#253f53", statusInk: "#a9d9f7", healthy: "#70c294", warning: "#e3b65c", warningSoft: "#433b28", warningInk: "#f4d184",
    danger: "#ff6e79", dangerSoft: "#371b22", dangerInk: "#ffc0c5", brand: "#8ecfff"
  },
  terminal: { accent: 75, muted: 110, success: 78, warning: 180, error: 203, promptSymbol: "❯", responseLabel: "Kestrel", toolPrefix: "│", thinkingVerbs: ["tracing", "reviewing", "verifying"] }
};

export const BUILTIN_SKINS: readonly SkinDefinition[] = [workstrand, daylight, mono, slate].map((skin) => SkinDefinitionSchema.parse(skin));

function channel(value: string): number {
  const normalized = Number.parseInt(value, 16) / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(value: string): number {
  return 0.2126 * channel(value.slice(1, 3)) + 0.7152 * channel(value.slice(3, 5)) + 0.0722 * channel(value.slice(5, 7));
}

export function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function validateContrast(skin: SkinDefinition): void {
  const checks: Array<[string, string, string, number]> = [
    ["primary text", skin.colors.ink, skin.colors.canvas, 4.5],
    ["secondary text", skin.colors.muted, skin.colors.canvas, 4.5],
    ["faint text", skin.colors.faint, skin.colors.canvas, 3],
    ["focus signal", skin.colors.signal, skin.colors.canvas, 3],
    ["primary button", skin.colors.solidText, skin.colors.solid, 4.5],
    ["primary button hover", skin.colors.solidText, skin.colors.solidHover, 4.5],
    ["status text", skin.colors.statusInk, skin.colors.statusSoft, 4.5],
    ["secondary text on surfaces", skin.colors.muted, skin.colors.surface, 4.5],
    ["warning text", skin.colors.warningInk, skin.colors.warningSoft, 4.5],
    ["error text", skin.colors.dangerInk, skin.colors.dangerSoft, 4.5]
  ];
  for (const [label, foreground, background, minimum] of checks) {
    if (contrast(foreground, background) < minimum) throw new Error(`Skin ${label} contrast must be at least ${minimum}:1.`);
  }
}

export class SkinManager {
  private readonly customKey = "display.custom-skins";
  private readonly selectedKey = "display.selected-skin";
  private custom: SkinDefinition[];
  private readonly quarantined: unknown[];
  private readonly unsafeCustomIds = new Set<string>();
  private selectedId: string;

  constructor(private readonly database: KestrelDatabase) {
    const storedValue = database.getPrivateState<unknown>(this.customKey);
    const stored = Array.isArray(storedValue) ? storedValue : [];
    const custom: SkinDefinition[] = [];
    const quarantined: unknown[] = [];
    for (const value of stored) {
      const parsed = SkinDefinitionSchema.safeParse(value);
      if (!parsed.success || parsed.data.builtin || custom.length >= 20) {
        quarantined.push(value);
        continue;
      }
      custom.push(parsed.data);
      try {
        validateContrast(parsed.data);
      } catch {
        this.unsafeCustomIds.add(parsed.data.id);
      }
    }
    this.custom = custom;
    this.quarantined = quarantined;
    this.selectedId = database.getPrivateState<string>(this.selectedKey) ?? "workstrand";
    if (!this.all().some((skin) => skin.id === this.selectedId)) this.selectedId = "workstrand";
  }

  all(): SkinDefinition[] {
    return [
      ...BUILTIN_SKINS,
      ...this.custom.map((skin) => this.renderableSkin(skin)),
    ];
  }

  selected(): SkinDefinition {
    return this.all().find((skin) => skin.id === this.selectedId) ?? workstrand;
  }

  status(): SkinStatus {
    return SkinStatusSchema.parse({ selectedId: this.selected().id, skins: this.all() });
  }

  select(id: string): SkinStatus {
    if (!this.all().some((skin) => skin.id === id)) throw new Error(`Skin ${id} is not installed.`);
    this.selectedId = id;
    this.persist();
    return this.status();
  }

  import(source: string): SkinStatus {
    if (Buffer.byteLength(source) > 65_536) throw new Error("Skin document exceeds 64 KB.");
    let raw: unknown;
    try { raw = JSON.parse(source); } catch { throw new Error("Skin document must be valid JSON."); }
    const input = SkinImportSchema.parse(raw);
    if (BUILTIN_SKINS.some((skin) => skin.id === input.id)) throw new Error("A custom skin cannot replace a built-in skin.");
    const base = this.all().find((skin) => skin.id === input.base);
    if (!base) throw new Error(`Skin base ${input.base} is not installed.`);
    const skin = SkinDefinitionSchema.parse({
      id: input.id,
      name: input.name,
      description: input.description,
      mode: input.mode ?? base.mode,
      colors: { ...base.colors, ...(input.colors ?? {}) },
      terminal: { ...base.terminal, ...(input.terminal ?? {}) },
      builtin: false
    });
    validateContrast(skin);
    const exists = this.custom.some((candidate) => candidate.id === skin.id);
    if (!exists && this.custom.length >= 20) throw new Error("At most 20 custom skins can be installed.");
    this.custom = [...this.custom.filter((candidate) => candidate.id !== skin.id), skin];
    this.unsafeCustomIds.delete(skin.id);
    this.selectedId = skin.id;
    this.persist();
    return this.status();
  }

  remove(id: string): SkinStatus {
    if (BUILTIN_SKINS.some((skin) => skin.id === id)) throw new Error("Built-in skins cannot be removed.");
    if (!this.custom.some((skin) => skin.id === id)) throw new Error(`Custom skin ${id} is not installed.`);
    this.custom = this.custom.filter((skin) => skin.id !== id);
    this.unsafeCustomIds.delete(id);
    if (this.selectedId === id) this.selectedId = "workstrand";
    this.persist();
    return this.status();
  }

  private persist(): void {
    this.database.setPrivateState(this.customKey, [
      ...this.custom,
      ...this.quarantined,
    ]);
    this.database.setPrivateState(this.selectedKey, this.selectedId);
  }

  private renderableSkin(skin: SkinDefinition): SkinDefinition {
    if (!this.unsafeCustomIds.has(skin.id)) return skin;
    const fallback = skin.mode === "light" ? daylight : workstrand;
    return {
      ...fallback,
      id: skin.id,
      name: skin.name,
      description: skin.description,
      builtin: false,
    };
  }
}
