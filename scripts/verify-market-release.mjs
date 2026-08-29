import { readFile } from "node:fs/promises";
import process from "node:process";
import {
	fetchHttpsResponse,
	verifyPublicReleaseArtifacts,
} from "./release-distribution-verifier.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const distributionMode = process.argv.includes("--distribution");
const fail = (message) => {
	console.error(`Market release gate failed: ${message}`);
	process.exitCode = 1;
};

const [
	builder,
	developmentBuilder,
	inheritedEntitlements,
	developmentInheritedEntitlements,
	desktopPackage,
	desktopMain,
	productIdentity,
	workflow,
	websiteWorkflow,
	privacy,
	support,
	rootPackage,
	developmentVerifier,
	desktopSmoke,
	desktopSetup,
	workspace,
	afterPack,
	architectureAudit,
	actionReceiptContracts,
	actionReceiptDatabase,
	actionReceiptMigrationSql,
	actionReceiptMigrations,
	actionReceiptBuilder,
	actionReceiptRenderer,
	actionReceiptSmoke,
] = await Promise.all([
	read("apps/desktop/electron-builder.yml"),
	read("apps/desktop/electron-builder.dev.yml"),
	read("apps/desktop/build/entitlements.mac.inherit.plist"),
	read("apps/desktop/build/entitlements.mac.dev.inherit.plist"),
	read("apps/desktop/package.json"),
	read("apps/desktop/src/main/index.ts"),
	read("packages/shared-types/src/identity.ts"),
	read(".github/workflows/release-macos.yml"),
	read(".github/workflows/deploy-website.yml"),
	read("apps/website/src/app/privacy/page.tsx"),
	read("apps/website/src/app/support/page.tsx"),
	read("package.json"),
	read("scripts/verify-development-macos-app.mjs"),
	read("scripts/smoke-desktop.mjs"),
	read("scripts/test-desktop-setup.mjs"),
	read("pnpm-workspace.yaml"),
	read("apps/desktop/build/after-pack.cjs"),
	read("scripts/macos-architecture-audit.cjs"),
	read("packages/shared-types/src/contracts.ts"),
	read("packages/database/src/index.ts"),
	read("packages/database/migrations/011_action_receipts.sql"),
	read("packages/database/src/migrations.ts"),
	read("packages/agent-core/src/action-receipts.ts"),
	read("apps/desktop/src/renderer/App.tsx"),
	read("scripts/test-desktop-chat-configuration.mjs"),
]);

for (const [name, source] of [
	["privacy", privacy],
	["support", support],
]) {
	if (/TODO|TBD|example\.com|your[- ]?(email|company)/i.test(source))
		fail(`${name} route contains a release placeholder.`);
}

for (const marker of [
	"arch: [arm64]",
	"Kestrel-Apple-Silicon-",
	"hardenedRuntime: true",
	"target: dmg",
	"target: zip",
	"target: pkg",
	"provider: generic",
	"${env.KESTREL_UPDATE_URL}",
	"channel: latest",
	'minimumSystemVersion: "13.0.0"',
	"npmRebuild: true",
	"node_modules/@img/sharp-darwin-arm64/**/*",
]) {
	if (!builder.includes(marker))
		fail(`desktop packaging is missing ${marker}.`);
}
for (const forbidden of ["universal", "x64", "mas", "app-store"]) {
	if (builder.toLowerCase().includes(forbidden))
		fail(`desktop packaging still contains unsupported target ${forbidden}.`);
}
for (const marker of [
	"--arm64",
	"uname -m",
	"test:local-ai:real",
	"codesign --verify",
	"stapler validate",
	"spctl --assess",
	"pkgutil --check-signature",
	"lipo -archs",
	'= "arm64"',
	"KESTREL_UPDATE_URL",
	"release/*.dmg",
	"release/*.zip",
	"release/*.pkg",
	"release/*.blockmap",
	"latest-mac.yml",
	"SHA256SUMS",
	"release-manifest.json",
	"MACOSX_DEPLOYMENT_TARGET",
]) {
	if (!workflow.includes(marker))
		fail(`macOS release workflow is missing ${marker}.`);
}
for (const secret of [
	"CSC_LINK",
	"CSC_KEY_PASSWORD",
	"CSC_INSTALLER_LINK",
	"CSC_INSTALLER_KEY_PASSWORD",
	"APPLE_ID",
	"APPLE_APP_SPECIFIC_PASSWORD",
	"APPLE_TEAM_ID",
]) {
	if (!workflow.includes(secret))
		fail(`macOS release workflow is missing ${secret}.`);
}
if (!workflow.includes("test:packaged-desktop:arm64"))
	fail(
		"macOS release workflow does not smoke-test the signed packaged application.",
	);
for (const marker of [
	"actions/configure-pages@",
	"actions/upload-pages-artifact@",
	"actions/deploy-pages@",
	"NEXT_PUBLIC_BASE_PATH",
	"NEXT_PUBLIC_SITE_URL",
	"NEXT_PUBLIC_RELEASE_STATUS == 'verified'",
	"PUBLIC_RELEASE_VERSION",
	"PUBLIC_RELEASE_COMMIT",
	"audit:market -- --distribution",
]) {
	if (!websiteWorkflow.includes(marker))
		fail(`website deployment workflow is missing ${marker}.`);
}
if (
	!desktopPackage.includes('"package:mac:dev"') ||
	!desktopPackage.includes("--arm64") ||
	!desktopPackage.includes("MACOSX_DEPLOYMENT_TARGET=13.0") ||
	!desktopPackage.includes("npm_config_arch=arm64")
)
	fail("desktop development packaging must target arm64.");
for (const marker of [
	"extends: electron-builder.yml",
	"appId: com.kestrel.desktop.dev",
	'identity: "-"',
	"entitlements.mac.dev.inherit.plist",
	"KESTREL_RELEASE_CHANNEL: development",
]) {
	if (!developmentBuilder.includes(marker))
		fail(`desktop development packaging is missing ${marker}.`);
}
if (
	inheritedEntitlements.includes(
		"com.apple.security.cs.disable-library-validation",
	)
)
	fail(
		"production helper entitlements unnecessarily disable library validation.",
	);
if (
	!developmentInheritedEntitlements.includes(
		"com.apple.security.cs.disable-library-validation",
	)
)
	fail(
		"development helper entitlements do not permit the ad-hoc Electron framework identity.",
	);
if (
	!desktopPackage.includes("KESTREL_RELEASE_CHANNEL=development") ||
	!desktopPackage.includes("CSC_FOR_PULL_REQUEST=true") ||
	!desktopPackage.includes("electron-builder.dev.yml")
)
	fail(
		"desktop development packaging must persist and sign its isolated development identity.",
	);
if (!desktopPackage.includes("verify-development-macos-app.mjs"))
	fail(
		"desktop development packaging must verify its documented ad-hoc signature.",
	);
if (!desktopSmoke.includes("--use-mock-keychain"))
	fail(
		"packaged desktop smoke must isolate its test-only keychain from production Safe Storage.",
	);
if (
	!desktopSmoke.includes("runtime-list-action-receipts") ||
	!desktopSmoke.includes("receipt-typed-body-sentinel")
)
	fail(
		"packaged desktop smoke must verify privacy-bounded action-receipt persistence.",
	);
if (!desktopSetup.includes("--use-mock-keychain"))
	fail(
		"desktop setup smoke must isolate its test-only keychain from production Safe Storage.",
	);
if (
	!desktopMain.includes("app.setName(PRODUCT_IDENTITY.runtimeApplicationName)")
)
	fail(
		"desktop startup must preserve its compatibility runtime name for user data.",
	);
if (!desktopMain.includes('appendSwitch("use-mock-keychain")'))
	fail("desktop startup must disable Chromium Keychain Safe Storage.");
for (const marker of [
	'runtimeApplicationName = "Kestrel"',
	"keychainService: `${runtimeApplicationName} Safe Storage`",
	"userDataDirectoryName: runtimeApplicationName",
]) {
	if (!productIdentity.includes(marker))
		fail(`product identity is missing ${marker}.`);
}
for (const marker of [
	'"--verify", "--deep", "--strict"',
	'"Signature=adhoc"',
	'"Identifier=com.kestrel.desktop.dev"',
	'"TeamIdentifier=not set"',
	'"/usr/bin/lipo"',
	'"com.apple.security.cs.disable-library-validation"',
	"LSMinimumSystemVersion",
	"auditPackagedMacApp",
]) {
	if (!developmentVerifier.includes(marker))
		fail(`development app verifier is missing ${marker}.`);
}
if (developmentVerifier.includes('"--sign"'))
	fail(
		"development app verifier must not replace electron-builder's entitlement-aware signing.",
	);
if (
	!desktopPackage.includes('"package:mac:mdm"') ||
	!desktopPackage.includes("--mac pkg")
)
	fail("desktop MDM packaging must provide an arm64 PKG target.");
if (
	/package:mac:universal|test:packaged-desktop:universal/.test(
		`${desktopPackage}\n${rootPackage}`,
	)
)
	fail("universal desktop scripts remain configured.");
if (
	/^supportedArchitectures:/m.test(workspace) ||
	/cpu:\n\s+- x64/.test(workspace)
)
	fail("workspace install still fetches extra CPU families for packaging.");
if (
	!afterPack.includes("auditPackagedMacApp") ||
	!architectureAudit.includes('ALLOWED_ARCHITECTURE = "arm64"') ||
	!architectureAudit.includes("MAXIMUM_MINOS = [13, 0, 0]")
)
	fail(
		"packaged macOS architecture audit must require arm64 binaries that run on macOS 13.",
	);
if (!rootPackage.includes("pnpm test:desktop-setup"))
	fail(
		"the market verification command does not exercise guided local-AI setup.",
	);
if (!rootPackage.includes("pnpm test:desktop-personas"))
	fail(
		"the market verification command does not exercise the full desktop persona matrix.",
	);
if (!rootPackage.includes("pnpm test:desktop-restart-recovery"))
	fail(
		"the market verification command does not exercise Agent Core restart recovery.",
	);
if (!rootPackage.includes("pnpm test:desktop-managed-policy"))
	fail(
		"the market verification command does not exercise signed managed-policy bootstrap.",
	);
if (!rootPackage.includes("pnpm test:desktop-chat-configuration"))
	fail(
		"the market verification command does not exercise consequential action receipts.",
	);
for (const marker of [
	"export const ActionReceiptSchema",
	'trust: z.literal("local_encrypted_bounded")',
	'runtime-list-action-receipts',
]) {
	if (!actionReceiptContracts.includes(marker))
		fail(`the action-receipt contract is missing ${marker}.`);
}
for (const marker of [
	"CREATE TABLE IF NOT EXISTS action_receipts",
	"idx_action_receipts_session_started",
]) {
	if (!actionReceiptMigrationSql.includes(marker))
		fail(`encrypted action-receipt migration is missing ${marker}.`);
}
if (!actionReceiptMigrations.includes('11: "011_action_receipts.sql"'))
	fail(
		"canonical database migrations must register action_receipts as version 11.",
	);
for (const marker of [
	"encryptText(JSON.stringify(parsed)",
	"MAX_ACTION_RECEIPTS_PER_SESSION",
]) {
	if (!actionReceiptDatabase.includes(marker))
		fail(`encrypted action-receipt persistence is missing ${marker}.`);
}
for (const marker of [
	"UNCERTAIN_OUTCOME",
	'const result = outcome === "uncertain" ? undefined',
	'outcome === "verified" && input.execution.verification',
	"Raw tool error text is not copied into receipts.",
	'"workspace.undo"',
	'"agent.config.rollback-preview"',
]) {
	if (!actionReceiptBuilder.includes(marker))
		fail(`the truthful action-receipt builder is missing ${marker}.`);
}
for (const marker of [
	"latestRunActionReceipts",
	"<ActionReceiptList receipts={latestReceipts} />",
	'runtime-list-action-receipts',
]) {
	if (!actionReceiptRenderer.includes(marker))
		fail(`the desktop action-receipt surface is missing ${marker}.`);
}
for (const marker of [
	"receipt-raw-body-sentinel-do-not-display",
	"details.action-receipts",
	'runtime-list-action-receipts',
	"persistedReceipts",
]) {
	if (!actionReceiptSmoke.includes(marker))
		fail(`the desktop action-receipt smoke is missing ${marker}.`);
}

if (distributionMode) {
	const requiredInputs = [
		"PUBLIC_SITE_URL",
		"PUBLIC_SUPPORT_URL",
		"PUBLIC_PRIVACY_URL",
		"PUBLIC_DOWNLOAD_URL",
		"PUBLIC_RELEASE_MANIFEST_URL",
		"PUBLIC_RELEASE_CHECKSUMS_URL",
		"PUBLIC_RELEASE_VERSION",
		"PUBLIC_RELEASE_COMMIT",
		"PUBLIC_PUBLISHER_NAME",
		"PUBLIC_SUPPORT_EMAIL",
		"KESTREL_UPDATE_URL",
	];
	const urls = new Map();

	for (const name of requiredInputs) {
		const value = process.env[name]?.trim();
		if (!value) {
			fail(`${name} is required for distribution.`);
			continue;
		}
		if (
			![
				"PUBLIC_SITE_URL",
				"PUBLIC_SUPPORT_URL",
				"PUBLIC_PRIVACY_URL",
				"PUBLIC_DOWNLOAD_URL",
				"PUBLIC_RELEASE_MANIFEST_URL",
				"PUBLIC_RELEASE_CHECKSUMS_URL",
				"KESTREL_UPDATE_URL",
			].includes(name)
		)
			continue;
		try {
			const url = new URL(value);
			if (url.protocol !== "https:") {
				fail(`${name} must use HTTPS.`);
				continue;
			}
			urls.set(name, url);
		} catch {
			fail(`${name} must be a valid absolute URL.`);
		}
	}

	if (
		process.env.PUBLIC_SUPPORT_EMAIL?.trim() &&
		!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(process.env.PUBLIC_SUPPORT_EMAIL)
	) {
		fail("PUBLIC_SUPPORT_EMAIL must be a valid public email address.");
	}
	const releaseVersion = process.env.PUBLIC_RELEASE_VERSION?.trim() ?? "";
	const releaseCommit = process.env.PUBLIC_RELEASE_COMMIT?.trim() ?? "";
	if (
		releaseVersion &&
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/.test(
			releaseVersion,
		)
	) {
		fail("PUBLIC_RELEASE_VERSION must be a semantic release version.");
	}
	if (releaseCommit && !/^[a-f0-9]{40}$/.test(releaseCommit)) {
		fail("PUBLIC_RELEASE_COMMIT must be a full lowercase Git commit SHA.");
	}

	const artifactSuffixes = [
		["PUBLIC_DOWNLOAD_URL", ".dmg"],
		["PUBLIC_RELEASE_MANIFEST_URL", ".json"],
	];
	for (const [name, suffix] of artifactSuffixes) {
		const url = urls.get(name);
		if (url && !url.pathname.toLowerCase().endsWith(suffix))
			fail(`${name} must point to a ${suffix} release artifact.`);
	}

	const verifyEndpoint = async (name, url, { marker } = {}) => {
		if (!url) return;
		try {
			const response = await fetchHttpsResponse({ url, label: name });
			if (!response.ok) {
				fail(`${name} returned HTTP ${response.status}.`);
				return;
			}
			if (marker) {
				const body = await response.text();
				if (!body.includes(marker))
					fail(`${name} does not contain the expected Kestrel release marker.`);
			}
		} catch (error) {
			fail(
				`${name} could not be verified: ${error instanceof Error ? error.message : String(error)}.`,
			);
		}
	};

	await verifyEndpoint("PUBLIC_SITE_URL", urls.get("PUBLIC_SITE_URL"), {
		marker: "Kestrel",
	});
	await verifyEndpoint("PUBLIC_SUPPORT_URL", urls.get("PUBLIC_SUPPORT_URL"), {
		marker: "Product support",
	});
	await verifyEndpoint("PUBLIC_PRIVACY_URL", urls.get("PUBLIC_PRIVACY_URL"), {
		marker: "Privacy boundary",
	});
	const downloadUrl = urls.get("PUBLIC_DOWNLOAD_URL");
	const manifestUrl = urls.get("PUBLIC_RELEASE_MANIFEST_URL");
	const checksumsUrl = urls.get("PUBLIC_RELEASE_CHECKSUMS_URL");
	const updateBaseUrl = urls.get("KESTREL_UPDATE_URL");
	if (
		releaseVersion &&
		releaseCommit &&
		downloadUrl &&
		manifestUrl &&
		checksumsUrl &&
		updateBaseUrl
	) {
		try {
			await verifyPublicReleaseArtifacts({
				version: releaseVersion,
				expectedCommit: releaseCommit,
				downloadUrl,
				manifestUrl,
				checksumsUrl,
				updateBaseUrl,
			});
		} catch (error) {
			fail(
				`public release artifacts are inconsistent: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}

if (!process.exitCode) {
	console.log(
		`Apple Silicon internet release gate passed (${distributionMode ? "distribution" : "repository"} mode).`,
	);
}
