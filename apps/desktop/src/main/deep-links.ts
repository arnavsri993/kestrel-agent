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

export function deepLinksFromArgv(argv: readonly string[]): KestrelDeepLink[] {
	return argv.flatMap((value) => {
		const parsed = parseKestrelDeepLink(value);
		return parsed ? [parsed] : [];
	});
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
