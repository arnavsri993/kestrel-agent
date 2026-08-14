import { describe, expect, it } from "vitest";
import { PersonalityRegistry } from "./personality.js";

describe("PersonalityRegistry", () => {
  it("initializes with built-in personalities", () => {
    const registry = new PersonalityRegistry();
    const list = registry.list();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some(p => p.builtin && p.id === "pragmatic")).toBe(true);
    expect(registry.get("pragmatic").name).toBe("Pragmatic");
  });

  it("initializes with custom personalities", () => {
    const registry = new PersonalityRegistry([
      { id: "custom1", name: "Custom 1", description: "Desc", instructions: "Inst", memoryScope: "shared" }
    ]);
    expect(registry.get("custom1").name).toBe("Custom 1");
    expect(registry.get("custom1").builtin).toBe(false);
  });

  describe("register", () => {
    it("allows registering a valid custom personality", () => {
      const registry = new PersonalityRegistry();
      const p = registry.register({ id: "valid-id", name: "Valid", description: "Desc", instructions: "Inst", memoryScope: "isolated" });
      expect(p.builtin).toBe(false);
      expect(registry.get("valid-id")).toEqual(p);
    });

    it("throws on invalid ID", () => {
      const registry = new PersonalityRegistry();
      expect(() => registry.register({ id: "Invalid ID!", name: "Name", description: "Desc", instructions: "Inst", memoryScope: "shared" }))
        .toThrow("Personality ID is invalid.");
    });

    it("throws on invalid name", () => {
      const registry = new PersonalityRegistry();
      expect(() => registry.register({ id: "custom", name: "", description: "Desc", instructions: "Inst", memoryScope: "shared" }))
        .toThrow("Personality name is invalid.");
      expect(() => registry.register({ id: "custom", name: "a".repeat(101), description: "Desc", instructions: "Inst", memoryScope: "shared" }))
        .toThrow("Personality name is invalid.");
    });

    it("throws on invalid description", () => {
      const registry = new PersonalityRegistry();
      expect(() => registry.register({ id: "custom", name: "Name", description: "   ", instructions: "Inst", memoryScope: "shared" }))
        .toThrow("Personality description is invalid.");
    });

    it("throws on invalid instructions", () => {
      const registry = new PersonalityRegistry();
      expect(() => registry.register({ id: "custom", name: "Name", description: "Desc", instructions: "", memoryScope: "shared" }))
        .toThrow("Personality instructions are invalid.");
    });

    it("throws when personality already exists", () => {
      const registry = new PersonalityRegistry();
      expect(() => registry.register({ id: "pragmatic", name: "Name", description: "Desc", instructions: "Inst", memoryScope: "shared" }))
        .toThrow("Personality pragmatic already exists.");
    });

    it("enforces maximum custom personalities limit", () => {
      const registry = new PersonalityRegistry();
      for (let i = 0; i < 100; i++) {
        registry.register({ id: `custom-${i}`, name: "Name", description: "Desc", instructions: "Inst", memoryScope: "shared" });
      }
      expect(() => registry.register({ id: "custom-100", name: "Name", description: "Desc", instructions: "Inst", memoryScope: "shared" }))
        .toThrow("At most 100 custom personalities can be registered.");
    });

    it("validates provider scope", () => {
      const registry = new PersonalityRegistry();
      expect(() => registry.register({ 
        id: "custom", name: "Name", description: "Desc", instructions: "Inst", memoryScope: "shared",
        providerIds: [""]
      })).toThrow("Personality provider scope is invalid.");
    });

    it("validates tool scope", () => {
      const registry = new PersonalityRegistry();
      expect(() => registry.register({ 
        id: "custom", name: "Name", description: "Desc", instructions: "Inst", memoryScope: "shared",
        toolNames: ["invalid tool!"]
      })).toThrow("Personality tool scope is invalid.");
    });
  });

  describe("get", () => {
    it("throws when personality is missing", () => {
      const registry = new PersonalityRegistry();
      expect(() => registry.get("missing")).toThrow("Personality missing is unavailable.");
    });
  });

  describe("remove", () => {
    it("removes a custom personality", () => {
      const registry = new PersonalityRegistry();
      registry.register({ id: "custom", name: "Name", description: "Desc", instructions: "Inst", memoryScope: "shared" });
      const p = registry.remove("custom");
      expect(p.id).toBe("custom");
      expect(() => registry.get("custom")).toThrow();
    });

    it("throws when removing a built-in personality", () => {
      const registry = new PersonalityRegistry();
      expect(() => registry.remove("pragmatic")).toThrow("Built-in personalities cannot be removed.");
    });
  });
});
