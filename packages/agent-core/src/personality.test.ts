import { describe, it, expect, beforeEach } from "vitest";
import { PersonalityRegistry, AgentPersonality } from "./personality";

describe("PersonalityRegistry", () => {
  let registry: PersonalityRegistry;

  beforeEach(() => {
    registry = new PersonalityRegistry();
  });

  describe("initialization", () => {
    it("should initialize with built-in personalities", () => {
      const all = registry.list();
      expect(all.length).toBeGreaterThan(0);
      expect(all.some((p) => p.builtin)).toBe(true);
      expect(all.find((p) => p.id === "pragmatic")).toBeDefined();
    });

    it("should allow initialization with custom personalities", () => {
      const customReg = new PersonalityRegistry([
        {
          id: "custom-one",
          name: "Custom One",
          description: "Test description",
          instructions: "Test instructions",
          memoryScope: "isolated",
        },
      ]);
      expect(customReg.get("custom-one")).toBeDefined();
      expect(customReg.get("custom-one").builtin).toBe(false);
    });
  });

  describe("register", () => {
    it("should register a valid custom personality", () => {
      const custom: Omit<AgentPersonality, "builtin"> = {
        id: "tester-bot",
        name: "Tester Bot",
        description: "A testing bot",
        instructions: "Test thoroughly",
        memoryScope: "shared",
        preferredModel: "test-model",
        providerIds: ["provider-1"],
        toolNames: ["test_tool"],
      };

      const result = registry.register(custom);
      expect(result.builtin).toBe(false);
      expect(registry.get("tester-bot")).toEqual({ ...custom, builtin: false });
    });

    it("should throw on invalid ID", () => {
      expect(() =>
        registry.register({
          id: "Invalid ID!",
          name: "Test",
          description: "Test",
          instructions: "Test",
          memoryScope: "shared",
        }),
      ).toThrow(/invalid/i);
    });

    it("should throw on duplicate ID", () => {
      registry.register({
        id: "tester-bot",
        name: "Test",
        description: "Test",
        instructions: "Test",
        memoryScope: "shared",
      });
      expect(() =>
        registry.register({
          id: "tester-bot",
          name: "Another",
          description: "Test",
          instructions: "Test",
          memoryScope: "shared",
        }),
      ).toThrow(/already exists/i);
    });

    it("should validate other fields", () => {
      const base = {
        id: "test-bot",
        name: "Test",
        description: "Test",
        instructions: "Test",
        memoryScope: "shared" as const,
      };
      expect(() => registry.register({ ...base, name: "" })).toThrow(
        /invalid/i,
      );
      expect(() => registry.register({ ...base, description: "" })).toThrow(
        /invalid/i,
      );
      expect(() => registry.register({ ...base, instructions: "" })).toThrow(
        /invalid/i,
      );
    });
  });

  describe("get", () => {
    it("should return existing personality", () => {
      expect(registry.get("pragmatic").name).toBe("Pragmatic");
    });

    it("should throw for non-existent personality", () => {
      expect(() => registry.get("non-existent")).toThrow(/unavailable/i);
    });
  });

  describe("remove", () => {
    it("should remove custom personality", () => {
      registry.register({
        id: "test-bot",
        name: "Test",
        description: "Test",
        instructions: "Test",
        memoryScope: "shared",
      });
      expect(registry.get("test-bot")).toBeDefined();

      registry.remove("test-bot");
      expect(() => registry.get("test-bot")).toThrow();
    });

    it("should not remove built-in personality", () => {
      expect(() => registry.remove("pragmatic")).toThrow(/cannot be removed/i);
    });
  });
});
