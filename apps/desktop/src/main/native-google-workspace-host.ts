import { RendererRequestSchema, type RendererResponse } from "@kestrel/shared-types";
import { GMAIL_READONLY_SCOPE } from "@kestrel/shared-types";
import type { CredentialBroker } from "./credential-broker";
import {
	GoogleWorkspaceOAuthManager,
	type GoogleWorkspaceOAuthStatus,
} from "./google-workspace-oauth";
import { NATIVE_GOOGLE_WORKSPACE_REQUEST_TYPES } from "./native-google-workspace-requests";
export { NATIVE_GOOGLE_WORKSPACE_REQUEST_TYPES } from "./native-google-workspace-requests";

export interface NativeGoogleWorkspaceHostOptions {
	broker: Pick<CredentialBroker, "getOpaqueSecret" | "setOpaqueSecret" | "removeOpaqueSecret">;
	openAuthUrl(url: string, signal: AbortSignal): Promise<void>;
	reconfigure<T>(
		mutation: () => Promise<T>,
		rollback?: () => Promise<void>,
		validate?: () => void,
		shouldRestoreCore?: () => boolean,
	): Promise<T>;
	isBusy?: () => boolean;
	shouldRestoreCore?: () => boolean;
	fetcher?: typeof fetch;
	now?: () => Date;
	timeoutMs?: number;
	requestTimeoutMs?: number;
}

interface Owner {
	kind: "connect" | "disconnect";
	controller: AbortController;
	done: Promise<RendererResponse>;
}

function communicationSources(status: GoogleWorkspaceOAuthStatus) {
	const gmail = status.connected
		? status.scopes.includes(GMAIL_READONLY_SCOPE)
			? {
					id: "gmail" as const,
					label: "Connected Gmail",
					kind: "email" as const,
					state: "connected" as const,
					detail: "Recent verification messages can be searched on request.",
					...(status.email ? { account: status.email } : {}),
				}
			: {
					id: "gmail" as const,
					label: "Connected Gmail",
					kind: "email" as const,
					state: "needs_reconnect" as const,
					detail: "Reconnect Google Workspace to allow read-only code lookup.",
					...(status.email ? { account: status.email } : {}),
				}
		: {
				id: "gmail" as const,
				label: "Connected Gmail",
				kind: "email" as const,
				state: "not_connected" as const,
				detail: "Connect Google Workspace to search a mailbox on request.",
			};
	return [
		{
			id: "mac-messages" as const,
			label: "Apple Messages",
			kind: "local" as const,
			state: "unavailable" as const,
			detail: "Messages access is not available in the native Chromium host.",
		},
		gmail,
	];
}

/** Native Google sign-in stores credentials only in the owning native profile. */
export class NativeGoogleWorkspaceHost {
	private readonly manager: GoogleWorkspaceOAuthManager;
	private owner: Owner | undefined;
	private revocationController: AbortController | undefined;
	private closing = false;

	constructor(private readonly options: NativeGoogleWorkspaceHostOptions) {
		this.manager = new GoogleWorkspaceOAuthManager({
			broker: options.broker,
			openExternal: async (url, signal) => {
				if (!signal) throw new Error("Google sign-in requires a cancellable native browser.");
				await options.openAuthUrl(url, signal);
			},
			persistSecret: (write, signal) => this.commitSecret(write, signal),
			disconnectSecret: (remove, revoke) => this.removeThenRevoke(remove, revoke, this.owner?.controller.signal),
			...(options.fetcher ? { fetcher: options.fetcher } : {}),
			...(options.now ? { now: options.now } : {}),
			...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
			...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
		});
	}

	private async commitSecret(write: () => Promise<void>, signal?: AbortSignal): Promise<void> {
		const secretId = GoogleWorkspaceOAuthManager.secretId;
		const previous = await this.options.broker.getOpaqueSecret(secretId);
		const rollback = async () => {
			if (previous === undefined) await this.options.broker.removeOpaqueSecret(secretId);
			else await this.options.broker.setOpaqueSecret(secretId, previous);
		};
		await this.options.reconfigure(async () => {
			signal?.throwIfAborted();
			await write();
		}, rollback, () => signal?.throwIfAborted(), this.options.shouldRestoreCore);
	}

	private async removeThenRevoke(
		remove: () => Promise<void>,
		revoke: (signal?: AbortSignal) => Promise<void>,
		signal?: AbortSignal,
	): Promise<void> {
		const secretId = GoogleWorkspaceOAuthManager.secretId;
		const previous = await this.options.broker.getOpaqueSecret(secretId);
		const rollback = async () => {
			if (previous !== undefined) await this.options.broker.setOpaqueSecret(secretId, previous);
		};
		await this.options.reconfigure(async () => {
			signal?.throwIfAborted();
			await remove();
		}, rollback, () => signal?.throwIfAborted(), this.options.shouldRestoreCore);
		// Core has restarted without the token before revocation begins. Finish
		// with an independent bounded signal so late UI cancellation cannot leave
		// the local profile disconnected while silently skipping vendor revoke.
		const revokeController = new AbortController();
		this.revocationController = revokeController;
		if (this.closing) revokeController.abort(new Error("The native Google Workspace host is shutting down."));
		const timer = setTimeout(() => revokeController.abort(new Error("Google revocation timed out.")), 30_000);
		timer.unref();
		try { await revoke(revokeController.signal); }
		catch { throw new Error("Google Workspace was disconnected locally, but remote revocation could not be confirmed."); }
		finally {
			clearTimeout(timer);
			if (this.revocationController === revokeController) this.revocationController = undefined;
		}
	}

	private reserve(kind: Owner["kind"]): Owner {
		if (this.closing) throw new Error("The native Google Workspace host is shutting down.");
		if (this.owner) throw new Error("Google Workspace sign-in or disconnect is already in progress.");
		const owner: Owner = { kind, controller: new AbortController(), done: Promise.resolve({ ok: true }) };
		this.owner = owner;
		return owner;
	}

	private run(owner: Owner, operation: () => Promise<RendererResponse>, externalSignal?: AbortSignal): Promise<RendererResponse> {
		const abort = () => owner.controller.abort(externalSignal?.reason ?? new Error("Google sign-in was cancelled."));
		if (externalSignal?.aborted) abort();
		else externalSignal?.addEventListener("abort", abort, { once: true });
		owner.done = Promise.resolve().then(operation).finally(() => {
			externalSignal?.removeEventListener("abort", abort);
			if (this.owner === owner) this.owner = undefined;
		});
		return owner.done;
	}

	private safeError(error: unknown): Error {
		const message = error instanceof Error ? error.message : "";
		if ([
			"Enter a Google OAuth client ID created for a Desktop app.",
			"Google sign-in is unavailable because the bundled OAuth client is misconfigured.",
			"Wait for the active task to finish or cancel it before disconnecting Google Workspace.",
			"Google Workspace sign-in or disconnect is already in progress.",
			"Google Workspace disconnect is already in progress.",
			"Google Workspace was disconnected locally, but remote revocation could not be confirmed.",
		].includes(message)) return new Error(message);
		if (/timed out/i.test(message)) return new Error("Google sign-in timed out. Try again when you can finish the browser consent flow.");
		if (/cancel|abort|shutdown/i.test(message)) return new Error("Google sign-in was cancelled.");
		return new Error("Google Workspace could not be updated. Check the connection and try again.");
	}

	private async cancelConnect(): Promise<GoogleWorkspaceOAuthStatus> {
		const owner = this.owner;
		if (owner?.kind === "connect") {
			owner.controller.abort(new Error("Google sign-in was cancelled."));
			await owner.done.catch(() => undefined);
		}
		return this.manager.status();
	}

	async handle(raw: unknown, externalSignal?: AbortSignal): Promise<RendererResponse> {
		if (this.closing) throw new Error("The native Google Workspace host is shutting down.");
		const parsed = RendererRequestSchema.safeParse(raw);
		if (!parsed.success || !NATIVE_GOOGLE_WORKSPACE_REQUEST_TYPES.has(parsed.data.type))
			return { ok: false, error: "Invalid native Google Workspace request." };
		if (externalSignal?.aborted) throw this.safeError(externalSignal.reason);
		const request = parsed.data;
		try {
		switch (request?.type) {
			case "oauth-google-status":
				try { return { ok: true, googleWorkspaceOAuth: await this.manager.status() }; }
				catch (error) { throw this.safeError(error); }
			case "communication-sources":
				try { return { ok: true, communicationSources: communicationSources(await this.manager.status()) }; }
				catch (error) { throw this.safeError(error); }
			case "oauth-google-connect": {
				const owner = this.reserve("connect");
				return this.run(owner, async () => ({
					ok: true,
					googleWorkspaceOAuth: await this.manager.connect(request.clientId, owner.controller.signal),
				}), externalSignal).catch(error => { throw this.safeError(error); });
			}
			case "oauth-google-cancel":
				try { return { ok: true, googleWorkspaceOAuth: await this.cancelConnect() }; }
				catch (error) { throw this.safeError(error); }
			case "oauth-google-disconnect": {
				const previous = this.owner;
				if (previous?.kind === "disconnect") throw new Error("Google Workspace disconnect is already in progress.");
				if (previous?.kind === "connect") {
					previous.controller.abort(new Error("Google sign-in was cancelled."));
					await previous.done.catch(() => undefined);
				}
				if (this.options.isBusy?.()) throw new Error("Wait for the active task to finish or cancel it before disconnecting Google Workspace.");
				const owner = this.reserve("disconnect");
				return this.run(owner, async () => ({
					ok: true,
					googleWorkspaceOAuth: await this.disconnectWithDeadline(owner),
				}), externalSignal).catch(error => { throw this.safeError(error); });
			}
			default:
				return { ok: false, error: "Invalid native Google Workspace request." };
		}
		} catch (error) { throw this.safeError(error); }
	}

	private async disconnectWithDeadline(owner: Owner): Promise<GoogleWorkspaceOAuthStatus> {
		const timeoutMs = Math.max(30_000, Math.min(10 * 60_000, this.options.timeoutMs ?? 5 * 60_000));
		const timer = setTimeout(() => owner.controller.abort(new Error("Google disconnect timed out.")), timeoutMs);
		timer.unref();
		try { return await this.manager.disconnect(owner.controller.signal); }
		finally { clearTimeout(timer); }
	}

	async close(): Promise<void> {
		this.closing = true;
		this.revocationController?.abort(new Error("The native Google Workspace host is shutting down."));
		const owner = this.owner;
		if (owner) {
			owner.controller.abort(new Error("The native Google Workspace host is shutting down."));
			await owner.done.catch(() => undefined);
		}
	}
}
