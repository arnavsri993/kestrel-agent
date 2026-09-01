import { describe, expect, it } from "vitest";
import {
	LEGACY_SETTINGS_SECTION_ALIASES,
	SETTINGS_CATALOG,
	SETTINGS_SECTIONS,
	normalizeSettingsSection,
	sectionDefinition,
	settingsScopeForSection,
	settingsSectionMatchesQuery,
} from "./settings-catalog";

describe("organized settings catalog", () => {
	it("keeps every section and searchable setting uniquely addressable", () => {
		expect(new Set(SETTINGS_SECTIONS.map((section) => section.id)).size).toBe(
			SETTINGS_SECTIONS.length,
		);
		expect(new Set(SETTINGS_CATALOG.map((entry) => entry.id)).size).toBe(
			SETTINGS_CATALOG.length,
		);
		for (const entry of SETTINGS_CATALOG) {
			expect(sectionDefinition(entry.section).id).toBe(entry.section);
			expect(entry.anchor).toMatch(/^setting-[a-z0-9-]+$/);
			expect(entry.keywords.length).toBeGreaterThan(0);
		}
	});

	it("searches labels, descriptions, ids, and keywords without changing scope", () => {
		const homepage = SETTINGS_CATALOG.find(
			(entry) => entry.id === "browser.startup.homepage",
		)!;
		expect(settingsSectionMatchesQuery(homepage, "home")).toBe(true);
		expect(settingsSectionMatchesQuery(homepage, "browser.startup.homepage")).toBe(
			true,
		);
		expect(settingsSectionMatchesQuery(homepage, "payment")).toBe(false);
		expect(settingsSectionMatchesQuery(homepage, "")).toBe(true);
		expect(settingsScopeForSection(homepage.section)).toBe("browser");

		const memory = SETTINGS_CATALOG.find(
			(entry) => entry.id === "agent.memory.recall",
		)!;
		expect(settingsScopeForSection(memory.section)).toBe("agent");
	});

	it("preserves legacy deep links while exposing canonical Agent sections", () => {
		for (const [legacy, canonical] of Object.entries(
			LEGACY_SETTINGS_SECTION_ALIASES,
		)) {
			expect(normalizeSettingsSection(legacy as keyof typeof LEGACY_SETTINGS_SECTION_ALIASES)).toBe(
				canonical,
			);
		}
		expect(normalizeSettingsSection(undefined)).toBe("agent-connections");
	});
});
