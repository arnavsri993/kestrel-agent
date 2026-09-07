import { ipcRenderer } from "electron";

// This preload runs in Electron's isolated world. It intentionally exposes no
// API to the page: password values arrive from the main process, are applied to
// DOM controls here, and only a non-secret completion result returns over IPC.
const PASSWORD_SUBMISSION_CHANNEL = "kestrel:user-browser-password-submission";
const PASSWORD_COMMAND_CHANNEL = "kestrel:user-browser-credential-command";
const PASSWORD_RESPONSE_CHANNEL = "kestrel:user-browser-credential-response";
const PASSWORD_FORM_CHANGED_CHANNEL = "kestrel:user-browser-password-form-changed";
const MAX_PASSWORD_LENGTH = 4_096;

type PasswordFieldElement =
	| HTMLInputElement
	| HTMLSelectElement
	| HTMLTextAreaElement;

type FieldKind = "username" | "password" | "new-password" | "secret";

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
}

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

function fieldKind(node: PasswordFieldElement): FieldKind | undefined {
	const type = String(node.type || node.tagName || "").toLowerCase();
	const autocomplete = String(node.autocomplete || "").toLowerCase();
	const hint = fieldHint(node);
	if (autocomplete === "new-password") return "new-password";
	if (type === "password" || autocomplete === "current-password") return "password";
	if (
		autocomplete === "one-time-code" ||
		/(?:\botp\b|one[-_ ]time[-_ ]code|recovery[-_ ]code|verification[-_ ]code|security[-_ ]code|\b(?:cvv|cvc)\b|api[-_ ]key|access[-_ ]token|private[-_ ]key)/i.test(
			hint,
		)
	)
		return "secret";
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

function describeFields(root: ParentNode = document): DescribedField[] {
	return Array.from(
		root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
			"input,select,textarea",
		),
	)
		.filter(visible)
		.flatMap((node) => {
			const kind = fieldKind(node);
			if (!kind) return [];
			const rect = node.getBoundingClientRect();
			const type = String(node.type || node.tagName || "").toLowerCase();
			const autocomplete = String(node.autocomplete || "").toLowerCase();
			const label = String(
				node.labels?.[0]?.innerText ||
					node.getAttribute("aria-label") ||
					node.getAttribute("placeholder") ||
					node.getAttribute("name") ||
					(kind === "username"
						? "Username"
						: kind === "secret"
							? "Sensitive field"
							: "Password"),
			)
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 500);
			return [
				{
					id: "field-pending",
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
		.slice(0, 32)
		.map((field, index) => ({ ...field, id: `field-${index}` }));
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
	return true;
}

function setControlValue(node: PasswordFieldElement, value: string): void {
	const prototype =
		node instanceof HTMLInputElement
			? HTMLInputElement.prototype
			: node instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLSelectElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	if (setter) setter.call(node, value);
	else node.value = value;
	node.dispatchEvent(new Event("input", { bubbles: true }));
	node.dispatchEvent(new Event("change", { bubbles: true }));
}

function fill(command: PasswordBridgeCommand): number {
	const fields = describeFields();
	const requested = command.fieldId
		? fields.filter((field) => field.id === command.fieldId)
		: fields;
	let filled = 0;
	let focusTarget: PasswordFieldElement | undefined;
	for (const field of requested) {
		if (
			field.kind === "username" &&
			command.includeUsername !== false &&
			command.username !== undefined
		) {
			setControlValue(field.node, command.username);
			filled += 1;
			focusTarget = field.node;
		} else if (
			(field.kind === "password" || field.kind === "new-password") &&
			command.includePassword !== false &&
			command.password !== undefined
		) {
			setControlValue(field.node, command.password);
			filled += 1;
			focusTarget = field.node;
		}
	}
	focusTarget?.focus();
	return filled;
}

function scanSnapshot() {
	const fields = describeFields();
	const focusedFieldId = fields.find((field) => field.node === document.activeElement)?.id;
	return {
		fields: fields.map(({ node: _node, ...field }) => field),
		...(focusedFieldId ? { focusedFieldId } : {}),
	};
}

function passwordFormSubmission(event: Event): void {
	const target = event.target as { tagName?: unknown } | null;
	if (!target || String(target.tagName).toUpperCase() !== "FORM") return;
	const form = target as HTMLFormElement;
	const fields = describeFields(form);
	const passwordField = fields.find(
		(field) =>
			(field.kind === "password" || field.kind === "new-password") && visible(field.node),
	);
	if (!passwordField) return;
	const password = passwordField.node.value;
	if (!password || password.length > MAX_PASSWORD_LENGTH || password.includes("\0")) return;
	const usernameField = fields.find((field) => field.kind === "username");
	ipcRenderer.send(PASSWORD_SUBMISSION_CHANNEL, {
		username: (usernameField?.node.value ?? "").trim().slice(0, 500),
		password,
		passwordFieldRect: passwordField.rect,
	});
}

let formChangeTimer: ReturnType<typeof setTimeout> | undefined;
function notifyFormChanged(): void {
	if (!process.isMainFrame) return;
	if (formChangeTimer) clearTimeout(formChangeTimer);
	formChangeTimer = setTimeout(() => {
		formChangeTimer = undefined;
		ipcRenderer.send(PASSWORD_FORM_CHANGED_CHANNEL);
	}, 180);
}

function observePasswordForms(): void {
	const root = document.documentElement;
	if (!root) return;
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

if (process.isMainFrame) {
	document.addEventListener("submit", passwordFormSubmission, true);
	document.addEventListener("focusin", notifyFormChanged, true);
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
