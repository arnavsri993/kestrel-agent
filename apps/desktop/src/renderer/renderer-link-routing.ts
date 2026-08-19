export interface RendererLinkActivation {
	defaultPrevented: boolean;
	button: number;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
}

export interface RendererLink {
	href: string;
	hasDownload: boolean;
	openExternally: boolean;
	target: string;
}

/**
 * Returns a URL only for ordinary renderer-link activations that may move into
 * the persistent user browser. Everything else stays with its existing owner.
 */
export function userBrowserUrlForRendererLink(
	event: RendererLinkActivation,
	link: RendererLink,
): string | undefined {
	if (
		event.defaultPrevented ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey ||
		link.hasDownload ||
		link.openExternally ||
		(link.target !== "" && link.target.toLowerCase() !== "_self")
	)
		return undefined;

	try {
		const url = new URL(link.href);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.toString()
			: undefined;
	} catch {
		return undefined;
	}
}
