import Link from "next/link";
import { sitePath } from "../lib/site-path";

export default function NotFound() {
	return (
		<div className="not-found-container">
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

			<main className="not-found-main" id="content">
				<div className="not-found-content">
					<span className="not-found-code">404 / NOT FOUND</span>
					<h1>The requested route does not exist in local context.</h1>
					<p>
						The page or resource you are looking for might have been moved, renamed, or is outside the current scope boundary.
					</p>

					<div className="not-found-actions">
						<Link href="/" className="primary-cta">
							Return to Home Overview
						</Link>
						<Link href="/case-studies" className="text-cta">
							Explore Case Studies
						</Link>
						<Link href="/support" className="text-cta">
							Support &amp; Diagnostics
						</Link>
					</div>

					<div className="not-found-links-card">
						<h3>Suggested Navigation Paths</h3>
						<ul className="not-found-list">
							<li>
								<Link href="/#decision">01 / Complete Decision Workflow</Link>
							</li>
							<li>
								<Link href="/#memory">02 / Context With A Boundary</Link>
							</li>
							<li>
								<Link href="/#control">03 / Safety &amp; Risk Policy Model</Link>
							</li>
							<li>
								<Link href="/#faq">07 / Frequently Asked Questions</Link>
							</li>
							<li>
								<Link href="/privacy">Privacy Policy &amp; Security Perimeter</Link>
							</li>
						</ul>
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
