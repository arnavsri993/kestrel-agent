import { readFile, stat } from "node:fs/promises";

const MAX_RUNTIME_PREFERENCES_BYTES = 64_000;

export interface RuntimePreferences {
  subscriptions?: Partial<Record<"codex" | "claude", { enabled: boolean; path: string }>>;
}

export async function readRuntimePreferencesFile(path: string): Promise<RuntimePreferences> {
  try {
    if ((await stat(path)).size > MAX_RUNTIME_PREFERENCES_BYTES) return {};
    const contents = await readFile(path, "utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_RUNTIME_PREFERENCES_BYTES) return {};
    const value: unknown = JSON.parse(contents);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as RuntimePreferences)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}
