import React from "react";

type RecordedError = { message: string; stack?: string; at: string };

let lastGlobalError: RecordedError | null = null;
let globalListenersInstalled = false;
const GLOBAL_LOG_LIMIT = 5;

function describeError(value: unknown): { message: string; stack?: string } {
	if (value instanceof Error)
		return { message: value.message || value.name, ...(value.stack ? { stack: value.stack } : {}) };
	if (typeof value === "string") return { message: value };
	try {
		return { message: JSON.stringify(value) ?? String(value) };
	} catch {
		return { message: String(value) };
	}
}

export function lastRecordedGlobalError(): RecordedError | null {
	return lastGlobalError;
}

export function installGlobalErrorListeners(target: Window = window): void {
	if (globalListenersInstalled) return;
	globalListenersInstalled = true;
	let logged = 0;
	const record = (value: unknown, kind: string) => {
		lastGlobalError = { ...describeError(value), at: new Date().toISOString() };
		if (logged < GLOBAL_LOG_LIMIT) {
			logged += 1;
			console.warn(`[kestrel] ${kind}:`, lastGlobalError.message);
		}
	};
	target.addEventListener("error", (event) => record(event.error ?? event.message, "uncaught error"));
	target.addEventListener("unhandledrejection", (event) =>
		record(event.reason, "unhandled rejection"),
	);
}

export function formatDiagnostics(input: {
	error: unknown;
	componentStack?: string | null;
	reportPath?: string;
	globalError?: RecordedError | null;
}): string {
	const { message, stack } = describeError(input.error);
	const lines = [`Kestrel renderer error: ${message}`, `Time: ${new Date().toISOString()}`];
	if (input.reportPath) lines.push(`Diagnostic report: ${input.reportPath}`);
	if (stack) lines.push("", "Stack:", stack);
	if (input.componentStack) lines.push("", "Component stack:", input.componentStack.trim());
	if (input.globalError && input.globalError.message !== message)
		lines.push("", `Last global error (${input.globalError.at}): ${input.globalError.message}`);
	return lines.join("\n");
}

async function exportDiagnosticReportPath(): Promise<string | undefined> {
	try {
		const response = await window.kestrel?.request({ type: "export-diagnostic-report" });
		if (response?.ok && "diagnosticReportPath" in response && response.diagnosticReportPath)
			return response.diagnosticReportPath;
	} catch {
		// The main process may be the part that failed; copy local details only.
	}
	return undefined;
}

type Props = { children: React.ReactNode };
type State = {
	error: unknown;
	hasError: boolean;
	componentStack: string | null;
	copyState: "idle" | "copying" | "copied" | "failed";
};

export class AppErrorBoundary extends React.Component<Props, State> {
	state: State = { error: null, hasError: false, componentStack: null, copyState: "idle" };

	static getDerivedStateFromError(error: unknown): Partial<State> {
		return { error, hasError: true };
	}

	componentDidCatch(error: unknown, info: React.ErrorInfo): void {
		this.setState({ componentStack: info.componentStack ?? null });
		console.error("[kestrel] renderer crashed:", describeError(error).message);
	}

	private copyDiagnostics = async () => {
		this.setState({ copyState: "copying" });
		const reportPath = await exportDiagnosticReportPath();
		const text = formatDiagnostics({
			error: this.state.error,
			componentStack: this.state.componentStack,
			...(reportPath ? { reportPath } : {}),
			globalError: lastRecordedGlobalError(),
		});
		try {
			await navigator.clipboard.writeText(text);
			this.setState({ copyState: "copied" });
		} catch {
			this.setState({ copyState: "failed" });
		}
	};

	render(): React.ReactNode {
		if (!this.state.hasError) return this.props.children;
		const { copyState } = this.state;
		return (
			<main className="app-error-boundary" role="alert" aria-labelledby="app-error-title">
				<div className="app-error-boundary-card">
					<h1 id="app-error-title">Kestrel hit a problem</h1>
					<p>
						This window stopped responding to an unexpected error. Your conversations, settings,
						and local data are preserved. Reloading usually fixes it.
					</p>
					<div className="app-error-boundary-actions">
						<button type="button" className="button primary" onClick={() => location.reload()}>
							Reload
						</button>
						<button
							type="button"
							className="button secondary"
							disabled={copyState === "copying"}
							onClick={() => void this.copyDiagnostics()}
						>
							{copyState === "copying" ? "Copying…" : "Copy diagnostics"}
						</button>
					</div>
					<p className="app-error-boundary-status" role="status" aria-live="polite">
						{copyState === "copied"
							? "Diagnostics copied to the clipboard."
							: copyState === "failed"
								? "Couldn't access the clipboard."
								: ""}
					</p>
				</div>
			</main>
		);
	}
}
