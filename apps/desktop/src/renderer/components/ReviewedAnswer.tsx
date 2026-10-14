import type { RuntimeMessage } from "@kestrel/shared-types";
import type { ReactNode } from "react";
import "./reviewed-answer.css";

/** Only an explicit correction can fold an earlier answer; ordinary replies stay open. */
export function supersededAnswerIds(messages: readonly RuntimeMessage[]): Set<string> {
	const earlier = new Map<string, RuntimeMessage>();
	const superseded = new Set<string>();
	for (const message of messages) {
		const target = message.supersedesMessageId
			? earlier.get(message.supersedesMessageId) : undefined;
		if (message.role === "assistant" && !message.modelToolCalls?.length &&
			target?.role === "assistant" && !target.modelToolCalls?.length &&
			target.sessionId === message.sessionId) superseded.add(target.id);
		earlier.set(message.id, message);
	}
	return superseded;
}

export function ReviewedAnswer({ superseded, children }: {
	superseded: boolean;
	children: ReactNode;
}) {
	return superseded ? (
		<details className="reviewed-answer-earlier">
			<summary>Earlier draft</summary>
			<div className="reviewed-answer-content">{children}</div>
		</details>
	) : <>{children}</>;
}
