import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import type {
	ExtensionCapabilityStatus,
	ExtensionCompatibilityFinding,
	ExtensionCompatibilityReport,
	ExtensionCompatibilityState,
	ExtensionManifestInspection,
	ExtensionRuntimeCheck,
	ExtensionRuntimeVerification,
} from "@kestrel/shared-types";

const MAX_SCAN_FILES = 2_000;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_FILE_BYTES = 512 * 1024;
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".html", ".htm"]);

type CapabilityDefinition = {
	capability: string;
	status: ExtensionCapabilityStatus;
	reason: string;
};

/**
 * This is intentionally a conservative registry.  An API is never promoted
 * from unknown merely because Chromium happens to accept part of it today.
 */
export const EXTENSION_CAPABILITY_REGISTRY: readonly CapabilityDefinition[] = [
	{
		capability: "chrome.storage",
		status: "partial",
		reason:
			"The storage permission can cover chrome.storage.sync, which Electron documents as unsupported; Kestrel only treats a statically observed chrome.storage.local use as fully supported.",
	},
	{
		capability: "chrome.storage.sync",
		status: "unsupported",
		reason: "Electron documents chrome.storage.sync as unsupported.",
	},
	{
		capability: "chrome.storage.managed",
		status: "unsupported",
		reason: "Electron documents chrome.storage.managed as unsupported.",
	},
	{
		capability: "chrome.tabs",
		status: "partial",
		reason:
			"Electron documents selected chrome.tabs operations, not the complete Chrome tabs API surface.",
	},
	{
		capability: "chrome.tabs.query",
		status: "partial",
		reason: "Electron supports only a limited set of chrome.tabs.query fields.",
	},
	{
		capability: "chrome.tabs.update",
		status: "partial",
		reason: "Electron supports only URL and muted updates through chrome.tabs.update.",
	},
	{
		capability: "chrome.storage.local",
		status: "full",
		reason: "Electron documents chrome.storage.local support.",
	},
	{
		capability: "chrome.scripting",
		status: "full",
		reason: "Electron documents chrome.scripting support.",
	},
	{
		capability: "chrome.webRequest",
		status: "full",
		reason: "Electron documents chrome.webRequest support.",
	},
	{
		capability: "chrome.devtools",
		status: "full",
		reason: "Electron documents DevTools extension APIs.",
	},
	{
		capability: "chrome.management",
		status: "partial",
		reason: "Electron documents selected chrome.management APIs, not the whole Chrome surface.",
	},
	{
		capability: "chrome.tabs.sendMessage",
		status: "full",
		reason: "Electron documents chrome.tabs.sendMessage support.",
	},
	{
		capability: "chrome.tabs.reload",
		status: "full",
		reason: "Electron documents chrome.tabs.reload support.",
	},
	{
		capability: "chrome.tabs.executeScript",
		status: "full",
		reason: "Electron documents chrome.tabs.executeScript support.",
	},
	{
		capability: "chrome.runtime.getBackgroundPage",
		status: "full",
		reason: "Electron documents this chrome.runtime method.",
	},
	{
		capability: "chrome.runtime.getManifest",
		status: "full",
		reason: "Electron documents this chrome.runtime method.",
	},
	{
		capability: "chrome.runtime.getPlatformInfo",
		status: "full",
		reason: "Electron documents this chrome.runtime method.",
	},
	{
		capability: "chrome.runtime.getURL",
		status: "full",
		reason: "Electron documents this chrome.runtime method.",
	},
	{
		capability: "chrome.runtime.connect",
		status: "full",
		reason: "Electron documents chrome.runtime.connect support.",
	},
	{
		capability: "chrome.runtime.sendMessage",
		status: "full",
		reason: "Electron documents chrome.runtime.sendMessage support.",
	},
	{
		capability: "chrome.runtime.reload",
		status: "full",
		reason: "Electron documents chrome.runtime.reload support.",
	},
	{
		capability: "chrome.runtime.onMessage",
		status: "full",
		reason: "Electron documents chrome.runtime messaging events.",
	},
	{
		capability: "chrome.runtime.onConnect",
		status: "full",
		reason: "Electron documents chrome.runtime connection events.",
	},
	{
		capability: "chrome.identity",
		status: "unknown",
		reason: "Kestrel has not verified Chrome identity API support in Electron.",
	},
	{
		capability: "chrome.action",
		status: "unknown",
		reason: "Kestrel has not verified extension action behavior in Electron.",
	},
	{
		capability: "chrome.commands",
		status: "unknown",
		reason: "Kestrel has not verified extension command behavior in Electron.",
	},
	{
		capability: "chrome.contextMenus",
		status: "unknown",
		reason: "Kestrel has not verified context menu extension behavior in Electron.",
	},
	{
		capability: "chrome.declarativeNetRequest",
		status: "unknown",
		reason: "Kestrel has not verified declarative net request behavior in Electron.",
	},
	{
		capability: "chrome.cookies",
		status: "unknown",
		reason: "Kestrel has not verified Chrome cookies API support in Electron.",
	},
	{
		capability: "chrome.downloads",
		status: "unknown",
		reason: "Kestrel has not verified Chrome downloads API support in Electron.",
	},
	{
		capability: "chrome.history",
		status: "unknown",
		reason: "Kestrel has not verified Chrome history API support in Electron.",
	},
	{
		capability: "chrome.bookmarks",
		status: "unknown",
		reason: "Kestrel has not verified Chrome bookmarks API support in Electron.",
	},
	{
		capability: "chrome.notifications",
		status: "unknown",
		reason: "Kestrel has not verified Chrome notifications API support in Electron.",
	},
	{
		capability: "chrome.sidePanel",
		status: "unknown",
		reason: "Kestrel has not verified Chrome side panel API support in Electron.",
	},
	{
		capability: "chrome.windows",
		status: "unknown",
		reason: "Kestrel has not verified Chrome windows API support in Electron.",
	},
	{
		capability: "manifest.content_scripts",
		status: "full",
		reason: "Electron documents content script manifest support.",
	},
	{
		capability: "manifest.host_permissions",
		status: "full",
		reason: "Electron documents Manifest V3 host permissions.",
	},
	{
		capability: "manifest.minimum_chrome_version",
		status: "partial",
		reason: "Electron recognizes this manifest key, but Kestrel does not evaluate the requested Chrome version.",
	},
	{
		capability: "manifest.background.service_worker",
		status: "unknown",
		reason: "Kestrel can attempt MV3 worker startup, but Electron's worker diagnostics are experimental.",
	},
	{
		capability: "manifest.background.page",
		status: "full",
		reason: "Electron documents Manifest V2 background page support.",
	},
	{
		capability: "manifest.action",
		status: "unknown",
		reason: "Kestrel does not yet verify extension action behavior.",
	},
	{
		capability: "manifest.commands",
		status: "unknown",
		reason: "Kestrel does not yet verify extension command behavior.",
	},
	{
		capability: "manifest.declarative_net_request",
		status: "unknown",
		reason: "Kestrel has not verified declarative net request support.",
	},
	{
		capability: "manifest.side_panel",
		status: "unknown",
		reason: "Kestrel has not verified side panel support.",
	},
	{
		capability: "manifest.externally_connectable",
		status: "unknown",
		reason: "Kestrel has not verified externally connectable extension behavior.",
	},
	{
		capability: "manifest.web_accessible_resources",
		status: "unknown",
		reason: "Kestrel has not verified web-accessible resource behavior.",
	},
	{
		capability: "manifest.optional_permissions",
		status: "unknown",
		reason: "Kestrel does not implement Chrome's optional-permission grant flow.",
	},
	{
		capability: "manifest.optional_host_permissions",
		status: "unknown",
		reason: "Kestrel does not implement Chrome's optional host-permission grant flow.",
	},
	{
		capability: "manifest.incognito",
		status: "unknown",
		reason: "Kestrel has not verified Chrome extension incognito behavior.",
	},
	{
		capability: "manifest.content_security_policy",
		status: "unknown",
		reason: "Kestrel records this policy but has not separately verified its extension-runtime behavior.",
	},
];

const KNOWN_MANIFEST_KEYS = new Set([
	"name",
	"short_name",
	"description",
	"version",
	"version_name",
	"manifest_version",
	"default_locale",
	"homepage_url",
	"key",
	"permissions",
	"optional_permissions",
	"host_permissions",
	"optional_host_permissions",
	"background",
	"content_scripts",
	"commands",
	"action",
	"browser_action",
	"page_action",
	"side_panel",
	"declarative_net_request",
	"externally_connectable",
	"web_accessible_resources",
	"minimum_chrome_version",
	"incognito",
	"content_security_policy",
	"icons",
	"devtools_page",
	"options_page",
	"options_ui",
	"chrome_url_overrides",
	"sandbox",
	"omnibox",
	"protocol_handlers",
	"oauth2",
]);

/**
 * A manifest permission can expose an API even if the extension's code is
 * generated, minified beyond our scan limit, or loaded later.  Map those
 * permissions to their capability family so "no source hit" never becomes a
 * claim of Chrome compatibility.  Permissions without one API family use a
 * deliberately unknown, permission-scoped finding below.
 */
const DECLARED_PERMISSION_CAPABILITIES: Readonly<Record<string, string>> = {
	activeTab: "permission.activeTab",
	alarms: "chrome.alarms",
	bookmarks: "chrome.bookmarks",
	clipboardRead: "permission.clipboardRead",
	clipboardWrite: "permission.clipboardWrite",
	contextMenus: "chrome.contextMenus",
	cookies: "chrome.cookies",
	debugger: "chrome.debugger",
	declarativeNetRequest: "chrome.declarativeNetRequest",
	declarativeNetRequestFeedback: "chrome.declarativeNetRequest",
	declarativeNetRequestWithHostAccess: "chrome.declarativeNetRequest",
	downloads: "chrome.downloads",
	geolocation: "permission.geolocation",
	history: "chrome.history",
	identity: "chrome.identity",
	idle: "chrome.idle",
	management: "chrome.management",
	nativeMessaging: "chrome.runtime.connectNative",
	notifications: "chrome.notifications",
	pageCapture: "chrome.pageCapture",
	platformKeys: "chrome.platformKeys",
	proxy: "chrome.proxy",
	scripting: "chrome.scripting",
	search: "chrome.search",
	sessions: "chrome.sessions",
	sidePanel: "chrome.sidePanel",
	storage: "chrome.storage",
	tabs: "chrome.tabs",
	topSites: "chrome.topSites",
	unlimitedStorage: "permission.unlimitedStorage",
	webNavigation: "chrome.webNavigation",
	webRequest: "chrome.webRequest",
	webRequestBlocking: "chrome.webRequest",
};

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function strings(value: unknown, maxLength: number): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0 && item.length <= maxLength)
		.slice(0, 200);
}

function countManifestList(value: unknown): number {
	return Array.isArray(value) ? Math.min(value.length, 10_000) : 0;
}

function contentSecurityPolicySummary(value: unknown): string | undefined {
	if (typeof value === "string" && value.length <= 2_000) return value;
	const policy = asObject(value);
	if (!policy) return undefined;
	const keys = Object.keys(policy)
		.filter((key) => typeof policy[key] === "string")
		.slice(0, 20);
	return keys.length > 0 ? `object: ${keys.join(", ")}` : undefined;
}

function manifestInspection(manifest: Record<string, unknown>): ExtensionManifestInspection {
	const background = asObject(manifest.background);
	const commands = asObject(manifest.commands);
	const action = manifest.action ?? manifest.browser_action ?? manifest.page_action;
	const contentSecurityPolicy = contentSecurityPolicySummary(
		manifest.content_security_policy,
	);
	return {
		manifestVersion:
			typeof manifest.manifest_version === "number" &&
			Number.isInteger(manifest.manifest_version) &&
			manifest.manifest_version >= 1 &&
			manifest.manifest_version <= 4
				? manifest.manifest_version
				: null,
		permissions: strings(manifest.permissions, 200),
		optionalPermissions: strings(manifest.optional_permissions, 200),
		hostPermissions: strings(manifest.host_permissions, 2_000),
		optionalHostPermissions: strings(manifest.optional_host_permissions, 2_000),
		contentScriptCount: countManifestList(manifest.content_scripts),
		background:
			typeof background?.service_worker === "string" && background.service_worker
				? "service_worker"
				: typeof background?.page === "string" && background.page
					? "page"
					: "none",
		commands: Object.keys(commands ?? {}).slice(0, 100),
		hasAction: Boolean(action && typeof action === "object"),
		hasSidePanel: Boolean(manifest.side_panel && typeof manifest.side_panel === "object"),
		hasDeclarativeNetRequest: Boolean(manifest.declarative_net_request),
		hasExternallyConnectable: Boolean(manifest.externally_connectable),
		webAccessibleResourceCount: countManifestList(manifest.web_accessible_resources),
		...(typeof manifest.minimum_chrome_version === "string" &&
		manifest.minimum_chrome_version.length <= 100
			? { minimumChromeVersion: manifest.minimum_chrome_version }
			: {}),
		...(typeof manifest.incognito === "string" && manifest.incognito.length <= 100
			? { incognito: manifest.incognito }
			: {}),
		...(contentSecurityPolicy ? { contentSecurityPolicy } : {}),
		unknownManifestKeys: Object.keys(manifest)
			.filter((key) => !KNOWN_MANIFEST_KEYS.has(key))
			.slice(0, 200),
	};
}

function capabilityFor(value: string): CapabilityDefinition {
	const normalized = value.startsWith("browser.")
		? `chrome.${value.slice("browser.".length)}`
		: value;
	const exact = [...EXTENSION_CAPABILITY_REGISTRY]
		.sort((left, right) => right.capability.length - left.capability.length)
		.find(
			(entry) =>
				normalized === entry.capability ||
				normalized.startsWith(`${entry.capability}.`),
		);
	return (
		exact ?? {
			capability: normalized,
			status: "unknown",
			reason: "Kestrel has not verified this Chrome extension capability in Electron.",
		}
	);
}

function findingFor(capability: string, evidence: ExtensionCompatibilityFinding["evidence"]): ExtensionCompatibilityFinding {
	const definition = capabilityFor(capability);
	return {
		capability: definition.capability,
		status: definition.status,
		reason: definition.reason,
		evidence,
	};
}

function findingForDeclaredPermission(
	permission: string,
	evidence: ExtensionCompatibilityFinding["evidence"],
): ExtensionCompatibilityFinding {
	const capability = DECLARED_PERMISSION_CAPABILITIES[permission];
	if (capability) return findingFor(capability, evidence);
	return {
		capability: `permission.${permission}`,
		status: "unknown",
		reason:
			"Kestrel records this declared Chrome extension permission but has not classified its runtime behavior in Electron.",
		evidence,
	};
}

function stableFindings(findings: ExtensionCompatibilityFinding[]): ExtensionCompatibilityFinding[] {
	const selected = new Map<string, ExtensionCompatibilityFinding>();
	const weight: Record<ExtensionCapabilityStatus, number> = {
		unsupported: 5,
		partial: 4,
		unknown: 3,
		emulated: 2,
		full: 1,
	};
	for (const finding of findings) {
		const existing = selected.get(finding.capability);
		if (!existing || weight[finding.status] > weight[existing.status])
			selected.set(finding.capability, finding);
	}
	return [...selected.values()].sort((left, right) =>
		left.capability.localeCompare(right.capability),
	);
}

function stateForFindings(
	findings: readonly ExtensionCompatibilityFinding[],
): ExtensionCompatibilityState {
	if (findings.some((finding) => finding.status === "unsupported"))
		return "unsupported";
	if (findings.some((finding) => finding.status === "partial")) return "partial";
	if (findings.some((finding) => finding.status === "unknown")) return "unknown";
	return "expected_compatible";
}

function summaryForState(state: ExtensionCompatibilityState): string {
	switch (state) {
		case "verified":
			return "Verified after Kestrel reloaded the extension from its persistent profile.";
		case "expected_compatible":
			return "No unsupported requirements were detected. Kestrel will verify persistence on the next browser start.";
		case "partial":
			return "This extension uses capability areas that Electron supports only in part.";
		case "unsupported":
			return "This extension requires a capability Electron documents as unsupported.";
		case "unknown":
			return "This extension uses capability areas Kestrel has not verified in Electron.";
	}
}

export function emptyRuntimeVerification(): ExtensionRuntimeVerification {
	return {
		status: "not_run",
		registered: "not_checked",
		ready: "not_checked",
		backgroundServiceWorker: "not_applicable",
		contentScripts: "not_checked",
		storageLocal: "not_checked",
		extensionAction: "not_checked",
		hostPermissions: "not_checked",
		remainedLoaded: "not_checked",
		persistedAcrossRestart: "not_checked",
		findings: [],
	};
}

function sourceFiles(
	directory: string,
	state: { files: string[]; truncated: boolean },
): void {
	if (state.files.length >= MAX_SCAN_FILES) {
		state.truncated = true;
		return;
	}
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (state.files.length >= MAX_SCAN_FILES) {
			state.truncated = true;
			return;
		}
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) {
			state.truncated = true;
			continue;
		}
		if (entry.isDirectory()) {
			sourceFiles(path, state);
			continue;
		}
		if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
			state.files.push(path);
	}
}

function scanSource(
	extensionDir: string,
): { usages: string[]; filesScanned: number; sourceBytesScanned: number; truncated: boolean; dynamicApiAccessDetected: boolean } {
	const fileState = { files: [] as string[], truncated: false };
	sourceFiles(extensionDir, fileState);
	const usages = new Set<string>();
	let sourceBytesScanned = 0;
	let truncated = fileState.truncated;
	let dynamicApiAccessDetected = false;
	for (const file of fileState.files.sort()) {
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(file);
		} catch {
			truncated = true;
			continue;
		}
		if (!stat.isFile() || stat.isSymbolicLink()) {
			truncated = true;
			continue;
		}
		if (stat.size > MAX_SCAN_FILE_BYTES || sourceBytesScanned + stat.size > MAX_SCAN_BYTES) {
			truncated = true;
			continue;
		}
		let source: string;
		try {
			source = readFileSync(file, "utf8");
		} catch {
			truncated = true;
			continue;
		}
		sourceBytesScanned += Buffer.byteLength(source);
		const apiPattern = /\b(chrome|browser)\s*\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g;
		for (const match of source.matchAll(apiPattern)) {
			const parts = [match[1], match[2], match[3], match[4]].filter(
				(part): part is string => Boolean(part),
			);
			if (parts.length > 1) usages.add(parts.join("."));
		}
		if (/\b(?:chrome|browser)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\[/u.test(source))
			dynamicApiAccessDetected = true;
	}
	return {
		usages: [...usages].sort(),
		filesScanned: fileState.files.length,
		sourceBytesScanned,
		truncated,
		dynamicApiAccessDetected,
	};
}

export function analyzeExtensionCompatibility(
	extensionDir: string,
): ExtensionCompatibilityReport {
	const manifestPath = join(extensionDir, "manifest.json");
	if (!existsSync(manifestPath)) throw new Error("Missing manifest.json in extension directory.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		throw new Error("Unable to parse extension manifest.json.");
	}
	const manifest = asObject(parsed);
	if (!manifest) throw new Error("Invalid extension manifest.");
	const inspection = manifestInspection(manifest);
	const source = scanSource(extensionDir);
	const declaredRequirements = [
		...inspection.permissions.map((permission) => `permission: ${permission}`),
		...inspection.optionalPermissions.map(
			(permission) => `optional permission: ${permission}`,
		),
		...inspection.hostPermissions.map((permission) => `host permission: ${permission}`),
		...inspection.optionalHostPermissions.map(
			(permission) => `optional host permission: ${permission}`,
		),
	];
	const findings: ExtensionCompatibilityFinding[] = [];
	for (const permission of inspection.permissions)
		findings.push(findingForDeclaredPermission(permission, "manifest"));
	for (const permission of inspection.optionalPermissions)
		findings.push(findingForDeclaredPermission(permission, "manifest"));
	if (inspection.contentScriptCount > 0)
		findings.push(findingFor("manifest.content_scripts", "manifest"));
	if (inspection.hostPermissions.length > 0)
		findings.push(findingFor("manifest.host_permissions", "manifest"));
	if (inspection.background === "service_worker")
		findings.push(findingFor("manifest.background.service_worker", "manifest"));
	if (inspection.background === "page")
		findings.push(findingFor("manifest.background.page", "manifest"));
	if (inspection.commands.length > 0)
		findings.push(findingFor("manifest.commands", "manifest"));
	if (inspection.hasAction) findings.push(findingFor("manifest.action", "manifest"));
	if (inspection.hasSidePanel)
		findings.push(findingFor("manifest.side_panel", "manifest"));
	if (inspection.hasDeclarativeNetRequest)
		findings.push(findingFor("manifest.declarative_net_request", "manifest"));
	if (inspection.hasExternallyConnectable)
		findings.push(findingFor("manifest.externally_connectable", "manifest"));
	if (inspection.webAccessibleResourceCount > 0)
		findings.push(findingFor("manifest.web_accessible_resources", "manifest"));
	if (inspection.optionalPermissions.length > 0)
		findings.push(findingFor("manifest.optional_permissions", "manifest"));
	if (inspection.optionalHostPermissions.length > 0)
		findings.push(
			findingFor("manifest.optional_host_permissions", "manifest"),
		);
	if (inspection.minimumChromeVersion)
		findings.push(findingFor("manifest.minimum_chrome_version", "manifest"));
	if (inspection.incognito)
		findings.push(findingFor("manifest.incognito", "manifest"));
	if (inspection.contentSecurityPolicy)
		findings.push(findingFor("manifest.content_security_policy", "manifest"));
	if (inspection.manifestVersion !== 2 && inspection.manifestVersion !== 3) {
		findings.push({
			capability: "manifest.manifest_version",
			status: "unknown",
			reason: "Kestrel has not verified this manifest version in its current extension runtime.",
			evidence: "manifest",
		});
	}
	for (const key of inspection.unknownManifestKeys) {
		findings.push({
			capability: `manifest.${key}`,
			status: "unknown",
			reason: "Kestrel records this manifest key but has not classified its runtime behavior.",
			evidence: "manifest",
		});
	}
	for (const usage of source.usages)
		findings.push(findingFor(usage, "static_analysis"));
	if (source.dynamicApiAccessDetected) {
		findings.push({
			capability: "dynamic Chrome API access",
			status: "unknown",
			reason: "The package accesses a Chrome API through a computed property, so static analysis cannot identify the exact capability.",
			evidence: "static_analysis",
		});
	}
	if (source.truncated) {
		findings.push({
			capability: "static analysis coverage",
			status: "unknown",
			reason: "Kestrel did not scan every source file because a safety limit or unreadable file was encountered.",
			evidence: "static_analysis",
		});
	}
	const stable = stableFindings(findings);
	const state = stateForFindings(stable);
	return {
		state,
		summary: summaryForState(state),
		manifest: inspection,
		declaredRequirements: [...new Set(declaredRequirements)].sort(),
		detectedApiUsage: source.usages,
		findings: stable,
		staticAnalysis: {
			filesScanned: source.filesScanned,
			sourceBytesScanned: source.sourceBytesScanned,
			truncated: source.truncated,
			dynamicApiAccessDetected: source.dynamicApiAccessDetected,
		},
		runtime: emptyRuntimeVerification(),
	};
}

function failedRuntimeFinding(check: string): ExtensionCompatibilityFinding {
	return {
		capability: `runtime ${check}`,
		status: "partial",
		reason: `Kestrel could not complete the ${check} runtime check.`,
		evidence: "runtime",
	};
}

export function compatibilityWithRuntime(
	report: ExtensionCompatibilityReport,
	updates: Partial<
		Pick<
			ExtensionRuntimeVerification,
			| "registered"
			| "ready"
			| "backgroundServiceWorker"
			| "contentScripts"
			| "storageLocal"
			| "extensionAction"
			| "hostPermissions"
			| "remainedLoaded"
			| "persistedAcrossRestart"
		>
		>,
): ExtensionCompatibilityReport {
	const runtime: ExtensionRuntimeVerification = {
		...report.runtime,
		...updates,
		checkedAt: new Date().toISOString(),
		findings: [],
	};
	const checks: Array<[string, ExtensionRuntimeCheck]> = [
		["registration", runtime.registered],
		["extension readiness", runtime.ready],
		["background service worker", runtime.backgroundServiceWorker],
		["content script behavior", runtime.contentScripts],
		["storage initialization", runtime.storageLocal],
		["extension action behavior", runtime.extensionAction],
		["host permission behavior", runtime.hostPermissions],
		["loaded extension observation", runtime.remainedLoaded],
		["restart persistence", runtime.persistedAcrossRestart],
	];
	runtime.findings = checks
		.filter(([, status]) => status === "failed")
		.map(([check]) => failedRuntimeFinding(check));
	const completed = checks.every(
		([, status]) => status === "passed" || status === "not_applicable",
	);
	runtime.status = runtime.findings.length > 0
		? "failed"
		: completed
			? "passed"
			: "not_run";
	const staticState = stateForFindings(report.findings);
	let state = staticState;
	if (
		staticState === "expected_compatible" &&
		runtime.status === "passed"
	)
		state = "verified";
	else if (
		staticState === "expected_compatible" &&
		runtime.status === "failed"
	)
		state = "partial";
	return { ...report, state, summary: summaryForState(state), runtime };
}
