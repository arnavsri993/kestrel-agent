import { describe, expect, it } from "vitest";
import { extractLoginCodes, isLoginCodeChallenge } from "./communication";

describe("communication login-code handoff", () => {
	it("recognizes a verification page from its code field", () => {
		expect(
			isLoginCodeChallenge({
				url: "https://accounts.example.test/verify",
				title: "Verify your sign in",
				visibleText: "Enter the code we sent you.",
				forms: [
					{ label: "Verification code", type: "text", name: "otp" },
				],
			}),
		).toBe(true);
	});

	it("does not offer code lookup for unrelated pages", () => {
		expect(
			isLoginCodeChallenge({
				url: "https://example.test/docs",
				title: "Code examples",
				visibleText: "Authentication is documented here.",
				forms: [],
			}),
		).toBe(false);
	});

	it("returns only short codes and never the surrounding message", () => {
		expect(
			extractLoginCodes(
				"Your Kestrel verification code is 481902. It expires in 10 minutes.",
			),
		).toEqual(["481902"]);
		expect(extractLoginCodes("Your invoice number is 481902.")).toEqual([]);
			expect(extractLoginCodes("Your login code is AB12-CD.")).toEqual([
				"AB12-CD",
			]);
			expect(extractLoginCodes("Your login code is 123-456.")).toEqual([
				"123-456",
			]);
			expect(extractLoginCodes("Your login code is 123 456.")).toEqual([
				"123456",
			]);
	});
});
