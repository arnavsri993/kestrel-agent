import { describe, expect, test } from "vitest";
import { PersonalityRegistry } from "./personality";

describe("PersonalityRegistry", () => {
	test("initializes with built-in personalities", () => {
		const registry = new PersonalityRegistry();
		const personalities = registry.list();
		expect(personalities.length).toBeGreaterThanOrEqual(3);

		const pragmatic = registry.get("pragmatic");
		expect(pragmatic.builtin).toBe(true);
		expect(pragmatic.name).toBe("Pragmatic");
	});

	test("can register and retrieve a custom personality", () => {
		const registry = new PersonalityRegistry();
		const custom = registry.register({
			id: "jovial",
			name: "Jovial Agent",
			description: "Always happy",
			instructions: "Be happy.",
			memoryScope: "shared",
		});

		expect(custom.builtin).toBe(false);
		expect(custom.id).toBe("jovial");

		const retrieved = registry.get("jovial");
		expect(retrieved).toEqual(custom);
		expect(registry.list()).toContainEqual(custom);
	});

	test("prevents removing built-in personalities", () => {
		const registry = new PersonalityRegistry();
		expect(() => registry.remove("pragmatic")).toThrowError(
			"Built-in personalities cannot be removed.",
		);
	});

	test("can remove a custom personality", () => {
		const registry = new PersonalityRegistry();
		registry.register({
			id: "temp-agent",
			name: "Temp",
			description: "Temp",
			instructions: "Temp",
			memoryScope: "isolated",
		});

		expect(registry.get("temp-agent")).toBeDefined();
		const removed = registry.remove("temp-agent");
		expect(removed.id).toBe("temp-agent");
		expect(() => registry.get("temp-agent")).toThrowError(
			"Personality temp-agent is unavailable.",
		);
	});

	test("validates personality id", () => {
		const registry = new PersonalityRegistry();
		expect(() =>
			registry.register({
				id: "INVALID_ID!!!",
				name: "Test",
				description: "Test",
				instructions: "Test",
				memoryScope: "isolated",
			}),
		).toThrowError("Personality ID is invalid.");
	});

	test("validates duplicate personalities", () => {
		const registry = new PersonalityRegistry();
		expect(() =>
			registry.register({
				id: "pragmatic", // Already built-in
				name: "Test",
				description: "Test",
				instructions: "Test",
				memoryScope: "isolated",
			}),
		).toThrowError("Personality pragmatic already exists.");
	});

	test("enforces maximum custom personalities limit", () => {
		const registry = new PersonalityRegistry();

		for (let i = 0; i < 100; i++) {
			registry.register({
				id: `agent-${i}`,
				name: `Agent ${i}`,
				description: "Desc",
				instructions: "Inst",
				memoryScope: "isolated",
			});
		}

		expect(() => {
			registry.register({
				id: "one-too-many",
				name: "Too Many",
				description: "Desc",
				instructions: "Inst",
				memoryScope: "isolated",
			});
		}).toThrowError("At most 100 custom personalities can be registered.");
	});

	test("validates configuration limits like name and description", () => {
		const registry = new PersonalityRegistry();
		expect(() =>
			registry.register({
				id: "valid",
				name: "a".repeat(101), // over 100
				description: "Test",
				instructions: "Test",
				memoryScope: "isolated",
			}),
		).toThrowError("Personality name is invalid.");

		expect(() =>
			registry.register({
				id: "valid",
				name: "Valid",
				description: "a".repeat(501), // over 500
				instructions: "Test",
				memoryScope: "isolated",
			}),
		).toThrowError("Personality description is invalid.");
	});
});
