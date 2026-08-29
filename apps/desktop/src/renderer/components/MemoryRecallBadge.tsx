import type { MemoryRecallStatus } from "@kestrel/shared-types";

export function MemoryRecallBadge({
	recall,
}: {
	recall: MemoryRecallStatus;
}) {
	const active =
		recall.chatInjection === "active" &&
		(recall.activeMemories > 0 || recall.confirmedPreferences > 0);
	return (
		<p className="new-tab-memory-recall" role="status" aria-live="polite">
			<span className="new-tab-memory-recall-icon" aria-hidden="true">
				◆
			</span>
			{active ? (
				<>
					<strong>
						{recall.activeMemories}{" "}
						{recall.activeMemories === 1 ? "memory" : "memories"}
						{recall.confirmedPreferences > 0
							? ` · ${recall.confirmedPreferences} confirmed ${recall.confirmedPreferences === 1 ? "preference" : "preferences"}`
							: ""}
					</strong>
					<small>
						Shared context is on for {recall.personalityName}. New chats can use
						these facts when relevant.
					</small>
				</>
			) : recall.chatInjection === "active" ? (
				<>
					<strong>Memory is ready</strong>
					<small>
						Say <em>remember that …</em> in chat to store a preference, then inspect
						it in Life → Memory.
					</small>
				</>
			) : (
				<>
					<strong>Shared memory is off</strong>
					<small>{recall.offReason ?? "Shared context is not injected into chat."}</small>
				</>
			)}
		</p>
	);
}
