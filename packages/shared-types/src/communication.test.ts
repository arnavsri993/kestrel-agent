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
	it("does not mistake a verification button or read-only instructions for a login field", () => {
		for (const forms of [[], [{ label: "Show verification", type: "button", name: "verify" }]]) {
			expect(isLoginCodeChallenge({ url: "http://127.0.0.1/verification", title: "Local verification page", visibleText: "Verify your code. Show verification.", forms })).toBe(false);
		}
	});
	it("keeps code lookup available for a protected field without exposing its metadata", () => {
		expect(isLoginCodeChallenge({ url: "https://accounts.example.test/verify", title: "Verify your sign in", visibleText: "Enter the verification code we sent you.", forms: [{ label: "Sensitive field", type: "sensitive", name: "" }] })).toBe(true);
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
