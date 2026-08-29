import { describe, expect, it } from "vitest";
import { userFacingError } from "./error-copy";

describe("userFacingError", () => {
	it("keeps short actionable service messages", () => {
		expect(userFacingError(new Error("Invalid API key"), "Try again.")).toBe(
			"Invalid API key",
		);
	});

	it("hides renderer and IPC implementation details", () => {
		expect(
			userFacingError(
				new Error("Error invoking remote method 'credential-list': Error: boom"),
				"Could not check saved accounts.",
			),
		).toBe("Could not check saved accounts.");
	});

	it("hides paths and stack-shaped errors", () => {
		expect(
			userFacingError(new Error("ENOENT: /Users/test/secret.db"), "Try again."),
		).toBe("Try again.");
	});
});
