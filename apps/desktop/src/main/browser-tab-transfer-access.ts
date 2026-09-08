import { randomUUID } from "node:crypto";

interface PendingTabTransfer<Owner> {
	owner: Owner;
	tabId: string;
	expiresAt: number;
}

export class BrowserTabTransferAccess<Owner> {
	readonly #ttlMs: number;
	readonly #createToken: () => string;
	readonly #pending = new Map<string, PendingTabTransfer<Owner>>();

	constructor(options: { ttlMs?: number; createToken?: () => string } = {}) {
		this.#ttlMs = options.ttlMs ?? 30_000;
		this.#createToken = options.createToken ?? randomUUID;
	}

	issue(owner: Owner, tabId: string, now = Date.now()): string {
		this.#trim(now);
		const token = this.#createToken();
		this.#pending.set(token, {
			owner,
			tabId,
			expiresAt: now + this.#ttlMs,
		});
		return token;
	}

	consume(token: string, tabId: string, now = Date.now()): Owner | null {
		const pending = this.#pending.get(token);
		this.#pending.delete(token);
		if (!pending || pending.expiresAt <= now || pending.tabId !== tabId)
			return null;
		return pending.owner;
	}

	revokeOwner(owner: Owner): void {
		for (const [token, pending] of this.#pending) {
			if (pending.owner === owner) this.#pending.delete(token);
		}
	}

	#trim(now: number): void {
		for (const [token, pending] of this.#pending) {
			if (pending.expiresAt <= now) this.#pending.delete(token);
		}
	}
}
