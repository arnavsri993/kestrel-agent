import type { MemoryRecallReceipt } from "@kestrel/shared-types";
import { formatMemoryRecallReceipt } from "@kestrel/shared-types";
import { useState } from "react";

export function MemoryRecallReceiptLine({
	receipt,
}: {
	receipt: MemoryRecallReceipt;
}) {
	const [expanded, setExpanded] = useState(false);
	return (
		<button
			type="button"
			className={`memory-recall-receipt${expanded ? " is-expanded" : ""}`}
			aria-expanded={expanded}
			onClick={() => setExpanded((current) => !current)}
		>
			<span className="memory-recall-receipt-icon" aria-hidden="true">
				◆
			</span>
			<span className="memory-recall-receipt-summary">Used context</span>
			{expanded ? (
				<span className="memory-recall-receipt-detail">
					{formatMemoryRecallReceipt(receipt)}
				</span>
			) : null}
		</button>
	);
}
