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
    expect(() => manager.import(JSON.stringify({ version: 1, id: "hover-invisible", name: "Hover invisible", description: "Bad hover contrast.", base: "daylight", colors: { solidHover: "#ffffff" } }))).toThrow("primary button hover contrast");
    expect(() => manager.import(JSON.stringify({ version: 1, id: "status-invisible", name: "Status invisible", description: "Bad status contrast.", base: "daylight", colors: { statusInk: "#f1d8ca" } }))).toThrow("status text contrast");
    expect(() => manager.import(JSON.stringify({ version: 1, id: "surface-invisible", name: "Surface invisible", description: "Bad surface contrast.", base: "workstrand", colors: { muted: "#888888" } }))).toThrow("secondary text on surfaces contrast");
    expect(() => manager.import(JSON.stringify({ version: 1, id: "scripted", name: "Scripted", description: "Unknown executable input.", script: "alert(1)" }))).toThrow();
    expect(() => manager.import(JSON.stringify({ version: 1, id: "remote", name: "Remote", description: "Remote stylesheet.", colors: { signal: "https://example.com/theme.css" } }))).toThrow();
    expect(() => manager.import(" ".repeat(65_537))).toThrow("64 KB");
    expect(manager.status().selectedId).toBe("field-notes");
    expect(manager.remove("field-notes")).toMatchObject({ selectedId: "workstrand" });
    expect(() => manager.remove("workstrand")).toThrow("Built-in");
    database.close();
  });

  it("restores the prior skin state when persistence fails", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const manager = new SkinManager(database);
    manager.import(JSON.stringify({
      version: 1,
      id: "field-notes",
      name: "Field Notes",
      description: "A personal paper-like variant.",
      base: "daylight",
    }));
    const setPrivateState = database.setPrivateState.bind(database);
    database.setPrivateState = (key, value) => {
      if (key === "display.custom-skins")
        throw new Error("skin state unavailable");
      setPrivateState(key, value);
    };

    expect(() => manager.import(JSON.stringify({
      version: 1,
      id: "second-notes",
      name: "Second Notes",
      description: "Another paper-like variant.",
      base: "daylight",
    }))).toThrow("skin state unavailable");
    expect(manager.status()).toMatchObject({
      selectedId: "field-notes",
      skins: expect.arrayContaining([
        expect.objectContaining({ id: "field-notes" }),
      ]),
    });
    expect(manager.status().skins.some((skin) => skin.id === "second-notes")).toBe(false);
    expect(new SkinManager(database).status().selectedId).toBe("field-notes");
    database.close();
  });

  it("retains legacy custom skins and selection while rendering unsafe definitions through a safe fallback", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const daylight = BUILTIN_SKINS.find((skin) => skin.id === "daylight")!;
    const legacy = {
      ...daylight,
      id: "legacy-paper",
      name: "Legacy Paper",
      description: "Created before hover contrast was enforced.",
      builtin: false,
      colors: {
        ...daylight.colors,
        solidHover: daylight.colors.solidText,
      },
    };
    database.setPrivateState("display.custom-skins", [legacy]);
    database.setPrivateState("display.selected-skin", legacy.id);

    const manager = new SkinManager(database);
    const status = manager.status();
    expect(status.selectedId).toBe(legacy.id);
    expect(status.skins.find((skin) => skin.id === legacy.id)).toMatchObject({
      id: legacy.id,
      colors: { solidHover: daylight.colors.solidHover },
    });
    expect(database.getPrivateState("display.custom-skins")).toEqual([legacy]);
    expect(database.getPrivateState("display.selected-skin")).toBe(legacy.id);
    manager.select(legacy.id);
    expect(database.getPrivateState("display.custom-skins")).toEqual([legacy]);

    expect(() =>
      manager.import(JSON.stringify({
        version: 1,
        id: "new-inaccessible-paper",
        name: "New inaccessible paper",
        description: "New imports must meet current contrast requirements.",
        base: "daylight",
        colors: { solidHover: daylight.colors.solidText },
      })),
    ).toThrow("primary button hover contrast");
    database.close();
  });

  it("recovers when the persisted custom-skin state is not an array", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    database.setPrivateState("display.custom-skins", { corrupted: true });
    const manager = new SkinManager(database);
    expect(manager.status()).toMatchObject({ selectedId: "workstrand", skins: expect.arrayContaining([expect.objectContaining({ id: "workstrand" })]) });
    expect(manager.all()).toHaveLength(BUILTIN_SKINS.length);
    database.close();
  });
});
