import type { Metadata } from "next";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "./globals.css";
import { sitePath } from "../lib/site-path";

const siteUrl = new URL(
	process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
);
const socialImageUrl = new URL(
	sitePath("/media/social-preview.svg"),
	siteUrl.origin,
);

export const metadata: Metadata = {
	metadataBase: siteUrl,
	title: "Kestrel — one place for the whole job",
	description:
		"A local-first macOS agent for coding, research, automation, files, and verified delivery from one project-aware conversation.",
	icons: {
		icon: sitePath("/brand/workstrand-icon.svg"),
		shortcut: sitePath("/brand/workstrand-icon.svg"),
		apple: sitePath("/brand/workstrand-icon.svg"),
	},
	openGraph: {
		title: "Kestrel — one place for the whole job",
		description:
			"Bring a project or a question. Kestrel can inspect, build, research, run, and verify the work with visible approval boundaries.",
		images: [
			{
				url: socialImageUrl,
				width: 1200,
				height: 630,
				alt: "Kestrel local work agent",
			},
		],
	},
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
