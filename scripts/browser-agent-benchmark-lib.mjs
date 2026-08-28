import { createHash } from "node:crypto";

export const BENCHMARK_REPORT_SCHEMA_VERSION = "1.1.0";
export const BENCHMARK_TRACK_ID = "deterministic-scripted-browser-tools";
export const BENCHMARK_CATEGORIES = Object.freeze([
	"research",
	"forms",
	"productivity",
	"commerce",
	"accounts",
	"failures",
]);
export const BENCHMARK_CATEGORY_COUNTS = Object.freeze({
	research: 10,
	forms: 10,
	productivity: 8,
	commerce: 8,
	accounts: 6,
	failures: 8,
});
export const BENCHMARK_FAILURE_CLASSES = Object.freeze([
	"none",
	"model_reasoning",
	"browser_action",
	"website_changed",
	"authentication",
	"permission",
	"connector",
	"local_file",
	"network",
	"user_cancellation",
	"policy_block",
	"timeout",
	"verification",
	"unknown",
]);

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedTarget(value) {
	if (typeof value === "string") return value.length > 0 && value.length <= 2_000;
	return (
		isRecord(value) &&
		typeof value.role === "string" &&
		value.role.length > 0 &&
		typeof value.name === "string" &&
		value.name.length > 0
	);
}

export function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function corpusSha256(corpus) {
	return createHash("sha256").update(stableJson(corpus)).digest("hex");
}

export function validateBenchmarkCorpus(corpus, expectedCount = 50) {
	const errors = [];
	if (!Array.isArray(corpus)) return ["Corpus must be an array."];
	if (corpus.length !== expectedCount)
		errors.push(`Corpus must contain exactly ${expectedCount} workflows.`);
	const ids = new Set();
	const allowedSteps = new Set([
		"navigate",
		"click",
		"type",
		"select",
		"upload",
		"observe-text",
		"screenshot",
		"wait-for-download",
		"verify-state",
		"auth-handoff",
		"capture-target",
		"expect-tool-failure",
		"expect-approval-block",
		"expect-target-missing",
		"safe-stop",
	]);
	for (const [index, workflow] of corpus.entries()) {
		const label = `Workflow ${index + 1}`;
		if (!isRecord(workflow)) {
			errors.push(`${label} must be an object.`);
			continue;
		}
		if (!/^[a-z][a-z0-9-]{2,79}$/.test(workflow.id ?? ""))
			errors.push(`${label} has an invalid id.`);
		else if (ids.has(workflow.id))
			errors.push(`${label} repeats id ${workflow.id}.`);
		else ids.add(workflow.id);
		if (!Number.isInteger(workflow.version) || workflow.version < 1)
			errors.push(`${label} must have a positive integer version.`);
		if (!BENCHMARK_CATEGORIES.includes(workflow.category))
			errors.push(`${label} has an invalid category.`);
		if (typeof workflow.title !== "string" || !workflow.title.trim())
			errors.push(`${label} must have a title.`);
		if (typeof workflow.objective !== "string" || !workflow.objective.trim())
			errors.push(`${label} must have an objective.`);
		if (!["completed", "intervention_required"].includes(workflow.expectedOutcome))
			errors.push(`${label} has an invalid expected outcome.`);
		if (
			workflow.expectedOutcome === "intervention_required" &&
			!BENCHMARK_FAILURE_CLASSES.includes(workflow.expectedFailureClass)
		)
			errors.push(`${label} must name its expected safe-stop failure class.`);
		const pageKeys = new Set();
		const controlIds = new Set();
		const fieldNames = new Set();
		const downloadNames = new Set();
		const workflowPages = Array.isArray(workflow.pages) ? workflow.pages : [];
		const workflowSteps = Array.isArray(workflow.steps) ? workflow.steps : [];
		const workflowPredicates = Array.isArray(workflow.predicates)
			? workflow.predicates
			: [];
		if (!Array.isArray(workflow.pages) || workflow.pages.length < 1)
			errors.push(`${label} must define at least one fixture page.`);
		else {
			for (const [pageIndex, page] of workflowPages.entries()) {
				const pageLabel = `${label} page ${pageIndex + 1}`;
				if (!isRecord(page)) {
					errors.push(`${pageLabel} must be an object.`);
					continue;
				}
				if (!["primary", "secondary"].includes(page.site))
					errors.push(`${pageLabel} has an invalid fixture site.`);
				if (
					typeof page.path !== "string" ||
					!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(page.path)
				)
					errors.push(`${pageLabel} has an invalid fixture path.`);
				else if (["primary", "secondary"].includes(page.site)) {
					const pageKey = `${page.site}:${page.path}`;
					if (pageKeys.has(pageKey))
						errors.push(`${pageLabel} duplicates ${pageKey}.`);
					else pageKeys.add(pageKey);
				}
				if (page.fields !== undefined && !Array.isArray(page.fields))
					errors.push(`${pageLabel} fields must be an array.`);
				for (const field of Array.isArray(page.fields) ? page.fields : []) {
					if (!isRecord(field) || typeof field.name !== "string" || !field.name)
						errors.push(`${pageLabel} has a field without a valid name.`);
					else fieldNames.add(field.name);
				}
				if (page.controls !== undefined && !Array.isArray(page.controls))
					errors.push(`${pageLabel} controls must be an array.`);
				for (const control of Array.isArray(page.controls) ? page.controls : []) {
					if (!isRecord(control) || typeof control.id !== "string" || !control.id)
						errors.push(`${pageLabel} has a control without a valid id.`);
					else controlIds.add(control.id);
				}
				if (page.downloads !== undefined && !Array.isArray(page.downloads))
					errors.push(`${pageLabel} downloads must be an array.`);
				for (const download of Array.isArray(page.downloads) ? page.downloads : []) {
					if (
						!isRecord(download) ||
						typeof download.filename !== "string" ||
						!download.filename
					)
						errors.push(`${pageLabel} has a download without a valid filename.`);
					else downloadNames.add(download.filename);
				}
			}
			for (const [pageIndex, page] of workflowPages.entries()) {
				if (!isRecord(page)) continue;
				const linkedTargets = [
					...(Array.isArray(page.links) ? page.links : []),
					...(page.redirectTo ? [page.redirectTo] : []),
					...(Array.isArray(page.controls) ? page.controls : []).flatMap((control) =>
						[control.navigate, control.popup].filter(Boolean),
					),
				];
				for (const destination of linkedTargets) {
					if (
						!isRecord(destination) ||
						!pageKeys.has(`${destination.site}:${destination.path}`)
					)
						errors.push(
							`${label} page ${pageIndex + 1} references an undeclared fixture page.`,
						);
				}
			}
		}

		const validatePredicates = (predicates, predicateLabel) => {
			if (!Array.isArray(predicates) || predicates.length < 1) {
				errors.push(`${predicateLabel} must define independent state predicates.`);
				return;
			}
			for (const [predicateIndex, predicate] of predicates.entries()) {
				const itemLabel = `${predicateLabel} predicate ${predicateIndex + 1}`;
				if (!isRecord(predicate)) {
					errors.push(`${itemLabel} must be an object.`);
					continue;
				}
				if (!Object.hasOwn(predicate, "equals") && !Object.hasOwn(predicate, "minimum") && !Object.hasOwn(predicate, "includes"))
					errors.push(`${itemLabel} has no explicit expectation.`);
				if (predicate.kind === "visited") {
					if (!pageKeys.has(`${predicate.site}:${predicate.path}`))
						errors.push(`${itemLabel} references an undeclared fixture page.`);
				} else if (predicate.kind === "activation") {
					if (!controlIds.has(predicate.id))
						errors.push(`${itemLabel} references an undeclared control.`);
				} else if (predicate.kind === "field") {
					if (!fieldNames.has(predicate.name))
						errors.push(`${itemLabel} references an undeclared field.`);
				} else if (predicate.kind === "download") {
					if (!downloadNames.has(predicate.filename))
						errors.push(`${itemLabel} references an undeclared download.`);
				} else errors.push(`${itemLabel} has an invalid kind.`);
			}
		};

		if (!Array.isArray(workflow.steps) || workflow.steps.length < 1)
			errors.push(`${label} must define at least one execution step.`);
		else {
			for (const [stepIndex, step] of workflowSteps.entries()) {
				if (!isRecord(step) || !allowedSteps.has(step.op)) {
					errors.push(`${label} step ${stepIndex + 1} has an invalid operation.`);
					continue;
				}
				if (
					step.op === "select" &&
					(typeof step.value !== "string" || step.value.length > 2_000)
				)
					errors.push(
						`${label} step ${stepIndex + 1} must have a bounded select value.`,
					);
				if (
					["click", "type", "select"].includes(step.op) &&
					!isBoundedTarget(step.target)
				)
					errors.push(`${label} step ${stepIndex + 1} has an invalid target.`);
				if (
					step.op === "navigate" &&
					!pageKeys.has(`${step.site ?? "primary"}:${step.path}`)
				)
					errors.push(
						`${label} step ${stepIndex + 1} navigates to an undeclared fixture page.`,
					);
				if (step.op === "verify-state")
					validatePredicates(step.predicates, `${label} step ${stepIndex + 1}`);
				if (
					["expect-tool-failure", "expect-approval-block"].includes(step.op) &&
					(!isRecord(step.action) ||
						!["click", "type", "select", "key", "scroll"].includes(
							step.action.type,
						) ||
						(["click", "type", "select"].includes(step.action.type) &&
							!step.action.capturedTarget &&
							!isBoundedTarget(step.action.target)))
				)
					errors.push(`${label} step ${stepIndex + 1} has an invalid guarded action.`);
				if (step.op === "expect-approval-block") {
					validatePredicates(step.predicates, `${label} step ${stepIndex + 1}`);
					if (
						!Array.isArray(step.predicates) ||
						!step.predicates.some(
							(predicate) =>
								isRecord(predicate) &&
								predicate.kind === "activation" &&
								predicate.equals === 0,
						)
					)
						errors.push(
							`${label} step ${stepIndex + 1} must prove an untouched consequential activation.`,
						);
				}
			}
		}
		validatePredicates(workflowPredicates, label);
		const safeStopSteps = workflowSteps.filter(
			(step) => isRecord(step) && step.op === "safe-stop",
		);
		if (
			workflow.expectedOutcome === "intervention_required" &&
			safeStopSteps.length !== 1
		)
			errors.push(`${label} expects intervention and must have one safe-stop step.`);
		if (
			workflow.expectedOutcome === "intervention_required" &&
			workflowSteps.at(-1)?.op !== "safe-stop"
		)
			errors.push(`${label} must end an intervention workflow at its safe stop.`);
		if (
			workflow.expectedOutcome === "intervention_required" &&
			!workflowPredicates.some(
				(predicate) =>
					isRecord(predicate) &&
					["visited", "activation", "download"].includes(predicate.kind) &&
					predicate.equals === 0,
			) &&
			!workflowSteps.some(
				(step) => isRecord(step) && step.op === "expect-target-missing",
			)
		)
			errors.push(`${label} safe stop must prove an untouched or missing consequential target.`);
		if (
			workflow.expectedOutcome === "intervention_required" &&
			(safeStopSteps[0]?.failureClass !== workflow.expectedFailureClass ||
				safeStopSteps[0]?.failureClass === "none")
		)
			errors.push(`${label} safe stop must match its non-success failure class.`);
		if (workflow.expectedOutcome === "completed" && safeStopSteps.length > 0)
			errors.push(`${label} completed workflow cannot contain a safe stop.`);
		if (
			workflow.expectedOutcome === "completed" &&
			!workflowSteps.some(
				(step) =>
					isRecord(step) &&
					["click", "type", "select", "upload"].includes(step.op),
			)
		)
			errors.push(`${label} completed workflow must exercise a mutating browser action.`);
		if (
			workflow.expectedOutcome === "completed" &&
			!workflowPredicates.some(
				(predicate) =>
					isRecord(predicate) &&
					(predicate.kind === "field" ||
						((predicate.kind === "activation" || predicate.kind === "download") &&
							((typeof predicate.equals === "number" && predicate.equals > 0) ||
								(typeof predicate.minimum === "number" && predicate.minimum > 0)))),
			)
		)
			errors.push(`${label} completion predicates do not prove a browser-side effect.`);
	}
	for (const category of BENCHMARK_CATEGORIES) {
		const actual = corpus.filter(
			(workflow) => isRecord(workflow) && workflow.category === category,
		).length;
		const expected = BENCHMARK_CATEGORY_COUNTS[category];
		if (actual !== expected)
			errors.push(
				`Corpus must contain exactly ${expected} ${category} workflows.`,
			);
	}
	const approvalBoundaryWorkflows = corpus.filter(
		(workflow) =>
			isRecord(workflow) &&
			Array.isArray(workflow.steps) &&
			workflow.steps.some(
				(step) => isRecord(step) && step.op === "expect-approval-block",
			),
	);
	if (approvalBoundaryWorkflows.length < 3)
		errors.push(
			"Corpus must include approval-block evidence in at least three workflows.",
		);
	for (const category of ["forms", "accounts", "failures"]) {
		if (!approvalBoundaryWorkflows.some((workflow) => workflow.category === category))
			errors.push(`Corpus must include an approval-block workflow in ${category}.`);
	}
	return errors;
}

function stateValue(state, predicate) {
	if (predicate.kind === "visited")
		return state.visits?.[`${predicate.site}:${predicate.path}`] ?? 0;
	if (predicate.kind === "activation")
		return state.activations?.[predicate.id] ?? 0;
	if (predicate.kind === "field") return state.fields?.[predicate.name];
	if (predicate.kind === "download")
		return state.downloads?.[predicate.filename] ?? 0;
	throw new Error(`Unsupported benchmark predicate: ${String(predicate.kind)}`);
}

export function evaluateBenchmarkPredicates(state, predicates) {
	return predicates.map((predicate) => {
		const actual = stateValue(state, predicate);
		let passed = true;
		const expectations = {};
		if (Object.hasOwn(predicate, "equals")) {
			expectations.equals = predicate.equals;
			passed &&= actual === predicate.equals;
		}
		if (Object.hasOwn(predicate, "minimum")) {
			expectations.minimum = predicate.minimum;
			passed &&= typeof actual === "number" && actual >= predicate.minimum;
		}
		if (Object.hasOwn(predicate, "includes")) {
			expectations.includes = predicate.includes;
			passed &&=
				typeof actual === "string" && actual.includes(predicate.includes);
		}
		return {
			predicate,
			actual,
			expected: expectations,
			passed,
		};
	});
}

export function predicatesPassed(results) {
	return results.every((result) => result.passed);
}

export function classifyBenchmarkFailure(error) {
	const message = String(error instanceof Error ? error.message : error).toLowerCase();
	if (/timeout|timed out|deadline/.test(message)) return "timeout";
	if (/auth|login|sign in|session expired|verification code/.test(message))
		return "authentication";
	if (/permission|not granted|outside.*allowlist|approval/.test(message))
		return "permission";
	if (/network|econn|socket|fetch|http 5\d\d/.test(message)) return "network";
	if (/cancel|aborted/.test(message)) return "user_cancellation";
	if (/workspace|upload|file/.test(message)) return "local_file";
	if (/policy|denied|blocked/.test(message)) return "policy_block";
	if (/target|selector|element|snapshot|browser|navigation/.test(message))
		return "browser_action";
	if (/predicate|final state|verify|verification/.test(message))
		return "verification";
	return "unknown";
}

function percentile(values, percentileValue) {
	if (values.length === 0) return 0;
	const ordered = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((percentileValue / 100) * ordered.length) - 1;
	return ordered[Math.max(0, Math.min(ordered.length - 1, rank))];
}

function rate(numerator, denominator) {
	return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

export function summarizeBenchmarkResults(results) {
	const expectedCompletions = results.filter(
		(result) => result.expectedOutcome === "completed",
	);
	const expectedSafeStops = results.filter(
		(result) => result.expectedOutcome === "intervention_required",
	);
	const completionClaims = results.filter((result) => result.completionClaimed);
	const verifiedCompletions = results.filter(
		(result) => result.verifiedCompletion,
	);
	const verifiedSafeStops = results.filter((result) => result.safeStopVerified);
	const benchmarkPasses = results.filter((result) => result.benchmarkPassed);
	const falsePositives = results.filter((result) => result.falsePositive);
	const metrics = results.reduce(
		(total, result) => {
			for (const key of Object.keys(total))
				total[key] += Number(result.metrics?.[key] ?? 0);
			return total;
		},
			{
				actions: 0,
				observations: 0,
				retries: 0,
				failedAttempts: 0,
				interventions: 0,
				approvalBlockAttempts: 0,
				approvalBlocks: 0,
				approvalGrants: 0,
				scriptedRecoveries: 0,
			},
	);
	const failureClasses = Object.fromEntries(
		BENCHMARK_FAILURE_CLASSES.map((failureClass) => [
			failureClass,
			results.filter((result) => result.failureClass === failureClass).length,
		]),
	);
	return {
		workflowCount: results.length,
		expectedCompletionCount: expectedCompletions.length,
		completionClaimCount: completionClaims.length,
		verifiedCompletionCount: verifiedCompletions.length,
		expectedSafeStopCount: expectedSafeStops.length,
		verifiedSafeStopCount: verifiedSafeStops.length,
		benchmarkPassCount: benchmarkPasses.length,
		falsePositiveCompletionCount: falsePositives.length,
		completionRate: rate(
			completionClaims.filter((result) => result.expectedOutcome === "completed")
				.length,
			expectedCompletions.length,
		),
		verifiedCompletionRate: rate(
			verifiedCompletions.length,
			expectedCompletions.length,
		),
		safeStopVerificationRate: rate(
			verifiedSafeStops.length,
			expectedSafeStops.length,
		),
		benchmarkPassRate: rate(benchmarkPasses.length, results.length),
		falsePositiveCompletionRate: rate(
			falsePositives.length,
			completionClaims.length,
		),
		metrics,
		approvalBoundary:
			metrics.approvalBlockAttempts === 0
				? {
						status: "not_measured",
						attemptedWithoutGrant: 0,
						blockedWithoutMutation: 0,
						blockRate: null,
						reason:
							"The selected workflow filter did not include an approval-block case.",
					}
				: {
						status: "measured",
						attemptedWithoutGrant: metrics.approvalBlockAttempts,
						blockedWithoutMutation: metrics.approvalBlocks,
						blockRate: rate(
							metrics.approvalBlocks,
							metrics.approvalBlockAttempts,
						),
					},
		durationMs: {
			total: results.reduce(
				(total, result) => total + Number(result.durationMs ?? 0),
				0,
			),
			p50: percentile(
				results.map((result) => Number(result.durationMs ?? 0)),
				50,
			),
			p95: percentile(
				results.map((result) => Number(result.durationMs ?? 0)),
				95,
			),
		},
		failureClasses,
		modelUsage: {
			status: "not_measured",
			inputTokens: null,
			outputTokens: null,
			totalTokens: null,
			estimatedCostUsd: null,
			reason:
				"This deterministic track invokes Kestrel browser tools directly and does not make a model call.",
		},
		approvalPrompts: {
			status: "not_measured",
			count: null,
			reason:
				"The harness verifies missing-approval runtime blocks and explicit grants, but does not render or measure user approval prompts.",
		},
	};
}
