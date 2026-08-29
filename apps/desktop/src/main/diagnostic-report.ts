import { app } from "electron";
import { writeFile } from "node:fs/promises";

export interface ContentFreeDiagnosticEnvelope {
	version: 1;
	generatedAt: string;
	appVersion: string;
	platform: string;
	arch: string;
	electron: string;
	packaged: boolean;
	distribution: "developer" | "signed" | "unknown";
	readinessSummary?: {
		readyForLiveWork: boolean;
		pass: number;
		warning: number;
		fail: number;
	};
	lastFailureClass?: string;
	lastFailureAt?: string;
	note: string;
}

let lastFailureClass: string | undefined;
let lastFailureAt: string | undefined;

function readAppVersion(): string {
	try {
		return app.getVersion();
	} catch {
		return "development";
	}
}

function readPackagedState(): boolean {
	try {
		return app.isPackaged;
	} catch {
		return false;
	}
}

function classifyFailure(error: unknown): string {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "unknown_error";
	const normalized = message.toLowerCase();
	if (normalized.includes("abort") || normalized.includes("cancel"))
		return "cancelled";
	if (normalized.includes("timeout")) return "timeout";
	if (normalized.includes("network") || normalized.includes("fetch"))
		return "network";
	if (normalized.includes("permission")) return "permission";
	if (normalized.includes("signature") || normalized.includes("notar"))
		return "distribution";
	return "runtime";
}

export function recordDiagnosticFailure(error: unknown): void {
	lastFailureClass = classifyFailure(error);
	lastFailureAt = new Date().toISOString();
}

export function installDiagnosticFailureHooks(): void {
	process.on("uncaughtException", (error) => {
		recordDiagnosticFailure(error);
	});
	process.on("unhandledRejection", (reason) => {
		recordDiagnosticFailure(reason);
	});
}

export async function buildContentFreeDiagnosticEnvelope(input?: {
	readyForLiveWork?: boolean;
	checks?: Array<{ status: "pass" | "warning" | "fail" }>;
}): Promise<ContentFreeDiagnosticEnvelope> {
	const checks = input?.checks ?? [];
	const packaged = readPackagedState();
	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		appVersion: readAppVersion(),
		platform: process.platform,
		arch: process.arch,
		electron: process.versions.electron,
		packaged,
		distribution: packaged ? "unknown" : "developer",
		...(input
			? {
					readinessSummary: {
						readyForLiveWork: Boolean(input.readyForLiveWork),
						pass: checks.filter((check) => check.status === "pass").length,
						warning: checks.filter((check) => check.status === "warning")
							.length,
						fail: checks.filter((check) => check.status === "fail").length,
					},
				}
			: {}),
		...(lastFailureClass
			? { lastFailureClass, ...(lastFailureAt ? { lastFailureAt } : {}) }
			: {}),
		note:
			"Content-free local diagnostic envelope. No prompts, page content, credentials, file paths, or personal memory are included. Share only after review.",
	};
}

export async function exportDiagnosticReport(
	path: string,
	envelope: ContentFreeDiagnosticEnvelope,
): Promise<void> {
	await writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}
