type Operator = "+" | "-" | "*" | "/";

type Token =
	| { kind: "number"; value: number }
	| { kind: "operator"; value: Operator }
	| { kind: "parenthesis"; value: "(" | ")" };

function tokenize(input: string): Token[] | null {
	const tokens: Token[] = [];
	let index = 0;

	while (index < input.length) {
		const character = input[index]!;
		if (/\s/.test(character)) {
			index += 1;
			continue;
		}
		if (/[+\-*/]/.test(character)) {
			tokens.push({ kind: "operator", value: character as Operator });
			index += 1;
			continue;
		}
		if (character === "(" || character === ")") {
			tokens.push({ kind: "parenthesis", value: character });
			index += 1;
			continue;
		}
		if (/[0-9.]/.test(character)) {
			const start = index;
			while (index < input.length && /[0-9.]/.test(input[index]!)) index += 1;
			const value = Number(input.slice(start, index));
			if (!Number.isFinite(value)) return null;
			tokens.push({ kind: "number", value });
			continue;
		}
		return null;
	}

	return tokens.length > 0 ? tokens : null;
}

class Parser {
	private index = 0;

	constructor(private readonly tokens: Token[]) {}

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
			value = operator.value === "+" ? value + right : value - right;
		}
		return value;
	}

	private parseTerm(): number | null {
		let value = this.parseFactor();
		if (value === null) return null;

		while (this.isOperator("*") || this.isOperator("/")) {
			const operator = this.tokens[this.index++]!;
			const right = this.parseFactor();
			if (right === null || (operator.value === "/" && right === 0)) return null;
			value = operator.value === "*" ? value * right : value / right;
		}
		return value;
	}

	private parseFactor(): number | null {
		if (this.isOperator("+") || this.isOperator("-")) {
			const operator = this.tokens[this.index++]!;
			const value = this.parseFactor();
			if (value === null) return null;
			return operator.value === "-" ? -value : value;
		}

		const token = this.tokens[this.index];
		if (token?.kind === "number") {
			this.index += 1;
			return token.value;
		}
		if (token?.kind !== "parenthesis" || token.value !== "(") return null;
		this.index += 1;
		const value = this.parseExpression();
		const closing = this.tokens[this.index];
		if (value === null || closing?.kind !== "parenthesis" || closing.value !== ")")
			return null;
		this.index += 1;
		return value;
	}

	private isOperator(value: Operator): boolean {
		const token = this.tokens[this.index];
		return token?.kind === "operator" && token.value === value;
	}
}

export function evaluateCalculatorExpression(input: string): string | null {
	const tokens = tokenize(input);
	if (!tokens) return null;
	const value = new Parser(tokens).parse();
	if (value === null || !Number.isFinite(value)) return null;
	if (Object.is(value, -0)) return "0";
	const rounded = Number(value.toPrecision(12));
	return Number.isFinite(rounded) ? String(rounded) : null;
}
