export type DesktopDeepLinkAction = "new-chat" | "settings";

export function desktopDeepLinkAction(
	value: string,
): DesktopDeepLinkAction | undefined {
	try {
		const url = new URL(value);
		if (
			url.protocol !== "kestrel:" ||
			url.username ||
			url.password ||
			url.port ||
			url.search ||
			url.hash ||
			(url.pathname !== "" && url.pathname !== "/")
		)
			return undefined;
		if (url.hostname === "new-chat") return "new-chat";
		if (url.hostname === "settings") return "settings";
	} catch {
		// Invalid or unsupported links are handled as a safe no-op by the caller.
	}
	return undefined;
}
