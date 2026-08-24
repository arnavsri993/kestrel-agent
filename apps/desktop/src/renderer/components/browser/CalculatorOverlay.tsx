import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { evaluateCalculatorExpression } from "./calculator";

type CalculatorAction = "clear" | "backspace" | "sign" | "equals";

interface CalculatorKey {
	label: string;
	value?: string;
	action?: CalculatorAction;
	className?: string;
	ariaLabel?: string;
}

const calculatorKeys: CalculatorKey[] = [
	{ label: "AC", action: "clear", className: "utility" },
	{ label: "⌫", action: "backspace", className: "utility", ariaLabel: "Backspace" },
	{ label: "(", value: "(", className: "utility" },
	{ label: ")", value: ")", className: "utility" },
	{ label: "7", value: "7" },
	{ label: "8", value: "8" },
	{ label: "9", value: "9" },
	{ label: "÷", value: "/", className: "operator", ariaLabel: "Divide" },
	{ label: "4", value: "4" },
	{ label: "5", value: "5" },
	{ label: "6", value: "6" },
	{ label: "×", value: "*", className: "operator", ariaLabel: "Multiply" },
	{ label: "1", value: "1" },
	{ label: "2", value: "2" },
	{ label: "3", value: "3" },
	{ label: "−", value: "-", className: "operator", ariaLabel: "Subtract" },
	{ label: "±", action: "sign", className: "utility", ariaLabel: "Change sign" },
	{ label: "0", value: "0" },
	{ label: ".", value: "." },
	{ label: "+", value: "+", className: "operator", ariaLabel: "Add" },
	{ label: "=", action: "equals", className: "equals", ariaLabel: "Calculate" },
];

export function CalculatorOverlay() {
	const [expression, setExpression] = useState("");
	const [result, setResult] = useState<string | null>(null);
	const [error, setError] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		inputRef.current?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			void window.kestrel.request({ type: "browser-close-calculator" });
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	function calculate() {
		const next = evaluateCalculatorExpression(expression);
		if (next === null) {
			setResult(null);
			setError(expression.trim() ? "Invalid expression" : "Enter an expression");
			return;
		}
		setResult(next);
		setError("");
	}

	function append(value: string) {
		setError("");
		if (result !== null) {
			if (/^[0-9.]$/.test(value)) {
				setExpression(value);
				setResult(null);
				return;
			}
			if (/^[+\-*/]$/.test(value)) {
				setExpression(`${result}${value}`);
				setResult(null);
				return;
			}
			setResult(null);
		}
		setExpression((current) => `${current}${value}`);
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
	}

	function changeSign() {
		setError("");
		if (result !== null) {
			const next = result.startsWith("-") ? result.slice(1) : `-${result}`;
			setExpression(next);
			setResult(next);
			return;
		}
		setExpression((current) => {
			if (!current) return "-";
			return current.startsWith("-") ? current.slice(1) : `-${current}`;
		});
	}

	function handleKey(key: CalculatorKey) {
		if (key.action === "clear") return clear();
		if (key.action === "backspace") return backspace();
		if (key.action === "sign") return changeSign();
		if (key.action === "equals") return calculate();
		if (key.value) append(key.value);
	}

	return (
		<div className="calculator-overlay">
			<section className="calculator-card" aria-labelledby="calculator-title">
				<header className="calculator-header">
					<div className="calculator-heading">
						<span className="calculator-icon" aria-hidden="true">
							<Icon name="calculator" />
						</span>
						<span>
							<strong id="calculator-title">Calculator</strong>
							<small>Floats above this tab</small>
						</span>
					</div>
					<button
						type="button"
						className="calculator-close"
						aria-label="Close calculator"
						title="Close calculator"
						onClick={() =>
							void window.kestrel.request({ type: "browser-close-calculator" })
						}
					>
						<Icon name="close" />
					</button>
				</header>
				<div className="calculator-display">
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
						onKeyDown={(event) => {
							if (event.key !== "Enter") return;
							event.preventDefault();
							calculate();
						}}
					/>
					<output id="calculator-status" aria-live="polite">
						{error || result || "Ready"}
					</output>
				</div>
				<div className="calculator-keypad" role="group" aria-label="Calculator keys">
					{calculatorKeys.map((key) => (
						<button
							type="button"
							key={key.label}
							className={`calculator-key ${key.className ?? ""}`}
							aria-label={key.ariaLabel ?? key.label}
							onClick={() => handleKey(key)}
						>
							{key.label}
						</button>
					))}
				</div>
			</section>
		</div>
	);
}
