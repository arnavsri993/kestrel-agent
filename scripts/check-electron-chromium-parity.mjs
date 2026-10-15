#!/usr/bin/env node

/**
 * Evidence-backed Electron vs native Chromium parity report.
 * Cross-checks docs/electron-chromium-parity-matrix.json against the browser
 * backend wire schema and native host operation handlers. Exits non-zero when
 * the matrix drifts from the wire schema or claims CEF "proven" without a
 * matching operation handler in kestrel_native_host.mm.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = join(root, "docs", "electron-chromium-parity-matrix.json");
const wirePath = join(
	root,
	"apps",
	"core-service",
	"src",
	"browser-backend-wire.ts",
);
const nativeHostPath = join(
	root,
	"apps",
	"native-chromium-host",
	"src",
	"kestrel_native_host.mm",
);

const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
const wireSource = readFileSync(wirePath, "utf8");
const nativeSource = readFileSync(nativeHostPath, "utf8");

const wireOps = [
	...wireSource.matchAll(/operation:\s*z\.literal\("([a-z0-9-]+)"\)/g),
].map((match) => match[1]);
const uniqueWireOps = [...new Set(wireOps)].sort();

const matrixOps = Object.keys(matrix.browserBackendOperations ?? {}).sort();
const missingFromMatrix = uniqueWireOps.filter((op) => !matrixOps.includes(op));
const extraInMatrix = matrixOps.filter((op) => !uniqueWireOps.includes(op));

const provenWithoutHandler = [];
for (const [operation, entry] of Object.entries(
	matrix.browserBackendOperations ?? {},
)) {
	if (entry.chromium !== "proven") continue;
	const pattern = new RegExp(
		`operation\\s*==\\s*"${operation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
	);
	if (!pattern.test(nativeSource)) provenWithoutHandler.push(operation);
}

const areaBlockers = (matrix.areas ?? []).filter(
	(area) => area.blocker || area.chromium === "missing",
);
const opBlockers = Object.entries(matrix.browserBackendOperations ?? {})
	.filter(([, entry]) => entry.chromium === "missing")
	.map(([operation]) => operation);

console.log("Electron ↔ Chromium desktop parity");
console.log(`Matrix: ${matrixPath}`);
console.log(`Canonical shipping runtime: ${matrix.canonicalShippingRuntime}`);
console.log("");
console.log("Browser-backend wire operations:");
for (const operation of uniqueWireOps) {
	const entry = matrix.browserBackendOperations?.[operation] ?? {};
	const cef = entry.chromium ?? "untracked";
	const smoke = entry.smoke ? ` (${entry.smoke})` : "";
	console.log(`- ${operation}: chromium=${cef}${smoke}`);
}
console.log("");
console.log(`Area blockers / missing (${areaBlockers.length}):`);
for (const area of areaBlockers) {
	console.log(
		`- [${area.id}] electron=${area.electron} chromium=${area.chromium}` +
			(area.notes ? ` — ${area.notes}` : ""),
	);
}
console.log("");
console.log(`Missing browser-backend ops on CEF (${opBlockers.length}):`);
for (const operation of opBlockers) console.log(`- ${operation}`);
console.log("");
console.log("Prioritized remediation:");
for (const item of matrix.prioritizedRemediation ?? []) {
	console.log(
		`${item.priority}. [${item.id}] ${item.action} (risk=${item.risk})`,
	);
}

const errors = [];
if (missingFromMatrix.length) {
	errors.push(
		`Matrix missing wire operations: ${missingFromMatrix.join(", ")}`,
	);
}
if (extraInMatrix.length) {
	errors.push(
		`Matrix has unknown operations not in wire schema: ${extraInMatrix.join(", ")}`,
	);
}
if (provenWithoutHandler.length) {
	errors.push(
		`Matrix marks chromium=proven but native host has no operation handler: ${provenWithoutHandler.join(", ")}`,
	);
}

if (errors.length) {
	console.error("");
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log("");
console.log(
	"Parity matrix is consistent with the browser-backend wire schema and CEF handlers.",
);
console.log(
	"Electron packaging remains required until check:electron-retirement is accepted with live evidence.",
);
