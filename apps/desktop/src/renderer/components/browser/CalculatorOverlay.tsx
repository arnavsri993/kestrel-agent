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
	type GraphBounds,
	evaluateCalculatorExpression,
	formatCalculatorNumber,
	sampleGraph,
} from "./calculator";

type CalculatorMode = "basic" | "scientific" | "graphing";
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

const graphKeys: CalculatorKey[] = [
	{ label: "x", value: "x", className: "constant", ariaLabel: "Variable x" },
	{ label: "sin", value: "sin(", className: "function", ariaLabel: "Sine" },
	{ label: "cos", value: "cos(", className: "function", ariaLabel: "Cosine" },
	{ label: "tan", value: "tan(", className: "function", ariaLabel: "Tangent" },
	{ label: "π", value: "pi", className: "constant", ariaLabel: "Pi" },
	{ label: "^", value: "^", className: "function", ariaLabel: "Power" },
	{ label: "(", value: "(" },
	{ label: ")", value: ")" },
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
	{ label: "0", value: "0" },
	{ label: ".", value: "." },
	{ label: "⌫", action: "backspace", className: "utility", ariaLabel: "Backspace" },
	{ label: "Clear", action: "clear", className: "utility" },
];

const modeLabels: Array<{ id: CalculatorMode; label: string; detail: string }> = [
	{ id: "basic", label: "Basic", detail: "Everyday arithmetic" },
	{ id: "scientific", label: "Scientific", detail: "Functions and constants" },
	{ id: "graphing", label: "Graphing", detail: "Plot y = f(x)" },
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

function GraphPlot({
	expression,
	bounds,
	angleUnit,
}: {
	expression: string;
	bounds: GraphBounds;
	angleUnit: CalculatorAngleUnit;
}) {
	const width = 640;
	const height = 320;
	const segments = useMemo(
		() => sampleGraph(expression, bounds, 420, { angleUnit }),
		[angleUnit, bounds, expression],
	);
	const xTicks = useMemo(() => tickValues(bounds.xMin, bounds.xMax, 8), [bounds.xMin, bounds.xMax]);
	const yTicks = useMemo(() => tickValues(bounds.yMin, bounds.yMax, 6), [bounds.yMin, bounds.yMax]);
	const mapX = (value: number) => ((value - bounds.xMin) / (bounds.xMax - bounds.xMin)) * width;
	const mapY = (value: number) => height - ((value - bounds.yMin) / (bounds.yMax - bounds.yMin)) * height;
	const paths = segments.map((segment) =>
		segment
			.map((point, index) => `${index === 0 ? "M" : "L"}${mapX(point.x).toFixed(2)} ${mapY(point.y).toFixed(2)}`)
			.join(" "),
	);
	const validBounds =
		Number.isFinite(bounds.xMin) &&
		Number.isFinite(bounds.xMax) &&
		Number.isFinite(bounds.yMin) &&
		Number.isFinite(bounds.yMax) &&
		bounds.xMin < bounds.xMax &&
		bounds.yMin < bounds.yMax;
	if (!validBounds)
		return <div className="calculator-plot-empty">Set a smaller minimum than maximum for each axis.</div>;
	const xAxisY = bounds.yMin <= 0 && bounds.yMax >= 0 ? mapY(0) : undefined;
	const yAxisX = bounds.xMin <= 0 && bounds.xMax >= 0 ? mapX(0) : undefined;

	return (
		<div className="calculator-plot" role="img" aria-label={`Graph of ${expression || "the entered function"}`}>
			<svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
				{yTicks.map((tick) => (
					<line
						key={`horizontal-${tick}`}
						x1="0"
						x2={width}
						y1={mapY(tick)}
						y2={mapY(tick)}
						className="calculator-plot-grid"
					/>
				))}
				{xTicks.map((tick) => (
					<line
						key={`vertical-${tick}`}
						x1={mapX(tick)}
						x2={mapX(tick)}
						y1="0"
						y2={height}
						className="calculator-plot-grid"
					/>
				))}
				{xAxisY !== undefined && <line x1="0" x2={width} y1={xAxisY} y2={xAxisY} className="calculator-plot-axis" />}
				{yAxisX !== undefined && <line x1={yAxisX} x2={yAxisX} y1="0" y2={height} className="calculator-plot-axis" />}
				{paths.map((path, index) => (
					<path key={`function-${index}`} d={path} className="calculator-plot-function" />
				))}
			</svg>
			<div className="calculator-plot-labels" aria-hidden="true">
				<span>{formatTick(bounds.xMin)}</span>
				<span>{formatTick(bounds.xMax)}</span>
			</div>
		</div>
	);
}

function tickValues(min: number, max: number, count: number): number[] {
	const step = (max - min) / count;
	return Array.from({ length: count + 1 }, (_, index) => min + step * index);
}

function formatTick(value: number): string {
	return formatCalculatorNumber(value) ?? "—";
}

function numericBound(value: string, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
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
	const [graphExpression, setGraphExpression] = useState("sin(x)");
	const [graphAngleUnit, setGraphAngleUnit] = useState<CalculatorAngleUnit>("rad");
	const [graphBounds, setGraphBounds] = useState<GraphBounds>({
		xMin: -10,
		xMax: 10,
		yMin: -5,
		yMax: 5,
	});
	const inputRef = useRef<HTMLInputElement | null>(null);
	const graphInputRef = useRef<HTMLInputElement | null>(null);

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
		if (mode === "graphing") graphInputRef.current?.focus();
		else inputRef.current?.focus();
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
		if (nextMode === "graphing") graphInputRef.current?.focus();
		else inputRef.current?.focus();
	}

	const graphSegments = useMemo(
		() => sampleGraph(graphExpression, graphBounds, 420, { angleUnit: graphAngleUnit }),
		[graphAngleUnit, graphBounds, graphExpression],
	);
	const graphStatus = !graphExpression.trim()
		? "Enter a function such as sin(x) or x^2."
		: graphSegments.length > 0
			? `${graphSegments.length} curve${graphSegments.length === 1 ? "" : "s"} plotted`
			: "No real values in this view";

	return (
		<div className="calculator-overlay">
			<section className={`calculator-card calculator-card-${mode}`} aria-labelledby="calculator-title">
				<header className="calculator-header calculator-drag-handle" title="Drag to move calculator">
					<div className="calculator-heading">
						<span className="calculator-icon" aria-hidden="true">
							<Icon name="calculator" />
						</span>
						<span>
							<strong id="calculator-title">Calculator</strong>
							<small>Drag this bar to move</small>
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
				<nav className="calculator-modes" aria-label="Calculator mode">
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
				</nav>

				{mode !== "graphing" ? (
					<div className="calculator-mode-panel">
						<div className="calculator-display">
							<div className="calculator-display-topline">
								<span>{mode === "scientific" ? angleUnit.toUpperCase() : "READY"}</span>
								{answer !== undefined && <span>Ans {formatCalculatorNumber(answer)}</span>}
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
							<output id="calculator-status" aria-live="polite">
								{error || result || "Ready"}
							</output>
						</div>
						{mode === "scientific" && (
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
								<button
									type="button"
									className="calculator-key utility"
									aria-label={`Angle unit ${angleUnit === "deg" ? "degrees" : "radians"}`}
									onClick={() => handleKey({ action: "angle", label: angleUnit.toUpperCase() })}
								>
									{angleUnit.toUpperCase()}
								</button>
							</div>
						)}
						<CalculatorKeypad keys={basicKeys} onKey={handleKey} />
					</div>
				) : (
					<div className="calculator-mode-panel calculator-graph-panel">
						<div className="calculator-graph-input">
							<label htmlFor="calculator-graph-expression">y =</label>
							<input
								id="calculator-graph-expression"
								ref={graphInputRef}
								value={graphExpression}
								placeholder="sin(x)"
								autoComplete="off"
								autoCapitalize="off"
								spellCheck={false}
								onChange={(event) => setGraphExpression(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") graphInputRef.current?.blur();
								}}
							/>
						</div>
						<div className="calculator-graph-options">
							{(["xMin", "xMax", "yMin", "yMax"] as const).map((bound) => (
								<label key={bound}>
									<span>{bound.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}</span>
									<input
										type="number"
										step="any"
										value={graphBounds[bound]}
										onChange={(event) =>
											setGraphBounds((current) => ({
												...current,
												[bound]: numericBound(event.target.value, current[bound]),
											}))
										}
									/>
								</label>
							))}
							<button
								type="button"
								className="calculator-angle-toggle"
								aria-pressed={graphAngleUnit === "deg"}
								onClick={() => setGraphAngleUnit((current) => (current === "deg" ? "rad" : "deg"))}
							>
								{graphAngleUnit.toUpperCase()}
							</button>
						</div>
						<GraphPlot expression={graphExpression} bounds={graphBounds} angleUnit={graphAngleUnit} />
						<p className="calculator-graph-status" role="status">
							{graphStatus}
						</p>
						<div className="calculator-graph-keypad" role="group" aria-label="Graphing calculator keys">
							{graphKeys.map((key, index) => (
								<button
									type="button"
									key={`${key.label}-${index}`}
									className={`calculator-key ${key.className ?? ""}`}
									aria-label={key.ariaLabel ?? key.label}
									onClick={() => {
										if (key.action === "clear") {
											setGraphExpression("");
											graphInputRef.current?.focus();
										} else if (key.action === "backspace") {
											setGraphExpression((current) => current.slice(0, -1));
											graphInputRef.current?.focus();
										} else if (key.value) {
											setGraphExpression((current) => `${current}${key.value}`);
											graphInputRef.current?.focus();
										}
									}}
								>
									{key.label}
								</button>
							))}
						</div>
					</div>
				)}
			</section>
		</div>
	);
}
