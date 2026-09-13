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
const fieldIds = new WeakMap<Element, { id: string; signature: string; owner: Node }>();
// Keep IDs distinct across full document navigations as well as DOM edits.
const fieldIdSeed = crypto.getRandomValues(new Uint32Array(2));
let nextFieldId = (fieldIdSeed[0]! & 0xfffff) * 0x100000000 + fieldIdSeed[1]!;
let submittedPasswordInCurrentPage = false;
let lastSubmittedUsername = "";
let lastSubmittedUsernameAt = 0;
function controlId(node: PasswordFieldElement): string {
	const signature = [node.type, node.autocomplete, fieldHint(node), sectionKey(node)].join("\0");
	const owner = formOwner(node);
	let field = fieldIds.get(node);
	if (!field || field.signature !== signature || field.owner !== owner) {
		field = { id: `field-${nextFieldId++}`, signature, owner };
		fieldIds.set(node, field);
	}
	return field.id;
}
// Child documents are inspected by the main-frame isolated preload only. Never
// route credential IPC to an arbitrary frame or traverse an opaque origin.
function sameOriginDocument(frame: HTMLIFrameElement): Document | undefined {
	try {
		const child = frame.contentDocument;
		if (!child || !frame.isConnected || child.defaultView?.frameElement !== frame) return;
		const url = new URL(child.URL);
		if (url.protocol !== "https:" || url.origin !== currentOrigin() || url.username || url.password) return;
		return child;
	} catch { return; }
}

function documentIsCurrent(doc: Document): boolean {
	if (doc === document) return Boolean(currentOrigin());
	try {
		const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null;
		return Boolean(frame && sameOriginDocument(frame) === doc && documentIsCurrent(frame.ownerDocument));
	} catch { return false; }
}

function deepActiveElement(): Element | null {
	let active = document.activeElement;
	for (let depth = 0; active && depth < 32; depth++) {
		const next = active.shadowRoot?.activeElement ??
			(active.tagName === "IFRAME" ? sameOriginDocument(active as HTMLIFrameElement)?.activeElement : undefined);
		if (!next || next === active) break;
		active = next;
	}
	return active;
}

function controls(root: ParentNode = document): PasswordFieldElement[] {
	const result: PasswordFieldElement[] = [];
	const pending: ParentNode[] = [root];
	let visited = 0;
	while (pending.length && result.length < 512 && visited < 10000) {
		const scope = pending.shift()!;
		for (const node of scope.querySelectorAll("*")) {
			if (++visited > 10000) break;
			if (/^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) result.push(node as PasswordFieldElement);
			if (node.shadowRoot) { observeRoot(node.shadowRoot); pending.push(node.shadowRoot); }
			if (node.tagName === "IFRAME") {
				const frame = node as HTMLIFrameElement;
				observeFrame(frame);
				const child = sameOriginDocument(frame);
				if (child) { observeDocument(child); pending.push(child); }
			}
			if (result.length >= 512) break;
		}
	}
	return result;
}

function pageRect(node: Element): { left: number; top: number; width: number; height: number } {
	const rect = node.getBoundingClientRect();
	let { left, top, width, height } = rect;
	let doc = node.ownerDocument;
	while (doc !== document) {
		const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null;
		if (!frame || sameOriginDocument(frame) !== doc) throw new Error("Detached autofill document");
		const outer = frame.getBoundingClientRect();
		const scaleX = frame.offsetWidth ? outer.width / frame.offsetWidth : 1;
		const scaleY = frame.offsetHeight ? outer.height / frame.offsetHeight : 1;
		left = outer.left + (frame.clientLeft + left) * scaleX;
		top = outer.top + (frame.clientTop + top) * scaleY;
		width *= scaleX;
		height *= scaleY;
		doc = frame.ownerDocument;
	}
	return { left, top, width, height };
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
	if (!node.isConnected || !documentIsCurrent(node.ownerDocument)) return false;
	const view = node.ownerDocument.defaultView;
	if (!view) return false;
	const rect = node.getBoundingClientRect();
	const style = view.getComputedStyle(node);
	let ancestor: Element | null = node;
	while (ancestor) {
		const ancestorStyle = view.getComputedStyle(ancestor);
		if (Number(ancestorStyle.opacity) === 0 || ancestorStyle.visibility === "hidden" || ancestorStyle.display === "none" || ancestor.hasAttribute("inert")) return false;
		ancestor = ancestor.parentElement ?? (ancestor.getRootNode() as ShadowRoot).host ?? null;
	}
	if (node.ownerDocument !== document) {
		const frame = view.frameElement;
		if (!frame || !visible(frame, includeOffscreen)) return false;
	}
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		(includeOffscreen || (rect.bottom >= 0 && rect.right >= 0 && rect.top <= view.innerHeight && rect.left <= view.innerWidth)) &&
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
	if (node.matches(":disabled") || node.disabled || ("readOnly" in node && node.readOnly) || ["hidden", "file", "checkbox", "radio", "submit", "button", "reset", "image", "range", "color"].includes(type)) return undefined;
	if (autocomplete === "new-password") return "new-password";
	if (
		autocomplete === "one-time-code" ||
		/(?:\botp\b|one[-_ ]time[-_ ]code|recovery[-_ ]code|verification[-_ ]code|security[-_ ]code|\b(?:cvv|cvc)\b|api[-_ ]key|access[-_ ]token|private[-_ ]key)/i.test(
			hint,
		)
	)
		return "secret";
	if (type === "password" || autocomplete === "current-password") return "password";
	if (profileKey(node) && autocomplete !== "username" && !(profileKey(node) === "email" && (node.form || node.getRootNode() as ParentNode).querySelector('input[type="password"],input[autocomplete="current-password"]'))) return "profile";
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

function usernameCapturePriority(node: PasswordFieldElement): number {
	const type = String(node.type || node.tagName || "").toLowerCase();
	const autocomplete = autocompleteToken(node);
	if (
		node.matches(":disabled") ||
		node.disabled ||
		["password", "file", "checkbox", "radio", "submit", "button", "reset", "image"].includes(type) ||
		autocomplete === "one-time-code"
	)
		return 0;
	if (autocomplete === "username") return 4;
	if (type === "email" || autocomplete === "email") return 3;
	const identifiers = [node.name, node.id]
		.filter(Boolean)
		.map((value) => value.replace(/[^a-z0-9]+/gi, "").toLowerCase());
	if (identifiers.some((value) => /^(?:loginfmt|login|user|username|email|emailaddress)$/.test(value))) return 2;
	return /(?:^|[-_ ])(?:user|username|email|login|account)(?:$|[-_ ])/i.test(fieldHint(node)) ? 1 : 0;
}

function validUsernameValue(node: PasswordFieldElement): string | undefined {
	if (!documentIsCurrent(node.ownerDocument) || usernameCapturePriority(node) === 0) return;
	const value = node.value.trim();
	if (!value || value.length > 500 || value.includes("\0")) return;
	return value;
}

function usernameForSubmission(owner: Element | Document | ShadowRoot): string {
	const scope =
		owner.nodeType === Node.DOCUMENT_NODE || owner.nodeType === Node.DOCUMENT_FRAGMENT_NODE
			? owner
			: owner.ownerDocument;
	const owned = controls(scope ?? document)
		.filter((node) => formOwner(node) === owner)
		.map((node) => ({ node, priority: usernameCapturePriority(node), value: validUsernameValue(node) }))
		.filter((item): item is { node: PasswordFieldElement; priority: number; value: string } => Boolean(item.priority && item.value))
		.sort((left, right) => right.priority - left.priority || Number(visible(right.node, true)) - Number(visible(left.node, true)));
	if (owned[0]) return owned[0].value.slice(0, 500);
	return Date.now() - lastSubmittedUsernameAt < 120_000 ? lastSubmittedUsername : "";
}

function describeFields(root: ParentNode = document, includeOffscreen = false): DescribedField[] {
	return controls(root)
		.filter((node) => visible(node, includeOffscreen))
		.flatMap((node) => {
			const kind = fieldKind(node);
			if (!kind) return [];
			const rect = pageRect(node);
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
		});
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
	// A password manager action applies to the complete owning form, including
	// controls below the fold. CSS-hidden controls remain excluded by visible().
	const fields = describeFields(document, true);
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
		if (controlId(field.node) !== field.id || !field.node.isConnected || !visible(field.node, true) || fieldKind(field.node) !== field.kind || currentOrigin() !== command.expectedOrigin) continue;
		if (focusedForm && formOwner(field.node) !== focusedForm) continue;
		if (command.profile && sectionKey(field.node) !== sectionKey(anchor?.node ?? field.node)) continue;
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
	const described = describeFields();
	const active = described.find(field => field.node === deepActiveElement());
	const group = active ? described.filter(field => formOwner(field.node) === formOwner(active.node) && sectionKey(field.node) === sectionKey(active.node)) : described;
	// Keep the focused control available even on very large forms.
	const fields = group.slice(0, 32);
	if (active && !fields.includes(active)) fields[31] = active;
	const focusedFieldId = active?.id;
	const passwordControls = controls().filter((node) =>
		node.type === "password" || ["current-password", "new-password"].includes(autocompleteToken(node)),
	);
	return {
		// Before submission, keep detecting dynamically revealed password fields.
		// Afterwards, a removed or CSS-hidden form is a completion signal, while a
		// still-visible password form is a bounded failure signal.
		hasPasswordControls: submittedPasswordInCurrentPage
			? passwordControls.some((node) => visible(node, true))
			: passwordControls.length > 0,
		fields: fields.map(({ node: _node, ...field }) => field),
		...(focusedFieldId ? { focusedFieldId } : {}),
	};
}

function submittedPasswordField(fields: DescribedField[]): DescribedField | undefined {
	const passwords = fields.filter((field) => field.kind === "password" || field.kind === "new-password");
	if (!passwords.length) return;
	const confirmationPattern = /\b(?:confirm|confirmation|repeat|retype|re-enter|verify)\b/i;
	const currentPattern = /\b(?:current|old|existing)\b/i;
	const newPattern = /\bnew\b/i;
	const explicitlyNew = passwords.filter(
		(field) => field.kind === "new-password" || newPattern.test(fieldHint(field.node)),
	);
	const confirmations = passwords.filter((field) => confirmationPattern.test(fieldHint(field.node)));
	if (explicitlyNew.length) {
		const primary = explicitlyNew.find((field) => !confirmations.includes(field)) ?? explicitlyNew[0]!;
		const requiredMatches = [...new Set([...explicitlyNew, ...confirmations])].filter((field) => field !== primary);
		if (requiredMatches.some((field) => field.node.value !== primary.node.value)) return;
		return primary;
	}
	if (confirmations.length) {
		const primary = passwords.find(
			(field) => !confirmations.includes(field) && !currentPattern.test(fieldHint(field.node)),
		);
		if (!primary || confirmations.some((field) => field.node.value !== primary.node.value)) return;
		return primary;
	}
	if (
		passwords.length >= 3 &&
		passwords[1]!.node.value &&
		passwords[1]!.node.value === passwords[2]!.node.value &&
		passwords[0]!.node.value !== passwords[1]!.node.value
	)
		return passwords[1];
	if (passwords.length >= 2 && currentPattern.test(fieldHint(passwords[0]!.node))) return passwords[1];
	return passwords[0];
}

function passwordFormSubmission(event: Event): void {
	const target = event.target as { tagName?: unknown } | null;
	if (!target || !("querySelectorAll" in target)) return;
	const form = target as HTMLFormElement;
	if (!documentIsCurrent((form as Node).ownerDocument ?? form as unknown as Document)) return;
	const fields = describeFields(form.tagName === "FORM" ? form.ownerDocument : form, true).filter((field) => formOwner(field.node) === form);
	if (event.isTrusted) {
		const profile: Record<string, string> = {};
		const sections = new Set(fields.filter((field) => field.kind === "profile" && editedControls.has(field.node)).map((field) => sectionKey(field.node)));
		for (const field of fields) {
			const key = profileKey(field.node);
			if (field.kind === "profile" && key && editedControls.has(field.node) && field.node.value.trim()) profile[key] = field.node.value.trim().slice(0, 500);
		}
		if (sections.size <= 1 && Object.keys(profile).length) ipcRenderer.send("kestrel:user-browser-profile-submission", profile);
	}
	// Password changes must save the new value, never the old-password input,
	// and must wait until every identified confirmation agrees.
	const passwordField = submittedPasswordField(fields);
	if (!passwordField) {
		const username = usernameForSubmission(form);
		if (event.isTrusted && username) {
			lastSubmittedUsername = username;
			lastSubmittedUsernameAt = Date.now();
			submittedPasswordInCurrentPage = false;
			ipcRenderer.send("kestrel:user-browser-username-submission", username);
		}
		return;
	}
	const password = passwordField.node.value;
	if (!password || password.length > MAX_PASSWORD_LENGTH || password.includes("\0")) return;
	const username = usernameForSubmission(form);
	if (username) { lastSubmittedUsername = username; lastSubmittedUsernameAt = Date.now(); }
	submittedPasswordInCurrentPage = true;
	ipcRenderer.send(PASSWORD_SUBMISSION_CHANNEL, {
		username,
		password,
		passwordFieldRect: passwordField.rect,
	});
}

function actionOwner(action: Element): Element | Document | ShadowRoot | undefined {
	const button = action.closest?.('button,input[type="submit"],input[type="image"],[role="button"]') as HTMLButtonElement | HTMLInputElement | null;
	if (!button) return;
	const tag = button.tagName;
	const nativeSubmit =
		(tag === "BUTTON" && (button as HTMLButtonElement).type !== "button" && (button as HTMLButtonElement).type !== "reset") ||
		(tag === "INPUT" && ["submit", "image"].includes((button as HTMLInputElement).type));
	const label = button.textContent || button.getAttribute("value") || button.getAttribute("aria-label") || "";
	if (!nativeSubmit && !/sign.?in|log.?in|continue|next|submit|save|change|update/i.test(label)) return;
	return button.form ?? button.closest('form,[role="form"]') ?? button.getRootNode() as Document | ShadowRoot;
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
			"class",
			"inert",
			"readonly",
			"form",
			"src",
			"sandbox",
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

const observedFrames = new WeakSet<HTMLIFrameElement>();
function observeFrame(frame: HTMLIFrameElement): void {
	if (observedFrames.has(frame)) return;
	observedFrames.add(frame);
	frame.addEventListener("load", () => { controls(); notifyFormChanged(); });
}

const observedDocuments = new WeakSet<Document>();
function observeDocument(doc: Document): void {
	if (observedDocuments.has(doc)) return;
	observedDocuments.add(doc);
	doc.addEventListener("submit", passwordFormSubmission, true);
	doc.addEventListener("focusin", notifyFormChanged, true);
	doc.addEventListener("scroll", notifyFormChanged, true);
	doc.defaultView?.addEventListener("resize", notifyFormChanged);
	doc.addEventListener("input", (event) => { if (event.isTrusted && event.composedPath()[0]) editedControls.add(event.composedPath()[0] as Element); }, true);
	// Scripted sign-in buttons often never emit a native submit event.
	doc.addEventListener("click", (event) => {
		if (!event.isTrusted || !documentIsCurrent(doc)) return;
		const target = event.composedPath()[0] as Element | null;
		const owner = target ? actionOwner(target) : undefined;
		if (owner) passwordFormSubmission({ target: owner, isTrusted: true } as unknown as Event);
	}, true);
	// Enter can let a site's key handler navigate or replace a username-first or
	// formless sign-in surface before submit/click observers get a stable view.
	doc.addEventListener("keydown", (event) => {
		if (!event.isTrusted || event.key !== "Enter" || event.isComposing || event.repeat || !documentIsCurrent(doc)) return;
		const target = event.composedPath()[0] as Element | null;
		if (!target || target.tagName === "TEXTAREA") return;
		const control = target.closest?.("input,select") as PasswordFieldElement | null;
		if (!control || (!fieldKind(control) && usernameCapturePriority(control) === 0)) return;
		passwordFormSubmission({ target: formOwner(control), isTrusted: true } as unknown as Event);
	}, true);
	if (doc.documentElement) observeRoot(doc.documentElement);
}

function observePasswordForms(): void {
	observeDocument(document);
	controls();
}

if (process.isMainFrame) {
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
