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

	it("supports scientific functions, constants, powers, and percentages", () => {
		expect(evaluateCalculatorExpression("sin(30)", { angleUnit: "deg" })).toBe("0.5");
		expect(evaluateCalculatorExpression("sqrt(81) + log(100) + ln(e)")).toBe("12");
		expect(evaluateCalculatorExpression("2pi")).toBe("6.28318530718");
		expect(evaluateCalculatorExpression("2^3^2")).toBe("512");
		expect(evaluateCalculatorExpression("5! + 50%")).toBe("120.5");
	});

	it("supports previous answers in a follow-up expression", () => {
		const answer = evaluateCalculatorExpression("6 * 7");
		expect(answer).toBe("42");
		expect(evaluateCalculatorExpression("ans + 8", { variables: { ans: Number(answer) } })).toBe("50");
	});
});
