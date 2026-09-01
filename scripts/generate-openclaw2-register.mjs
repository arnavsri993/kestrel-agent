import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
export const REGISTER_PATH = resolve(root, "docs/openclaw-2-behavior-matrix.json");
export const MARKDOWN_PATH = resolve(root, "docs/openclaw-2-behavior-matrix.md");

function markdownTableCell(value) {
	return String(value ?? "")
		.replaceAll("|", "\\|")
		.replaceAll("\n", " ");
}

function classificationCounts(behaviors) {
	return behaviors.reduce((counts, behavior) => {
		counts[behavior.classification] = (counts[behavior.classification] ?? 0) + 1;
		return counts;
	}, {});
}

export function renderOpenClaw2Markdown(register) {
	const behaviors = [...register.behaviors].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
	const counts = classificationCounts(behaviors);
	const countSummary = Object.entries(counts)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([classification, count]) => `${classification}: ${count}`)
		.join(", ");
	const lines = [
		"# OpenClaw 2.0 exact behavior register",
		"",
		`Pinned release: **${register.release.name}** (${register.release.tag}) at immutable commit \`${register.release.commit}\`.`,
		`Release: ${register.release.releaseUrl} · notes: ${register.release.releaseNotesUrl}`,
		"",
		"This generated register is the exact-behavior evidence layer. It is deliberately separate from the broad capability-family catalog and page audit.",
		"",
		`Generated from \`docs/openclaw-2-behavior-matrix.json\` on the fixed register date ${register.generatedAt}; entries are rendered in stable ID order.`,
		`Classification counts: ${countSummary}.`,
		"",
		"## Evidence model",
		"",
		`- Family coverage: [${register.familyCoverage.matrixPath}](${register.familyCoverage.matrixPath}) and [${register.familyCoverage.catalogPath}](${register.familyCoverage.catalogPath}) describe capability families only.`,
		"- Exact behavior: each entry below has pinned upstream provenance, Kestrel implementation paths, executable test paths, and an exact command.",
		"- `unresolved`, `platform-boundary`, and `operator-blocked` entries are disclosed limitations, not parity claims.",
		"",
		"## Focused verification",
		"",
		...register.focusedVerification.commands.map(
			(command) => `- \`${command.command}\``,
		),
		"",
		"## Registered behaviors",
		"",
		"| ID | Priority | Family | Classification | User-visible behavior | Test evidence |",
		"| --- | --- | --- | --- | --- | --- |",
		...behaviors.map(
			(behavior) =>
				`| \`${markdownTableCell(behavior.id)}\` | ${markdownTableCell(behavior.priority)} | \`${markdownTableCell(behavior.familyId)}\` | ${markdownTableCell(behavior.classification)} | ${markdownTableCell(behavior.userVisibleBehavior)} | ${behavior.testEvidence.map((path) => `\`${markdownTableCell(path)}\``).join(", ")} |`,
		),
		"The JSON register is authoritative for all fields, including security/privacy implications, migration implications, platform boundaries, rationales, and notes.",
	];
	return `${lines.join("\n")}\n`;
}

async function main() {
	const register = JSON.parse(await readFile(REGISTER_PATH, "utf8"));
	const rendered = renderOpenClaw2Markdown(register);
	if (process.argv.includes("--check")) {
		const current = await readFile(MARKDOWN_PATH, "utf8");
		if (current !== rendered)
			throw new Error(
				`${MARKDOWN_PATH} is stale; run corepack pnpm generate:openclaw2`,
			);
		console.log(`OpenClaw 2.0 register markdown is deterministic: ${MARKDOWN_PATH}`);
		return;
	}
	await writeFile(MARKDOWN_PATH, rendered, "utf8");
	console.log(`Wrote deterministic OpenClaw 2.0 register markdown to ${MARKDOWN_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
	await main();
