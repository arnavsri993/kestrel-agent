#!/usr/bin/env node
// Explicit, disposable acceptance canary for the production Native Core
// Keychain path. Never use this against the installed or a user profile.
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { candidateDigest } from "./native-retirement-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supplied = process.env.KESTREL_NATIVE_TEST_APP?.trim();
if (process.platform !== "darwin") throw new Error("This real-Keychain canary only runs on macOS.");
if (process.env.KESTREL_TEST_NATIVE_REAL_CORE_KEYCHAIN !== "1")
	throw new Error("Set KESTREL_TEST_NATIVE_REAL_CORE_KEYCHAIN=1 to opt in. No app was launched.");
if (!supplied) throw new Error("Set KESTREL_NATIVE_TEST_APP to the disposable .tmp candidate. No app was launched.");

const expectedCandidate = resolve(root, ".tmp/native-chromium-host/Kestrel.app");
const candidate = await realpath(resolve(supplied));

const temporaryBuildRoot = await realpath(resolve(root, ".tmp"));
if (candidate !== expectedCandidate || resolve(supplied) !== expectedCandidate ||
	!candidate.startsWith(`${temporaryBuildRoot}/`))
	throw new Error("Candidate must be the exact .tmp/native-chromium-host/Kestrel.app bundle. No app was launched.");
const executable = join(candidate, "Contents/MacOS/Kestrel");
const bundleId = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(candidate, "Contents/Info.plist")], { encoding: "utf8" }).trim();
if (bundleId !== "com.kestrel.native-chromium-host.dev")
	throw new Error("Candidate does not have the expected native development bundle identity. No app was launched.");
await lstat(executable);

const evidence = join(root, ".tmp", `native-real-keychain-evidence-${Date.now()}-${randomUUID()}`);
await mkdir(evidence, { mode: 0o700 });
const evidenceInfo = await lstat(evidence);
if (!evidenceInfo.isDirectory() || evidenceInfo.isSymbolicLink() || evidenceInfo.uid !== process.getuid() || (evidenceInfo.mode & 0o077) !== 0)
	throw new Error("Canary evidence directory is not an owned private directory.");
const profile = await realpath(await mkdtemp(join(tmpdir(), "kestrel-native-real-keychain-")));
await chmod(profile, 0o700);
const profileInfo = await lstat(profile);

if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink() || profileInfo.uid !== process.getuid() || (profileInfo.mode & 0o077) !== 0) {
	await rm(profile, { recursive: true, force: true });
	throw new Error("Generated canary profile is not an owned private directory.");
}
const markerPath = join(profile, ".kestrel-native-test-profile-v1");
const fakeKeyPath = join(profile, ".kestrel-native-test-core-key-v1");
const legacyKeyPath = join(profile, "native-core/database.key");
const databaseDir = join(profile, "native-core/database");
const databasePath = join(databaseDir, "kestrel.sqlite");
const account = createHash("sha256").update(profile).digest("hex");
const fixture = `kestrel-real-keychain-canary:${randomUUID()}`;
let child;
let browser;
let activeEndpoint;
let currentPhase = "preflight";
let profileRemoved = false;
let forcedStop = false;
let childStopped = true;
let firstCandidateDigest;
let sessionId;
let savedProfile = false;
let restartedProfile = false;
let fakeLegacyAbsentChecks = 0;
const receipt = {
	version: 1,
	gate: "native-core-real-keychain-restart",
	optIn: "KESTREL_TEST_NATIVE_REAL_CORE_KEYCHAIN=1",
	candidate: ".tmp/native-chromium-host/Kestrel.app",
	bundleIdentifier: bundleId,
	realBackendPath: "NativeCoreProfileKeyStore::GetOrCreate -> SecurityFrameworkKeychain",
	keychainItem: {
		service: "com.kestrel.native-core.database-key.v1",
		accountSha256: account,
		disposition: "if created, left behind; scoped to this generated temporary profile; no item value read or exported",
	},
	profileCleanup: "pending",
	phases: [],
};

function check(condition, message) {
	if (!condition) throw new Error(message);
}

async function verifyNoFakeOrLegacyKeys() {
	for (const path of [markerPath, fakeKeyPath, legacyKeyPath]) {
		try { await lstat(path); throw new Error("Fake or legacy profile key material unexpectedly exists."); }
		catch (error) { if (error?.code !== "ENOENT") throw error; }
	}
	fakeLegacyAbsentChecks++;
}

async function startCandidate() {
	check(await candidateDigest(candidate) === firstCandidateDigest, "Candidate bundle changed between canary starts.");
	await verifyNoFakeOrLegacyKeys();
	activeEndpoint = undefined;
	let stdoutBuffer = "";
	let stderrBuffer = "";
	let launchFailed = false;
	child = spawn(executable, [
		"--kestrel-chromium-desktop",
		"--kestrel-cache-path", profile,
		"--kestrel-durable-profile",
		"--remote-debugging-port=0",
	], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			TMPDIR: process.env.TMPDIR ?? tmpdir(),
			LANG: process.env.LANG ?? "en_US.UTF-8",
		},
	});
	childStopped = false;
	child.once("error", () => { launchFailed = true; });
	const scanForEndpoint = (stream, which) => {
		stream.setEncoding("utf8");
		stream.on("data", chunk => {
			const next = ((which === "stdout" ? stdoutBuffer : stderrBuffer) + chunk).slice(-4096);
			if (which === "stdout") stdoutBuffer = next;
			else stderrBuffer = next;
			const match = next.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/);
			if (match) activeEndpoint = match[1];
		});
	};
	scanForEndpoint(child.stdout, "stdout");
	scanForEndpoint(child.stderr, "stderr");
	const deadline = Date.now() + 310_000; // Core permits a human Keychain prompt for up to five minutes.
	while (!activeEndpoint && Date.now() < deadline) {
		check(!launchFailed && child.exitCode === null && child.signalCode === null, "Candidate exited before its private Core bridge became ready.");
		await delay(100);
	}
	check(Boolean(activeEndpoint), "Timed out waiting for the candidate after the Keychain prompt window.");
	browser = await chromium.connectOverCDP(activeEndpoint, { noDefaults: true });
	let context = browser.contexts()[0];
	check(Boolean(context), "Candidate did not expose its browser context.");
	let home;
	for (let attempt = 0; attempt < 300; attempt++) {
		check(child.exitCode === null && child.signalCode === null, "Candidate exited before Kestrel Home became ready.");
		home = context.pages().find(page => /chrome-extension:\/\/[^/]+\/index\.html$/.test(page.url()));
		if (home) break;
		if (attempt % 10 === 0) {
			const session = await browser.newBrowserCDPSession();
			let targets;
			try { targets = await session.send("Target.getTargets"); }
			finally { await session.detach().catch(() => {}); }
			const homeExists = targets.targetInfos.some(target => target.type === "page" && /chrome-extension:\/\/[^/]+\/index\.html$/.test(target.url));
			if (homeExists) {
				await browser.close();
				browser = await chromium.connectOverCDP(activeEndpoint, { noDefaults: true });
				context = browser.contexts()[0];
			}
		}
		await delay(100);
	}
	check(Boolean(home), "Kestrel Home did not become ready.");
	await home.waitForFunction(() => typeof window.kestrel?.request === "function", undefined, { timeout: 30_000 });
	return home;
}

async function request(home, value) {
	const result = await home.evaluate(requestValue => window.kestrel.request(requestValue), value);
	check(result?.ok === true, "Native Core request failed.");
	return result;
}

async function stopCandidate() {
	if (browser) { await browser.close().catch(() => {}); browser = undefined; }
	if (!child || child.exitCode !== null || child.signalCode !== null) { childStopped = true; return; }
	const waitForExit = timeout => new Promise(resolveExit => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolveExit({ code: child.exitCode, signal: child.signalCode });
			return;
		}
		const onExit = (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); };
		const timer = setTimeout(() => { child.off("exit", onExit); resolveExit(null); }, timeout);
		timer.unref?.();
		child.once("exit", onExit);
	});
	child.kill("SIGTERM");
	let outcome = await waitForExit(15_000);
	if (!outcome) {
		forcedStop = true;
		child.kill("SIGKILL");
		outcome = await waitForExit(5_000);
	}
	if (!outcome) { childStopped = false; throw new Error("Candidate remains alive after bounded SIGTERM and SIGKILL cleanup."); }
	childStopped = true;
	if (forcedStop) throw new Error("Candidate required SIGKILL; canary is failed despite process cleanup.");
	check(outcome.code === 0 && outcome.signal === null, "Candidate did not exit cleanly.");
}

async function verifyFixtureAbsentFromRawDatabase() {
	const entries = await readdir(databaseDir);
	const databaseFiles = entries.filter(name => name === "kestrel.sqlite" || name.startsWith("kestrel.sqlite-") || name.startsWith("kestrel.sqlite."));
	check(databaseFiles.includes("kestrel.sqlite"), "Native Core database file is missing.");
	const sentinel = Buffer.from(fixture, "utf8");
	for (const name of databaseFiles) {
		const file = join(databaseDir, name);
		const info = await lstat(file);
		check(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid(), "Unexpected Native Core database entry.");
		const bytes = await readFile(file);
		check(!bytes.includes(sentinel), "Generated fixture appeared in raw database bytes.");
	}
}

try {
	firstCandidateDigest = await candidateDigest(candidate);
	receipt.candidateSha256 = firstCandidateDigest;
	currentPhase = "first-start-and-write";
	let home = await startCandidate();
	const created = await request(home, { type: "runtime-create-session", title: "Native Keychain restart canary", kind: "conversation" });
	sessionId = created.session?.id;
	check(typeof sessionId === "string" && sessionId.length > 0, "Native Core did not create the canary session.");
	await request(home, { type: "runtime-append-message", sessionId, role: "user", content: fixture });
	const written = await request(home, { type: "runtime-list-messages", sessionId });
	check(written.messages?.some(message => message.content === fixture), "Native Core did not return the written canary message.");
	await verifyNoFakeOrLegacyKeys();
	check(await lstat(databasePath).then(info => info.isFile()), "Native Core did not create its durable database.");
	savedProfile = true;
	await stopCandidate();
	await verifyFixtureAbsentFromRawDatabase();
	receipt.phases.push({ phase: "real-backend-path-and-encrypted-payload-write", passed: true, observed: "Core opened a durable profile without test/legacy key files; generated content absent from SQLite database/WAL bytes" });

	currentPhase = "restart-and-readback";
	home = await startCandidate();
	const sessions = await request(home, { type: "runtime-list-sessions" });
	check(sessions.sessions?.some(session => session.id === sessionId && session.title === "Native Keychain restart canary"), "Canary session did not survive app restart.");
	const messages = await request(home, { type: "runtime-list-messages", sessionId });
	check(messages.messages?.some(message => message.content === fixture), "Canary message did not decrypt and survive app restart.");
	await verifyNoFakeOrLegacyKeys();
	await verifyFixtureAbsentFromRawDatabase();
	restartedProfile = true;
	await stopCandidate();
	check(await candidateDigest(candidate) === firstCandidateDigest, "Candidate bundle changed during the canary.");
	receipt.phases.push({ phase: "same-candidate-and-profile-restart-readback", passed: true, candidateSha256: firstCandidateDigest, sessionAndMessageRestored: true });
	receipt.result = "passed";
	currentPhase = "complete";
} catch (error) {
	receipt.result = "failed";
	receipt.failedPhase = currentPhase;
	// Deliberately omit exception details: they can contain process or profile data.
	console.error(`Native real-Keychain canary failed during ${currentPhase}. See the bounded receipt for phase status.`);
	process.exitCode = 1;
} finally {
	try { await stopCandidate(); }
	catch {
		receipt.result = "failed";
		receipt.failedPhase ??= "owned-process-cleanup";
		process.exitCode = 1;
	}
	if (forcedStop) {
		receipt.result = "failed";
		receipt.failedPhase ??= "forced-process-cleanup";
		process.exitCode = 1;
	}
	if (childStopped) {
		try {
			await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
			profileRemoved = true;
			receipt.profileCleanup = "generated private temporary profile removed";
		} catch {
			receipt.result = "failed";
			receipt.failedPhase ??= "profile-cleanup";
			process.exitCode = 1;
			receipt.profileCleanup = "cleanup failed; profile retained for inspection";
			receipt.profilePath = profile;
		}
	} else {
		receipt.result = "failed";
		receipt.failedPhase ??= "owned-process-cleanup";
		process.exitCode = 1;
		receipt.profileCleanup = "candidate did not stop; profile retained for diagnosis";
		receipt.profilePath = profile;
	}
	receipt.evidence = {
		firstStartReachedCore: savedProfile,
		restartReadbackPassed: restartedProfile,
		fakeAndLegacyKeyFilesAbsent: fakeLegacyAbsentChecks >= 4,
	};
	await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

if (receipt.result === "passed") console.log("Native real-Keychain Core restart canary passed; generated profile removed, scoped Keychain item left behind.");
