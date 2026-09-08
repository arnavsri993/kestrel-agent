import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS_CATALOG } from "../renderer/settings-catalog";

const appSource = readFileSync(new URL("../renderer/App.tsx", import.meta.url), "utf8");
const browserSettingsSource = readFileSync(
	new URL("../renderer/components/browser/BrowserSettings.tsx", import.meta.url),
	"utf8",
);
const computerUseSettingsSource = readFileSync(
	new URL("../renderer/components/ComputerUseSettings.tsx", import.meta.url),
	"utf8",
);
const settingsStyles = readFileSync(
	new URL("../renderer/instrument-workbench.css", import.meta.url),
	"utf8",
);

describe("settings surface accessibility contract", () => {
	it("renders a focusable anchor for every searchable setting", () => {
		const source = `${appSource}\n${browserSettingsSource}\n${computerUseSettingsSource}`;
		for (const entry of SETTINGS_CATALOG)
			expect(source).toContain(`id="${entry.anchor}"`);
	});

	it("keeps search navigation, focus restoration, responsive layout, and reduced motion explicit", () => {
		expect(appSource).toContain("settingsSearchRef");
		expect(appSource).toContain("settings-search-result-category");
		expect(appSource).toContain("scrollIntoView");
		expect(settingsStyles).toContain(
		"@container kestrel-browser-viewport (max-width: 860px)",
		);
		expect(settingsStyles).toContain(
		"@media (prefers-reduced-motion: reduce)",
		);
		expect(settingsStyles).toContain("focus-visible");
	});
});
