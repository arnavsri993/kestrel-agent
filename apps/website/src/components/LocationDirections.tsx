export function LocationDirections() {
	const mapUrl =
		"https://maps.google.com/?q=548+Market+St,+San+Francisco,+CA+94104";

	return (
		<section
			className="location-section"
			id="contact"
			aria-labelledby="location-title"
		>
			<div className="section-index">10 / HQ &amp; ENGINEERING HUB</div>
			<div className="section-heading">
				<h2 id="location-title">
					Find us in San Francisco.
					<span>Engineering Hub &amp; Visitor Directions.</span>
				</h2>
				<p>
					Visiting our engineering team or collaborating on security reviews? Here is how to find us in the Financial District / SOMA tech corridor.
				</p>
			</div>

			<div className="location-grid">
				<div className="location-card">
					<div className="location-header">
						<span className="location-badge">HQ &amp; WORKBENCH LAB</span>
						<h3>San Francisco Hub</h3>
						<address className="location-address">
							548 Market Street, Suite 39200<br />
							San Francisco, CA 94104<br />
							United States
						</address>
					</div>

					<div className="location-transit">
						<h4>Transit &amp; Directions</h4>
						<ul className="transit-list">
							<li>
								<span className="transit-icon">🚇</span>
								<div>
									<strong>BART &amp; Muni Metro</strong>
									<p>Montgomery St Station (2-minute walk / 0.1 miles)</p>
								</div>
							</li>
							<li>
								<span className="transit-icon">🚆</span>
								<div>
									<strong>Caltrain</strong>
									<p>San Francisco Station at 4th &amp; King (15 min via 30/45 bus or 20 min walk)</p>
								</div>
							</li>
							<li>
								<span className="transit-icon">✈️</span>
								<div>
									<strong>SFO Airport</strong>
									<p>Direct BART Red/Yellow line to Montgomery Station (approx 32 mins)</p>
								</div>
							</li>
						</ul>
					</div>

					<div className="location-actions">
						<a
							href={mapUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="map-button"
							aria-label="Open Google Maps for 548 Market Street, San Francisco"
						>
							Open in Google Maps ↗
						</a>
					</div>
				</div>

				<div className="map-embed-card" aria-label="Stylized map visualization">
					<div className="map-graphic">
						<div className="map-grid-layer" />
						<div className="map-pin">
							<div className="pin-pulse" />
							<div className="pin-core">★</div>
							<span className="pin-label">Kestrel Hub</span>
						</div>
						<div className="map-landmark market-st">Market St</div>
						<div className="map-landmark montgomery-st">Montgomery St</div>
						<div className="map-landmark sutter-st">Sutter St</div>
					</div>
					<div className="map-footer">
						<div className="coord-data">
							<span>LAT 37.7897° N</span>
							<span>LONG 122.4012° W</span>
						</div>
						<span className="coord-zone">PST / UTC-8</span>
					</div>
				</div>
			</div>
		</section>
	);
}
