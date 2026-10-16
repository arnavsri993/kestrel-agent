import { redactSensitiveContent } from "@kestrel/agent-core";
import { UserBrowserPageContextSchema } from "@kestrel/shared-types";

function pageUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
		// Context is descriptive, not a navigation command. Query/fragment values
		// can carry credentials; only the host-owned browser retains those values.
		url.search = "";
		url.hash = "";
		return url.href;
	} catch {
		return;
	}
}

function text(value: string, limit: number): string {
	return redactSensitiveContent(value).replace(
		/\b(?:https?|file|ftp|data|javascript|blob):[^\s<>"'{}[\]]+/gi,
		(value) => pageUrl(value) ?? "[redacted URL]",
	).slice(0, limit);
}

// Treat host responses as untrusted too. Native page scripts can be influenced
// by a website; validate and redact at the Electron-free Core boundary.
export function normalizeBrowserPageContext(value: unknown) {
	const context = UserBrowserPageContextSchema.parse(value);
	const url = pageUrl(context.url);
	if (!url) throw new Error("The selected tab does not have a safe readable URL.");
	return UserBrowserPageContextSchema.parse({
		...context,
		url,
		title: text(context.title, 500) || "Untitled page",
		description: context.description === undefined ? undefined : text(context.description, 2_000),
		selectedText: text(context.selectedText, 20_000),
		visibleText: text(context.visibleText, 40_000),
		headings: context.headings.map((value) => text(value, 500)).filter(Boolean),
		links: context.links.flatMap((link) => {
			const url = pageUrl(link.url);
			return url ? [{ text: text(link.text, 500), url }] : [];
		}),
		forms: context.forms.map((form) => ({
			label: text(form.label, 500),
			type: text(form.type, 100),
			name: text(form.name, 500),
		})),
	});
}
