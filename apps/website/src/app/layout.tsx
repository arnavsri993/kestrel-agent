import type { Metadata, Viewport } from "next";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "./globals.css";
import { sitePath } from "../lib/site-path";
import { GoogleAnalytics } from "../components/GoogleAnalytics";
import { JsonLd } from "../components/JsonLd";

const siteUrl = new URL(
	process.env.NEXT_PUBLIC_SITE_URL ?? "https://kestrel.local",
);
const socialImageUrl = new URL(
	sitePath("/media/social-preview.svg"),
	siteUrl.origin,
);

export const viewport: Viewport = {
	themeColor: "#090d0b",
	width: "device-width",
	initialScale: 1,
};

export const metadata: Metadata = {
	metadataBase: siteUrl,
	title: {
		default: "Kestrel — One Place for the Whole Job | Local-First AI Agent for macOS",
		template: "%s | Kestrel",
	},
	description:
		"A local-first macOS agent for coding, research, automation, files, and verified delivery from one project-aware conversation with deterministic approval boundaries.",
	keywords: [
		"macOS agent",
		"local-first AI",
		"Apple Silicon",
		"autonomous coding agent",
		"local LLM",
		"Ollama",
		"privacy-first agent",
		"approval boundaries",
		"developer tools",
	],
	authors: [{ name: "Kestrel Engineering Team" }],
	creator: "Kestrel",
	publisher: "Kestrel",
	robots: {
		index: true,
		follow: true,
		googleBot: {
			index: true,
			follow: true,
			"max-video-preview": -1,
			"max-image-preview": "large",
			"max-snippet": -1,
		},
	},
	icons: {
		icon: [
			{ url: sitePath("/brand/workstrand-icon.svg"), type: "image/svg+xml" },
		],
		shortcut: sitePath("/brand/workstrand-icon.svg"),
		apple: sitePath("/brand/workstrand-icon.svg"),
	},
	openGraph: {
		type: "website",
		locale: "en_US",
		url: siteUrl,
		siteName: "Kestrel",
		title: "Kestrel — One Place for the Whole Job | Local-First AI Agent for macOS",
		description:
			"Bring a project or a question. Kestrel can inspect, build, research, run, and verify the work with visible approval boundaries on Apple Silicon.",
		images: [
			{
				url: socialImageUrl.toString(),
				width: 1200,
				height: 630,
				alt: "Kestrel Local Work Agent Interface and Architecture Preview",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "Kestrel — One Place for the Whole Job",
		description:
			"Local-first macOS agent for coding, research, and automation with visible approval boundaries.",
		images: [socialImageUrl.toString()],
		creator: "@kestrelagent",
	},
	alternates: {
		canonical: "/",
	},
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en">
			<head>
				<JsonLd />
			</head>
			<body>
				<GoogleAnalytics />
				{children}
			</body>
		</html>
	);
}
