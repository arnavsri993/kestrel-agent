import type { Metadata } from "next";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: "Workstrand — one place for the whole job",
  description: "A local-first macOS agent for coding, research, automation, files, and verified delivery from one project-aware conversation.",
  icons: {
    icon: "/brand/workstrand-icon.svg",
    shortcut: "/brand/workstrand-icon.svg",
    apple: "/brand/workstrand-icon.svg"
  },
  openGraph: {
    title: "Workstrand — one place for the whole job",
    description: "Bring a project or a question. Workstrand can inspect, build, research, run, and verify the work with visible approval boundaries.",
    images: [{ url: "/media/social-preview.svg", width: 1200, height: 630, alt: "Workstrand local work agent" }]
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
