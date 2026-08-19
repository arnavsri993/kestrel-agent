import type { Metadata } from "next";
import { SiteLegal } from "../../components/SiteLegal";

export const metadata: Metadata = {
	title: "Support, System Readiness & Diagnostics — Kestrel",
	description:
		"Setup guides, system readiness verification, OAuth recovery, Apple Silicon permissions, and diagnostic guidance for Kestrel.",
	alternates: {
		canonical: "/support",
	},
};

const publisherName = process.env.NEXT_PUBLIC_PUBLISHER_NAME?.trim() || "Kestrel Engineering";
const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || "support@kestrel.local";

const sections = [
	{
		title: "Start with readiness",
		paragraphs: [
			"Open Tools, then choose Readiness to check the local runtime, model route, protected storage, database, workspace access, and packaged application state. Use the automatic setup action for the recommended local model, or choose Manual setup to use an existing Ollama installation.",
			"Readiness reports observed state. It does not mark a provider connected until verification succeeds.",
		],
	},
	{
		title: "Model and account recovery",
		items: [
			"A local model can keep basic work available when cloud providers are unconfigured or offline.",
			"API keys can be replaced from Settings without exposing the previous value.",
			"OAuth connections can be disconnected and authorized again in the provider’s external browser page.",
			"Subscription-backed Codex or Claude routes require the provider’s authenticated command-line tool.",
			"If a provider is unavailable, inspect the route evidence before retrying or selecting a fallback.",
		],
	},
	{
		title: "Paired-node extensions",
		paragraphs: [
			"Kestrel ships only as an Apple Silicon Mac application. It does not provide an iPhone, Android, App Store, or Google Play companion.",
			"The gateway's authenticated paired-node protocol is an extension contract for separately developed clients. Pair only software you trust with a gateway you control; non-loopback gateways require HTTPS and can be revoked from Kestrel.",
		],
	},
	{
		title: "Event applications",
		paragraphs: [
			"Import the official event page, review eligibility evidence, and check every personal or sensitive answer. Agent-written answers remain unreviewed until you approve them. Kestrel cannot accept legal terms, attest eligibility, pay fees, or perform the final submission without an explicit browser approval.",
			"Keep the confirmation or receipt after submission; it is the evidence used to mark the application submitted.",
		],
	},
	{
		title: "Permissions and safe mode",
		paragraphs: [
			"Project-folder access, Accessibility, Screen Recording, microphone, location, and provider scopes remain separate. Grant only the permission needed for the current task.",
			"If behavior is unexpected, stop the task, disconnect the affected provider or device, and inspect Activity before retrying. Consequential actions remain approval-gated.",
		],
	},
	{
		title: "Backups and deletion",
		paragraphs: [
			"Use the verified local backup control before changing machines or resetting application data. A backup contains personal work context and must be protected like the original device.",
			"The destructive reset control removes Kestrel’s local application state. Revoke external OAuth grants separately with each provider.",
		],
	},
	{
		title: "Guaranteed support SLA & contact",
		paragraphs: [
			`${publisherName} provides Kestrel engineering, security, account, privacy, and deletion support at ${supportEmail}. Include the app version, platform, and the relevant non-sensitive readiness error; never send API keys, OAuth tokens, private prompts, or pairing credentials.`,
			"Our team enforces strict response targets: < 2 hours for critical/security escalations, < 12 hours for enterprise setups, and < 24 hours for developer triage.",
		],
	},
];

export default function SupportPage() {
	return (
		<SiteLegal
			eyebrow="Product support & readiness"
			title="Recover from evidence, not guesswork."
			summary="Kestrel exposes setup, connection, permission, and activity state so most failures can be diagnosed without sharing private prompts."
			updated="August 14, 2026"
			sections={sections}
			breadcrumbs={[{ label: "Support & Readiness", href: "/support" }]}
			showSla={true}
		/>
	);
}
