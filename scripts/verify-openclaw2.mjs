import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { MARKDOWN_PATH, renderOpenClaw2Markdown } from "./generate-openclaw2-register.mjs";

export const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
export const REGISTER_PATH = resolve(ROOT, "docs/openclaw-2-behavior-matrix.json");

export const EXPECTED_OPENCLAW_RELEASE = Object.freeze({
	product: "OpenClaw",
	name: "OpenClaw 2.0",
	tag: "v2026.8.1",
	commit: "ea806575e6450e4d1efdfc72c19f04be982a1b9b",
	tagObject: "4d37fc4b0f86ce372d7cb433d1d939ef04f49322",
	releaseUrl: "https://github.com/openclaw/openclaw/releases/tag/v2026.8.1",
	releaseNotesUrl: "https://docs.openclaw.ai/releases/2026.8.1",
});

export const ALLOWED_CLASSIFICATIONS = Object.freeze([
	"verified-existing",
	"implemented-and-verified",
	"intentional-safer-difference",
	"extension-contract-verified",
	"platform-boundary",
	"operator-blocked",
	"unresolved",
]);

const ALLOWED_PRIORITIES = new Set(["P0", "P1", "P2"]);
const FROZEN_RELEASE_BLOCKING_BEHAVIOR_IDS = new Set([
	"oc2.search.local-transcript",
	"oc2.search.restart-privacy",
	"oc2.session.organization",
	"oc2.progress.durable-truth",
	"oc2.progress.delegated-work",
	"oc2.questions.structured-input",
	"oc2.questions.authority",
	"oc2.widgets.sandbox-grants",
	"oc2.widgets.dashboard-export",
	"oc2.credentials.masked-request",
	"oc2.credentials.egress-lifetime",
	"oc2.permissions.exact-recurring",
	"oc2.permissions.denial-revocation",
	"oc2.media.persistence-reload",
	"oc2.media.truthful-failure",
	"oc2.memory.private-recall",
	"oc2.memory.review-gated-consolidation",
	"oc2.models.policy-routing-scope",
	"oc2.sessions.compaction-continuity",
	"oc2.sessions.interruption-uncertainty",
	"oc2.automation.bound-owner",
	"oc2.orchestration.bounded-workers",
	"oc2.remote.paired-supervision",
	"oc2.plugins.artifact-trust",
	"oc2.plugins.update-uninstall",
	"oc2.migration.preview-sanitized",
	"oc2.migration.apply-preserves-source",
	"oc2.migration.unsupported-inventory",
	"oc2.lifecycle.backup-restore-schema",
	"oc2.lifecycle.diagnostics-update-identity",
	"oc2.channels.extension-contract",
	"oc2.browser.approval-recovery",
	"oc2.onboarding.real-route-readiness",
]);
const ALLOWED_REACHABILITY = new Set([
	"desktop-ui",
	"desktop-ui-and-local-index",
	"desktop-ui-and-local-memory",
	"desktop-ui-and-local-index",
	"desktop-ui-and-runtime-events",
	"desktop-ui-and-approval-contract",
	"desktop-ui-and-sandboxed-extension",
	"desktop-ui-and-policy-engine",
	"desktop-ui-and-protected-native-field",
	"desktop-ui-and-provider-capabilities",
	"desktop-ui-and-provider-runtime",
	"desktop-ui-and-runtime",
	"desktop-ui-and-scheduler",
	"desktop-ui-and-signed-extension-contract",
	"desktop-ui-review-surface",
	"desktop-ui-and-cli-migration",
	"desktop-readiness-and-cli",
	"desktop-settings-and-channel-adapters",
	"browser-workspace-and-agent-rail",
	"protected-process-egress",
	"authenticated-paired-web-surface",
	"desktop-onboarding-and-settings",
	"documented-boundary",
	"supported-interface",
]);

const REPOSITORY_PATH = /(?:^|\s)(?:(?:\.\/)?((?:apps|packages|scripts|tests|docs|editors)\/[A-Za-z0-9_./-]+))/g;

function fail(message) {
	throw new Error(message);
}

function requireString(value, label) {
	if (typeof value !== "string" || value.trim() === "")
		fail(`${label} must be a non-empty string.`);
	return value;
}

function requireArray(value, label) {
	if (!Array.isArray(value) || value.length === 0)
		fail(`${label} must be a non-empty array.`);
	return value;
}

function repositoryPaths(command) {
	return [...String(command).matchAll(REPOSITORY_PATH)].map((match) => match[1]);
}

function assertRepositoryFile(root, relativePath, label) {
	const path = requireString(relativePath, label);
	if (path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))
		fail(`${label} must be a relative repository path: ${path}`);
	const absolute = resolve(root, path);
	const rootPrefix = root.endsWith("/") ? root : `${root}/`;
	if (absolute !== root && !absolute.startsWith(rootPrefix))
		fail(`${label} escapes the repository: ${path}`);
	if (!existsSync(absolute) || !statSync(absolute).isFile())
		fail(`${label} does not exist: ${path}`);
}

function loadCatalogIds(root) {
	const catalogPath = resolve(root, "packages/agent-core/src/capability-catalog.ts");
	const source = readFileSync(catalogPath, "utf8");
	return new Set(
		[...source.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]),
	);
}

function loadPackageScripts(root) {
	const packageJson = JSON.parse(
		readFileSync(resolve(root, "package.json"), "utf8"),
	);
	return packageJson.scripts ?? {};
}

function validateCommand(command, root, requiredTestFiles = []) {
	const value = requireString(command, "verificationCommand");
	if (/[;&|<>$`\n\r]/.test(value))
		fail(`verificationCommand contains a shell operator: ${value}`);
	const paths = repositoryPaths(value);
	if (value.startsWith("corepack pnpm exec vitest run ")) {
		for (const path of paths) assertRepositoryFile(root, path, "verificationCommand path");
		if (paths.length === 0 || paths.some((path) => !/\.test\.(?:ts|tsx|mjs|js)$/.test(path)))
			fail(`vitest verificationCommand must reference test files: ${value}`);
		for (const path of requiredTestFiles)
			if (!paths.includes(path))
				fail(`verificationCommand omits test evidence ${path}: ${value}`);
		return { kind: "test", paths };
	}
	const scripts = loadPackageScripts(root);
	const scriptMatch = value.match(/^corepack pnpm ([A-Za-z0-9:_-]+)$/);
	if (scriptMatch) {
		if (!Object.hasOwn(scripts, scriptMatch[1]))
			fail(`verificationCommand references a missing package script ${scriptMatch[1]}.`);
		return { kind: "script", paths };
	}
	const directScriptMatch = value.match(/^(?:node|tsx) ((?:scripts|apps|packages)\/[^\s]+)$/);
	if (directScriptMatch) {
		assertRepositoryFile(root, directScriptMatch[1], "verification script");
		return { kind: "script", paths };
	}
	fail(`Unsupported verificationCommand: ${value}`);
}

function validateRelease(release) {
	if (!release || typeof release !== "object") fail("release is missing.");
	for (const [key, expected] of Object.entries(EXPECTED_OPENCLAW_RELEASE)) {
		if (release[key] !== expected)
			fail(`release.${key} must be ${expected}; received ${String(release[key])}.`);
	}
}

function validateUpstreamSource(source, index) {
	if (!source || typeof source !== "object") fail(`behavior ${index} upstreamSource is missing.`);
	const url = requireString(source.url, `behavior ${index} upstreamSource.url`);
	const official =
		url.startsWith("https://docs.openclaw.ai/") ||
		url.startsWith("https://github.com/openclaw/openclaw/");
	if (!official) fail(`behavior ${index} upstreamSource is not official: ${url}`);
	const sourcePath = requireString(
		source.sourcePath,
		`behavior ${index} upstreamSource.sourcePath`,
	);
	if (!sourcePath.startsWith("docs/"))
		fail(`behavior ${index} upstreamSource.sourcePath must be an OpenClaw docs path: ${sourcePath}`);
	if (source.releaseUrl !== EXPECTED_OPENCLAW_RELEASE.releaseUrl)
		fail(`behavior ${index} upstreamSource.releaseUrl is not pinned to the official release.`);
}

function validateFocusedVerification(focused, root) {
	if (!focused || typeof focused !== "object") fail("focusedVerification is missing.");
	const testFiles = requireArray(focused.testFiles, "focusedVerification.testFiles");
	if (new Set(testFiles).size !== testFiles.length)
		fail("focusedVerification.testFiles contains duplicates.");
	for (const path of testFiles) {
		assertRepositoryFile(root, path, "focusedVerification.testFiles entry");
		if (!/\.test\.(?:ts|tsx|mjs|js)$/.test(path))
			fail(`focused verification entry is not a test file: ${path}`);
	}
	const commands = requireArray(focused.commands, "focusedVerification.commands");
	const commandIds = new Set();
	let aggregateTestPaths = [];
	for (const command of commands) {
		if (!command || typeof command !== "object") fail("focused verification command is invalid.");
		const id = requireString(command.id, "focused verification command id");
		if (commandIds.has(id)) fail(`duplicate focused verification command id: ${id}`);
		commandIds.add(id);
		const result = validateCommand(command.command, root);
		if (result.kind === "test") aggregateTestPaths.push(...result.paths);
	}
	const expected = [...new Set(testFiles)].sort();
	const actual = [...new Set(aggregateTestPaths)].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		fail("focused Vitest command does not exactly cover focusedVerification.testFiles.");
}

function validateBehavior(behavior, index, root, catalogIds, focusedTestFiles) {
	if (!behavior || typeof behavior !== "object") fail(`behavior ${index} is invalid.`);
	const id = requireString(behavior.id, `behavior ${index}.id`);
	if (!/^oc2\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(id)) fail(`behavior ${id} has an invalid stable ID.`);
	if (behavior.behaviorType !== "exact-behavior")
		fail(`behavior ${id} must be marked exact-behavior, not a family-level entry.`);
	const familyId = requireString(behavior.familyId, `behavior ${id}.familyId`);
	if (!catalogIds.has(familyId)) fail(`behavior ${id} references unknown family ${familyId}.`);
	if (familyId === id) fail(`behavior ${id} confuses a family ID with an exact behavior ID.`);
	if (!ALLOWED_PRIORITIES.has(behavior.priority))
		fail(`behavior ${id} has an invalid priority ${String(behavior.priority)}.`);
	if (
		FROZEN_RELEASE_BLOCKING_BEHAVIOR_IDS.has(id) &&
		behavior.priority === "P2"
	)
		fail(`behavior ${id} is frozen P0/P1 and cannot be lowered to P2.`);
	if (!ALLOWED_CLASSIFICATIONS.includes(behavior.classification))
		fail(`behavior ${id} has an unknown classification ${String(behavior.classification)}.`);
	requireString(behavior.userVisibleBehavior, `behavior ${id}.userVisibleBehavior`);
	validateUpstreamSource(behavior.upstreamSource, id);
	if (behavior.openclawTag !== EXPECTED_OPENCLAW_RELEASE.tag)
		fail(`behavior ${id} has a stale OpenClaw tag.`);
	if (behavior.openclawCommit !== EXPECTED_OPENCLAW_RELEASE.commit)
		fail(`behavior ${id} has a mismatched OpenClaw commit.`);
	if (!ALLOWED_REACHABILITY.has(behavior.reachability))
		fail(`behavior ${id} has an invalid reachability classification.`);
	for (const key of [
		"securityPrivacyImplications",
		"migrationImplications",
		"platformBoundary",
		"rationale",
		"notes",
	]) requireString(behavior[key], `behavior ${id}.${key}`);
	const implementationEvidence = requireArray(
		behavior.implementationEvidence,
		`behavior ${id}.implementationEvidence`,
	);
	for (const path of implementationEvidence)
		assertRepositoryFile(root, path, `behavior ${id}.implementationEvidence entry`);
	const testEvidence = requireArray(behavior.testEvidence, `behavior ${id}.testEvidence`);
	for (const path of testEvidence) {
		assertRepositoryFile(root, path, `behavior ${id}.testEvidence entry`);
		if (!/\.test\.(?:ts|tsx|mjs|js)$/.test(path))
			fail(`behavior ${id}.testEvidence must reference a test file: ${path}`);
		if (!focusedTestFiles.has(path))
			fail(`behavior ${id}.testEvidence is not run by the focused verifier: ${path}`);
	}
	const requiresBehavioralEvidence =
		behavior.classification === "verified-existing" ||
		behavior.classification === "implemented-and-verified";
	if (requiresBehavioralEvidence) {
		const behavioralEvidence = requireArray(
			behavior.behavioralTestEvidence,
			`behavior ${id}.behavioralTestEvidence`,
		);
		for (const [evidenceIndex, evidence] of behavioralEvidence.entries()) {
			if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
				fail(`behavior ${id}.behavioralTestEvidence entry ${evidenceIndex} is invalid.`);
			const path = requireString(
				evidence.path,
				`behavior ${id}.behavioralTestEvidence entry ${evidenceIndex}.path`,
			);
			assertRepositoryFile(
				root,
				path,
				`behavior ${id}.behavioralTestEvidence entry ${evidenceIndex}.path`,
			);
			if (!/\.test\.(?:ts|tsx|mjs|js)$/.test(path))
				fail(`behavior ${id}.behavioralTestEvidence must reference a test file: ${path}`);
			if (!focusedTestFiles.has(path))
				fail(`behavior ${id}.behavioralTestEvidence is not run by the focused verifier: ${path}`);
			if (!testEvidence.includes(path))
				fail(`behavior ${id}.behavioralTestEvidence is not included in testEvidence: ${path}`);
			requireString(
				evidence.testName,
				`behavior ${id}.behavioralTestEvidence entry ${evidenceIndex}.testName`,
			);
			if (evidence.evidenceLevel !== "behavioral")
				fail(`behavior ${id}.behavioralTestEvidence must use behavioral evidence, not ${String(evidence.evidenceLevel)}.`);
		}
	}
	validateCommand(behavior.verificationCommand, root, testEvidence);
	if (
		(behavior.classification === "verified-existing" ||
			behavior.classification === "implemented-and-verified") &&
		behavior.reachability === "documented-boundary"
	)
		fail(`behavior ${id} claims executable parity without a reachable interface.`);
	if (
		behavior.classification === "intentional-safer-difference" &&
		!/safer|intentionally|deliberately|conservative/i.test(behavior.rationale)
	)
		fail(`safer difference ${id} is missing its product/security rationale.`);
	if (
		behavior.classification === "extension-contract-verified" &&
		!/contract|extension/i.test(`${behavior.rationale} ${behavior.platformBoundary}`)
	)
		fail(`extension behavior ${id} is missing its tested contract boundary.`);
	if (behavior.classification === "platform-boundary" && behavior.priority !== "P2")
		fail(`platform-boundary behavior ${id} must remain P2.`);
	if (behavior.classification === "operator-blocked" && !/operator|credential|hosting|not available|blocked/i.test(behavior.rationale))
		fail(`operator-blocked behavior ${id} is missing its operator gate rationale.`);
}

export function validateBehaviorRegister(register, options = {}) {
	const root = options.root ?? ROOT;
	if (!register || typeof register !== "object") fail("OpenClaw 2.0 register is not an object.");
	if (register.schemaVersion !== 1) fail("OpenClaw 2.0 register schemaVersion must be 1.");
	if (register.registerType !== "exact-behavior-register")
		fail("OpenClaw 2.0 register type is invalid.");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(requireString(register.generatedAt, "generatedAt")))
		fail("generatedAt must be a deterministic YYYY-MM-DD value.");
	requireString(register.scope, "scope");
	validateRelease(register.release);
	const familyCoverage = register.familyCoverage;
	if (!familyCoverage || familyCoverage.type !== "capability-family")
		fail("familyCoverage must explicitly be capability-family coverage.");
	for (const key of ["catalogPath", "pageAuditPath", "matrixPath", "statusMeaning", "sourceMeaning"])
		requireString(familyCoverage[key], `familyCoverage.${key}`);
	for (const key of ["catalogPath", "pageAuditPath", "matrixPath"])
		assertRepositoryFile(root, familyCoverage[key], `familyCoverage.${key}`);
	if (!/family/i.test(familyCoverage.statusMeaning) || !/exact|behavior/i.test(familyCoverage.sourceMeaning))
		fail("familyCoverage does not explain the family-versus-behavior distinction.");
	validateFocusedVerification(register.focusedVerification, root);
	const catalogIds = loadCatalogIds(root);
	const behaviors = requireArray(register.behaviors, "behaviors");
	const ids = new Set();
	const focusedTestFiles = new Set(register.focusedVerification.testFiles);
	for (let index = 0; index < behaviors.length; index += 1) {
		const id = behaviors[index]?.id;
		if (ids.has(id)) fail(`duplicate behavior ID: ${id}`);
		ids.add(id);
		validateBehavior(behaviors[index], index, root, catalogIds, focusedTestFiles);
	}
	const counts = Object.fromEntries(ALLOWED_CLASSIFICATIONS.map((classification) => [classification, 0]));
	const priorityCounts = { P0: 0, P1: 0, P2: 0 };
	for (const behavior of behaviors) {
		counts[behavior.classification] += 1;
		priorityCounts[behavior.priority] += 1;
		if ((behavior.priority === "P0" || behavior.priority === "P1") && behavior.classification === "unresolved")
			fail(`unresolved ${behavior.priority} behavior is release-blocking: ${behavior.id}`);
	}
	return {
		total: behaviors.length,
		counts,
		priorityCounts,
		unresolvedP0P1: behaviors.filter(
			(behavior) =>
				(behavior.priority === "P0" || behavior.priority === "P1") &&
				behavior.classification === "unresolved",
		).length,
	};
}

export function loadBehaviorRegister(path = REGISTER_PATH) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function readRemoteOpenClawIdentity() {
	let output;
	try {
		output = execFileSync(
			"git",
			[
				"ls-remote",
				EXPECTED_OPENCLAW_RELEASE.releaseUrl.replace(
					"/releases/tag/v2026.8.1",
					".git",
				),
				`refs/tags/${EXPECTED_OPENCLAW_RELEASE.tag}`,
				`refs/tags/${EXPECTED_OPENCLAW_RELEASE.tag}^{}`,
			],
			{ cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (error) {
		const detail = error?.stderr?.toString?.().trim() || error?.message || "unknown git error";
		fail(`could not verify the stable OpenClaw tag remotely: ${detail}`);
	}
	const refs = new Map(
		output
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [sha, ref] = line.trim().split(/\s+/);
				return [ref, sha];
			}),
	);
	if (refs.get(`refs/tags/${EXPECTED_OPENCLAW_RELEASE.tag}`) !== EXPECTED_OPENCLAW_RELEASE.tagObject)
		fail("the official OpenClaw stable tag object changed from the pinned identity.");
	if (refs.get(`refs/tags/${EXPECTED_OPENCLAW_RELEASE.tag}^{}`) !== EXPECTED_OPENCLAW_RELEASE.commit)
		fail("the official OpenClaw stable tag no longer resolves to the pinned immutable commit.");
	return {
		tagObject: refs.get(`refs/tags/${EXPECTED_OPENCLAW_RELEASE.tag}`),
		commit: refs.get(`refs/tags/${EXPECTED_OPENCLAW_RELEASE.tag}^{}`),
	};
}

function runFocusedCommand(command, root) {
	const value = command.trim();
	if (value.startsWith("corepack pnpm exec vitest run ")) {
		const paths = repositoryPaths(value);
		const result = spawnSync(
			"corepack",
			["pnpm", "exec", "vitest", "run", ...paths],
			{ cwd: root, stdio: "inherit" },
		);
		if (result.error) fail(`focused command failed to start: ${result.error.message}`);
		if (result.status !== 0) fail(`focused command exited ${String(result.status)}: ${value}`);
		return;
	}
	const args = value.split(/\s+/);
	if (args.length === 3 && args[0] === "corepack" && args[1] === "pnpm") {
		const result = spawnSync("corepack", ["pnpm", args[2]], { cwd: root, stdio: "inherit" });
		if (result.error) fail(`focused script failed to start: ${result.error.message}`);
		if (result.status !== 0) fail(`focused script exited ${String(result.status)}: ${value}`);
		return;
	}
	fail(`cannot execute unsupported focused verification command: ${value}`);
}

export function runFocusedVerification(register, root = ROOT) {
	for (const command of register.focusedVerification.commands) runFocusedCommand(command.command, root);
}

export async function main() {
	const register = loadBehaviorRegister();
	const summary = validateBehaviorRegister(register);
	const generatedMarkdown = renderOpenClaw2Markdown(register);
	const currentMarkdown = readFileSync(MARKDOWN_PATH, "utf8");
	if (currentMarkdown !== generatedMarkdown)
		fail("docs/openclaw-2-behavior-matrix.md is stale; run corepack pnpm generate:openclaw2.");
	const remote = readRemoteOpenClawIdentity();
	console.log(
		`OpenClaw 2.0 register validated: ${summary.total} exact behaviors; ${summary.priorityCounts.P0} P0, ${summary.priorityCounts.P1} P1, ${summary.priorityCounts.P2} P2; ${summary.unresolvedP0P1} unresolved P0/P1.`,
	);
	console.log(`Stable tag freshness verified: ${EXPECTED_OPENCLAW_RELEASE.tag} -> ${remote.commit}.`);
	runFocusedVerification(register);
	console.log("OpenClaw 2.0 focused verification passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	try {
		await main();
	} catch (error) {
		console.error(`OpenClaw 2.0 verification failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
