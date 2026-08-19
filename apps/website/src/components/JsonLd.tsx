export function JsonLd() {
	const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://kestrel.local";
	const publisherName = process.env.NEXT_PUBLIC_PUBLISHER_NAME ?? "Kestrel Engineering Team";
	const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "security@kestrel.local";

	const softwareAppSchema = {
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: "Kestrel",
		operatingSystem: "macOS 13.0 or later (Apple Silicon arm64)",
		applicationCategory: "DeveloperApplication",
		description:
			"A local-first macOS agent for coding, research, automation, files, and verified delivery with visible approval boundaries.",
		offers: {
			"@type": "Offer",
			price: "0",
			priceCurrency: "USD",
			availability: "https://schema.org/InStock",
		},
		url: siteUrl,
		author: {
			"@type": "Organization",
			name: publisherName,
			url: siteUrl,
		},
		softwareRequirements: "Apple Silicon (M1/M2/M3/M4 or later), macOS Ventura (13.0+)",
		featureList: [
			"Local-first execution perimeter",
			"Consequential action approval gates",
			"Sandboxed IPC and encrypted secure storage",
			"Local model support (Ollama / GGUF) and cloud LLM integrations",
			"Transparent activity audit logging",
		],
	};

	const localBusinessSchema = {
		"@context": "https://schema.org",
		"@type": "LocalBusiness",
		name: "Kestrel Labs & Engineering Hub",
		image: `${siteUrl}/brand/workstrand-mark.svg`,
		"@id": `${siteUrl}#hq`,
		url: siteUrl,
		telephone: "+1-415-555-0199",
		priceRange: "$$",
		address: {
			"@type": "PostalAddress",
			streetAddress: "548 Market Street, Suite 39200",
			addressLocality: "San Francisco",
			addressRegion: "CA",
			postalCode: "94104",
			addressCountry: "US",
		},
		geo: {
			"@type": "GeoCoordinates",
			latitude: 37.7897,
			longitude: -122.4012,
		},
		openingHoursSpecification: [
			{
				"@type": "OpeningHoursSpecification",
				dayOfWeek: [
					"Monday",
					"Tuesday",
					"Wednesday",
					"Thursday",
					"Friday",
				],
				opens: "09:00",
				closes: "18:00",
			},
		],
		sameAs: [
			"https://github.com/arnavsri993/kestrel-agent",
			"https://x.com/kestrelagent",
		],
		contactPoint: {
			"@type": "ContactPoint",
			contactType: "customer support",
			email: supportEmail,
			availableLanguage: ["English"],
		},
	};

	const organizationSchema = {
		"@context": "https://schema.org",
		"@type": "Organization",
		name: publisherName,
		url: siteUrl,
		logo: `${siteUrl}/brand/workstrand-mark.svg`,
		sameAs: [
			"https://github.com/arnavsri993/kestrel-agent",
		],
		contactPoint: [
			{
				"@type": "ContactPoint",
				email: supportEmail,
				contactType: "technical support",
			},
		],
	};

	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareAppSchema) }}
			/>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusinessSchema) }}
			/>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
			/>
		</>
	);
}
