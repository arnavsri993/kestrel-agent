import { ipcRenderer, webUtils } from "electron";

// This preload runs in Electron's isolated world. It intentionally exposes no
// API to the page: password values arrive from the main process, are applied to
// DOM controls here, and only a non-secret completion result returns over IPC.
const PASSWORD_SUBMISSION_CHANNEL = "kestrel:user-browser-password-submission";
const PASSWORD_COMMAND_CHANNEL = "kestrel:user-browser-credential-command";
const PASSWORD_RESPONSE_CHANNEL = "kestrel:user-browser-credential-response";
const PASSWORD_FORM_CHANGED_CHANNEL = "kestrel:user-browser-password-form-changed";
const MAX_PASSWORD_LENGTH = 4_096;
const HEIC_UPLOAD_CHANNEL = "kestrel:user-browser-heic-upload";
const HEIC_UPLOAD_FAILED_CHANNEL = "kestrel:user-browser-heic-upload-failed";
const HEIC_UPLOAD_INPUT_ID_ATTRIBUTE = "data-kestrel-heic-upload-id";

interface PendingHeicUpload {
	pathSignature: string;
}

const pendingHeicUploads = new WeakMap<HTMLInputElement, PendingHeicUpload>();

type PasswordFieldElement =
	| HTMLInputElement
	| HTMLSelectElement
	| HTMLTextAreaElement;

const PROFILE_KEYS = new Set(["name", "given-name", "additional-name", "family-name", "email", "tel", "organization", "street-address", "address-line1", "address-line2", "address-line3", "address-level2", "address-level1", "postal-code", "country", "country-name", "bday", "bday-day", "bday-month", "bday-year"]);
const editedControls = new WeakSet<Element>();
const fieldIds = new WeakMap<Element, string>();
let nextFieldId = 0;
function controlId(node: Element): string {
	let id = fieldIds.get(node);
	if (!id) { id = `field-${nextFieldId++}`; fieldIds.set(node, id); }
	return id;
}
function deepActiveElement(): Element | null {
	let active = document.activeElement;
	while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
	return active;
}

function controls(root: ParentNode = document): PasswordFieldElement[] {
	const result: PasswordFieldElement[] = [];
	const pending: ParentNode[] = [root];
	while (pending.length && result.length < 512) {
		const scope = pending.shift()!;
		for (const node of scope.querySelectorAll("*")) {
			if (/^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) result.push(node as PasswordFieldElement);
			if (node.shadowRoot) { observeRoot(node.shadowRoot); pending.push(node.shadowRoot); }
			if (result.length >= 512) break;
		}
	}
	return result;
}

function sectionKey(node: PasswordFieldElement): string {
	return String(node.autocomplete || "").toLowerCase().split(/\s+/)
		.filter((token) => token.startsWith("section-") || token === "shipping" || token === "billing").join(" ");
}

function formOwner(node: PasswordFieldElement): Element | Document | ShadowRoot {
	return node.form ?? node.closest('[role="form"]') ?? node.getRootNode() as Document | ShadowRoot;
}

function autocompleteToken(node: PasswordFieldElement): string {
	return String(node.autocomplete || "").toLowerCase().trim().split(/\s+/).filter((token) => token !== "webauthn").at(-1) || "";
}
function profileKey(node: PasswordFieldElement): string | undefined {
	const token = autocompleteToken(node);
	if (PROFILE_KEYS.has(token)) return token;
	if (token && token !== "on") return undefined;
	const hint = [node.name, node.id, node.getAttribute("aria-label"), node.labels?.[0]?.innerText].filter(Boolean).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
	const rules: [RegExp, string][] = [
		[/\b(first|given)[-_ ]?name\b/, "given-name"], [/\b(last|family|sur)[-_ ]?name\b/, "family-name"],
		[/\bmiddle[-_ ]?name\b/, "additional-name"], [/\b(full[-_ ]?name|your name)\b|^name$/, "name"],
		[/\b(e[-_ ]?mail)\b/, "email"], [/\b(phone|telephone|mobile)\b/, "tel"],
		[/\b(address[-_ ]?(2|line[-_ ]?2)|apartment|suite)\b/, "address-line2"],
		[/\b(street|address[-_ ]?(1|line[-_ ]?1)|address)\b/, "address-line1"],
		[/\b(city|town)\b/, "address-level2"], [/\b(state|province|region)\b/, "address-level1"],
		[/\b(zip|postal)[-_ ]?(code)?\b/, "postal-code"], [/\bcountry\b/, "country-name"],
		[/\b(birthday|birthdate|dob|date of birth)\b/, "bday"], [/\b(company|organization)\b/, "organization"],
	];
	return rules.find(([pattern]) => pattern.test(hint))?.[1];
}
type FieldKind = "username" | "password" | "new-password" | "secret" | "profile";

interface DescribedField {
	id: string;
	kind: FieldKind;
	label: string;
	type: string;
	autocomplete: string;
	rect: { x: number; y: number; width: number; height: number };
	node: PasswordFieldElement;
}

interface PasswordBridgeCommand {
	requestId: string;
	type: "scan" | "fill";
	expectedOrigin: string;
	fieldId?: string;
	username?: string;
	password?: string;
	includeUsername?: boolean;
	includePassword?: boolean;
	profile?: Record<string, string>;
	onlyEmpty?: boolean;
}

function visible(element: Element, includeOffscreen = false): boolean {
	const node = element as HTMLElement;
	const rect = node.getBoundingClientRect();
	const style = getComputedStyle(node);
	let ancestor: Element | null = node;
	while (ancestor) {
		const ancestorStyle = getComputedStyle(ancestor);
		if (Number(ancestorStyle.opacity) === 0 || ancestorStyle.visibility === "hidden" || ancestorStyle.display === "none" || ancestor.hasAttribute("inert")) return false;
		ancestor = ancestor.parentElement ?? (ancestor.getRootNode() as ShadowRoot).host ?? null;
	}
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		(includeOffscreen || (rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth)) &&
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

function fieldKind(node: PasswordFieldElement): FieldKind | undefined {
	const type = String(node.type || node.tagName || "").toLowerCase();
	const autocomplete = autocompleteToken(node);
	const hint = fieldHint(node);
	if (node.matches(":disabled") || node.disabled || ("readOnly" in node && node.readOnly) || ["hidden", "file", "checkbox", "radio", "submit", "button"].includes(type)) return undefined;
	if (autocomplete === "new-password") return "new-password";
	if (
		autocomplete === "one-time-code" ||
		/(?:\botp\b|one[-_ ]time[-_ ]code|recovery[-_ ]code|verification[-_ ]code|security[-_ ]code|\b(?:cvv|cvc)\b|api[-_ ]key|access[-_ ]token|private[-_ ]key)/i.test(
			hint,
		)
	)
		return "secret";
	if (type === "password" || autocomplete === "current-password") return "password";
	if (profileKey(node) && autocomplete !== "username" && !(profileKey(node) === "email" && (node.form || document).querySelector('input[type="password"],input[autocomplete="current-password"]'))) return "profile";
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

function describeFields(root: ParentNode = document, includeOffscreen = false): DescribedField[] {
	return controls(root)
		.filter((node) => visible(node, includeOffscreen))
		.flatMap((node) => {
			const kind = fieldKind(node);
			if (!kind) return [];
			const rect = node.getBoundingClientRect();
			const type = String(node.type || node.tagName || "").toLowerCase();
			const autocomplete = autocompleteToken(node);
			const label = String(
				node.labels?.[0]?.innerText ||
					node.getAttribute("aria-label") ||
					node.getAttribute("placeholder") ||
					node.getAttribute("name") ||
					(kind === "username"
						? "Username"
						: kind === "secret"
							? "Sensitive field"
							: kind === "profile" ? "Personal info" : "Password"),
			)
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 500);
			return [
				{
					id: controlId(node),
					kind,
					label,
					type: type.slice(0, 100),
					autocomplete: autocomplete.slice(0, 100),
					rect: {
						x: Math.max(0, Math.round(rect.left)),
						y: Math.max(0, Math.round(rect.top)),
						width: Math.max(0, Math.round(rect.width)),
						height: Math.max(0, Math.round(rect.height)),
					},
					node,
				},
			];
		})
		.slice(0, 32);
}

function currentOrigin(): string | undefined {
	try {
		const url = new URL(location.href);
		if (url.protocol !== "https:" || url.username || url.password || url.origin === "null")
			return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

function isBridgeCommand(value: unknown): value is PasswordBridgeCommand {
	if (!value || typeof value !== "object") return false;
	const command = value as Record<string, unknown>;
	if (
		typeof command.requestId !== "string" ||
		!/^password-request-[a-f0-9-]{36}$/.test(command.requestId) ||
		(command.type !== "scan" && command.type !== "fill") ||
		typeof command.expectedOrigin !== "string" ||
		currentOrigin() !== command.expectedOrigin
	)
		return false;
	if (command.fieldId !== undefined && !/^field-[0-9]+$/.test(String(command.fieldId)))
		return false;
	if (command.username !== undefined && (typeof command.username !== "string" || command.username.length > 500))
		return false;
	if (
		command.password !== undefined &&
		(typeof command.password !== "string" ||
			command.password.length > MAX_PASSWORD_LENGTH ||
			command.password.includes("\0"))
	)
		return false;
	if (command.profile !== undefined && (!command.profile || typeof command.profile !== "object" || Array.isArray(command.profile) || Object.entries(command.profile).some(([key, value]) => !PROFILE_KEYS.has(key) || typeof value !== "string" || value.length > 500))) return false;
	return true;
}

function setControlValue(node: PasswordFieldElement, value: string): boolean {
	const prototype =
		node.tagName === "INPUT"
			? HTMLInputElement.prototype
			: node.tagName === "TEXTAREA"
				? HTMLTextAreaElement.prototype
				: HTMLSelectElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	if (node.tagName === "SELECT") {
		const option = Array.from((node as HTMLSelectElement).options).find((item) => !item.disabled && [item.value, item.textContent?.trim()].some((text) => text?.toLowerCase() === value.toLowerCase() || (/^\d+$/.test(text || "") && /^\d+$/.test(value) && Number(text) === Number(value))));
		if (!option) return false;
		value = option.value;
	}
	if (setter) setter.call(node, value);
	else node.value = value;
	node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	node.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
	return node.isConnected && node.value === value;
}

function fill(command: PasswordBridgeCommand): number {
	const fields = describeFields(document, Boolean(command.profile));
	const active = fields.find((field) => field.node === deepActiveElement());
	const anchor = active ?? (!command.profile ? fields.find((field) => field.kind === "password") ?? fields.find((field) => field.kind === "username") : undefined);
	const focusedForm = anchor ? formOwner(anchor.node) : undefined;
	const section = anchor ? sectionKey(anchor.node) : "";
	const requested = command.fieldId
		? fields.filter((field) => field.id === command.fieldId)
		: focusedForm ? fields.filter((field) => formOwner(field.node) === focusedForm && (!command.profile || sectionKey(field.node) === section)) : [];
	let filled = 0;
	let focusTarget: PasswordFieldElement | undefined;
	for (const field of requested) {
		if (!field.node.isConnected || !visible(field.node, Boolean(command.profile)) || fieldKind(field.node) !== field.kind || currentOrigin() !== command.expectedOrigin) continue;
		if (command.onlyEmpty && (field.node.value || editedControls.has(field.node))) continue;
		if (command.profile) {
			const key = profileKey(field.node);
			if (!key || field.kind !== "profile") continue;
			let value = command.profile[key];
			if (!value && key === "name") value = [command.profile["given-name"], command.profile["additional-name"], command.profile["family-name"]].filter(Boolean).join(" ");
			if (!value && key === "street-address") value = [command.profile["address-line1"], command.profile["address-line2"], command.profile["address-line3"]].filter(Boolean).join("\n");
			if (!value && key === "address-line1") value = command.profile["street-address"]?.split("\n")[0];
			if (!value && /^bday-(year|month|day)$/.test(key)) {
				const date = command.profile.bday?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
				if (date) value = date[{ "bday-year": 1, "bday-month": 2, "bday-day": 3 }[key]!];
			}
			if (value && setControlValue(field.node, value)) filled += 1;
			continue;
		}
		if (
			(field.kind === "username" || (field.kind === "profile" && profileKey(field.node) === "email")) &&
			command.includeUsername !== false &&
			command.username !== undefined
		) {
			if (setControlValue(field.node, command.username)) filled += 1;
			focusTarget = field.node;
		} else if (
			(field.kind === "password" || (field.kind === "new-password" && Boolean(command.fieldId))) &&
			command.includePassword !== false &&
			command.password !== undefined
		) {
			if (setControlValue(field.node, command.password)) filled += 1;
			focusTarget = field.node;
		}
	}
	if (!command.onlyEmpty) focusTarget?.focus();
	return filled;
}

function scanSnapshot() {
	const fields = describeFields();
	const focusedFieldId = fields.find((field) => field.node === deepActiveElement())?.id;
	return {
		hasPasswordControls: controls().some((node) => node.type === "password" || ["current-password", "new-password"].includes(autocompleteToken(node))),
		fields: fields.map(({ node: _node, ...field }) => field),
		...(focusedFieldId ? { focusedFieldId } : {}),
	};
}

function passwordFormSubmission(event: Event): void {
	const target = event.target as { tagName?: unknown } | null;
	if (!target || !("querySelectorAll" in target)) return;
	const form = target as HTMLFormElement;
	const fields = describeFields(form.tagName === "FORM" ? document : form, true).filter((field) => formOwner(field.node) === form);
	if (event.isTrusted) {
		const profile: Record<string, string> = {};
		const sections = new Set(fields.filter((field) => field.kind === "profile" && editedControls.has(field.node)).map((field) => sectionKey(field.node)));
		for (const field of fields) {
			const key = profileKey(field.node);
			if (field.kind === "profile" && key && editedControls.has(field.node) && field.node.value.trim()) profile[key] = field.node.value.trim().slice(0, 500);
		}
		if (sections.size <= 1 && Object.keys(profile).length) ipcRenderer.send("kestrel:user-browser-profile-submission", profile);
	}
	const passwordField = fields.find(
		(field) =>
			(field.kind === "password" || field.kind === "new-password") && visible(field.node, true),
	);
	if (!passwordField) {
		const username = fields.find((field) => field.kind === "username" || (field.kind === "profile" && profileKey(field.node) === "email"));
		if (event.isTrusted && username && editedControls.has(username.node) && username.node.value.trim())
			ipcRenderer.send("kestrel:user-browser-username-submission", username.node.value.trim().slice(0, 500));
		return;
	}
	const password = passwordField.node.value;
	if (!password || password.length > MAX_PASSWORD_LENGTH || password.includes("\0")) return;
	const usernameField = fields.find((field) => field.kind === "username" || (field.kind === "profile" && profileKey(field.node) === "email"));
	ipcRenderer.send(PASSWORD_SUBMISSION_CHANNEL, {
		username: (usernameField?.node.value ?? "").trim().slice(0, 500),
		password,
		passwordFieldRect: passwordField.rect,
	});
}

let formChangeTimer: ReturnType<typeof setTimeout> | undefined;
function notifyFormChanged(): void {
	if (!process.isMainFrame) return;
	if (formChangeTimer) return;
	formChangeTimer = setTimeout(() => {
		formChangeTimer = undefined;
		ipcRenderer.send(PASSWORD_FORM_CHANGED_CHANNEL);
	}, 180);
}

const observedRoots = new WeakSet<Node>();
function observeRoot(root: Node): void {
	if (observedRoots.has(root)) return;
	observedRoots.add(root);
	if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) root.addEventListener("submit", passwordFormSubmission, true);
	new MutationObserver(notifyFormChanged).observe(root, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: [
			"autocomplete",
			"aria-label",
			"disabled",
			"hidden",
			"id",
			"name",
			"placeholder",
			"style",
			"type",
		],
	});
}

function observePasswordForms(): void {
	if (document.documentElement) observeRoot(document.documentElement);
	controls();
}

if (process.isMainFrame) {
	document.addEventListener("submit", passwordFormSubmission, true);
	document.addEventListener("focusin", notifyFormChanged, true);
	document.addEventListener("scroll", notifyFormChanged, true);
	window.addEventListener("resize", notifyFormChanged);
	document.addEventListener("input", (event) => { if (event.isTrusted && event.composedPath()[0]) editedControls.add(event.composedPath()[0] as Element); }, true);
	// Scripted sign-in buttons often never emit a native submit event.
	document.addEventListener("click", (event) => {
		if (!event.isTrusted) return;
		const target = event.composedPath()[0] as Element | null;
		const button = target?.closest?.('button,input[type="submit"],[role="button"]');
		if (!button || !/sign.?in|log.?in|continue|next|submit/i.test(button.textContent || button.getAttribute("value") || "")) return;
		const form = button.closest('form,[role="form"]') ?? button.getRootNode();
		if (form) passwordFormSubmission({ target: form, isTrusted: true } as unknown as Event);
	}, true);
	if (document.documentElement) observePasswordForms();
	else
		document.addEventListener("DOMContentLoaded", observePasswordForms, {
			once: true,
		});
	ipcRenderer.on(PASSWORD_COMMAND_CHANNEL, (_event, raw: unknown) => {
		if (!isBridgeCommand(raw)) return;
		try {
			if (raw.type === "scan") {
				ipcRenderer.send(PASSWORD_RESPONSE_CHANNEL, {
					requestId: raw.requestId,
					ok: true,
					snapshot: scanSnapshot(),
				});
				return;
			}
			ipcRenderer.send(PASSWORD_RESPONSE_CHANNEL, {
				requestId: raw.requestId,
				ok: true,
				filled: fill(raw),
			});
		} catch {
			ipcRenderer.send(PASSWORD_RESPONSE_CHANNEL, {
				requestId: raw.requestId,
				ok: false,
			});
		}
	});
	notifyFormChanged();
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


if (process.isMainFrame) {
	// Register on window before page scripts run, so a site cannot receive the
	// original HEIC in an earlier capture listener while Kestrel prepares JPEGs.
	window.addEventListener("input", queueHeicUploadConversion, true);
	window.addEventListener("change", queueHeicUploadConversion, true);
}
