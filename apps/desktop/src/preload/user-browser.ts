import { ipcRenderer, webUtils } from "electron";

// Deliberately leave drag-and-drop events untouched. This preload belongs to
// the embedded website WebContentsView, whose upload controls must receive
// native file drops. Kestrel's own chrome installs its separate drop guard.

const PASSWORD_SUBMISSION_CHANNEL = "kestrel:user-browser-password-submission";
const HEIC_UPLOAD_CHANNEL = "kestrel:user-browser-heic-upload";
const HEIC_UPLOAD_FAILED_CHANNEL = "kestrel:user-browser-heic-upload-failed";
const HEIC_UPLOAD_INPUT_ID_ATTRIBUTE = "data-kestrel-heic-upload-id";
const MAX_PASSWORD_LENGTH = 100_000;

interface PendingHeicUpload {
	pathSignature: string;
}

const pendingHeicUploads = new WeakMap<HTMLInputElement, PendingHeicUpload>();

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

function fileInputFromEvent(event: Event): HTMLInputElement | undefined {
	const target = event.target as { tagName?: unknown; type?: unknown } | null;
	if (
		!target ||
		String(target.tagName).toUpperCase() !== "INPUT" ||
		String(target.type).toLowerCase() !== "file"
	)
		return undefined;
	return target as HTMLInputElement;
}

function localFilePaths(input: HTMLInputElement): string[] | undefined {
	if (!input.files?.length) return undefined;
	const paths: string[] = [];
	for (const file of Array.from(input.files)) {
		try {
			const path = webUtils.getPathForFile(file);
			if (!path) return undefined;
			paths.push(path);
		} catch {
			return undefined;
		}
	}
	return paths;
}

function hasHeicImage(paths: readonly string[]): boolean {
	return paths.some((path) => /\.hei(?:c|f)$/i.test(path));
}

function stopWebsiteUploadEvent(event: Event): void {
	event.stopImmediatePropagation();
	event.stopPropagation();
}

function queueHeicUploadConversion(event: Event): void {
	if (!event.isTrusted) return;
	const input = fileInputFromEvent(event);
	if (!input) return;
	const paths = localFilePaths(input);
	if (!paths || !hasHeicImage(paths)) {
		pendingHeicUploads.delete(input);
		input.removeAttribute(HEIC_UPLOAD_INPUT_ID_ATTRIBUTE);
		return;
	}
	const pathSignature = paths.join("\0");
	const pending = pendingHeicUploads.get(input);
	if (pending?.pathSignature === pathSignature) {
		stopWebsiteUploadEvent(event);
		return;
	}
	const inputId = crypto.randomUUID();
	pendingHeicUploads.set(input, { pathSignature });
	input.setAttribute(HEIC_UPLOAD_INPUT_ID_ATTRIBUTE, inputId);
	stopWebsiteUploadEvent(event);
	ipcRenderer.send(HEIC_UPLOAD_CHANNEL, { inputId, paths });
}

ipcRenderer.on(HEIC_UPLOAD_FAILED_CHANNEL, (_event, value: unknown) => {
	const inputId =
		value &&
		typeof value === "object" &&
		"inputId" in value &&
		typeof value.inputId === "string"
			? value.inputId
			: undefined;
	if (!inputId || !/^[a-z0-9-]{10,100}$/.test(inputId)) return;
	const input = document.querySelector<HTMLInputElement>(
		`input[${HEIC_UPLOAD_INPUT_ID_ATTRIBUTE}="${inputId}"]`,
	);
	if (!input) return;
	pendingHeicUploads.delete(input);
	input.removeAttribute(HEIC_UPLOAD_INPUT_ID_ATTRIBUTE);
	// Let the site handle the original selection if conversion fails. These
	// replacement events are deliberately untrusted, so the capture handler
	// above will not attempt a conversion loop.
	input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
});

document.addEventListener("submit", passwordFormSubmission, true);
// Register on window before page scripts run, so a site cannot receive the
// original HEIC in an earlier capture listener while Kestrel prepares JPEGs.
window.addEventListener("input", queueHeicUploadConversion, true);
window.addEventListener("change", queueHeicUploadConversion, true);
