/**
 * Memory retrieval benchmark corpus (synthetic, non-personal).
 * Track is separate from the deterministic browser-agent benchmark.
 */
export const MEMORY_RETRIEVAL_CORPUS_VERSION = "memory-retrieval-v1";

export const MEMORY_RETRIEVAL_CASES = [
	{
		id: "exact-recall",
		category: "exact_recall",
		documents: [{ id: "d1", text: "The project codename is Harbor Lantern." }],
		query: "Harbor Lantern",
		relevantIds: ["d1"],
	},
	{
		id: "paraphrase-recall",
		category: "paraphrased_recall",
		documents: [
			{
				id: "d2",
				text: "Sai prefers morning deep-work blocks before meetings.",
			},
		],
		query: "When does Sai like uninterrupted focus time?",
		relevantIds: ["d2"],
	},
	{
		id: "people-fact",
		category: "people_facts",
		documents: [
			{ id: "d3", text: "Jordan is the FTC mentor for team 9930." },
			{ id: "d4", text: "Alex manages the workshop inventory spreadsheet." },
		],
		query: "Who mentors FTC team 9930?",
		relevantIds: ["d3"],
	},
	{
		id: "project-context",
		category: "project_context",
		documents: [
			{
				id: "d5",
				text: "Kestrel acquisition hardening prioritizes tool routing and restart recovery.",
			},
			{ id: "d6", text: "The website uses static Next.js marketing pages." },
		],
		query: "What are the acquisition hardening priorities?",
		relevantIds: ["d5"],
	},
	{
		id: "temporal-context",
		category: "temporal_context",
		documents: [
			{
				id: "d7",
				text: "On 2026-09-10 the onboarding copy was shortened.",
				at: "2026-09-10T12:00:00.000Z",
			},
			{
				id: "d8",
				text: "On 2026-09-18 Memory workspace shipped scoped documents.",
				at: "2026-09-18T12:00:00.000Z",
			},
		],
		query: "What shipped around mid-September 2026 for Memory?",
		relevantIds: ["d8"],
	},
	{
		id: "contradiction-new-wins",
		category: "contradictory_facts",
		documents: [
			{
				id: "d9",
				text: "Preferred editor is VS Code.",
				at: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "d10",
				text: "Preferred editor is Cursor.",
				at: "2026-08-01T00:00:00.000Z",
			},
		],
		query: "What editor is preferred now?",
		relevantIds: ["d10"],
	},
	{
		id: "unrelated-exclusion",
		category: "unrelated_exclusion",
		documents: [
			{ id: "d11", text: "The weather in Austin was humid yesterday." },
			{ id: "d12", text: "GitHub issue triage runs every Monday." },
		],
		query: "When is GitHub issue triage?",
		relevantIds: ["d12"],
	},
	{
		id: "forgotten-memory",
		category: "forgotten_memory",
		documents: [
			{
				id: "d13",
				text: "Temporary staging password was rotated.",
				forgotten: true,
			},
			{ id: "d14", text: "Staging uses SSO only." },
		],
		query: "How does staging authentication work?",
		relevantIds: ["d14"],
	},
];

export function lexicalRank(query, documents) {
	const terms = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 2);
	return documents
		.filter((document) => !document.forgotten)
		.map((document) => {
			const hay = document.text.toLowerCase();
			const score = terms.reduce(
				(sum, term) => sum + (hay.includes(term) ? 1 : 0),
				0,
			);
			return { id: document.id, score };
		})
		.filter((row) => row.score > 0)
		.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
		.map((row) => row.id);
}

export function precisionAtK(retrieved, relevant, k) {
	const top = retrieved.slice(0, k);
	if (top.length === 0) return 0;
	const hits = top.filter((id) => relevant.includes(id)).length;
	return hits / top.length;
}

export function recallAtK(retrieved, relevant, k) {
	if (relevant.length === 0) return 1;
	const top = new Set(retrieved.slice(0, k));
	const hits = relevant.filter((id) => top.has(id)).length;
	return hits / relevant.length;
}

export function meanReciprocalRank(retrieved, relevant) {
	for (let index = 0; index < retrieved.length; index += 1) {
		if (relevant.includes(retrieved[index])) return 1 / (index + 1);
	}
	return 0;
}
