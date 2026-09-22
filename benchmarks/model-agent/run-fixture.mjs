#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MODEL_AGENT_FIXTURES,
	MODEL_AGENT_TRACK,
	emptyModelAgentReport,
} from "./fixtures-v1.mjs";

const reportPath =
	process.argv.includes("--report")
		? process.argv[process.argv.indexOf("--report") + 1]
		: resolve(
				dirname(fileURLToPath(import.meta.url)),
				"../../.tmp/model-agent-benchmark/fixture.json",
			);

const report = {
	...emptyModelAgentReport({ mode: "fixture" }),
	fixtures: MODEL_AGENT_FIXTURES.map((fixture) => ({
		id: fixture.id,
		status: "structured_only",
		destructive: fixture.destructive,
		allowNetwork: fixture.allowNetwork,
	})),
	track: MODEL_AGENT_TRACK,
	generatedAt: new Date().toISOString(),
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
	`model-agent fixture track wrote ${report.fixtures.length} cases to ${reportPath}`,
);
console.log(
	"Metrics remain not_measured until a model adapter is attached; live canaries stay opt-in.",
);
