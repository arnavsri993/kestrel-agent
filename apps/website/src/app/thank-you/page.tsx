import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { ResponsePromise } from "../../components/ResponsePromise";
import { sitePath } from "../../lib/site-path";

export const metadata: Metadata = {
	title: "Thank You & Next Steps — Kestrel",
	description:
		"Confirmation, developer preview onboarding checklist, and direct resources for the Kestrel local work agent.",
};

export default function ThankYouPage() {
	return (
		<div className="thank-you-page-container">
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

			<main className="thank-you-main" id="content">
				<div className="thank-you-inner">
					<Breadcrumbs items={[{ label: "Thank You", href: "/thank-you" }]} />

					<header className="thank-you-header">
						<span className="kicker">Confirmation &amp; Onboarding</span>
						<h1>Thank you for connecting with Kestrel.</h1>
						<p>
							Your submission or inquiry has been received directly by our engineering team. We treat your inbox and device with the same privacy principles we build into our software.
						</p>
					</header>

					<div className="thank-you-grid">
						<section className="onboarding-card">
							<h2>Next Steps &amp; Developer Checklist</h2>
							<ol className="checklist-steps">
								<li>
									<span className="step-num">01</span>
									<div>
										<strong>Verify Your Apple Silicon System</strong>
										<p>Ensure your Mac is running macOS Ventura (13.0+) on an M1, M2, M3, or M4 chip.</p>
									</div>
								</li>
								<li>
									<span className="step-num">02</span>
									<div>
										<strong>Review the Safety &amp; Risk Grammar</strong>
										<p>Read how Kestrel gates external communication and protects local directories.</p>
									</div>
								</li>
								<li>
									<span className="step-num">03</span>
									<div>
										<strong>Configure Local Ollama or API Keys</strong>
										<p>Optionally prepare your local model runtime or keychain-backed provider keys.</p>
									</div>
								</li>
							</ol>

							<div className="thank-you-actions">
								<Link href="/case-studies" className="primary-cta">
									Explore Live Case Studies
								</Link>
								<Link href="/support" className="text-cta">
									Check System Readiness &amp; Support
								</Link>
							</div>
						</section>

						<aside className="thank-you-sidebar">
							<ResponsePromise compact={true} />

							<div className="resource-box">
								<h3>Helpful Resources</h3>
								<ul className="resource-list">
									<li>
										<Link href="/#decision">Verified Decision Flow</Link>
									</li>
									<li>
										<Link href="/#architecture">Security &amp; Encryption Model</Link>
									</li>
									<li>
										<Link href="/privacy">Privacy &amp; Data Deletion Policy</Link>
									</li>
									<li>
										<a
											href="https://github.com/arnavsri993/kestrel-agent"
											target="_blank"
											rel="noopener noreferrer"
										>
											GitHub Repository ↗
										</a>
									</li>
								</ul>
							</div>
						</aside>
					</div>
				</div>
			</main>

			<footer className="legal-footer">
				<strong>Kestrel</strong>
				<p>Local-first by architecture. Consequential actions stay visible.</p>
				<nav aria-label="Legal and support">
					<Link href="/">Home</Link>
					<Link href="/case-studies">Case Studies</Link>
					<Link href="/privacy">Privacy</Link>
					<Link href="/support">Support</Link>
				</nav>
			</footer>
		</div>
	);
}
