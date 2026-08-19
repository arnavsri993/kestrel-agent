import Link from "next/link";

export function ResponsePromise({
	compact = false,
}: {
	compact?: boolean;
}) {
	if (compact) {
		return (
			<div className="response-promise-compact">
				<span className="sla-badge">SLA COMMITMENT</span>
				<p>
					<strong>&lt; 2h</strong> Security / Critical · <strong>&lt; 24h</strong> Developer Support
				</p>
			</div>
		);
	}

	return (
		<section className="response-promise-card" aria-label="Support Response Time Commitment">
			<div className="promise-badge-header">
				<span className="pulse-indicator" aria-hidden="true" />
				<span className="promise-kicker">Guaranteed Response Time Promise</span>
			</div>
			<div className="promise-content">
				<h3>Engineering &amp; Security Support SLAs</h3>
				<p>
					Every inquiry, issue, or security report is triaged directly by our engineering core. We don&apos;t route you through generic support queues.
				</p>
				<div className="sla-grid">
					<div className="sla-item">
						<span className="sla-time">&lt; 2 Hours</span>
						<strong>Security &amp; Vulnerability Reports</strong>
						<small>Immediate incident triage &amp; remediation branch</small>
					</div>
					<div className="sla-item">
						<span className="sla-time">&lt; 12 Hours</span>
						<strong>Enterprise &amp; Early Preview Inquiries</strong>
						<small>Direct architecture reviews and deployment assistance</small>
					</div>
					<div className="sla-item">
						<span className="sla-time">&lt; 24 Hours</span>
						<strong>Developer Feedback &amp; GitHub Issues</strong>
						<small>Actionable diagnostic guidance and patch timeline</small>
					</div>
				</div>
				<div className="promise-footer">
					<p>Need urgent architectural assistance or security coordination?</p>
					<Link href="/support" className="promise-action">
						View Support &amp; Recovery Channels →
					</Link>
				</div>
			</div>
		</section>
	);
}
