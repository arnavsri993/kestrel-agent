import { describe, expect, it } from "vitest";
import {
	classifyAdaptiveFailure,
	decideAdaptiveExecution,
	emptyAdaptiveExecutionBudget,
} from "./adaptive-execution";

describe("adaptive execution", () => {
	it.each([
		[{ code: "ECONNRESET" }, "infrastructure"],
		[{ code: "rate_limit_exceeded", status: 429 }, "provider"],
		[{ status: 401 }, "auth"],
		[{ kind: "mcp_tool_failed" }, "tool"],
		[{ code: "malformed_output" }, "model_reasoning"],
		[{ code: "model_does_not_support_vision" }, "insufficient_capability"],
		[{ code: "invalid_argument" }, "invalid_assumption"],
		[{ code: "validation_failed" }, "verification"],
		[{ code: "ETIMEDOUT" }, "timeout"],
	] as const)("classifies %o as %s", (signal, category) => {
		expect(classifyAdaptiveFailure(signal).category).toBe(category);
	});

	it("does not retain source error text or secrets in classifications or budgets", () => {
		const secret = "sk-private-value";
		const result = decideAdaptiveExecution(
			emptyAdaptiveExecutionBudget(),
			new Error(`provider unavailable ${secret}`),
		);

		expect(result.classification).toEqual({ category: "provider" });
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	it("retries bounded transient failures without escalating them", () => {
		const first = decideAdaptiveExecution(
			emptyAdaptiveExecutionBudget(),
			{ code: "rate_limit_exceeded" },
		);
		expect(first).toMatchObject({
			action: "retry",
			reason: "retry_available",
			budget: { retries: 1, escalations: 0 },
		});

		const second = decideAdaptiveExecution(first.budget, { status: 401 });
		expect(second.action).toBe("retry");
		expect(second.budget.escalations).toBe(0);
	});

	it("escalates only model reasoning, capability, and verification failures", () => {
		for (const signal of [
			{ code: "malformed_output" },
			{ code: "model does not support vision" },
			{ code: "validation_failed" },
		]) {
			const result = decideAdaptiveExecution(emptyAdaptiveExecutionBudget(), signal);
			expect(result.action).toBe("escalate");
		}

		for (const signal of [
			{ code: "ECONNRESET" },
			{ code: "provider_unavailable" },
			{ status: 403 },
			{ kind: "tool_failure" },
			{ code: "ETIMEDOUT" },
		]) {
			const result = decideAdaptiveExecution(emptyAdaptiveExecutionBudget(), signal);
			expect(result.action).not.toBe("escalate");
		}
	});

	it("stops invalid assumptions instead of repeating the same request", () => {
		const result = decideAdaptiveExecution(
			emptyAdaptiveExecutionBudget(),
			{ code: "invalid_argument" },
		);
		expect(result).toMatchObject({ action: "stop", reason: "invalid_assumption" });
	});

	it("prevents an escalation cycle for a repeated category", () => {
		const first = decideAdaptiveExecution(
			emptyAdaptiveExecutionBudget(),
			{ code: "malformed_output" },
		);
		const repeated = decideAdaptiveExecution(first.budget, {
			code: "malformed_output",
		});

		expect(repeated).toMatchObject({
			action: "stop",
			reason: "escalation_cycle_prevented",
			budget: { failures: 2, escalations: 1 },
		});
	});

	it("enforces retry and total failure budgets", () => {
		const policy = { maximumRetries: 1, maximumFailures: 2 };
		const first = decideAdaptiveExecution(
			emptyAdaptiveExecutionBudget(),
			{ code: "ECONNRESET" },
			policy,
		);
		const second = decideAdaptiveExecution(first.budget, { code: "ECONNRESET" }, policy);
		const third = decideAdaptiveExecution(second.budget, { code: "ECONNRESET" }, policy);

		expect(first.action).toBe("retry");
		expect(second).toMatchObject({ action: "stop", reason: "retry_budget_exhausted" });
		expect(third).toMatchObject({ action: "stop", reason: "failure_budget_exhausted" });
	});
});
