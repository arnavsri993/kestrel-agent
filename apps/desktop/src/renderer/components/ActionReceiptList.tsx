import type { ActionReceipt, RuntimeToolExecution } from "@kestrel/shared-types";
import {
	actionReceiptApprovalLabel,
	actionReceiptOutcomeLabel,
	actionReceiptRollbackLabel,
	actionReceiptVerificationLabel,
	groupActionReceipts,
} from "../runtime-evidence";

function receiptTime(receipt: ActionReceipt): string {
	const value = receipt.completedAt ?? receipt.startedAt;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function preconditionLabel(receipt: ActionReceipt): string {
	return `${receipt.precondition.status.replaceAll("_", " ")} · ${receipt.precondition.summary}`;
}

export function ActionReceiptList({
	receipts,
	executions,
}: {
	receipts: ActionReceipt[];
	executions: RuntimeToolExecution[];
}) {
	if (receipts.length === 0) return null;
	const groups = groupActionReceipts(receipts, executions);
	return (
		<details className="action-receipts" aria-label="Action receipts">
			<summary>
				<span>Action receipts</span>
				<small>
					{groups.length} action
					{groups.length === 1 ? "" : "s"}
				</small>
			</summary>
			<div className="action-receipt-list">
				{groups.map(({ latest, history }) => (
					<ActionReceiptCard key={latest.id} receipt={latest} history={history} />
				))}
			</div>
		</details>
	);
}

function ActionReceiptCard({ receipt, history = [] }: {
	receipt: ActionReceipt;
	history?: ActionReceipt[];
}) {
	return (
		<article
			className={`action-receipt action-receipt-${receipt.outcome}`}
			aria-label={`Action receipt: ${receipt.action.title}`}
			key={receipt.id}
		>
			<header>
				<div>
					<strong>{receipt.action.title}</strong>
					<small>{receiptTime(receipt)}</small>
				</div>
				<span className="action-receipt-status">
					{actionReceiptOutcomeLabel(receipt.outcome)}
				</span>
			</header>
			<dl>
				<div>
					<dt>Destination</dt>
					<dd>{receipt.destination.label}</dd>
				</div>
				<div>
					<dt>Approval</dt>
					<dd>
						{actionReceiptApprovalLabel(
							receipt.approval,
							receipt.outcome,
						)}
					</dd>
				</div>
				<div>
					<dt>Verification</dt>
					<dd title={receipt.verification?.evidenceSha256}>
						{actionReceiptVerificationLabel(receipt)}
					</dd>
				</div>
				<div>
					<dt>Rollback</dt>
					<dd>
						{actionReceiptRollbackLabel(receipt.rollback)} ·{" "}
						{receipt.rollback.reason}
					</dd>
				</div>
			</dl>
			<details className="action-receipt-evidence">
				<summary>Expected and observed state</summary>
				<p>{receipt.action.summary}</p>
				<dl>
					<div>
						<dt>Precondition</dt>
						<dd>{preconditionLabel(receipt)}</dd>
					</div>
					<div>
						<dt>Expected</dt>
						<dd>{receipt.expectedState}</dd>
					</div>
					<div>
						<dt>Observed</dt>
						<dd>{receipt.observedState}</dd>
					</div>
					{receipt.result && (
						<div>
							<dt>Result</dt>
							<dd>{receipt.result}</dd>
						</div>
					)}
				</dl>
			</details>
			{history.length > 0 && (
				<details className="action-receipt-history" aria-label={`Earlier states for ${receipt.action.title}`}>
					<summary>Earlier states ({history.length})</summary>
					<div className="action-receipt-list">
						{history.map(previous => <ActionReceiptCard key={previous.id} receipt={previous} />)}
					</div>
				</details>
			)}
			<small className="action-receipt-trust">
				Encrypted locally · bounded receipt metadata only
			</small>
		</article>
	);
}
