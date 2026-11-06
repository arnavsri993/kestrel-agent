import { app } from "electron";
import { writeFile } from "node:fs/promises";

import { buildDiagnosticEnvelope, type ContentFreeDiagnosticEnvelope } from "./diagnostic-envelope";
export type { ContentFreeDiagnosticEnvelope } from "./diagnostic-envelope";

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
	const packaged = readPackagedState();
	return buildDiagnosticEnvelope({ appVersion: readAppVersion(), platform: process.platform, arch: process.arch,
		runtime: "electron", node: process.versions.node, electron: process.versions.electron, packaged,
		distribution: packaged ? "unknown" : "developer", ...(input ? { readiness: input } : {}),
		lastFailureClass, lastFailureAt });
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
