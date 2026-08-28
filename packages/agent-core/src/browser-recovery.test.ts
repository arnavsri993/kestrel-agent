import { describe, expect, it } from "vitest";
import {
	browserRecoveryReason,
	BrowserRecoveryError,
	toBrowserRecoveryError,
} from "./browser-recovery";

describe("typed browser recovery guidance", () => {
	it.each([
		["Browser target ref is stale. Take a new snapshot.", "stale_target"],
		["Browser target was not found.", "target_missing"],
		[
			"Browser target is obscured or cannot receive pointer input.",
			"obscured",
		],
		["Execution context was destroyed after navigation.", "navigation_changed"],
		["The browser session expired; login is required.", "auth_required"],
		["The isolated browser denied the popup.", "popup_denied"],
		["net::ERR_INTERNET_DISCONNECTED", "network_error"],
	] as const)("classifies %s as %s", (message, reasonCode) => {
		expect(browserRecoveryReason(new Error(message))).toBe(reasonCode);
	});

	it("returns advisory read-only reobservation hints without permitting replay", () => {
		const error = toBrowserRecoveryError(
			new Error("Browser target ref is stale. Take a new snapshot."),
			{
				operation: "act",
				surface: "visible",
				effectState: "possibly_started",
			},
		);

		expect(error).toBeInstanceOf(BrowserRecoveryError);
		expect(error?.recovery).toMatchObject({
			reasonCode: "stale_target",
			effectState: "not_started",
			automaticReplayAllowed: false,
			advisoryOnly: true,
			hints: [
				{
					kind: "snapshot",
					toolName: "browser.visible-snapshot",
					readOnly: true,
					requiresApproval: false,
				},
				{ kind: "reobserve", readOnly: true, requiresApproval: false },
				{ kind: "safe_stop", readOnly: true, requiresApproval: false },
			],
		});
	});

	it("marks authentication handoff as explicit and approval-requiring", () => {
		const error = toBrowserRecoveryError(
			new Error("Authentication expired; sign-in is required."),
			{
				operation: "navigate",
				surface: "isolated",
				effectState: "unknown",
			},
		);

		expect(
			error?.recovery.hints.find((hint) => hint.kind === "auth_handoff"),
		).toMatchObject({
			toolName: "browser.auth-handoff",
			readOnly: false,
			requiresApproval: true,
		});
	});

	it("keeps the more conservative effect state when an observation fails after an action", () => {
		const observationError = toBrowserRecoveryError(
			new Error("Network unavailable."),
			{
				operation: "observe",
				surface: "isolated",
				effectState: "not_started",
			},
		)!;
		const actionError = toBrowserRecoveryError(observationError, {
			operation: "act",
			surface: "isolated",
			effectState: "possibly_started",
		});

		expect(actionError?.recovery).toMatchObject({
			reasonCode: "network_error",
			operation: "act",
			effectState: "possibly_started",
			automaticReplayAllowed: false,
		});
	});

	it.each([
		new Error("Browser target operation timed out."),
		new Error("Browser operation cancelled."),
		"not an error",
	])("does not invent guidance for an unclassified or cancelled failure", (error) => {
		expect(
			toBrowserRecoveryError(error, {
				operation: "act",
				surface: "isolated",
				effectState: "unknown",
			}),
		).toBeUndefined();
	});
});
