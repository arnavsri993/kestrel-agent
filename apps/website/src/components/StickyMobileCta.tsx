"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export function StickyMobileCta() {
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		const handleScroll = () => {
			// Show sticky CTA when scrolled past hero section (approx 400px)
			if (window.scrollY > 380) {
				setVisible(true);
			} else {
				setVisible(false);
			}
		};

		window.addEventListener("scroll", handleScroll, { passive: true });
		return () => window.removeEventListener("scroll", handleScroll);
	}, []);

	if (!visible) return null;

	return (
		<aside className="sticky-mobile-cta" aria-label="Quick action">
			<div className="sticky-cta-content">
				<div className="sticky-cta-info">
					<strong>Kestrel macOS</strong>
					<small>Local-first work agent</small>
				</div>
				<div className="sticky-cta-buttons">
					<a href="#decision" className="sticky-btn-primary">
						Explore Workflows
					</a>
					<Link href="/case-studies" className="sticky-btn-secondary">
						Cases
					</Link>
				</div>
			</div>
		</aside>
	);
}
