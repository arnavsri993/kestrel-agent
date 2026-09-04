import { ipcRenderer } from "electron";

// Deliberately leave drag-and-drop events untouched. This preload belongs to
// the embedded website WebContentsView, whose upload controls must receive
// native file drops. Kestrel's own chrome installs its separate drop guard.

const PASSWORD_SUBMISSION_CHANNEL = "kestrel:user-browser-password-submission";
const MAX_PASSWORD_LENGTH = 100_000;

type PasswordFieldElement =
	| HTMLInputElement
	| HTMLSelectElement
	| HTMLTextAreaElement;

function visible(element: Element): boolean {
	const node = element as HTMLElement;
	const rect = node.getBoundingClientRect();
	const style = getComputedStyle(node);
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		rect.bottom >= 0 &&
		rect.right >= 0 &&
		rect.top <= innerHeight &&
		rect.left <= innerWidth &&
		style.visibility !== "hidden" &&
		style.display !== "none" &&
		Number(style.opacity) > 0
	);
}

function fieldHint(node: PasswordFieldElement): string {
	return [
		node.autocomplete,
		node.getAttribute("name"),
		node.id,
		node.getAttribute("placeholder"),
		node.getAttribute("aria-label"),
		node.labels?.[0]?.innerText,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

function fieldKind(
	node: PasswordFieldElement,
): "password" | "username" | undefined {
	const type = String(node.type || node.tagName || "").toLowerCase();
	const autocomplete = String(node.autocomplete || "").toLowerCase();
	if (autocomplete === "new-password") return undefined;
	if (
		type === "password" ||
		autocomplete === "current-password"
	)
		return "password";
	if (
		type === "email" ||
		autocomplete === "username" ||
		autocomplete === "email" ||
		/(?:^|[-_ ])(?:user|username|email|login|account)(?:$|[-_ ])/i.test(
			fieldHint(node),
		)
	)
		return "username";
}

function passwordFormSubmission(event: Event): void {
	// Event targets crossing Electron's isolated-world boundary are not
	// guaranteed to pass an instanceof check against the preload realm's DOM
	// constructors. Use the stable tag name, then narrow to the form API.
	const target = event.target as { tagName?: unknown } | null;
	if (!target || String(target.tagName).toUpperCase() !== "FORM") return;
	const form = target as HTMLFormElement;
	const fields = Array.from(
		form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
			"input,select,textarea",
		),
	)
		.map((node) => ({ node, kind: fieldKind(node) }))
		.filter(
			(field): field is { node: PasswordFieldElement; kind: "password" | "username" } =>
				Boolean(field.kind),
		)
		.slice(0, 32);
	const passwordField = fields.find(
		(field) => field.kind === "password" && visible(field.node),
	);
	if (!passwordField) return;
	const password = passwordField.node.value;
	if (
		!password ||
		password.length > MAX_PASSWORD_LENGTH ||
		password.includes("\0")
	)
		return;
	const usernameField = fields.find((field) => field.kind === "username");
	const rect = passwordField.node.getBoundingClientRect();
	ipcRenderer.send(PASSWORD_SUBMISSION_CHANNEL, {
		username: (usernameField?.node.value ?? "").trim().slice(0, 500),
		password,
		passwordFieldRect: {
			x: Math.max(0, Math.round(rect.left)),
			y: Math.max(0, Math.round(rect.top)),
			width: Math.max(0, Math.round(rect.width)),
			height: Math.max(0, Math.round(rect.height)),
		},
	});
}

document.addEventListener("submit", passwordFormSubmission, true);
