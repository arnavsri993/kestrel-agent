import { describe, expect, it } from "vitest";
import {
	PROJECT_APPEARANCE_STORAGE_KEY,
	readProjectAppearances,
	writeProjectAppearances,
} from "./project-appearance";

function storage(initial = "") {
	let value = initial;
	return {
		getItem: () => value || null,
		setItem: (_key: string, next: string) => {
			value = next;
		},
		read: () => value,
	};
}

describe("project appearance preferences", () => {
	it("keeps only known icons and colors from local storage", () => {
		const fixture = storage(
			JSON.stringify({
				"/projects/valid": { icon: "agent", color: "purple" },
				"/projects/unknown-icon": { icon: "not-an-icon", color: "red" },
				"/projects/unknown-color": { icon: "folder", color: "#fff" },
			}),
		);

		expect(readProjectAppearances(fixture)).toEqual({
			"/projects/valid": { icon: "agent", color: "purple" },
		});
	});

	it("writes preferences under the dedicated local key", () => {
		const fixture = storage();
		writeProjectAppearances(fixture, {
			"/projects/design": { icon: "sparkle", color: "blue" },
		});

		expect(fixture.read()).toBe(
			JSON.stringify({
				"/projects/design": { icon: "sparkle", color: "blue" },
			}),
		);
		expect(PROJECT_APPEARANCE_STORAGE_KEY).toBe("kestrel:project-appearance");
	});
});
