import type { MemoryRecallReceipt } from "@kestrel/shared-types";
import { formatMemoryRecallReceipt } from "@kestrel/shared-types";

export function MemoryRecallReceiptLine({
	receipt,
}: {
	receipt: MemoryRecallReceipt;
}) {
	return (
		<p className="memory-recall-receipt" role="status" aria-live="polite">
			<span className="memory-recall-receipt-icon" aria-hidden="true">
				◆
			</span>
			{formatMemoryRecallReceipt(receipt)}
		</p>
	);
}
