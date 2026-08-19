import { describe, expect, it } from "vitest";
import { personalizedConfigurationPrompts } from "./configuration-prompts";

describe("personalized configuration prompts", () => {
	it("asks to change the live search engine, density, and tab layout", () => {
		expect(
			personalizedConfigurationPrompts({
				density: "comfortable",
				showToolActivity: true,
				searchEngine: "google",
				tabLayout: "horizontal",
				contextEnabled: true,
			}),
		).toEqual([
			"Set search engine to DuckDuckGo",
			"Make chat density compact",
			"Use vertical tabs",
			"Turn off current page context sharing",
		]);
	});

	it("inverts compact density, a non-Google engine, and vertical tabs", () => {
		expect(
			personalizedConfigurationPrompts({
				density: "compact",
				showToolActivity: false,
				searchEngine: "duckduckgo",
				tabLayout: "vertical",
				contextEnabled: false,
			}),
		).toEqual([
			"Set search engine to Google",
			"Make chat density comfortable",
			"Use horizontal tabs",
			"Enable current page context sharing",
		]);
	});

	it("never returns the previous hardcoded sample list", () => {
		const prompts = personalizedConfigurationPrompts({
			density: "comfortable",
			showToolActivity: true,
			searchEngine: "google",
			tabLayout: "horizontal",
			contextEnabled: true,
			launchAtLogin: false,
			paused: false,
		});

		expect(prompts).not.toContain("Turn off desktop pet");
		expect(prompts).not.toEqual([
			"Set search engine to Google",
			"Make chat density compact",
			"Use vertical tabs",
			"Turn off desktop pet",
		]);
	});

	it("skips unknown optional settings instead of filling with presets", () => {
		expect(
			personalizedConfigurationPrompts(
				{
					density: "compact",
					showToolActivity: true,
				},
				3,
			),
		).toEqual([
			"Make chat density comfortable",
			"Hide routine tool progress",
		]);
	});
});
