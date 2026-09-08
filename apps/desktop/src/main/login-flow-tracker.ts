import { URL } from "node:url";

const DEFAULT_TTL_MS = 2 * 60_000;
const MAX_NAVIGATION_CHAIN = 16;

export type LoginFlowTabId = string;

export interface LoginFlowContext {
	tabId: LoginFlowTabId;
	initiatingOrigin: string;
	authOrigin?: string;
	selectedCredentialId?: string;
	username?: string;
	navigationChain: string[];
	autofillOccurred: boolean;
	startedAt: number;
	lastActivityAt: number;
	expiresAt: number;
}

export interface LoginFlowTrackerOptions {
	now?: () => number;
	ttlMs?: number;
	maxNavigationChain?: number;
}

/**
 * Short-lived, non-secret context for multi-step login pages.
 *
 * Passwords deliberately have no representation in this class or its public
 * context. Credential IDs are opaque references resolved by the password vault.
 */
export class LoginFlowTracker {
	private readonly flows = new Map<LoginFlowTabId, LoginFlowContext>();
	private readonly now: () => number;
	private readonly ttlMs: number;
	private readonly maxNavigationChain: number;

	constructor(options: LoginFlowTrackerOptions = {}) {
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.maxNavigationChain = Math.max(
			1,
			Math.floor(options.maxNavigationChain ?? MAX_NAVIGATION_CHAIN),
		);
		if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0)
			throw new Error("Login flow TTL must be positive and finite.");
	}

	recordNavigation(tabId: LoginFlowTabId, url: string): LoginFlowContext | undefined {
		const origin = normalizeHttpsOrigin(url);
		if (!origin) {
			this.clearTab(tabId);
			return undefined;
		}
		const now = this.now();
		this.expire(now);
		const existing = this.flows.get(tabId);
		if (!existing) {
			const created: LoginFlowContext = {
				tabId,
				initiatingOrigin: origin,
				authOrigin: origin,
				navigationChain: [origin],
				autofillOccurred: false,
				startedAt: now,
				lastActivityAt: now,
				expiresAt: now + this.ttlMs,
			};
			this.flows.set(tabId, created);
			return this.copy(created);
		}
		existing.authOrigin = origin;
		if (existing.navigationChain.at(-1) !== origin) {
			existing.navigationChain.push(origin);
			if (existing.navigationChain.length > this.maxNavigationChain)
				existing.navigationChain.splice(
					0,
					existing.navigationChain.length - this.maxNavigationChain,
				);
		}
		this.touch(existing, now);
		return this.copy(existing);
	}

	selectCredential(
		tabId: LoginFlowTabId,
		credentialId: string,
		username?: string,
	): LoginFlowContext | undefined {
		const flow = this.active(tabId);
		if (!flow || !credentialId) return undefined;
		flow.selectedCredentialId = credentialId;
		if (username !== undefined) flow.username = username;
		this.touch(flow, this.now());
		return this.copy(flow);
	}

	markAutofill(tabId: LoginFlowTabId): LoginFlowContext | undefined {
		const flow = this.active(tabId);
		if (!flow) return undefined;
		flow.autofillOccurred = true;
		this.touch(flow, this.now());
		return this.copy(flow);
	}

	clearTab(tabId: LoginFlowTabId): void {
		this.flows.delete(tabId);
	}

	clearAll(): void {
		this.flows.clear();
	}

	readContext(tabId: LoginFlowTabId): LoginFlowContext | undefined {
		const flow = this.active(tabId);
		return flow ? this.copy(flow) : undefined;
	}

	private active(tabId: LoginFlowTabId): LoginFlowContext | undefined {
		this.expire(this.now());
		return this.flows.get(tabId);
	}

	private expire(now: number): void {
		for (const [tabId, flow] of this.flows) {
			if (flow.expiresAt <= now) this.flows.delete(tabId);
		}
	}

	private touch(flow: LoginFlowContext, now: number): void {
		flow.lastActivityAt = now;
		flow.expiresAt = now + this.ttlMs;
	}

	private copy(flow: LoginFlowContext): LoginFlowContext {
		return { ...flow, navigationChain: [...flow.navigationChain] };
	}
}

export function normalizeHttpsOrigin(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.origin === "null")
			return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}
