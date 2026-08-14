import type { Metadata } from "next";
import { SiteLegal } from "../../components/SiteLegal";

export const metadata: Metadata = {
	title: "Privacy — Kestrel",
	description:
		"How the Kestrel local work agent handles projects, credentials, model traffic, paired devices, diagnostics, and deletion.",
};

const publisherName = process.env.NEXT_PUBLIC_PUBLISHER_NAME?.trim();
const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim();

const sections = [
	{
		title: "What stays on your device",
		paragraphs: [
			"Kestrel is designed around local storage. Project context, conversations, approvals, event-application drafts, configuration, and remembered context are stored on the device running Kestrel unless you deliberately connect an external service.",
			"Sensitive stored fields are encrypted. Managed credentials use the operating system’s protected credential storage and are not exposed to the desktop renderer.",
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
			"An event or hackathon website receives information only when you approve browser-assisted submission.",
		],
	},
	{
		title: "Credentials and account access",
		paragraphs: [
			"Kestrel does not ask you to paste browser cookies or OAuth refresh tokens into chat. API keys are write-only after entry. OAuth uses the provider’s external authorization page, and access can be disconnected from Kestrel or revoked with the provider.",
			"The local model path can operate without a cloud-model account. Installing it requires an explicit automatic-setup action or the separate manual setup path.",
		],
	},
	{
		title: "Paired-node extensions",
		paragraphs: [
			"Kestrel does not ship a mobile application. Its authenticated gateway exposes a bounded protocol that separately developed paired-node extensions may use for Talk, wake phrases, or permission-gated location.",
			"The protocol's presence record excludes coordinates, foreground applications, window titles, input events, and IP addresses. The operator of an external node is responsible for its platform permissions and privacy disclosures.",
		],
	},
	{
		title: "Diagnostics and analytics",
		paragraphs: [
			"Kestrel does not enable product analytics or advertising tracking by default. Optional OTLP or Prometheus diagnostics are operator-configured and exclude prompt content, credentials, and personal memory by design.",
			"The marketing website does not need an agent endpoint and does not run the desktop application in the browser.",
		],
	},
	{
		title: "Your controls",
		items: [
			"Inspect, correct, or delete remembered context from the application.",
			"Disconnect providers and paired-node extensions and revoke their credentials.",
			"Remove individual event-application drafts and local artifacts through their product controls.",
			"Reset local application data using the documented recovery path.",
			"Revoke OAuth access directly with the connected provider.",
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
		title: "Policy changes and contact",
		paragraphs: [
			publisherName && supportEmail
				? `Material changes will be reflected on this page with a new date. ${publisherName} publishes Kestrel and receives privacy and deletion requests at ${supportEmail}.`
				: "Material changes will be reflected on this page with a new date. Until a verified publisher and public support address are configured, this development preview is not a public service and cannot pass the distribution gate.",
		],
	},
];

export default function PrivacyPage() {
	return (
		<SiteLegal
			eyebrow="Privacy boundary"
			title="Your context is not the product."
			summary="Kestrel keeps work local by default, identifies every deliberate external route, and gives you controls to disconnect and delete."
			updated="July 23, 2026"
			sections={sections}
		/>
	);
}
