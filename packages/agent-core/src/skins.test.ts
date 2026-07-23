import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { BUILTIN_SKINS, SkinManager, contrast } from "./skins";

describe("visual skin registry", () => {
  it("ships complete accessible built-ins and persists selection independently", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const manager = new SkinManager(database);
    expect(BUILTIN_SKINS.map((skin) => skin.id)).toEqual(["workstrand", "daylight", "mono", "slate"]);
    for (const skin of BUILTIN_SKINS) {
      expect(contrast(skin.colors.ink, skin.colors.canvas), skin.id).toBeGreaterThanOrEqual(4.5);
      expect(contrast(skin.colors.signal, skin.colors.canvas), skin.id).toBeGreaterThanOrEqual(3);
    }
    manager.select("slate");
    expect(new SkinManager(database).status()).toMatchObject({ selectedId: "slate" });
    database.close();
  });

  it("imports strict inherited JSON, rejects unsafe contrast, and recovers after removal", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const manager = new SkinManager(database);
    const source = JSON.stringify({
      version: 1,
      id: "field-notes",
      name: "Field Notes",
      description: "A personal paper-like variant.",
      base: "daylight",
      colors: { signal: "#7b2f12" },
      terminal: { promptSymbol: "»", thinkingVerbs: ["noting", "cross-checking"] }
    });
    expect(manager.import(source)).toMatchObject({ selectedId: "field-notes", skins: expect.arrayContaining([expect.objectContaining({ id: "field-notes", builtin: false, mode: "light" })]) });
    expect(() => manager.import(JSON.stringify({ version: 1, id: "invisible", name: "Invisible", description: "Bad contrast.", base: "daylight", colors: { ink: "#f5f2ea" } }))).toThrow("contrast");
    expect(() => manager.import(JSON.stringify({ version: 1, id: "scripted", name: "Scripted", description: "Unknown executable input.", script: "alert(1)" }))).toThrow();
    expect(() => manager.import(JSON.stringify({ version: 1, id: "remote", name: "Remote", description: "Remote stylesheet.", colors: { signal: "https://example.com/theme.css" } }))).toThrow();
    expect(() => manager.import(" ".repeat(65_537))).toThrow("64 KB");
    expect(manager.status().selectedId).toBe("field-notes");
    expect(manager.remove("field-notes")).toMatchObject({ selectedId: "workstrand" });
    expect(() => manager.remove("workstrand")).toThrow("Built-in");
    database.close();
  });
});
