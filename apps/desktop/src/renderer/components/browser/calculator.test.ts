import { describe, expect, it } from "vitest";
import { evaluateCalculatorExpression } from "./calculator";

describe("calculator expressions", () => {
	it("respects arithmetic precedence and parentheses", () => {
		expect(evaluateCalculatorExpression("2 + 3 * (4 - 1)")).toBe("11");
	});

	it("supports unary signs and decimals", () => {
		expect(evaluateCalculatorExpression("-2.5 / +0.5")).toBe("-5");
	});

	it("rejects unsafe or incomplete input", () => {
		expect(evaluateCalculatorExpression("2 / 0")).toBeNull();
		expect(evaluateCalculatorExpression("2 + nope")).toBeNull();
		expect(evaluateCalculatorExpression("2 +")).toBeNull();
	});
});
