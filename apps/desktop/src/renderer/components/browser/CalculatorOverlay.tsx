import {
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Icon } from "../Icon";
import {
	type CalculatorAngleUnit,
	evaluateCalculatorExpression,
	formatCalculatorNumber,
} from "./calculator";

type CalculatorMode = "basic" | "scientific";
type CalculatorAction =
	| "clear"
	| "backspace"
	| "sign"
	| "equals"
	| "angle";

interface CalculatorKey {
	label: string;
	value?: string;
	action?: CalculatorAction;
	className?: string;
	ariaLabel?: string;
}

const basicKeys: CalculatorKey[] = [
	{ label: "AC", action: "clear", className: "utility" },
	{ label: "⌫", action: "backspace", className: "utility", ariaLabel: "Backspace" },
	{ label: "%", value: "%", className: "utility", ariaLabel: "Percent" },
	{ label: "÷", value: "/", className: "operator", ariaLabel: "Divide" },
	{ label: "7", value: "7" },
	{ label: "8", value: "8" },
	{ label: "9", value: "9" },
	{ label: "×", value: "*", className: "operator", ariaLabel: "Multiply" },
	{ label: "4", value: "4" },
	{ label: "5", value: "5" },
	{ label: "6", value: "6" },
	{ label: "−", value: "-", className: "operator", ariaLabel: "Subtract" },
	{ label: "1", value: "1" },
	{ label: "2", value: "2" },
	{ label: "3", value: "3" },
	{ label: "+", value: "+", className: "operator", ariaLabel: "Add" },
	{ label: "±", action: "sign", className: "utility", ariaLabel: "Change sign" },
	{ label: "0", value: "0", className: "wide" },
	{ label: ".", value: "." },
	{ label: "=", action: "equals", className: "equals", ariaLabel: "Calculate" },
];

const scientificKeys: CalculatorKey[] = [
	{ label: "sin", value: "sin(", className: "function", ariaLabel: "Sine" },
	{ label: "cos", value: "cos(", className: "function", ariaLabel: "Cosine" },
	{ label: "tan", value: "tan(", className: "function", ariaLabel: "Tangent" },
	{ label: "ln", value: "ln(", className: "function", ariaLabel: "Natural logarithm" },
	{ label: "log", value: "log(", className: "function", ariaLabel: "Base ten logarithm" },
	{ label: "√", value: "sqrt(", className: "function", ariaLabel: "Square root" },
	{ label: "xʸ", value: "^", className: "function", ariaLabel: "Power" },
	{ label: "x!", value: "!", className: "function", ariaLabel: "Factorial" },
	{ label: "π", value: "pi", className: "constant", ariaLabel: "Pi" },
	{ label: "e", value: "e", className: "constant", ariaLabel: "Euler's number" },
	{ label: "(", value: "(", className: "utility" },
	{ label: ")", value: ")", className: "utility" },
	{ label: "abs", value: "abs(", className: "function", ariaLabel: "Absolute value" },
	{ label: "exp", value: "exp(", className: "function", ariaLabel: "Exponential" },
	{ label: "asin", value: "asin(", className: "function", ariaLabel: "Inverse sine" },
	{ label: "acos", value: "acos(", className: "function", ariaLabel: "Inverse cosine" },
	{ label: "atan", value: "atan(", className: "function", ariaLabel: "Inverse tangent" },
	{ label: "Ans", value: "ans", className: "constant", ariaLabel: "Previous answer" },
];

const modeLabels: Array<{ id: CalculatorMode; label: string; detail: string }> = [
	{ id: "basic", label: "Basic", detail: "Everyday arithmetic" },
	{ id: "scientific", label: "Scientific", detail: "Functions and constants" },
];

function closeCalculator(): void {
	void window.kestrel.request({ type: "browser-close-calculator" });
}

function isContinuation(value: string): boolean {
	return /^[+\-*/^%!)]$/.test(value);
}

function appendToExpression(
	current: string,
	result: string | null,
	value: string,
): { expression: string; result: string | null } {
	if (result === null) return { expression: `${current}${value}`, result: null };
	if (isContinuation(value)) return { expression: `${result}${value}`, result: null };
	if (value === "(") return { expression: `${result}*(`, result: null };
	return { expression: value, result: null };
}

function CalculatorKeypad({
	keys,
	onKey,
}: {
	keys: CalculatorKey[];
	onKey(key: CalculatorKey): void;
}) {
	return (
		<div className="calculator-keypad" role="group" aria-label="Calculator keys">
			{keys.map((key, index) => (
				<button
					type="button"
					key={`${key.label}-${index}`}
					className={`calculator-key ${key.className ?? ""}`}
					aria-label={key.ariaLabel ?? key.label}
					onClick={() => onKey(key)}
				>
					{key.label}
				</button>
			))}
		</div>
	);
}

export function CalculatorOverlay() {
	const [mode, setMode] = useState<CalculatorMode>("basic");
	const [expression, setExpression] = useState("");
	const [result, setResult] = useState<string | null>(null);
	const [answer, setAnswer] = useState<number | undefined>();
	const [error, setError] = useState("");
	const [angleUnit, setAngleUnit] = useState<CalculatorAngleUnit>("deg");
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		inputRef.current?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			closeCalculator();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	useEffect(() => {
		inputRef.current?.focus();
	}, [mode]);

	const expressionOptions = useMemo(
		() => ({
			angleUnit,
			...(answer === undefined ? {} : { variables: { ans: answer } }),
		}),
		[angleUnit, answer],
	);

	function calculate() {
		const next = evaluateCalculatorExpression(expression, expressionOptions);
		if (next === null) {
			setResult(null);
			setError(expression.trim() ? "Check the expression" : "Enter an expression");
			return;
		}
		setResult(next);
		setAnswer(Number(next));
		setError("");
		inputRef.current?.focus();
	}

	function handleExpressionKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter") {
			event.preventDefault();
			calculate();
			return;
		}
		if (result === null) return;
		if (/^[0-9.]$/.test(event.key)) {
			event.preventDefault();
			setExpression(event.key);
			setResult(null);
			setError("");
			return;
		}
		if (/^[+\-*/^%]$/.test(event.key)) {
			event.preventDefault();
			setExpression(`${result}${event.key}`);
			setResult(null);
			setError("");
		}
	}

	function append(value: string) {
		setError("");
		const next = appendToExpression(expression, result, value);
		setExpression(next.expression);
		setResult(next.result);
		inputRef.current?.focus();
	}

	function clear() {
		setExpression("");
		setResult(null);
		setError("");
		inputRef.current?.focus();
	}

	function backspace() {
		setError("");
		setResult(null);
		setExpression((current) => current.slice(0, -1));
		inputRef.current?.focus();
	}

	function changeSign() {
		setError("");
		setResult(null);
		setExpression((current) => {
			if (!current) return "-";
			return current.startsWith("-") ? current.slice(1) : `-${current}`;
		});
		inputRef.current?.focus();
	}

	function handleKey(key: CalculatorKey) {
		if (key.action === "clear") return clear();
		if (key.action === "backspace") return backspace();
		if (key.action === "sign") return changeSign();
		if (key.action === "equals") return calculate();
		if (key.action === "angle") {
			setAngleUnit((current) => (current === "deg" ? "rad" : "deg"));
			return;
		}
		if (key.value) append(key.value);
	}

	function updateMode(nextMode: CalculatorMode) {
		setMode(nextMode);
		setError("");
	}

	return (
		<div className="calculator-overlay">
			<section className={`calculator-card calculator-card-${mode}`} aria-labelledby="calculator-title">
				<header className="calculator-header calculator-drag-handle" title="Drag to move calculator">
					<div className="calculator-heading">
						<span className="calculator-icon" aria-hidden="true">
							<Icon name="calculator" />
						</span>
						<span className="calculator-heading-copy">
							<strong id="calculator-title">Calculator</strong>
							<small>Quick calculations</small>
						</span>
					</div>
					<button
						type="button"
						className="calculator-close"
						aria-label="Close calculator"
						title="Close calculator"
						onClick={closeCalculator}
					>
						<Icon name="close" />
					</button>
				</header>

				<div className="calculator-modes" role="group" aria-label="Calculator mode">
					{modeLabels.map((item) => (
						<button
							type="button"
							key={item.id}
							className={mode === item.id ? "active" : ""}
							aria-pressed={mode === item.id}
							title={item.detail}
							onClick={() => updateMode(item.id)}
						>
							{item.label}
						</button>
					))}
				</div>

				<div className="calculator-mode-panel">
					<div className="calculator-display">
						<div className="calculator-display-topline">
							<span>Expression</span>
							<span>
								{mode === "scientific" && `${angleUnit.toUpperCase()} · `}
								{answer === undefined ? "Ready" : `Ans ${formatCalculatorNumber(answer)}`}
							</span>
						</div>
						<label className="sr-only" htmlFor="calculator-expression">
							Expression
						</label>
						<input
							id="calculator-expression"
							ref={inputRef}
							value={expression}
							placeholder="0"
							inputMode="decimal"
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							aria-describedby="calculator-status"
							onChange={(event) => {
								setExpression(event.target.value);
								setResult(null);
								setError("");
							}}
							onKeyDown={handleExpressionKeyDown}
						/>
						<div className={`calculator-result-row ${error ? "is-error" : ""}`}>
							<span>{error ? "Error" : result ? "Result" : "Ready"}</span>
							<output id="calculator-status" aria-live="polite">
								{error || result || "—"}
							</output>
						</div>
					</div>

					{mode === "scientific" && (
						<section className="calculator-function-section" aria-label="Scientific functions">
							<div className="calculator-section-heading">
								<span>Functions</span>
								<button
									type="button"
									className="calculator-angle-toggle"
									aria-pressed={angleUnit === "deg"}
									aria-label={`Angle unit ${angleUnit === "deg" ? "degrees" : "radians"}`}
									title="Toggle angle unit"
									onClick={() => handleKey({ action: "angle", label: angleUnit.toUpperCase() })}
								>
									{angleUnit.toUpperCase()}
								</button>
							</div>
							<div className="calculator-scientific-keys" role="group" aria-label="Scientific functions">
								{scientificKeys.map((key, index) => (
									<button
										type="button"
										key={`${key.label}-${index}`}
										className={`calculator-key ${key.className ?? ""}`}
										aria-label={key.ariaLabel ?? key.label}
										onClick={() => handleKey(key)}
									>
										{key.label}
									</button>
								))}
							</div>
						</section>
					)}

					<CalculatorKeypad keys={basicKeys} onKey={handleKey} />
				</div>
			</section>
		</div>
	);
}
