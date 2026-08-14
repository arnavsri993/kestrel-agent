import { describe, expect, it } from "vitest";
import { PersonalityRegistry } from "./personality";

describe("PersonalityRegistry", () => {
  it("initializes with built-in personalities", () => {
    const registry = new PersonalityRegistry();
    const personalities = registry.list();
    expect(personalities.length).toBe(3);
    expect(personalities.find(p => p.id === "pragmatic")).toBeDefined();
    expect(personalities.find(p => p.id === "friendly")).toBeDefined();
    expect(personalities.find(p => p.id === "concise")).toBeDefined();
  });

  it("allows registering custom personalities", () => {
    const registry = new PersonalityRegistry();
    const custom = registry.register({
      id: "pirate",
      name: "Pirate",
      description: "Speaks like a pirate",
      instructions: "Avast ye! Speak like a true pirate.",
      memoryScope: "shared",
    });
    
    expect(custom.builtin).toBe(false);
    expect(registry.get("pirate")).toMatchObject({
      id: "pirate",
      name: "Pirate"
    });
    expect(registry.list().length).toBe(4);
  });

  it("validates personality inputs", () => {
    const registry = new PersonalityRegistry();
    
    expect(() => registry.register({
      id: "Invalid-ID!",
      name: "Pirate",
      description: "Speaks like a pirate",
      instructions: "Avast ye!",
      memoryScope: "shared",
    })).toThrow("Personality ID is invalid.");

    expect(() => registry.register({
      id: "pirate",
      name: "",
      description: "Speaks like a pirate",
      instructions: "Avast ye!",
      memoryScope: "shared",
    })).toThrow("Personality name is invalid.");

    expect(() => registry.register({
      id: "pirate",
      name: "Pirate",
      description: "",
      instructions: "Avast ye!",
      memoryScope: "shared",
    })).toThrow("Personality description is invalid.");

    expect(() => registry.register({
      id: "pirate",
      name: "Pirate",
      description: "Speaks like a pirate",
      instructions: "",
      memoryScope: "shared",
    })).toThrow("Personality instructions are invalid.");
  });

  it("prevents registering duplicate ids", () => {
    const registry = new PersonalityRegistry();
    expect(() => registry.register({
      id: "pragmatic",
      name: "Another Pragmatic",
      description: "Desc",
      instructions: "Inst",
      memoryScope: "shared"
    })).toThrow("Personality pragmatic already exists.");
  });

  it("allows removing custom personalities but not built-ins", () => {
    const registry = new PersonalityRegistry();
    registry.register({
      id: "custom",
      name: "Custom",
      description: "Desc",
      instructions: "Inst",
      memoryScope: "shared"
    });

    const removed = registry.remove("custom");
    expect(removed.id).toBe("custom");
    expect(() => registry.get("custom")).toThrow("Personality custom is unavailable.");

    expect(() => registry.remove("pragmatic")).toThrow("Built-in personalities cannot be removed.");
  });

  it("initializes with provided custom personalities up to the limit", () => {
    const customPersonalities = Array.from({ length: 5 }, (_, i) => ({
      id: `custom-${i}`,
      name: `Custom ${i}`,
      description: "Desc",
      instructions: "Inst",
      memoryScope: "shared" as const
    }));

    const registry = new PersonalityRegistry(customPersonalities);
    expect(registry.list().length).toBe(8); // 3 built-in + 5 custom
  });
});
