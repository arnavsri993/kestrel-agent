import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
	const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://kestrel.local";
	const currentDate = new Date().toISOString();

	return [
		{
			url: `${siteUrl}/`,
			lastModified: currentDate,
			changeFrequency: "weekly",
			priority: 1.0,
		},
		{
			url: `${siteUrl}/case-studies`,
			lastModified: currentDate,
			changeFrequency: "weekly",
			priority: 0.9,
		},
		{
			url: `${siteUrl}/support`,
			lastModified: currentDate,
			changeFrequency: "monthly",
			priority: 0.8,
		},
		{
			url: `${siteUrl}/privacy`,
			lastModified: currentDate,
			changeFrequency: "monthly",
			priority: 0.8,
		},
		{
			url: `${siteUrl}/thank-you`,
			lastModified: currentDate,
			changeFrequency: "monthly",
			priority: 0.5,
		},
	];
}
