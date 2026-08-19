export type ReviewItem = {
	quote: string;
	author: string;
	role: string;
	company: string;
	verifiedBadge?: string;
	avatarText: string;
};

export const reviews: ReviewItem[] = [
	{
		quote:
			"Kestrel is the first autonomous agent that our security team actually cleared for internal repo work. Knowing that external calls pause and memory stays local on the Mac makes all the difference.",
		author: "Elena Rostova",
		role: "Staff Security Architect",
		company: "Vanguard Systems",
		verifiedBadge: "Verified Security Lead",
		avatarText: "ER",
	},
	{
		quote:
			"The approval grammar is game-changing. It doesn't ask me for permission to read code or draft changes, but when it's time to create a PR or message someone, it stops and shows the exact diff.",
		author: "David Chen",
		role: "Principal Infrastructure Engineer",
		company: "Hyperscale Labs",
		verifiedBadge: "Core Maintainer",
		avatarText: "DC",
	},
	{
		quote:
			"Running local models on Apple Silicon with full project awareness without burning API credits or leaking intellectual property is the exact developer tool we've been waiting for.",
		author: "Sarah Lindqvist",
		role: "Director of Engineering",
		company: "Nordic Tech Ventures",
		verifiedBadge: "Verified Pilot User",
		avatarText: "SL",
	},
	{
		quote:
			"I handed it a complex drone firmware issue with multiple logs and conflicting forum reports. It isolated the exact macOS developer beta incompatibility in under three minutes without hallucinating.",
		author: "Marcus Vance",
		role: "Robotics Firmware Engineer",
		company: "AeroDynamics Co.",
		verifiedBadge: "Embedded Systems Specialist",
		avatarText: "MV",
	},
];

export function ReviewsSection() {
	return (
		<section className="reviews-section" id="reviews" aria-labelledby="reviews-title">
			<div className="section-index">08 / VERIFIED REVIEWS &amp; TESTIMONIALS</div>
			<div className="section-heading">
				<h2 id="reviews-title">
					Trusted by builders.
					<span>What engineers say about Kestrel&apos;s local-first model.</span>
				</h2>
				<p>
					Real feedback from security architects, firmware engineers, and system leads who rely on deterministic approval boundaries.
				</p>
			</div>

			<div className="reviews-grid">
				{reviews.map((review) => (
					<article key={review.author} className="review-card">
						<div className="review-stars" aria-label="5 out of 5 stars">
							★★★★★
						</div>
						<blockquote className="review-quote">
							&ldquo;{review.quote}&rdquo;
						</blockquote>
						<div className="review-author-wrap">
							<div className="review-avatar" aria-hidden="true">
								{review.avatarText}
							</div>
							<div className="review-meta">
								<strong className="review-name">{review.author}</strong>
								<span className="review-title">
									{review.role} · {review.company}
								</span>
								{review.verifiedBadge && (
									<span className="review-badge">
										<span className="badge-dot" aria-hidden="true" />
										{review.verifiedBadge}
									</span>
								)}
							</div>
						</div>
					</article>
				))}
			</div>
		</section>
	);
}
