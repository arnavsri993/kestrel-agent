import {
	type KestrelDeepLink,
	KestrelDeepLinkSchema,
} from "@kestrel/shared-types";

const MAX_PENDING_DEEP_LINKS = 32;

export function parseKestrelDeepLink(
	value: unknown,
): KestrelDeepLink | undefined {
	const parsed = KestrelDeepLinkSchema.safeParse(value);
	if (!parsed.success) return undefined;
	return new URL(parsed.data).toString();
}

export function parseWebUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 8192 || /[\u0000-\u001f\u007f]/.test(trimmed))
		return undefined;
	try {
		const parsed = new URL(trimmed);
		if (
			parsed.protocol === "http:" ||
			parsed.protocol === "https:" ||
			parsed.protocol === "file:"
		) {
			return parsed.toString();
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function deepLinksFromArgv(argv: readonly string[]): KestrelDeepLink[] {
	return argv.flatMap((value) => {
		const parsed = parseKestrelDeepLink(value);
		return parsed ? [parsed] : [];
	});
}

export function urlsFromArgv(argv: readonly string[]): {
	deepLinks: KestrelDeepLink[];
	webUrls: string[];
} {
	const deepLinks: KestrelDeepLink[] = [];
	const webUrls: string[] = [];
	for (const arg of argv) {
		const deepLink = parseKestrelDeepLink(arg);
		if (deepLink) {
			deepLinks.push(deepLink);
			continue;
		}
		const webUrl = parseWebUrl(arg);
		if (webUrl) {
			webUrls.push(webUrl);
		}
	}
	return { deepLinks, webUrls };
}

export class DeepLinkQueue {
	private readonly pending: KestrelDeepLink[] = [];

	enqueue(value: unknown): boolean {
		const parsed = parseKestrelDeepLink(value);
		if (!parsed) return false;
		if (this.pending.includes(parsed)) return true;
		if (this.pending.length >= MAX_PENDING_DEEP_LINKS) return false;
		this.pending.push(parsed);
		return true;
	}

	drain(deliver: (deepLink: KestrelDeepLink) => void): number {
		let delivered = 0;
		while (this.pending.length > 0) {
			const next = this.pending[0]!;
			try {
				deliver(next);
			} catch {
				break;
			}
			this.pending.shift();
			delivered += 1;
		}
		return delivered;
	}

	get size(): number {
		return this.pending.length;
	}
}
