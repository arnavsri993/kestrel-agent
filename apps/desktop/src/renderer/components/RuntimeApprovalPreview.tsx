import type { RuntimeToolExecution } from "@kestrel/shared-types";
import { approvalPreviewText, browserApprovalPreview } from "../browser-approval-preview";
import "./runtime-approval-preview.css";

export function RuntimeApprovalPreview({ execution }: { execution: RuntimeToolExecution }) {
	const preview = browserApprovalPreview(execution);
	if (!preview) return (
		<pre className="approval-preview" aria-label="Action preview" tabIndex={0}>
			{approvalPreviewText(execution)}
		</pre>
	);
	return (
		<section className="runtime-browser-approval-preview" aria-label="Action preview" tabIndex={0}>
			<p>{preview.description}</p>
			<dl>
				<dt>{preview.label}</dt>
				<dd>{preview.values.map((value, index) => <div key={index}>{value}</div>)}</dd>
			</dl>
		</section>
	);
}
