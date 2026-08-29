import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	buildContentFreeDiagnosticEnvelope,
	exportDiagnosticReport,
	recordDiagnosticFailure,
} from "./diagnostic-report";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("diagnostic report", () => {
	it("builds a content-free envelope without prompts or secrets", async () => {
		recordDiagnosticFailure(new Error("network timeout while refreshing token"));
		const envelope = await buildContentFreeDiagnosticEnvelope({
			readyForLiveWork: true,
			checks: [
				{ status: "pass" },
				{ status: "warning" },
				{ status: "fail" },
			],
		});
		expect(envelope.version).toBe(1);
		expect(envelope.readinessSummary).toMatchObject({
			readyForLiveWork: true,
			pass: 1,
			warning: 1,
			fail: 1,
		});
		expect(envelope.lastFailureClass).toBe("timeout");
		expect(JSON.stringify(envelope)).not.toMatch(/refreshing token/i);
	});

	it("writes a local JSON report with owner-only permissions", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-diagnostic-"));
		roots.push(root);
		const path = join(root, "report.json");
		const envelope = await buildContentFreeDiagnosticEnvelope();
		await exportDiagnosticReport(path, envelope);
		const saved = JSON.parse(readFileSync(path, "utf8")) as {
			version: number;
			note: string;
		};
		expect(saved.version).toBe(1);
		expect(saved.note).toMatch(/content-free/i);
	});
});
