import type { Metadata } from "next";
import { SiteLegal } from "../../components/SiteLegal";

export const metadata: Metadata = {
	title: "Privacy Policy & Local Boundary — Kestrel",
	description:
		"How the Kestrel local work agent protects projects, Keychain credentials, model traffic, paired devices, telemetry, and complete data deletion.",
	alternates: {
		canonical: "/privacy",
	},
};

const publisherName = process.env.NEXT_PUBLIC_PUBLISHER_NAME?.trim() || "Kestrel Engineering";
const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || "privacy@kestrel.local";

const sections = [
	{
		title: "What stays on your device",
		paragraphs: [
			"Kestrel is designed around local storage. Project context, conversations, approvals, event-application drafts, configuration, and remembered context are stored on the device running Kestrel unless you deliberately connect an external service.",
			"Sensitive stored fields are encrypted using AES-256-GCM. Managed credentials use the operating system’s protected Keychain storage and are never exposed to the desktop renderer or web previews.",
		],
	},
	{
		title: "When data leaves the device",
		paragraphs: [
			"Data leaves the device only when a feature needs a service you selected. The destination and purpose depend on that connection.",
		],
		items: [
			"A cloud model provider receives the prompt context needed to answer the request.",
			"OAuth-connected services receive only the requests made through their approved scopes.",
			"An optional memory or observability provider receives only the categories enabled in its settings.",
			"An optional operator-supplied paired-node extension exchanges authenticated commands, bounded results, and privacy-preserving presence with your configured gateway.",
			"An event or web service receives information only when you explicitly approve browser-assisted submission.",
		],
	},
	{
		title: "Credentials and account access",
		paragraphs: [
			"Kestrel does not ask you to paste browser cookies or OAuth refresh tokens into chat. API keys are write-only after entry. OAuth uses the provider’s external authorization page, and access can be disconnected from Kestrel or revoked with the provider at any time.",
			"The local model path can operate without any cloud-model account. Installing it requires an explicit automatic-setup action or the separate manual setup path via Ollama.",
		],
	},
	{
		title: "Paired-node extensions",
		paragraphs: [
			"Kestrel does not ship a tracking mobile application. Its authenticated gateway exposes a bounded protocol that separately developed paired-node extensions may use for Talk, wake phrases, or permission-gated location.",
			"The protocol's presence record excludes coordinates, foreground applications, window titles, input events, and IP addresses. The operator of an external node is responsible for its platform permissions and privacy disclosures.",
		],
	},
	{
		title: "Diagnostics and analytics",
		paragraphs: [
			"Kestrel does not enable product analytics or advertising tracking by default. Optional OTLP or Prometheus diagnostics are operator-configured and exclude prompt content, credentials, and personal memory by design.",
			"The marketing website uses privacy-conscious, anonymized analytics (IP anonymization enabled) with no cross-site advertising trackers.",
		],
	},
	{
		title: "Your controls & Data Deletion",
		items: [
			"Inspect, correct, or delete remembered context directly from the application UI.",
			"Disconnect providers and paired-node extensions and instantly purge their credentials.",
			"Remove individual event drafts, project indexing trees, and local artifacts with one click.",
			"Execute a destructive reset to erase all local databases, vector embeddings, and Keychain records.",
			"Revoke OAuth access directly with the connected cloud provider.",
		],
	},
	{
		title: "Retention, transfers, and children",
		paragraphs: [
			"Local data remains until you delete it or remove the application data. External providers apply their own retention and transfer terms; review those terms before connecting them.",
			"Kestrel is a general work tool and is not directed to children. It does not sell personal information or use personal information for cross-context behavioral advertising.",
		],
	},
	{
		title: "Policy changes, response SLA, and contact",
		paragraphs: [
			`Material changes will be reflected on this page with a new date. ${publisherName} publishes Kestrel and receives privacy, security, and deletion requests at ${supportEmail}.`,
			"Our team commits to an SLA of < 2 hours for security-critical inquiries and < 24 hours for all privacy and data deletion inquiries.",
		],
	},
];

export default function PrivacyPage() {
	return (
		<SiteLegal
			eyebrow="Privacy boundary"
			title="Your context is not the product."
			summary="Kestrel keeps work local by default, identifies every deliberate external route, and gives you controls to disconnect and delete."
			updated="August 14, 2026"
			sections={sections}
			breadcrumbs={[{ label: "Privacy Policy", href: "/privacy" }]}
			showSla={true}
		/>
	);
}
