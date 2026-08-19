"use client";

import { motion, useReducedMotion } from "motion/react";
import type { MouseEvent } from "react";
import Link from "next/link";
import { AmbientMedia, type VisualAsset } from "../components/AmbientMedia";
import {
	ApprovalScene,
	ContextScene,
	TeacherScene,
} from "../components/ProductScenes";
import { FaqSection } from "../components/FaqSection";
import { ReviewsSection } from "../components/ReviewsSection";
import { TeamSection } from "../components/TeamSection";
import { LocationDirections } from "../components/LocationDirections";
import { ResponsePromise } from "../components/ResponsePromise";
import { StickyMobileCta } from "../components/StickyMobileCta";
import mediaRegistry from "../data/media-registry.json";
import { resolvePublicRelease } from "../lib/release-config";
import { sitePath } from "../lib/site-path";

const assets = mediaRegistry as VisualAsset[];
const hero = assets.find((asset) => asset.id === "hero-signal-field")!;
const cta = assets.find((asset) => asset.id === "cta-resolution-field")!;

const stages = ["Notice", "Retrieve", "Plan", "Approve", "Act", "Verify"];
const repositoryUrl = "https://github.com/arnavsri993/kestrel-agent";

const capabilityExamples = [
	{
		trigger: "A repository is shared",
		work: "Inspect the project, plan the change, implement it, and run the relevant checks.",
		boundary: "Local changes remain reviewable.",
	},
	{
		trigger: "A folder is provided",
		work: "Understand the contents, apply the requested transformation, and organize the outputs.",
		boundary: "Access stays scoped to the selected folder.",
	},
	{
		trigger: "A scheduling request arrives",
		work: "Compare commitments, recommend an option, and prepare the reply and event.",
		boundary: "External communication waits for approval.",
	},
	{
		trigger: "The task is unfamiliar",
		work: "Discover available tools and skills, construct a plan, and verify the result.",
		boundary: "Missing capability is reported, not invented.",
	},
];

const featuredCaseStudies = [
	{
		title: "Autonomous Multi-Calendar Scheduling",
		tag: "Personal Context",
		summary: "Resolving overlapping teacher appointments against swim sessions and prep blocks with zero unreviewed emails.",
		link: "/case-studies#smart-scheduling",
	},
	{
		title: "Air-Gapped Codebase Refactoring",
		tag: "Software Engineering",
		summary: "Modernizing 40,000 lines of TypeScript to ESM with local Apple Silicon models and 100% green test passes.",
		link: "/case-studies#repo-refactor",
	},
	{
		title: "DJI Drone Controller Diagnostics",
		tag: "Hardware Triage",
		summary: "Isolating USB handshake timeouts on iOS Developer Beta in under 3 minutes without unnecessary hardware replacements.",
		link: "/case-studies#drone-firmware",
	},
];

const securityControls = [
	[
		"01",
		"Encrypted memory fields",
		"AES-256-GCM protects stored content. The database key stays in macOS secure storage and never enters the renderer.",
	],
	[
		"02",
		"Sandboxed interface",
		"No Node integration, raw filesystem, or database handle. IPC remains narrow and schema-validated.",
	],
	[
		"03",
		"Scoped permissions",
		"Selected folders are allowlisted. Accessibility, screen recording, and Apple Events stay off until needed.",
	],
	[
		"04",
		"Untrusted-content boundary",
		"Email and web content remain data. Deterministic policy—not text inside that content—governs tools.",
	],
	[
		"05",
		"Inspectable activity",
		"Observation, context, proposal, approval, execution, and verification appear as separate audit events.",
	],
	[
		"06",
		"Deletable context",
		"The architecture includes source inspection, correction, deletion, and channel-separated storage.",
	],
];

const publicRelease = resolvePublicRelease({
	NEXT_PUBLIC_RELEASE_VERSION: process.env.NEXT_PUBLIC_RELEASE_VERSION,
	NEXT_PUBLIC_RELEASE_STATUS: process.env.NEXT_PUBLIC_RELEASE_STATUS,
	NEXT_PUBLIC_DOWNLOAD_URL: process.env.NEXT_PUBLIC_DOWNLOAD_URL,
	NEXT_PUBLIC_RELEASE_MANIFEST_URL:
		process.env.NEXT_PUBLIC_RELEASE_MANIFEST_URL,
	NEXT_PUBLIC_RELEASE_CHECKSUMS_URL:
		process.env.NEXT_PUBLIC_RELEASE_CHECKSUMS_URL,
});

const releaseChecks = publicRelease.available
	? [
			["available", "Developer ID signature and Apple notarization"],
			["available", "Gatekeeper-verified Apple Silicon DMG"],
			["available", "Apple Silicon arm64 architecture verification"],
			["available", "Published manifest and SHA-256 checksums"],
			["available", "Signed direct-download and update channel"],
		]
	: [
			["available", "Ad-hoc-signed Apple Silicon development app"],
			["pending", "Developer ID signing and notarization"],
			["pending", "Gatekeeper verification on packaged artifacts"],
			["available", "Apple Silicon arm64 architecture verification"],
			["pending", "Public download, manifest, checksums, and update host"],
		];

function Arrow() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<path d="M4 12h15M14 6l6 6-6 6" />
		</svg>
	);
}

function Brand() {
	return (
		<span className="brand-lockup">
			<img
				className="brand-mark"
				src={sitePath("/brand/workstrand-mark.svg")}
				alt="Kestrel Workstrand Logo Mark"
			/>
			<strong>Kestrel</strong>
			<small>local work agent</small>
		</span>
	);
}

const navItems = [
	["Decision", "#decision"],
	["Memory", "#memory"],
	["Control", "#control"],
	["Architecture", "#architecture"],
	["Cases", "/case-studies"],
	["Leaderboard", "/leaderboard"],
	["FAQ", "#faq"],
	["Reviews", "#reviews"],
	["Team", "#team"],
	["Contact", "#contact"],
];

function closeMobileMenu(event: MouseEvent<HTMLAnchorElement>) {
	const details = event.currentTarget.closest("details");
	const href = event.currentTarget.getAttribute("href");
	const target = href?.startsWith("#")
		? document.getElementById(href.slice(1))
		: null;
	if (details) details.open = false;
	requestAnimationFrame(() => {
		(target ?? details?.querySelector<HTMLElement>("summary"))?.focus({
			preventScroll: true,
		});
	});
}

export default function Home() {
	const reduced = useReducedMotion();

	return (
		<>
			<a className="skip-link" href="#content">
				Skip to product story
			</a>

			<header className="site-header">
				<nav className="site-nav" aria-label="Primary navigation">
					<a className="site-brand" href="#top" aria-label="Kestrel home">
						<Brand />
					</a>
					<div className="nav-links">
						{navItems.map(([label, href]) => (
							<a key={href} href={href}>
								{label}
							</a>
						))}
					</div>
					<a className="nav-release" href="#release">
						Release status <Arrow />
					</a>
					<details className="nav-menu">
						<summary>Menu</summary>
						<div>
							{navItems.map(([label, href]) => (
								<a key={href} href={href} onClick={closeMobileMenu}>
									{label}
								</a>
							))}
							<a href="#release" onClick={closeMobileMenu}>
								Release status
							</a>
						</div>
					</details>
				</nav>
			</header>

			<main id="content">
				{/* ── Hero (CTA Above the Fold) ────────────────────────────── */}
				<section className="hero" id="top" aria-labelledby="hero-title">
					<AmbientMedia asset={hero} className="hero-media" />
					<div className="hero-copy">
						<span className="kicker">One local place for the whole job</span>
						<h1 id="hero-title">
							Bring the outcome.<span>Kestrel handles the work.</span>
						</h1>
						<p>
							Choose a project and say what done looks like. Kestrel can
							inspect, build, research, run, and verify—then pause before
							consequential action.
						</p>
						<div className="hero-actions">
							<a className="primary-cta" href="#decision" id="hero-primary-cta">
								See verified workflow <Arrow />
							</a>
							<Link className="secondary-cta" href="/case-studies">
								Explore Case Studies
							</Link>
							<a className="text-cta" href="#control">
								Safety model
							</a>
						</div>
						<div className="hero-sla-pill">
							<span className="sla-dot" aria-hidden="true" />
							<span>Response Guarantee: &lt; 2h Security · &lt; 24h Dev SLA</span>
						</div>
						<small className="availability">
							Development preview · mocked connectors · no signed public
							download yet
						</small>
					</div>
					<div className="hero-product">
						<TeacherScene />
					</div>
					<motion.div
						className="hero-thread"
						initial={reduced ? false : { scaleX: 0 }}
						animate={{ scaleX: 1 }}
						transition={{
							duration: 1.1,
							delay: 0.2,
							ease: [0.22, 1, 0.36, 1],
						}}
					/>
				</section>

				{/* ── Stage Strip ──────────────────────────────────────────── */}
				<ol className="stage-strip" aria-label="Kestrel decision path">
					{stages.map((stage, index) => (
						<li key={stage}>
							<span>{String(index + 1).padStart(2, "0")}</span>
							<strong>{stage}</strong>
							{index < stages.length - 1 && <i aria-hidden="true" />}
						</li>
					))}
				</ol>

				{/* ── 01 Decision ──────────────────────────────────────────── */}
				<section
					className="narrative-section decision-section"
					id="decision"
					aria-labelledby="decision-title"
					tabIndex={-1}
				>
					<div className="section-index">01 / ONE COMPLETE DECISION</div>
					<div className="section-heading">
						<h2 id="decision-title">
							A request arrives.
							<span>A reviewable answer is already waiting.</span>
						</h2>
						<p>
							A teacher offered Friday or Monday. Kestrel checked the calendar,
							found Friday swim, protected the weekend for study, and prepared
							the exact changes—without sending them.
						</p>
					</div>
					<div className="teacher-workflow">
						<ol
							className="workflow-rail"
							aria-label="Scheduling decision evidence"
						>
							{[
								"Email read",
								"Options extracted",
								"Calendar compared",
								"Monday recommended",
								"Reply drafted",
								"Event prepared",
								"Approval requested",
							].map((item, index) => (
								<li key={item} className={index === 6 ? "active" : "done"}>
									<span>{index < 6 ? "✓" : "07"}</span>
									<strong>{item}</strong>
								</li>
							))}
						</ol>
						<TeacherScene />
					</div>
				</section>

				{/* ── 02 Memory ────────────────────────────────────────────── */}
				<section
					className="memory-section"
					id="memory"
					aria-labelledby="memory-title"
					tabIndex={-1}
				>
					<div className="memory-copy">
						<div className="section-index">02 / CONTEXT WITH A BOUNDARY</div>
						<h2 id="memory-title">
							Remember less.<span>Use the part that changes the answer.</span>
						</h2>
						<p>
							When a DJI controller reports a connection problem, generic
							troubleshooting starts with a cable and restart. Kestrel can avoid
							repeating steps already tried and weigh the phone&apos;s developer
							beta instead.
						</p>
						<blockquote>
							&ldquo;Because the phone still charges, DJI Fly launches, and another
							cable already failed, software compatibility now outranks a dead
							controller.&rdquo;
						</blockquote>
						<div className="memory-note">
							<span>Retrieval scope</span>
							<strong>Decision-changing context only</strong>
							<small>
								Unrelated personal memory stays outside the working context.
							</small>
						</div>
					</div>
					<ContextScene />
				</section>

				{/* ── 03 Control ───────────────────────────────────────────── */}
				<section
					className="control-section"
					id="control"
					aria-labelledby="control-title"
					tabIndex={-1}
				>
					<div className="control-copy" id="safety">
						<div className="section-index">03 / CONTROL THAT STAYS VISIBLE</div>
						<h2 id="control-title">Autonomy stops where consequence starts.</h2>
						<p>
							Every action receives a policy level. External communication
							pauses by default. Sensitive submissions and high-consequence
							changes always require stronger review.
						</p>
						<ol className="risk-ladder" aria-label="Kestrel action levels">
							<li>
								<span>0</span>
								<div>
									<strong>Read and prepare</strong>
									<small>No external side effect</small>
								</div>
							</li>
							<li>
								<span>1</span>
								<div>
									<strong>Reversible local work</strong>
									<small>Configurable approval</small>
								</div>
							</li>
							<li className="active">
								<span>2</span>
								<div>
									<strong>External communication</strong>
									<small>Approval by default</small>
								</div>
							</li>
							<li>
								<span>3</span>
								<div>
									<strong>Sensitive submission</strong>
									<small>Explicit review every time</small>
								</div>
							</li>
							<li>
								<span>4</span>
								<div>
									<strong>High consequence</strong>
									<small>Strong confirmation</small>
								</div>
							</li>
						</ol>
					</div>
					<div className="demo-wrap">
						<span className="demo-label">Try the local approval state</span>
						<ApprovalScene />
						<p className="demo-boundary">
							This interaction changes only the preview in your browser. It has
							no agent endpoint.
						</p>
					</div>
				</section>

				{/* ── 04 Capability ────────────────────────────────────────── */}
				<section
					className="capability-section"
					aria-labelledby="capability-title"
				>
					<div className="section-index">04 / ONE GRAMMAR, DIFFERENT WORK</div>
					<div className="section-heading compact-heading">
						<h2 id="capability-title">
							The plan changes.<span>The safety grammar does not.</span>
						</h2>
						<p>
							Kestrel uses available tools and installable skills to plan
							unfamiliar work. Each example below is a task shape—not a claim of
							a dedicated production integration.
						</p>
					</div>
					<div className="capability-ledger">
						{capabilityExamples.map((example, index) => (
							<article key={example.trigger}>
								<span>{String(index + 1).padStart(2, "0")}</span>
								<h3>{example.trigger}</h3>
								<p>{example.work}</p>
								<small>{example.boundary}</small>
							</article>
						))}
					</div>
				</section>

				{/* ── 05 Featured Case Studies ──────────────────────────────── */}
				<section
					className="featured-cases-section"
					id="cases"
					aria-labelledby="cases-title"
				>
					<div className="section-index">05 / VERIFIED CASE STUDIES</div>
					<div className="section-heading compact-heading">
						<h2 id="cases-title">
							Proven workflows in practice.
							<span>Real tasks executed within strict safety boundaries.</span>
						</h2>
						<p>
							Explore detailed breakdowns of how Kestrel handles calendar conflicts, air-gapped code refactors, and embedded hardware diagnostics.
						</p>
					</div>
					<div className="featured-cases-grid">
						{featuredCaseStudies.map((cs) => (
							<article key={cs.title} className="featured-case-card">
								<span className="case-tag-pill">{cs.tag}</span>
								<h3>{cs.title}</h3>
								<p>{cs.summary}</p>
								<Link href={cs.link} className="case-card-link">
									Read Full Workflow Breakdown →
								</Link>
							</article>
						))}
					</div>
					<div className="cases-footer-cta">
						<Link href="/case-studies" className="primary-cta">
							View All Case Studies &amp; Metrics <Arrow />
						</Link>
					</div>
				</section>

				{/* ── 06 Token Arena & Community Leaderboard ─────────────────── */}
				<section
					className="leaderboard-spotlight-section"
					id="arena"
					aria-labelledby="arena-title"
				>
					<div className="section-index">06 / COMMUNITY TOKEN ARENA</div>
					<div className="section-heading compact-heading">
						<h2 id="arena-title">
							Compete on throughput and cache efficiency.
							<span>Gamified token metrics, daily streaks, and community tiers.</span>
						</h2>
						<p>
							Benchmark your AI workflows against engineers worldwide. Track
							prompt ROI, build consecutive daily streaks, and climb from
							Apprentice to Grandmaster—with zero private context leaving your
							device.
						</p>
					</div>

					<div className="arena-spotlight-grid">
						<div className="arena-preview-card">
							<div className="arena-card-top">
								<span className="live-pill">● Live Weekly Sprint</span>
								<span className="arena-metric-label">Leaderboard Snapshot</span>
							</div>
							<div className="arena-podium-mini">
								<div className="mini-podium-item gold">
									<span className="mini-rank">👑 #1</span>
									<strong>@vector_valkyrie</strong>
									<small>8.45M tokens · 98.4% ROI</small>
								</div>
								<div className="mini-podium-item silver">
									<span className="mini-rank">🥈 #2</span>
									<strong>@context_king</strong>
									<small>7.12M tokens · 96.1% ROI</small>
								</div>
								<div className="mini-podium-item bronze">
									<span className="mini-rank">🥉 #3</span>
									<strong>@synth_weaver</strong>
									<small>5.34M tokens · 93.8% ROI</small>
								</div>
							</div>
							<div className="arena-card-footer">
								<div className="arena-privacy-tag">
									🛡️ 100% Local-first telemetry &amp; Pseudonymous handles
								</div>
								<Link href="/leaderboard" className="button button-primary">
									Enter Token Arena &amp; View Standings →
								</Link>
							</div>
						</div>

						<div className="arena-stats-highlights">
							<div className="highlight-box">
								<span className="highlight-icon">⚡</span>
								<div>
									<h4>Prompt ROI Scoring</h4>
									<p>
										Rewards cache hits and minimal token waste per verified
										task completion.
									</p>
								</div>
							</div>
							<div className="highlight-box">
								<span className="highlight-icon">🔥</span>
								<div>
									<h4>Daily Active Streaks</h4>
									<p>
										Build uninterrupted builder momentum with streak multipliers
										and tier rank protection.
									</p>
								</div>
							</div>
							<div className="highlight-box">
								<span className="highlight-icon">🏆</span>
								<div>
									<h4>Four Competitive Leagues</h4>
									<p>
										Token Titans (Volume), Efficiency Architects, Streak
										Masters, and Deep Reasoning.
									</p>
								</div>
							</div>
						</div>
					</div>
				</section>

				{/* ── 06 Security & Architecture ────────────────────────────── */}
				<section
					className="security-section"
					id="architecture"
					aria-labelledby="architecture-title"
					tabIndex={-1}
				>
					<div className="section-index">06 / LOCAL-FIRST BY ARCHITECTURE</div>
					<div className="section-heading compact-heading">
						<h2 id="architecture-title">Personal context has a perimeter.</h2>
						<p>
							The current vertical slice implements these controls. A production
							release remains gated on packaged security, signing, and hardware
							verification.
						</p>
					</div>
					<div className="security-ledger">
						{securityControls.map(([index, title, copy]) => (
							<article key={title}>
								<span>{index}</span>
								<h3>{title}</h3>
								<p>{copy}</p>
							</article>
						))}
					</div>
				</section>

				{/* ── 07 FAQs ──────────────────────────────────────────────── */}
				<FaqSection />

				{/* ── 08 Reviews ───────────────────────────────────────────── */}
				<ReviewsSection />

				{/* ── 09 Team ──────────────────────────────────────────────── */}
				<TeamSection />

				{/* ── 10 Location & Directions ─────────────────────────────── */}
				<LocationDirections />

				{/* ── 11 Response Promise SLA Banner ─────────────────────────── */}
				<div className="home-sla-wrap">
					<ResponsePromise />
				</div>

				{/* ── 12 Release Status ────────────────────────────────────── */}
				<section
					className="release-section"
					id="release"
					aria-labelledby="release-title"
					tabIndex={-1}
				>
					<AmbientMedia asset={cta} />
					<div className="release-copy">
						<div className="section-index">12 / RELEASE READINESS</div>
						<h2 id="release-title">
							{publicRelease.available
								? "Download Kestrel for Apple Silicon."
								: "The development app is real."}
							<span>
								{publicRelease.available
									? "Signed, notarized, and traceable to its checksum."
									: "The public release is not ready to pretend."}
							</span>
						</h2>
						<p>
							{publicRelease.available
								? "The direct-download build is for M-series Macs. Its release manifest and SHA-256 checksums remain beside the installer so the artifact can be independently verified."
								: "A signed download stays unavailable until the distribution gates are complete. The website will not turn pending infrastructure into a fake call to action."}
						</p>
						<div
							className="release-actions"
							aria-label={
								publicRelease.available
									? "Apple Silicon release actions"
									: "Unavailable release actions"
							}
						>
							{publicRelease.available ? (
								<>
									<a
										className="release-download"
										href={publicRelease.downloadUrl}
									>
										Download for Apple Silicon{" "}
										<small>DMG · {publicRelease.version}</small>
									</a>
									<a
										className="release-verify"
										href={publicRelease.manifestUrl}
									>
										Verify this release <small>manifest + SHA-256</small>
									</a>
								</>
							) : (
								<>
									<button type="button" disabled>
										Download for Apple Silicon <small>not signed yet</small>
									</button>
									<button type="button" disabled>
										Verify this release <small>publishing later</small>
									</button>
								</>
							)}
						</div>
						{publicRelease.available && (
							<p className="release-provenance">
								Checksums: <a href={publicRelease.checksumsUrl}>SHA256SUMS</a> ·
								Requires an Apple Silicon Mac running macOS 13 or later.
							</p>
						)}
					</div>
					<div className="release-panel">
						<p className="release-version">
							<span>Current version</span>
							<strong>{publicRelease.version}</strong>
						</p>
						<ul className="release-checklist">
							{releaseChecks.map(([status, label]) => (
								<li key={label} className={status}>
									<span>{status === "available" ? "Ready" : "Pending"}</span>
									<strong>{label}</strong>
								</li>
							))}
						</ul>
					</div>
				</section>
			</main>

			{/* ── Footer ───────────────────────────────────────────────────── */}
			<footer className="site-footer">
				<div className="footer-brand">
					<Brand />
				</div>
				<p>
					A local-first workbench for coding, research, automation, files, and
					verified delivery—with consequential actions kept visible.
				</p>
				<div className="footer-links">
					{navItems.map(([label, href]) => (
						<a key={href} href={href}>
							{label}
						</a>
					))}
					<a href="#release">Release</a>
					<Link href="/case-studies">Case Studies</Link>
					<Link href="/leaderboard">Leaderboard</Link>
					<Link href="/privacy">Privacy</Link>
					<Link href="/support">Support</Link>
					<Link href="/thank-you">Onboarding</Link>
					<a href={repositoryUrl} target="_blank" rel="noopener noreferrer">
						Repository ↗
					</a>
				</div>
				<div className="provenance">
					<strong>Build provenance &amp; Quality Commitment</strong>
					<p>
						fal is used only by deliberate development scripts for optional
						website atmosphere. It is absent from the public runtime and is not
						a Kestrel capability. All local features execute directly on Apple Silicon.
					</p>
				</div>
			</footer>

			{/* ── Sticky Mobile CTA ────────────────────────────────────────── */}
			<StickyMobileCta />
		</>
	);
}
