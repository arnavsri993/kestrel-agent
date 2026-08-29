import type { WorkspaceSnapshot } from "@kestrel/shared-types";

export function MemoryRecallStatus({
	snapshot,
}: {
	snapshot: WorkspaceSnapshot;
}) {
	const recall = snapshot.memoryRecall;
	return (
		<aside className="memory-recall-status" aria-live="polite">
			<strong>
				Chat memory: {recall.chatInjection === "active" ? "Active" : "Off"}
			</strong>
			<small>
				{recall.chatInjection === "active"
					? `${recall.activeMemories} active ${recall.activeMemories === 1 ? "memory" : "memories"} · ${recall.confirmedPreferences} confirmed ${recall.confirmedPreferences === 1 ? "preference" : "preferences"} · ${recall.personalityName} (${recall.personalityScope})`
					: recall.offReason}
			</small>
			{recall.explicitCapture ? (
				<small>Explicit capture: on</small>
			) : (
				<small>Explicit capture: off — “remember that …” commands are ignored</small>
			)}
			{recall.honchoLastError && (
				<small role="status">Honcho remote memory: {recall.honchoLastError}</small>
			)}
		</aside>
	);
}
