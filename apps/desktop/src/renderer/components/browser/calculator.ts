export type CalculatorAngleUnit = "deg" | "rad";

export interface CalculatorEvaluationOptions {
	angleUnit?: CalculatorAngleUnit;
	variables?: Record<string, number>;
}

type Operator = "+" | "-" | "*" | "/" | "^" | "!" | "%";

type Token =
	| { kind: "number"; value: number }
	| { kind: "identifier"; value: string }
	| { kind: "operator"; value: Operator }
	| { kind: "parenthesis"; value: "(" | ")" }
	| { kind: "comma" };

const NUMBER_PATTERN = /^(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*/;
const MAX_TOKEN_COUNT = 512;

function tokenize(input: string): Token[] | null {
	if (input.length > 4_096) return null;
	const tokens: Token[] = [];
	let index = 0;

	while (index < input.length) {
		if (tokens.length >= MAX_TOKEN_COUNT) return null;
		const character = input[index]!;
		if (/\s/.test(character)) {
			index += 1;
			continue;
		}
		if (/[+\-*/^!%]/.test(character)) {
			tokens.push({ kind: "operator", value: character as Operator });
			index += 1;
			continue;
		}
		if (character === "(" || character === ")") {
			tokens.push({ kind: "parenthesis", value: character });
			index += 1;
			continue;
		}
		if (character === ",") {
			tokens.push({ kind: "comma" });
			index += 1;
			continue;
		}

		const number = input.slice(index).match(NUMBER_PATTERN)?.[0];
		if (number) {
			const value = Number(number);
			if (!Number.isFinite(value)) return null;
			tokens.push({ kind: "number", value });
			index += number.length;
			continue;
		}

		const identifier = input.slice(index).match(IDENTIFIER_PATTERN)?.[0];
		if (identifier) {
			tokens.push({ kind: "identifier", value: identifier.toLowerCase() });
			index += identifier.length;
			continue;
		}
		return null;
	}

	return tokens.length > 0 ? tokens : null;
}

function normalizedAngleUnit(
	options: CalculatorEvaluationOptions,
): CalculatorAngleUnit {
	return options.angleUnit ?? "rad";
}

function toRadians(value: number, unit: CalculatorAngleUnit): number {
	return unit === "deg" ? (value * Math.PI) / 180 : value;
}

function fromRadians(value: number, unit: CalculatorAngleUnit): number {
	return unit === "deg" ? (value * 180) / Math.PI : value;
}

function isFiniteNumber(value: number): value is number {
	return Number.isFinite(value);
}

function factorial(value: number): number | null {
	if (!Number.isInteger(value) || value < 0 || value > 170) return null;
	let result = 1;
	for (let index = 2; index <= value; index += 1) result *= index;
	return result;
}

function callFunction(
	name: string,
	args: number[],
	options: CalculatorEvaluationOptions,
): number | null {
	const unit = normalizedAngleUnit(options);
	const one = args.length === 1 ? args[0]! : undefined;
	if (one !== undefined) {
		const unaryFunctions: Record<string, (value: number) => number> = {
			abs: Math.abs,
			acos: (value) => fromRadians(Math.acos(value), unit),
			asin: (value) => fromRadians(Math.asin(value), unit),
			atan: (value) => fromRadians(Math.atan(value), unit),
			ceil: Math.ceil,
			cos: (value) => Math.cos(toRadians(value, unit)),
			cosh: Math.cosh,
			cbrt: Math.cbrt,
			exp: Math.exp,
			floor: Math.floor,
			ln: Math.log,
			log: Math.log10,
			log10: Math.log10,
			round: Math.round,
			sin: (value) => Math.sin(toRadians(value, unit)),
			sinh: Math.sinh,
			sqrt: Math.sqrt,
			tan: (value) => Math.tan(toRadians(value, unit)),
			tanh: Math.tanh,
			deg: (value) => fromRadians(value, "deg"),
			rad: (value) => toRadians(value, "deg"),
		};
		const unary = unaryFunctions[name];
		if (unary) {
			const result = unary(one);
			return isFiniteNumber(result) ? result : null;
		}
		if (name === "factorial" || name === "fact") return factorial(one);
	}

	if (name === "min" || name === "max") {
		if (args.length < 1 || args.some((value) => !isFiniteNumber(value))) return null;
		const result = name === "min" ? Math.min(...args) : Math.max(...args);
		return isFiniteNumber(result) ? result : null;
	}
	if (name === "avg" || name === "mean") {
		if (args.length < 1) return null;
		const result = args.reduce((sum, value) => sum + value, 0) / args.length;
		return isFiniteNumber(result) ? result : null;
	}
	if (name === "pow" || name === "mod") {
		if (args.length !== 2) return null;
		const result =
			name === "pow" ? Math.pow(args[0]!, args[1]!) : args[0]! % args[1]!;
		return isFiniteNumber(result) ? result : null;
	}
	return null;
}

class Parser {
	private index = 0;

	constructor(
		private readonly tokens: Token[],
		private readonly options: CalculatorEvaluationOptions,
	) {}

	parse(): number | null {
		const value = this.parseExpression();
		return value !== null && this.index === this.tokens.length ? value : null;
	}

	private parseExpression(): number | null {
		let value = this.parseTerm();
		if (value === null) return null;

		while (this.isOperator("+") || this.isOperator("-")) {
			const operator = this.tokens[this.index++]!;
			const right = this.parseTerm();
			if (right === null) return null;
			value =
				operator.kind === "operator" && operator.value === "+"
					? value + right
					: value - right;
		}
		return value;
	}

	private parseTerm(): number | null {
		let value = this.parseUnary();
		if (value === null) return null;

		while (true) {
			if (this.isOperator("*") || this.isOperator("/")) {
				const operator = this.tokens[this.index++]!;
				const right = this.parseUnary();
				if (
					right === null ||
					(operator.kind === "operator" && operator.value === "/" && right === 0)
				)
					return null;
				value =
					operator.kind === "operator" && operator.value === "*"
						? value * right
						: value / right;
				continue;
			}
			if (this.canStartImplicitProduct()) {
				const right = this.parseUnary();
				if (right === null) return null;
				value *= right;
				continue;
			}
			break;
		}
		return isFiniteNumber(value) ? value : null;
	}

	private parseUnary(): number | null {
		if (this.isOperator("+") || this.isOperator("-")) {
			const operator = this.tokens[this.index++]!;
			const value = this.parseUnary();
			if (value === null) return null;
			return operator.kind === "operator" && operator.value === "-"
				? -value
				: value;
		}
		return this.parsePower();
	}

	private parsePower(): number | null {
		let value = this.parsePrimary();
		if (value === null) return null;

		while (this.isOperator("!") || this.isOperator("%")) {
			const operator = this.tokens[this.index++]!;
			if (operator.kind !== "operator") return null;
			if (operator.value === "!") {
				const next = factorial(value);
				if (next === null) return null;
				value = next;
			} else {
				value /= 100;
			}
		}

		if (this.isOperator("^")) {
			this.index += 1;
			const exponent = this.parseUnary();
			if (exponent === null) return null;
			value = Math.pow(value, exponent);
		}
		return isFiniteNumber(value) ? value : null;
	}

	private parsePrimary(): number | null {
		const token = this.tokens[this.index];
		if (!token) return null;
		if (token.kind === "number") {
			this.index += 1;
			return token.value;
		}
		if (token.kind === "parenthesis" && token.value === "(") {
			this.index += 1;
			const value = this.parseExpression();
			const closing = this.tokens[this.index];
			if (
				value === null ||
				closing?.kind !== "parenthesis" ||
				closing.value !== ")"
			)
				return null;
			this.index += 1;
			return value;
		}
		if (token.kind !== "identifier") return null;

		this.index += 1;
		if (this.isParenthesis("(")) {
			this.index += 1;
			const args: number[] = [];
			if (!this.isParenthesis(")")) {
				while (true) {
					const argument = this.parseExpression();
					if (argument === null) return null;
					args.push(argument);
					if (!this.isComma()) break;
					this.index += 1;
				}
			}
			if (!this.isParenthesis(")")) return null;
			this.index += 1;
			return callFunction(token.value, args, this.options);
		}

		const variables = this.options.variables ?? {};
		const constants: Record<string, number | undefined> = {
			ans: variables.ans,
			e: Math.E,
			pi: Math.PI,
			tau: Math.PI * 2,
		};
		const value = variables[token.value] ?? constants[token.value];
		return value !== undefined && isFiniteNumber(value) ? value : null;
	}

	private canStartImplicitProduct(): boolean {
		const token = this.tokens[this.index];
		return (
			token?.kind === "number" ||
			token?.kind === "identifier" ||
			(token?.kind === "parenthesis" && token.value === "(")
		);
	}

	private isOperator(value: Operator): boolean {
		const token = this.tokens[this.index];
		return token?.kind === "operator" && token.value === value;
	}

	private isParenthesis(value: "(" | ")"): boolean {
		const token = this.tokens[this.index];
		return token?.kind === "parenthesis" && token.value === value;
	}

	private isComma(): boolean {
		return this.tokens[this.index]?.kind === "comma";
	}
}

function parseCalculatorNumber(
	input: string,
	options: CalculatorEvaluationOptions = {},
): number | null {
	const tokens = tokenize(input);
	if (!tokens) return null;
	const value = new Parser(tokens, options).parse();
	return value !== null && isFiniteNumber(value) ? value : null;
}

export function formatCalculatorNumber(value: number): string | null {
	if (!isFiniteNumber(value)) return null;
	if (Object.is(value, -0)) return "0";
	const rounded = Number(value.toPrecision(12));
	return isFiniteNumber(rounded) ? String(rounded) : null;
}

export function evaluateCalculatorExpression(
	input: string,
	options: CalculatorEvaluationOptions = {},
): string | null {
	const value = parseCalculatorNumber(input, options);
	return value === null ? null : formatCalculatorNumber(value);
}
