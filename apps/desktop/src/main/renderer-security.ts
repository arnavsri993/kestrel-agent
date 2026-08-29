import { fileURLToPath } from "node:url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function trustedDevelopmentRendererUrl(
	value?: string,
): string | undefined {
	if (!value) return undefined;
	try {
		const configured = new URL(value);
		if (
			!["http:", "https:"].includes(configured.protocol) ||
			!LOOPBACK_HOSTS.has(configured.hostname) ||
			configured.username ||
			configured.password
		)
			return undefined;
		return configured.toString();
	} catch {
		return undefined;
	}
}

export function isTrustedRendererUrl(
	value: string,
	rendererEntryPath: string,
	developmentUrl?: string,
): boolean {
	try {
		const requested = new URL(value);
		if (developmentUrl) {
			const trustedDevelopmentUrl =
				trustedDevelopmentRendererUrl(developmentUrl);
			if (!trustedDevelopmentUrl) return false;
			const configured = new URL(trustedDevelopmentUrl);
			return (
				requested.origin === configured.origin &&
				requested.pathname === configured.pathname &&
				!requested.username &&
				!requested.password
			);
		}
		return (
			requested.protocol === "file:" &&
			!requested.hostname &&
			fileURLToPath(requested) === rendererEntryPath
		);
	} catch {
		return false;
	}
}

interface RendererNavigationEvent {
	preventDefault(): void;
}

interface RendererFrame {
	readonly url: string;
}

export function isTrustedRendererFrame<T extends RendererFrame>(
	senderFrame: T | null | undefined,
	mainFrame: T,
	isTrustedUrl: (url: string) => boolean,
): boolean {
	return senderFrame === mainFrame && isTrustedUrl(senderFrame.url);
}

interface RendererNavigationTarget {
	on(
		event: "will-navigate" | "will-redirect",
		listener: (event: RendererNavigationEvent, url: string) => void,
	): unknown;
}

export function protectRendererNavigation(
	target: RendererNavigationTarget,
	isTrusted: (url: string) => boolean,
): void {
	const preventUntrustedNavigation = (
		event: RendererNavigationEvent,
		url: string,
	) => {
		if (!isTrusted(url)) event.preventDefault();
	};
	target.on("will-navigate", preventUntrustedNavigation);
	target.on("will-redirect", preventUntrustedNavigation);
}

/** Allow only credential-free http(s) links in the system browser. */
export function safeExternalUrl(value: string): string | undefined {
	if (!value || value.length > 8_192) return undefined;
	try {
		const url = new URL(value);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

export function openExternalSafely(
	openExternal: (url: string) => Promise<void> | void,
	value: string,
): boolean {
	const safe = safeExternalUrl(value);
	if (!safe) return false;
	void Promise.resolve(openExternal(safe)).catch(() => undefined);
	return true;
}
