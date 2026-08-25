import { describe, expect, it } from "vitest";
import {
	evaluateCalculatorExpression,
	evaluateGraphFunction,
	sampleGraph,
} from "./calculator";

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

	it("evaluates graph functions with x and y= notation", () => {
		expect(evaluateGraphFunction("y = x^2 + 1", 3)).toBe(10);
		expect(evaluateGraphFunction("sin(x)", Math.PI / 2)).toBe(1);
		expect(evaluateGraphFunction("unknown(x)", 1)).toBeNull();

		const segments = sampleGraph("x^2", { xMin: -2, xMax: 2, yMin: -1, yMax: 5 }, 40);
		expect(segments).toHaveLength(1);
		expect(segments[0]?.some((point) => point.x === 0 && point.y === 0)).toBe(true);
	});
});
