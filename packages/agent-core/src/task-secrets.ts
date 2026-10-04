import { randomUUID } from "node:crypto";
import { replaceSensitiveText, maskSensitiveText } from "@kestrel/shared-types";

export interface PreparedTaskSecrets {
	text: string;
	scopeId?: string;
}

export interface TaskSecretCleanup {
	method: "temporary-secret-store-readback";
	removed: number;
	remaining: number;
	verified: boolean;
	limits: string;
}

interface SecretScope {
	sessionId: string;
	runId?: string;
	values: Map<string, Buffer>;
	count: number;
	expiresAt: number;
	timer: ReturnType<typeof setTimeout>;
}

export const TASK_SECRET_CLEANUP_LIMITS = "This verifies Kestrel's temporary credential store only. It does not verify CLI files, other apps, provider retention, backups, or forensic erasure from process memory.";

/** No disk persistence, provider access, renderer access, or process.env mutation. */
export class TaskSecretVault {
	private readonly scopes = new Map<string, SecretScope>();
	constructor(private readonly lifetimeMs = 10 * 60_000) {}

	prepare(sessionId: string, text: string): PreparedTaskSecrets {
		const scopeId = `task-secret-scope-${randomUUID()}`;
		const values = new Map<string, Buffer>();
		try {
			const safe = replaceSensitiveText(text, (_kind, secret) => {
				if (secret.length > 20_000 || values.size >= 16 || this.scopes.size >= 64)
					throw new Error("Temporary credential capacity exceeded. Use the protected credential field for this task.");
				const bytes = Buffer.from(secret, "utf8");
				for (const [ref, value] of values) {
					if (value.equals(bytes)) {
						bytes.fill(0);
						return `[TASK_SECRET:${ref}]`;
					}
				}
				const ref = `task-secret-${randomUUID()}`;
				values.set(ref, bytes);
				return `[TASK_SECRET:${ref}]`;
			});
			if (!values.size) return { text: safe };
			// The timer closes over an ID only, never over credential bytes.
			const timer = setTimeout(() => this.expire(scopeId), this.lifetimeMs);
			timer.unref();
			this.scopes.set(scopeId, { sessionId, values, count: values.size,
				expiresAt: Date.now() + this.lifetimeMs, timer });
			return { text: safe, scopeId };
		} catch (error) {
			for (const value of values.values()) value.fill(0);
			values.clear();
			throw error;
		}
	}

	bind(scopeId: string, sessionId: string, runId: string): void {
		const scope = this.scopes.get(scopeId);
		if (!scope || scope.sessionId !== sessionId || (scope.runId && scope.runId !== runId))
			throw new Error("The temporary credential does not belong to this task.");
		scope.runId = runId;
	}

	resolve(sessionId: string, runId: string, references: Record<string, string>): Record<string, string> {
		const environment: Record<string, string> = {};
		try {
			for (const [key, ref] of Object.entries(references)) {
				// Credential variables only; never interpreter, loader, path, or startup controls.
				if (!/^(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|[A-Z][A-Z0-9_]*_(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD))$/.test(key))
					throw new Error("Only credential environment variables are allowed.");
				const scope = [...this.scopes.values()].find(candidate =>
					candidate.sessionId === sessionId && candidate.runId === runId && candidate.values.has(ref));
				if (!scope || scope.expiresAt <= Date.now())
					throw new Error("The temporary credential expired, was removed, or belongs to another task. Enter it again through a protected field; no saved credential will be substituted.");
				environment[key] = scope.values.get(ref)!.toString("utf8");
			}
			return environment;
		} catch (error) {
			for (const key of Object.keys(environment)) delete environment[key];
			throw error;
		}
	}

	/** Exact-value defense also covers credentials without a recognizable prefix. */
	redact(sessionId: string, text: string): string {
		const values = [...this.scopes.values()]
			.filter(scope => scope.sessionId === sessionId)
			.flatMap(scope => [...scope.values.values()].map(value => value.toString("utf8")))
			.sort((a, b) => b.length - a.length);
		let safe = text;
		for (const value of values) safe = safe.replaceAll(value, "[REDACTED]");
		return maskSensitiveText(safe);
	}

	clearRun(runId: string): TaskSecretCleanup | undefined {
		let removed = 0;
		for (const [scopeId, scope] of this.scopes) {
			if (scope.runId !== runId) continue;
			removed += scope.count;
			this.clearScope(scopeId);
		}
		if (!removed) return undefined;
		const remaining = [...this.scopes.values()].filter(scope => scope.runId === runId)
			.reduce((sum, scope) => sum + scope.values.size, 0);
		return { method: "temporary-secret-store-readback", removed, remaining,
			verified: remaining === 0, limits: TASK_SECRET_CLEANUP_LIMITS };
	}

	clearScope(scopeId: string): void {
		const scope = this.scopes.get(scopeId);
		if (!scope) return;
		clearTimeout(scope.timer);
		for (const value of scope.values.values()) value.fill(0);
		scope.values.clear();
		this.scopes.delete(scopeId);
	}

	clearUnboundScope(scopeId: string): void {
		if (!this.scopes.get(scopeId)?.runId) this.clearScope(scopeId);
	}

	clearSession(sessionId: string): void {
		for (const [id, scope] of this.scopes) if (scope.sessionId === sessionId) this.clearScope(id);
	}

	hasRun(runId: string): boolean {
		return [...this.scopes.values()].some(scope => scope.runId === runId);
	}

	hasSession(sessionId: string): boolean {
		return [...this.scopes.values()].some(scope => scope.sessionId === sessionId);
	}

	private expire(scopeId: string): void {
		const scope = this.scopes.get(scopeId);
		if (!scope) return;
		for (const value of scope.values.values()) value.fill(0);
		scope.values.clear();
		// Keep non-secret counts for the task's eventual cleanup receipt, bounded
		// by scope capacity. A restart loses the values and these metadata together.
		if (!scope.runId) this.scopes.delete(scopeId);
	}
}
