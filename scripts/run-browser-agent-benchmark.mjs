import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch, platform, release } from "node:os";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { _electron as electron } from "@playwright/test";
import {
	BROWSER_AGENT_BENCHMARK_CORPUS,
	BROWSER_AGENT_BENCHMARK_CORPUS_VERSION,
} from "../benchmarks/browser-agent/corpus-v1.mjs";
import { BrowserAgentBenchmarkFixture } from "./browser-agent-benchmark-fixture.mjs";
import {
	BENCHMARK_REPORT_SCHEMA_VERSION,
	BENCHMARK_TRACK_ID,
	classifyBenchmarkFailure,
	corpusSha256,
	evaluateBenchmarkPredicates,
	predicatesPassed,
	summarizeBenchmarkResults,
	validateBenchmarkCorpus,
} from "./browser-agent-benchmark-lib.mjs";

function usage() {
	return `Kestrel deterministic browser-agent benchmark

Usage:
  pnpm benchmark:browser-agent [--report PATH] [--category NAME]
                               [--workflow ID] [--list] [--allow-failures]

The benchmark invokes Kestrel's real runtime browser tools against two local
loopback fixture origins. It does not call a model or make a live-site request.
`;
}

function parseArguments(argv) {
	const options = {
		report: ".tmp/browser-agent-benchmark/report.json",
		categories: [],
		workflows: [],
		list: false,
		allowFailures: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") {
			process.stdout.write(usage());
			process.exit(0);
		}
		if (argument === "--list") {
			options.list = true;
			continue;
		}
		if (argument === "--allow-failures") {
			options.allowFailures = true;
			continue;
		}
		if (["--report", "--category", "--workflow"].includes(argument)) {
			const value = argv[index + 1];
			if (!value || value.startsWith("--"))
				throw new Error(`${argument} requires a value.`);
			index += 1;
			if (argument === "--report") options.report = value;
			else if (argument === "--category") options.categories.push(value);
			else options.workflows.push(value);
			continue;
		}
		throw new Error(`Unknown benchmark argument: ${argument}`);
	}
	return options;
}

function git(command) {
	try {
		return execFileSync("git", command, { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Directory(path) {
	if (!existsSync(path)) return null;
	const hash = createHash("sha256");
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const absolutePath = join(directory, entry.name);
			const relativePath = relative(path, absolutePath).split(sep).join("/");
			const stat = lstatSync(absolutePath);
			hash.update(`${entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file"}\0${relativePath}\0${stat.mode & 0o777}\0`);
			if (entry.isDirectory()) visit(absolutePath);
			else if (entry.isSymbolicLink()) hash.update(readlinkSync(absolutePath));
			else if (entry.isFile()) hash.update(readFileSync(absolutePath));
		}
	};
	visit(path);
	return hash.digest("hex");
}

function gitBuffer(command) {
	return execFileSync("git", command, {
		encoding: "buffer",
		maxBuffer: 256 * 1024 * 1024,
	});
}

function sourceState() {
	const base = {
		commit: git(["rev-parse", "HEAD"]),
		tree: git(["rev-parse", "HEAD^{tree}"]),
		branch: git(["branch", "--show-current"]),
	};
	try {
		const status = gitBuffer([
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
		]);
		const diff = gitBuffer(["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
		const untracked = gitBuffer([
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
		])
			.toString("utf8")
			.split("\0")
			.filter(Boolean)
			.sort();
		const hash = createHash("sha256")
			.update("status\0")
			.update(status)
			.update("diff\0")
			.update(diff);
		for (const path of untracked) {
			const absolutePath = resolve(path);
			const stat = lstatSync(absolutePath);
			hash.update(`untracked\0${path}\0${stat.mode & 0o777}\0`);
			if (stat.isSymbolicLink()) hash.update(readlinkSync(absolutePath));
			else if (stat.isFile()) hash.update(readFileSync(absolutePath));
		}
		return {
			...base,
			dirty: status.length > 0,
			workingTreeSha256: hash.digest("hex"),
		};
	} catch {
		return { ...base, dirty: null, workingTreeSha256: null };
	}
}

function sanitizeError(error) {
	return String(error instanceof Error ? error.message : error)
		.replaceAll(/https?:\/\/[^\s)]+/g, "[fixture-url]")
		.slice(0, 1_000);
}

function initialMetrics() {
	return {
		actions: 0,
		observations: 0,
		retries: 0,
		failedAttempts: 0,
		interventions: 0,
		approvalGrants: 0,
		scriptedRecoveries: 0,
	};
}

function targetLabel(target) {
	if (typeof target === "string") return target;
	return `${target.role}:${target.name}`;
}

function matchingInteractive(interactive, target) {
	if (!Array.isArray(interactive)) return undefined;
	const role = String(target.role).toLowerCase();
	const name = String(target.name).trim().toLowerCase();
	return interactive.find(
		(candidate) =>
			String(candidate.role ?? "").toLowerCase() === role &&
			String(candidate.name ?? "").trim().toLowerCase() === name &&
			typeof candidate.ref === "string",
	);
}

async function wait(milliseconds) {
	await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const corpusErrors = validateBenchmarkCorpus(BROWSER_AGENT_BENCHMARK_CORPUS);
	if (corpusErrors.length > 0)
		throw new Error(`Invalid benchmark corpus:\n- ${corpusErrors.join("\n- ")}`);
	const unknownCategories = options.categories.filter(
		(category) =>
			!BROWSER_AGENT_BENCHMARK_CORPUS.some(
				(workflow) => workflow.category === category,
			),
	);
	if (unknownCategories.length > 0)
		throw new Error(`Unknown benchmark category: ${unknownCategories.join(", ")}`);
	const unknownWorkflows = options.workflows.filter(
		(id) => !BROWSER_AGENT_BENCHMARK_CORPUS.some((workflow) => workflow.id === id),
	);
	if (unknownWorkflows.length > 0)
		throw new Error(`Unknown benchmark workflow: ${unknownWorkflows.join(", ")}`);
	const selected = BROWSER_AGENT_BENCHMARK_CORPUS.filter(
		(workflow) =>
			(options.categories.length === 0 ||
				options.categories.includes(workflow.category)) &&
			(options.workflows.length === 0 || options.workflows.includes(workflow.id)),
	);
	if (options.list) {
		for (const workflow of selected)
			process.stdout.write(
				`${workflow.id}\t${workflow.category}\t${workflow.expectedOutcome}\t${workflow.title}\n`,
			);
		return;
	}
	if (selected.length === 0) throw new Error("No benchmark workflows selected.");

	const source = sourceState();
	const startedAt = new Date();
	const runToken = randomUUID();
	const root = mkdtempSync(join(tmpdir(), "kestrel-browser-agent-benchmark-"));
	const userData = join(root, "user-data");
	const workspaceRoot = join(root, "workspace");
	mkdirSync(userData, { recursive: true, mode: 0o700 });
	mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	writeFileSync(join(workspaceRoot, "benchmark-upload.txt"), "Bounded Kestrel benchmark upload.\n", {
		mode: 0o600,
	});
	writeFileSync(
		join(userData, "workspace-grants.json"),
		`${JSON.stringify(
			[{ path: realpathSync(workspaceRoot), name: "workspace" }],
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);

	const fixture = new BrowserAgentBenchmarkFixture();
	const results = [];
	let application;
	let page;
	let runtimeSessionId;
	let descriptors = new Map();
	let applicationInfo = {
		appVersion: "unknown",
		electronVersion: "unknown",
		isPackaged: Boolean(process.env.KESTREL_DESKTOP_EXECUTABLE),
		appAsarSha256: null,
		developmentOutSha256: null,
	};
	let fatalError;
	const benchmarkStarted = performance.now();
	try {
		const origins = await fixture.start();
		const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
		const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
		const executablePath = packagedExecutable
			? resolve(packagedExecutable)
			: requireFromDesktop("electron");
		application = await electron.launch({
			executablePath,
			args: packagedExecutable
				? ["--use-mock-keychain"]
				: [resolve("apps/desktop")],
			env: {
				...process.env,
				KESTREL_DISABLE_UPDATES: "1",
				KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1",
				KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
				KESTREL_TEST_USER_DATA: userData,
				KESTREL_REAL_USER_PROFILE: "1",
			},
		});
		page = await application.firstWindow();
		page.setDefaultTimeout(30_000);
		await page.evaluate(() => {
			localStorage.setItem("kestrel:onboarded", "yes");
			localStorage.setItem("kestrel:default-browser-prompted", "yes");
		});
		await page.reload();
		await page.locator("#runtime-prompt").waitFor();
		const appDetails = await application.evaluate(({ app }) => ({
			appVersion: app.getVersion(),
			electronVersion: process.versions.electron ?? "unknown",
			isPackaged: app.isPackaged,
			resourcesPath: process.resourcesPath,
		}));
		const appAsar = join(appDetails.resourcesPath, "app.asar");
			const appAsarSha256 = existsSync(appAsar) ? sha256File(appAsar) : null;
			applicationInfo = {
				appVersion: appDetails.appVersion,
				electronVersion: appDetails.electronVersion,
				isPackaged: appDetails.isPackaged,
				appAsarSha256,
				developmentOutSha256: appDetails.isPackaged
					? null
					: sha256Directory(resolve("apps/desktop/out")),
		};
		const runtime = await page.evaluate(async (workspace) => {
			const created = await window.kestrel.request({
				type: "runtime-create-session",
				title: "Browser-agent benchmark",
				workspaceRoot: workspace,
			});
			if (!created.ok || !created.session)
				throw new Error(created.ok ? "Runtime session was not returned." : created.error);
			const discovered = await window.kestrel.request({
				type: "runtime-discover-tools",
				sessionId: created.session.id,
				query: "browser",
			});
			if (!discovered.ok || !discovered.tools)
				throw new Error(
					discovered.ok ? "Browser tools were not returned." : discovered.error,
				);
			return { sessionId: created.session.id, tools: discovered.tools };
		}, workspaceRoot);
		runtimeSessionId = runtime.sessionId;
		descriptors = new Map(runtime.tools.map((descriptor) => [descriptor.name, descriptor]));
		for (const name of [
			"browser.create",
			"browser.navigate",
			"browser.snapshot",
			"browser.act",
			"browser.screenshot",
			"browser.auth-handoff",
			"browser.upload",
			"browser.downloads",
			"browser.close",
		]) {
			if (!descriptors.has(name))
				throw new Error(`Required Kestrel browser tool is unavailable: ${name}`);
		}

		for (const [workflowIndex, workflow] of selected.entries()) {
			const workflowStarted = performance.now();
			const fixtureRunId = `run-${workflow.id}-${runToken.slice(0, 8)}`;
			fixture.registerRun(fixtureRunId, workflow);
			const metrics = initialMetrics();
			const toolCalls = [];
			const capturedTargets = new Map();
			let browserSessionId;
			let observedOutcome = "failed";
			let failureClass = "none";
			let failureDetail;
			let ordinal = 0;
			let closeAttempted = false;

			const callTool = async (toolName, input, { expectFailure = false } = {}) => {
				const descriptor = descriptors.get(toolName);
				if (!descriptor)
					throw new Error(`Benchmark tool descriptor is unavailable: ${toolName}`);
				ordinal += 1;
				const mutating = descriptor.readOnly !== true;
				const idempotencyKey = mutating
					? `browser-benchmark:${fixtureRunId}:${ordinal}:${toolName}`
					: undefined;
					if (mutating) {
						metrics.actions += 1;
						metrics.approvalGrants += 1;
					} else metrics.observations += 1;
				const callStarted = performance.now();
				const requestPromise = page.evaluate(
					async ({ sessionId, toolName, input, options }) => {
						const result = await window.kestrel.request({
							type: "runtime-call-tool",
							sessionId,
							toolName,
							input,
							...options,
						});
						if (!result.ok) throw new Error(result.error);
						return result.execution;
					},
					{
						sessionId: runtimeSessionId,
						toolName,
						input,
						options: mutating
							? {
									approvalStatus: "approved",
									idempotencyKey,
								}
							: {},
					},
				);
				let timeout;
				let response;
				try {
					response = await Promise.race([
						requestPromise,
						new Promise((_, reject) => {
							timeout = setTimeout(
								() => reject(new Error(`${toolName} exceeded the 10 second benchmark tool budget.`)),
								10_000,
							);
						}),
					]);
				} catch (error) {
					if (!String(error instanceof Error ? error.message : error).includes("tool budget"))
						throw error;
					let runningExecution;
					if (idempotencyKey) {
						runningExecution = await page
							.evaluate(
								async ({ sessionId, idempotencyKey }) => {
									const listed = await window.kestrel.request({
										type: "runtime-list-executions",
										sessionId,
									});
									if (!listed.ok || !listed.executions) return undefined;
									return listed.executions.find(
										(execution) =>
											execution.idempotencyKey === idempotencyKey &&
											execution.status === "running",
									);
								},
								{ sessionId: runtimeSessionId, idempotencyKey },
							)
							.catch(() => undefined);
						if (runningExecution?.id)
							await page
								.evaluate(async (executionId) => {
									await window.kestrel.request({
										type: "runtime-cancel-execution",
										executionId,
									});
								}, runningExecution.id)
								.catch(() => undefined);
					}
					void requestPromise.catch(() => undefined);
					toolCalls.push({
						toolName,
						status: "timeout",
						durationMs: Math.round(performance.now() - callStarted),
						...(runningExecution?.id
							? { toolExecutionId: runningExecution.id }
							: {}),
							expectedFailure: expectFailure,
							approvalGrantSupplied: mutating,
						});
					throw error;
				} finally {
					if (timeout) clearTimeout(timeout);
				}
				const durationMs = Math.round(performance.now() - callStarted);
				toolCalls.push({
					toolName,
					status: response?.status ?? "missing",
					durationMs,
					...(response?.id ? { toolExecutionId: response.id } : {}),
						expectedFailure: expectFailure,
						approvalGrantSupplied: mutating,
					});
				if (expectFailure) {
					if (response?.status !== "failed")
						throw new Error(
							`${toolName} was expected to fail, but returned ${response?.status ?? "no status"}.`,
						);
					return response;
				}
				if (response?.status !== "verified")
					throw new Error(
						`${toolName} was not verified: ${response?.status ?? "no status"}${response?.error ? ` — ${response.error}` : ""}`,
					);
				return response;
			};

			const snapshot = async () => {
				const execution = await callTool("browser.snapshot", { browserSessionId });
				return execution.output;
			};

			const resolveTarget = async (target, maximumAttempts = 8) => {
				if (typeof target === "string") return target;
				let latest;
				for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
					latest = await snapshot();
					const matched = matchingInteractive(latest?.interactive, target);
					if (matched) return matched.ref;
					if (attempt + 1 < maximumAttempts) {
						metrics.retries += 1;
						await wait(50);
					}
				}
				throw new Error(
					`Benchmark target was not found after ${maximumAttempts} attempts: ${targetLabel(target)}.`,
				);
			};

			const executeAction = async (action, extra = {}) => {
				let targetValue = action.target;
				if (action.capturedTarget) {
					targetValue = capturedTargets.get(action.capturedTarget);
					if (!targetValue)
						throw new Error(`Captured benchmark target is missing: ${action.capturedTarget}`);
				} else if (
					action.type === "click" ||
					action.type === "type" ||
					action.type === "select"
				) {
					targetValue = await resolveTarget(
						action.target,
						extra.maximumAttempts ?? 8,
					);
				}
				const { capturedTarget: _capturedTarget, ...wireAction } = action;
				if (
					wireAction.type === "click" ||
					wireAction.type === "type" ||
					wireAction.type === "select"
				)
					wireAction.target = targetValue;
				return callTool(
					"browser.act",
					{
						browserSessionId,
						action: wireAction,
					},
					extra,
				);
			};

			try {
				const created = await callTool("browser.create", {
					allowedOrigins: [origins.primary, origins.secondary],
				});
				browserSessionId = String(created.output?.browserSessionId ?? "");
				if (!browserSessionId)
					throw new Error("Kestrel did not return an isolated browser session ID.");

				for (const step of workflow.steps) {
					if (step.op === "navigate") {
						await callTool("browser.navigate", {
							browserSessionId,
							url: fixture.url(fixtureRunId, step.site ?? "primary", step.path),
						});
					} else if (step.op === "click") {
						const retriesBefore = metrics.retries;
						await executeAction(
							{ type: "click", target: step.target },
							{ maximumAttempts: step.maxAttempts ?? 8 },
						);
						if (step.recovery || (step.recoveryOnRetry && metrics.retries > retriesBefore))
							metrics.scriptedRecoveries += 1;
					} else if (step.op === "type") {
						await executeAction(
							{ type: "type", target: step.target, text: step.text },
							{ maximumAttempts: step.maxAttempts ?? 8 },
						);
						if (step.recovery) metrics.scriptedRecoveries += 1;
					} else if (step.op === "select") {
						await executeAction({
							type: "select",
							target: step.target,
							value: step.value,
						});
					} else if (step.op === "upload") {
						await callTool("browser.upload", {
							browserSessionId,
							selector: step.selector,
							paths: step.paths,
						});
					} else if (step.op === "observe-text") {
						let found = false;
						for (let attempt = 0; attempt < (step.maxAttempts ?? 12); attempt += 1) {
							const observed = await snapshot();
							if (JSON.stringify(observed?.accessibilityTree).includes(step.text)) {
								found = true;
								break;
							}
							if (attempt + 1 < (step.maxAttempts ?? 12)) {
								metrics.retries += 1;
								await wait(50);
							}
						}
						if (!found)
							throw new Error(`Expected browser observation was not found: ${step.text}`);
						if (step.recovery) metrics.scriptedRecoveries += 1;
					} else if (step.op === "screenshot") {
						const screenshot = await callTool("browser.screenshot", { browserSessionId });
						if (
							!Number.isFinite(screenshot.output?.width) ||
							!Number.isFinite(screenshot.output?.height) ||
							!String(screenshot.output?.pngBase64 ?? "").startsWith("iVBOR")
						)
							throw new Error("Kestrel returned an invalid benchmark screenshot.");
					} else if (step.op === "wait-for-download") {
						let completed = false;
						for (let attempt = 0; attempt < 40; attempt += 1) {
							const downloads = await callTool("browser.downloads", { browserSessionId });
							if (
								downloads.output?.downloads?.some(
									(download) =>
										download.filename === step.filename &&
										download.status === "completed",
								)
							) {
								completed = true;
								break;
							}
							if (attempt + 1 < 40) {
								metrics.retries += 1;
								await wait(50);
							}
						}
						if (!completed)
							throw new Error(`Fixture download did not complete: ${step.filename}`);
					} else if (step.op === "verify-state") {
						const evaluation = evaluateBenchmarkPredicates(
							fixture.state(fixtureRunId),
							step.predicates,
						);
						if (predicatesPassed(evaluation) !== step.expect)
							throw new Error("Intermediate independent fixture state was unexpected.");
						if (step.expect === false) metrics.failedAttempts += 1;
					} else if (step.op === "auth-handoff") {
						await callTool("browser.auth-handoff", {
							browserSessionId,
							visible: step.visible,
						});
						if (step.intervention) metrics.interventions += 1;
					} else if (step.op === "capture-target") {
						capturedTargets.set(step.key, await resolveTarget(step.target));
					} else if (step.op === "expect-tool-failure") {
						const execution = await executeAction(step.action, { expectFailure: true });
						if (
							step.errorIncludes &&
							!String(execution.error ?? "")
								.toLowerCase()
								.includes(step.errorIncludes.toLowerCase())
						)
							throw new Error(
								`Expected failure did not include ${step.errorIncludes}: ${execution.error ?? "no error"}`,
							);
						metrics.failedAttempts += 1;
					} else if (step.op === "expect-target-missing") {
						const observed = await snapshot();
						if (matchingInteractive(observed?.interactive, step.target))
							throw new Error(`Unexpected benchmark target exists: ${targetLabel(step.target)}`);
						metrics.failedAttempts += 1;
					} else if (step.op === "safe-stop") {
						observedOutcome = "intervention_required";
						failureClass = step.failureClass;
						failureDetail = step.reason;
						metrics.interventions += 1;
						break;
					} else {
						throw new Error(`Unsupported benchmark operation: ${String(step.op)}`);
					}
				}
				if (observedOutcome !== "intervention_required")
					observedOutcome = "completed";
			} catch (error) {
				observedOutcome = "failed";
				failureClass = classifyBenchmarkFailure(error);
				failureDetail = sanitizeError(error);
			}

			let predicateResults = evaluateBenchmarkPredicates(
				fixture.state(fixtureRunId),
				workflow.predicates,
			);
			for (
				let attempt = 0;
				attempt < 20 && !predicatesPassed(predicateResults);
				attempt += 1
			) {
				await wait(50);
				predicateResults = evaluateBenchmarkPredicates(
					fixture.state(fixtureRunId),
					workflow.predicates,
				);
			}
			if (browserSessionId && !closeAttempted) {
				closeAttempted = true;
				try {
					await callTool("browser.close", { browserSessionId });
				} catch (closeError) {
					observedOutcome = "failed";
					failureClass = classifyBenchmarkFailure(closeError);
					failureDetail = `Cleanup failed: ${sanitizeError(closeError)}`;
				}
			}
			const finalStateVerified = predicatesPassed(predicateResults);
			const completionClaimed = observedOutcome === "completed";
			const verifiedCompletion =
				workflow.expectedOutcome === "completed" &&
				completionClaimed &&
				finalStateVerified;
			const safeStopVerified =
				workflow.expectedOutcome === "intervention_required" &&
				observedOutcome === "intervention_required" &&
				failureClass === workflow.expectedFailureClass &&
				finalStateVerified;
			const falsePositive =
				completionClaimed &&
				(!finalStateVerified || workflow.expectedOutcome !== "completed");
			const benchmarkPassed = verifiedCompletion || safeStopVerified;
			if (!benchmarkPassed && observedOutcome !== "failed") {
				failureClass = "verification";
				failureDetail = completionClaimed
					? "Independent final-state verification rejected the completion claim."
					: "Independent final-state verification rejected the expected safe stop.";
			}
			const result = {
				id: workflow.id,
				version: workflow.version,
				category: workflow.category,
				title: workflow.title,
				expectedOutcome: workflow.expectedOutcome,
				observedOutcome,
				completionClaimed,
				finalStateVerified,
				verifiedCompletion,
				safeStopVerified,
				benchmarkPassed,
				falsePositive,
				failureClass,
				...(failureDetail ? { failureDetail } : {}),
				durationMs: Math.round(performance.now() - workflowStarted),
				metrics,
				predicateResults,
				toolCalls,
			};
			results.push(result);
			process.stdout.write(
				`${result.benchmarkPassed ? "PASS" : "FAIL"} ${String(workflowIndex + 1).padStart(2, "0")}/${selected.length} ${workflow.id} (${result.durationMs} ms)${failureDetail ? ` — ${failureDetail}` : ""}\n`,
			);
		}
	} catch (error) {
		fatalError = error;
	} finally {
		await application?.close().catch(() => undefined);
		await fixture.close().catch(() => undefined);
	}

	const completedAt = new Date();
	const summary = summarizeBenchmarkResults(results);
	const report = {
		schemaVersion: BENCHMARK_REPORT_SCHEMA_VERSION,
		track: {
			id: BENCHMARK_TRACK_ID,
			measures:
				"Kestrel runtime, explicit approval-grant, browser-tool, Electron backend, accessibility targeting, scripted-recovery, and independent fixture-state reliability.",
			doesNotMeasure: [
				"open-ended model planning",
				"model reasoning quality",
				"live-site drift",
				"real authenticated accounts",
				"user approval prompt count",
			],
		},
		run: {
			id: `browser-agent-benchmark-${runToken}`,
			startedAt: startedAt.toISOString(),
			completedAt: completedAt.toISOString(),
			durationMs: Math.round(performance.now() - benchmarkStarted),
			fullCorpus: selected.length === BROWSER_AGENT_BENCHMARK_CORPUS.length,
			selectedWorkflowCount: selected.length,
			filters: {
				categories: options.categories,
				workflows: options.workflows,
			},
		},
		corpus: {
			version: BROWSER_AGENT_BENCHMARK_CORPUS_VERSION,
			sha256: corpusSha256(BROWSER_AGENT_BENCHMARK_CORPUS),
			workflowCount: BROWSER_AGENT_BENCHMARK_CORPUS.length,
			categoryCounts: Object.fromEntries(
				[...new Set(BROWSER_AGENT_BENCHMARK_CORPUS.map((workflow) => workflow.category))].map(
					(category) => [
						category,
						BROWSER_AGENT_BENCHMARK_CORPUS.filter(
							(workflow) => workflow.category === category,
						).length,
					],
				),
			),
		},
		source,
		environment: {
			platform: platform(),
			architecture: arch(),
			osRelease: release(),
			nodeVersion: process.version,
			appVersion: applicationInfo.appVersion,
			electronVersion: applicationInfo.electronVersion,
			packaged: applicationInfo.isPackaged,
			executableKind: process.env.KESTREL_DESKTOP_EXECUTABLE
				? `packaged:${basename(process.env.KESTREL_DESKTOP_EXECUTABLE)}`
				: "development-electron",
			appAsarSha256: applicationInfo.appAsarSha256,
			developmentOutSha256: applicationInfo.developmentOutSha256,
		},
		summary,
		results,
		liveCanaries: {
			status: "not_run",
			reason:
				"Live sites, accounts, and model routes are intentionally excluded from the deterministic track and require a separate explicit opt-in run.",
		},
		...(fatalError
			? {
				harnessFailure: {
					class: classifyBenchmarkFailure(fatalError),
					detail: sanitizeError(fatalError),
				},
			}
			: {}),
	};
	const reportPath = resolve(options.report);
	mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
	writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
		mode: 0o600,
	});
	rmSync(root, { recursive: true, force: true });
	process.stdout.write(
		`Benchmark report: ${reportPath}\nVerified workflow pass rate: ${(summary.benchmarkPassRate * 100).toFixed(1)}% (${summary.benchmarkPassCount}/${summary.workflowCount})\n`,
	);
	if (fatalError) throw fatalError;
	if (!options.allowFailures && summary.benchmarkPassCount !== summary.workflowCount)
		throw new Error(
			`Browser-agent benchmark failed ${summary.workflowCount - summary.benchmarkPassCount} workflow(s).`,
		);
}

main().catch((error) => {
	process.stderr.write(`${sanitizeError(error)}\n`);
	process.exitCode = 1;
});
