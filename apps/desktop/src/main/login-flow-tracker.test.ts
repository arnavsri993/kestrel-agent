import { describe, expect, it } from "vitest";
import { LoginFlowTracker, normalizeHttpsOrigin } from "./login-flow-tracker";

describe("normalizeHttpsOrigin", () => {
	it("keeps only the exact HTTPS origin", () => {
		expect(normalizeHttpsOrigin("https://login.example.test:443/step?x=1")).toBe(
			"https://login.example.test",
		);
		expect(normalizeHttpsOrigin("http://login.example.test/login")).toBeUndefined();
		expect(normalizeHttpsOrigin("https://user:secret@login.example.test")).toBeUndefined();
	});
});

describe("LoginFlowTracker", () => {
	it("tracks username-first navigation, opaque selection, and autofill without secrets", () => {
		let clock = 1_000;
		const tracker = new LoginFlowTracker({ now: () => clock, ttlMs: 100 });
		tracker.recordNavigation("tab-1", "https://login.example.test/username");
		tracker.selectCredential("tab-1", "password-opaque-1", "person@example.test");
		clock += 10;
		tracker.markAutofill("tab-1");
		const context = tracker.recordNavigation("tab-1", "https://login.example.test/password");
		expect(context).toMatchObject({
			initiatingOrigin: "https://login.example.test",
			authOrigin: "https://login.example.test",
			selectedCredentialId: "password-opaque-1",
			username: "person@example.test",
			autofillOccurred: true,
			startedAt: 1_000,
			lastActivityAt: 1_010,
			expiresAt: 1_110,
		});
		expect(context).not.toHaveProperty("password");
		expect(JSON.stringify(context)).not.toContain("secret");
	});

	it("records an auth origin and caps navigation history", () => {
		let clock = 0;
		const tracker = new LoginFlowTracker({ now: () => clock, maxNavigationChain: 2 });
		tracker.recordNavigation("tab-1", "https://app.example.test/start");
		tracker.recordNavigation("tab-1", "https://login.example.test/account");
		const context = tracker.recordNavigation("tab-1", "https://login.example.test/check");
		expect(context?.authOrigin).toBe("https://login.example.test");
		expect(context?.navigationChain).toEqual([
			"https://app.example.test",
			"https://login.example.test",
		]);
	});

	it("returns defensive copies and expires aggressively", () => {
		let clock = 0;
		const tracker = new LoginFlowTracker({ now: () => clock, ttlMs: 50 });
		tracker.recordNavigation("tab-1", "https://example.test/login");
		const copy = tracker.readContext("tab-1")!;
		copy.navigationChain.push("https://attacker.test");
		expect(tracker.readContext("tab-1")?.navigationChain).toEqual([
			"https://example.test",
		]);
		clock = 50;
		expect(tracker.readContext("tab-1")).toBeUndefined();
	});

	it("clears one tab or all tabs", () => {
		const tracker = new LoginFlowTracker();
		tracker.recordNavigation("tab-1", "https://one.example.test");
		tracker.recordNavigation("tab-2", "https://two.example.test");
		tracker.clearTab("tab-1");
		expect(tracker.readContext("tab-1")).toBeUndefined();
		expect(tracker.readContext("tab-2")).toBeDefined();
		tracker.clearAll();
		expect(tracker.readContext("tab-2")).toBeUndefined();
	});
});
