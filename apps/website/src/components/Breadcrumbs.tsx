import Link from "next/link";
import { sitePath } from "../lib/site-path";

export type BreadcrumbItem = {
	label: string;
	href?: string;
};

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
	const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://kestrel.local";

	const schemaData = {
		"@context": "https://schema.org",
		"@type": "BreadcrumbList",
		itemListElement: [
			{
				"@type": "ListItem",
				position: 1,
				name: "Home",
				item: `${siteUrl}/`,
			},
			...items.map((item, index) => ({
				"@type": "ListItem",
				position: index + 2,
				name: item.label,
				...(item.href ? { item: `${siteUrl}${item.href}` } : {}),
			})),
		],
	};

	return (
		<nav aria-label="Breadcrumb" className="breadcrumbs-nav">
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: JSON.stringify(schemaData) }}
			/>
			<ol className="breadcrumbs-list">
				<li className="breadcrumb-item">
					<Link href="/">Home</Link>
				</li>
				{items.map((item, index) => {
					const isLast = index === items.length - 1;
					return (
						<li key={item.label} className="breadcrumb-item">
							<span className="breadcrumb-separator" aria-hidden="true">
								/
							</span>
							{isLast || !item.href ? (
								<span className="breadcrumb-current" aria-current="page">
									{item.label}
								</span>
							) : (
								<Link href={item.href}>{item.label}</Link>
							)}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}
