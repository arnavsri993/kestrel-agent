import { describe, expect, it } from "vitest";
import {
	applyBrowserRecoveryBudget,
	browserRecoveryBlockForTool,
	browserRecoveryGuidanceFromOutput,
	browserRecoveryReason,
	BrowserRecoveryError,
	emptyBrowserRecoveryBudgetState,
	recordBrowserRecoveryToolSuccess,
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

	it("requires a fresh observation before one retry and stops after the repeated failure", () => {
		const recovery = toBrowserRecoveryError(
			new Error("Browser target ref is stale. Take a new snapshot."),
			{ operation: "act", surface: "visible", effectState: "possibly_started" },
		)!.recovery;
		const first = applyBrowserRecoveryBudget(
			emptyBrowserRecoveryBudgetState(),
			recovery,
		);

		expect(first.plan).toMatchObject({
			failureCount: 1,
			maximumFailures: 2,
			phase: "observe_required",
			mutationBlocked: true,
		});
		expect(
			browserRecoveryBlockForTool(
				first.state,
				"browser.visible-act",
				false,
			),
		).toMatchObject({ plan: { phase: "observe_required" } });
		expect(
			browserRecoveryBlockForTool(
				first.state,
				"browser.visible-snapshot",
				false,
			),
		).toBeDefined();

		const observed = recordBrowserRecoveryToolSuccess(
			first.state,
			"browser.visible-snapshot",
			true,
		);
		expect(
			browserRecoveryBlockForTool(
				observed,
				"browser.visible-act",
				false,
			),
		).toBeUndefined();

		const second = applyBrowserRecoveryBudget(observed, recovery);
		expect(second.plan).toMatchObject({
			failureCount: 2,
			maximumFailures: 2,
			phase: "stop_required",
			mutationBlocked: true,
		});
		expect(
			browserRecoveryBlockForTool(
				second.state,
				"browser.visible-act",
				false,
			),
		).toMatchObject({ plan: { phase: "stop_required" } });
	});

	it("blocks replay immediately when an action may already have started", () => {
		const recovery = toBrowserRecoveryError(
			new Error("Execution context was destroyed after navigation."),
			{ operation: "act", surface: "isolated", effectState: "possibly_started" },
		)!.recovery;
		const result = applyBrowserRecoveryBudget(
			emptyBrowserRecoveryBudgetState(),
			recovery,
		);

		expect(result.plan).toMatchObject({
			failureCount: 1,
			maximumFailures: 1,
			phase: "stop_required",
			automaticReplayAllowed: false,
		});
		expect(
			browserRecoveryBlockForTool(result.state, "browser.act", false),
		).toBeDefined();
	});

	it("allows an explicit authentication handoff without reopening arbitrary mutations", () => {
		const recovery = toBrowserRecoveryError(
			new Error("Authentication expired; sign-in is required."),
			{ operation: "navigate", surface: "isolated", effectState: "unknown" },
		)!.recovery;
		const result = applyBrowserRecoveryBudget(
			emptyBrowserRecoveryBudgetState(),
			recovery,
		);

		expect(
			browserRecoveryBlockForTool(
				result.state,
				"browser.auth-handoff",
				false,
			),
		).toBeUndefined();
		expect(
			browserRecoveryBlockForTool(result.state, "browser.act", false),
		).toBeDefined();
		const handedOff = recordBrowserRecoveryToolSuccess(
			result.state,
			"browser.auth-handoff",
			false,
		);
		expect(
			browserRecoveryBlockForTool(handedOff, "browser.act", false),
		).toBeUndefined();
	});

	it("keeps an authentication handoff available across an older surface stop", () => {
		const staleRecovery = toBrowserRecoveryError(
			new Error("Browser target ref is stale. Take a new snapshot."),
			{ operation: "act", surface: "isolated", effectState: "not_started" },
		)!.recovery;
		const firstStale = applyBrowserRecoveryBudget(
			emptyBrowserRecoveryBudgetState(),
			staleRecovery,
		);
		const observed = recordBrowserRecoveryToolSuccess(
			firstStale.state,
			"browser.snapshot",
			true,
		);
		const exhausted = applyBrowserRecoveryBudget(observed, staleRecovery);
		const authRecovery = toBrowserRecoveryError(
			new Error("Authentication expired; sign-in is required."),
			{ operation: "observe", surface: "isolated", effectState: "unknown" },
		)!.recovery;
		const authRequired = applyBrowserRecoveryBudget(
			exhausted.state,
			authRecovery,
		);

		expect(
			browserRecoveryBlockForTool(
				authRequired.state,
				"browser.auth-handoff",
				false,
			),
		).toBeUndefined();
		expect(
			browserRecoveryBlockForTool(
				authRequired.state,
				"browser.navigate",
				false,
			),
		).toBeDefined();
	});

	it("reconstructs allowed recovery tools instead of trusting output hints", () => {
		const recovery = toBrowserRecoveryError(
			new Error("Browser target ref is stale. Take a new snapshot."),
			{ operation: "act", surface: "visible", effectState: "not_started" },
		)!.recovery;
		const parsed = browserRecoveryGuidanceFromOutput({
			recovery: {
				...recovery,
				hints: [
					{
						kind: "snapshot",
						description: "Untrusted widening attempt",
						toolName: "browser.visible-act",
						readOnly: true,
						requiresApproval: false,
					},
				],
			},
		});
		expect(parsed?.hints).toEqual(recovery.hints);
		const budget = applyBrowserRecoveryBudget(
			emptyBrowserRecoveryBudgetState(),
			parsed!,
		);
		expect(budget.plan.allowedToolNames).toEqual([
			"browser.visible-snapshot",
		]);
		expect(
			browserRecoveryBlockForTool(
				budget.state,
				"browser.visible-act",
				false,
			),
		).toBeDefined();
	});
});
