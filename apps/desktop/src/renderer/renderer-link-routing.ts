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

export interface UserBrowserLinkRoute {
	url: string;
	active: boolean;
}

/**
 * Returns a managed-tab route for ordinary renderer links, including links
 * that would otherwise create a separate browsing context. Explicit system
 * handoffs, downloads, and non-web protocols stay with their existing owner.
 */
export function userBrowserRouteForRendererLink(
	event: RendererLinkActivation,
	link: RendererLink,
): UserBrowserLinkRoute | undefined {
	if (
		event.defaultPrevented ||
		(event.button !== 0 && event.button !== 1) ||
		event.altKey ||
		link.hasDownload ||
		link.openExternally
	)
		return undefined;

	try {
		const url = new URL(link.href);
		return url.protocol === "http:" || url.protocol === "https:"
			? {
					url: url.toString(),
					// Match browser conventions: middle-click and Cmd/Ctrl-click create
					// background tabs, while Shift keeps the new tab in the foreground.
					active:
						event.shiftKey ||
						(event.button === 0 && !event.metaKey && !event.ctrlKey),
				}
			: undefined;
	} catch {
		return undefined;
	}
}
