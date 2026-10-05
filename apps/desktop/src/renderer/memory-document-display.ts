import type { MemoryDocument } from "@kestrel/shared-types";

// Only generated task records with matching task provenance belong in this group.
// Manual notes, including notes called "outcome", keep their existing placement.
export function isTaskResult(document: MemoryDocument): boolean {
	const prefix = "workspace:agent-memory:agent-outcome-";
	return document.kind === "memory" && document.origin === "legacy" &&
		document.id.startsWith(prefix) && document.sourceIds.includes(`task:${document.id.slice(prefix.length)}`);
}

export function memoryDocumentTitle(document: MemoryDocument): string {
	if (isTaskResult(document) || (document.origin === "legacy" &&
		["semantic", "episodic", "procedural", "project", "relationship"].includes(document.title.toLowerCase()))) {
		const line = document.text.trim().split("\n")[0] || document.title;
		return line.length > 72 ? `${line.slice(0, 69)}…` : line;
	}
	return document.title;
}
