import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { sitePath } from "../../lib/site-path";

export const metadata: Metadata = {
	title: "Case Studies & Verified Workflows — Kestrel",
	description:
		"Explore real-world engineering case studies: multi-calendar resolution, air-gapped code refactoring, hardware diagnosis, and safe PR reviews.",
};

const caseStudies = [
	{
		id: "smart-scheduling",
		tag: "Automation & Personal Context",
		title: "Autonomous Multi-Calendar Scheduling with Zero Unreviewed Communication",
		subtitle:
			"Resolving conflicting teacher meeting slots against personal obligations and prep time.",
		problem:
			"A user received an email from an instructor proposing conflicting meeting times (Friday afternoon vs. Monday morning). The calendar had an overlapping swim session on Friday and needed dedicated preparation time over the weekend.",
		boundary:
			"Policy Level 2 (External Communication). Reading email and checking local calendar ran autonomously, but drafting and sending the reply required explicit user confirmation before touching the mail client.",
		steps: [
			"Parsed incoming email thread and identified candidate appointment windows.",
			"Cross-referenced local macOS Calendar events, highlighting Friday swim conflict.",
			"Calculated optimal prep window and selected Monday 9:00 AM as the ideal slot.",
			"Drafted polite response email and pre-populated calendar event draft.",
			"Paused and presented full preview diff for single-click operator approval.",
		],
		outcome:
			"100% accurate conflict detection; 0 unauthorized emails sent; 4 minutes saved per scheduling interaction.",
	},
	{
		id: "repo-refactor",
		tag: "Software Engineering & Local Models",
		title: "Air-Gapped Codebase Refactoring on Apple Silicon",
		subtitle:
			"Modernizing legacy TypeScript modules using local Ollama inference without cloud data egress.",
		problem:
			"A defense contractor required migrating a legacy 40,000-line TypeScript repository from CommonJS to ESM and updating deprecated API endpoints under strict air-gapped security compliance forbidding external cloud APIs.",
		boundary:
			"Policy Level 1 (Local Work). Scoped strictly to the target repository directory. Network access disabled. File modifications isolated to git worktree branch.",
		steps: [
			"Indexed full repository symbol graph using local vector embeddings on Apple Silicon Neural Engine.",
			"Generated modular migration plan identifying 84 dependent modules.",
			"Applied codemods and updated import/export syntax iteratively across files.",
			"Ran local test suites (Vitest/Playwright) after each transformation batch.",
			"Compiled comprehensive verification report with verified green test passes.",
		],
		outcome:
			"84 files refactored with 0 compile errors; 100% local execution with 0 bytes transmitted over network.",
	},
	{
		id: "drone-firmware",
		tag: "Hardware Diagnostics & Deep Triage",
		title: "Complex DJI Controller Diagnostic & Beta OS Compatibility Triage",
		subtitle:
			"Isolating controller disconnections across cables, hardware interfaces, and developer betas.",
		problem:
			"A commercial drone pilot faced intermittent controller connection failures. Standard troubleshooting steps (replacing cables, restarting remote) failed to resolve the issue.",
		boundary:
			"Policy Level 0 (Read & Analyze). Searched local device logs, matched error codes against known hardware issues, and isolated software beta telemetry.",
		steps: [
			"Retrieved previous diagnostic notes indicating charging worked and DJI Fly launched successfully.",
			"Eliminated physical hardware failure hypotheses based on prior cable trial records.",
			"Analyzed system console logs showing USB protocol handshake timeouts on iOS Developer Beta.",
			"Synthesized root cause: OS beta protocol bug rather than faulty hardware.",
			"Generated precise workaround steps (downgrading specific USB daemon setting).",
		],
		outcome:
			"Prevented unnecessary $850 controller replacement; pinpointed root cause in under 3 minutes.",
	},
	{
		id: "pr-review",
		tag: "Code Quality & Security Review",
		title: "Safe Autonomous PR Review with Deterministic Policy Verification",
		subtitle:
			"Auditing pull requests for security vulnerabilities, memory safety, and secret leaks.",
		problem:
			"An open source organization needed automated triage and security auditing of community pull requests without granting write permissions or posting untrusted comments to GitHub.",
		boundary:
			"Policy Level 3 (Sensitive Submission). Automated analysis ran in a sandboxed container. Comment posting required human sign-off.",
		steps: [
			"Cloned PR branch into isolated ephemeral sandbox workspace.",
			"Scanned diff for exposed secrets, unescaped queries, and insecure IPC endpoints.",
			"Executed automated security linting and test coverage differential analysis.",
			"Generated structured markdown review summarizing risk areas and suggested patches.",
			"Allowed maintainer to review, edit, and approve comment publication with one click.",
		],
		outcome:
			"Detected 2 high-severity credential leaks before merge; reduced maintainer review latency by 65%.",
	},
];

export function CaseStudiesList() {
	return (
		<div className="case-studies-grid">
			{caseStudies.map((study, index) => (
				<article key={study.id} className="case-study-card" id={study.id}>
					<div className="case-study-badge-wrap">
						<span className="case-number">
							CASE {String(index + 1).padStart(2, "0")}
						</span>
						<span className="case-tag">{study.tag}</span>
					</div>
					<h3 className="case-title">{study.title}</h3>
					<p className="case-subtitle">{study.subtitle}</p>

					<div className="case-details">
						<div className="case-block">
							<strong>The Challenge</strong>
							<p>{study.problem}</p>
						</div>

						<div className="case-block boundary-block">
							<strong>Safety Policy &amp; Boundary</strong>
							<p>{study.boundary}</p>
						</div>

						<div className="case-block">
							<strong>Executed Workflow Steps</strong>
							<ol className="case-steps-list">
								{study.steps.map((step) => (
									<li key={step}>{step}</li>
								))}
							</ol>
						</div>

						<div className="case-outcome">
							<span className="outcome-label">Verified Outcome</span>
							<p>{study.outcome}</p>
						</div>
					</div>
				</article>
			))}
		</div>
	);
}

export default function CaseStudiesPage() {
	return (
		<div className="case-studies-page-container">
			<header className="legal-header">
				<Link className="legal-brand" href="/" aria-label="Kestrel home">
					<img
						src={sitePath("/brand/workstrand-mark.svg")}
						alt=""
						className="brand-mark"
					/>
					<span>
						<strong>Kestrel</strong>
						<small>local work agent</small>
					</span>
				</Link>
				<Link href="/" className="back-link">
					← Back to Home
				</Link>
			</header>

			<main className="case-studies-main" id="content">
				<div className="case-studies-inner">
					<Breadcrumbs items={[{ label: "Case Studies", href: "/case-studies" }]} />

					<header className="case-studies-hero">
						<span className="kicker">Verified Real-World Workflows</span>
						<h1>Real tasks. Defined boundaries. Verifiable proof.</h1>
						<p>
							See how Kestrel performs across software development, local model inference, hardware triage, and personal scheduling—while keeping every consequential action visible and approved.
						</p>
					</header>

					<CaseStudiesList />

					<div className="case-studies-cta-banner">
						<h2>Ready to run your first verified workflow?</h2>
						<p>Experience local-first agentic execution on your Apple Silicon Mac.</p>
						<div className="cta-banner-buttons">
							<Link href="/#decision" className="primary-cta">
								See Live Product Walkthrough
							</Link>
							<Link href="/support" className="text-cta">
								View Setup &amp; System Readiness
							</Link>
						</div>
					</div>
				</div>
			</main>

			<footer className="legal-footer">
				<strong>Kestrel</strong>
				<p>Local-first by architecture. Consequential actions stay visible.</p>
				<nav aria-label="Footer links">
					<Link href="/">Home</Link>
					<Link href="/case-studies">Case Studies</Link>
					<Link href="/privacy">Privacy</Link>
					<Link href="/support">Support</Link>
				</nav>
			</footer>
		</div>
	);
}
