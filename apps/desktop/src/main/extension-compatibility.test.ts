import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	analyzeExtensionCompatibility,
	compatibilityWithRuntime,
	emptyRuntimeVerification,
} from "./extension-compatibility";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function inspectPackage(
	manifest: Record<string, unknown>,
	files: Record<string, string> = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "kestrel-extension-analysis-"));
	directories.push(directory);
	writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
	for (const [path, source] of Object.entries(files)) {
		const target = join(directory, path);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, source);
	}
	return analyzeExtensionCompatibility(directory);
}

describe("extension compatibility analysis", () => {
	it("reports documented content scripts, host access, and scripting as expected compatible", () => {
		const report = inspectPackage(
			{
				name: "Compatible fixture",
				version: "1.0.0",
				manifest_version: 3,
				host_permissions: ["https://example.test/*"],
				content_scripts: [{ matches: ["https://example.test/*"], js: ["content.js"] }],
				permissions: ["scripting"],
			},
			{
				"content.js":
					"chrome.scripting.executeScript({ target: {} });",
			},
		);

		expect(report.state).toBe("expected_compatible");
		expect(report.declaredRequirements).toEqual([
			"host permission: https://example.test/*",
			"permission: scripting",
		]);
		expect(report.detectedApiUsage).toEqual(["chrome.scripting.executeScript"]);
	});

	it("does not overclaim a generic storage permission when source only names local storage", () => {
		const report = inspectPackage(
			{
				name: "Storage fixture",
				version: "1.0.0",
				manifest_version: 3,
				permissions: ["storage"],
			},
			{ "worker.js": "chrome.storage.local.get('setting');" },
		);

		expect(report.state).toBe("partial");
		expect(report.findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					capability: "chrome.storage",
					status: "partial",
				}),
				expect.objectContaining({
					capability: "chrome.storage.local",
					status: "full",
				}),
			]),
		);
	});

	it("never overclaims explicitly unsupported storage APIs", () => {
		const report = inspectPackage(
			{ name: "Sync fixture", version: "1.0.0", manifest_version: 3 },
			{ "worker.js": "chrome.storage.sync.set({ setting: true });" },
		);

		expect(report.state).toBe("unsupported");
		expect(report.findings).toContainEqual(
			expect.objectContaining({
				capability: "chrome.storage.sync",
				status: "unsupported",
			}),
		);
	});

	it("marks documented limitations as partial rather than full compatibility", () => {
		const report = inspectPackage(
			{ name: "Tabs fixture", version: "1.0.0", manifest_version: 3 },
			{ "worker.js": "chrome.tabs.query({ active: true });" },
		);

		expect(report.state).toBe("partial");
		expect(report.findings).toContainEqual(
			expect.objectContaining({
				capability: "chrome.tabs.query",
				status: "partial",
			}),
		);
	});

	it("keeps unknown and dynamic APIs unverified", () => {
		const report = inspectPackage(
			{
				name: "Unverified fixture",
				version: "1.0.0",
				manifest_version: 3,
				action: {},
			},
			{
				"worker.js": "chrome.identity.getAuthToken(); chrome[apiName].sendMessage({});",
			},
		);

		expect(report.state).toBe("unknown");
		expect(report.staticAnalysis.dynamicApiAccessDetected).toBe(true);
		expect(report.findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ capability: "chrome.identity", status: "unknown" }),
				expect.objectContaining({
					capability: "dynamic Chrome API access",
					status: "unknown",
				}),
			]),
		);
	});

	it("classifies declared API permissions even when package source has no matching text", () => {
		const report = inspectPackage({
			name: "Identity fixture",
			version: "1.0.0",
			manifest_version: 3,
			permissions: ["identity"],
		});

		expect(report.state).toBe("unknown");
		expect(report.findings).toContainEqual(
			expect.objectContaining({ capability: "chrome.identity", status: "unknown" }),
		);
	});

	it.each([
		{
			name: "a toolbar action declaration",
			manifest: { action: {} },
			files: {},
			expectedState: "unknown",
			expectedCapability: "manifest.action",
		},
		{
			name: "a Manifest V3 worker declaration",
			manifest: { background: { service_worker: "worker.js" } },
			files: { "worker.js": "void 0;" },
			expectedState: "unknown",
			expectedCapability: "manifest.background.service_worker",
		},
		{
			name: "a context-menus permission",
			manifest: { permissions: ["contextMenus"] },
			files: {},
			expectedState: "unknown",
			expectedCapability: "chrome.contextMenus",
		},
		{
			name: "a declarative-net-request declaration",
			manifest: {
				permissions: ["declarativeNetRequest"],
				declarative_net_request: { rule_resources: [] },
			},
			files: {},
			expectedState: "unknown",
			expectedCapability: "chrome.declarativeNetRequest",
		},
		{
			name: "documented runtime messaging",
			manifest: {},
			files: { "worker.js": "chrome.runtime.sendMessage({ ready: true });" },
			expectedState: "expected_compatible",
			expectedCapability: "chrome.runtime.sendMessage",
		},
	])(
		"handles $name without matching a hard-coded extension identity",
		({ manifest, files, expectedState, expectedCapability }) => {
			const report = inspectPackage(
				{
					name: "Representative fixture",
					version: "1.0.0",
					manifest_version: 3,
					...manifest,
				},
				files,
			);

			expect(report.state).toBe(expectedState);
			expect(report.findings).toContainEqual(
				expect.objectContaining({ capability: expectedCapability }),
			);
		},
	);

	it("does not turn unchecked runtime evidence into Verified", () => {
		const report = inspectPackage({
			name: "Runtime fixture",
			version: "1.0.0",
			manifest_version: 3,
		});
		const result = compatibilityWithRuntime(report, {
			...emptyRuntimeVerification(),
			registered: "passed",
			ready: "passed",
			backgroundServiceWorker: "not_applicable",
			contentScripts: "not_applicable",
			storageLocal: "not_applicable",
			extensionAction: "not_applicable",
			hostPermissions: "not_applicable",
			remainedLoaded: "passed",
			persistedAcrossRestart: "passed",
		});

		expect(result.runtime.status).toBe("passed");
		expect(result.state).toBe("verified");

		const unchecked = compatibilityWithRuntime(report, {
			registered: "passed",
			ready: "not_checked",
			remainedLoaded: "passed",
			persistedAcrossRestart: "passed",
		});
		expect(unchecked.runtime.status).toBe("not_run");
		expect(unchecked.state).toBe("expected_compatible");
	});
});
