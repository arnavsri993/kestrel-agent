import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GMAIL_READONLY_SCOPE } from "@kestrel/shared-types";
import type { CredentialBroker } from "./credential-broker";

const GOOGLE_AUTHORIZATION_ENDPOINT =
	"https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_ENDPOINT =
	"https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_CALENDAR_PROBE_ENDPOINT =
	"https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_WORKSPACE_SECRET_ID = "google-workspace-oauth";
const REQUESTED_SCOPES = [
	"openid",
	"email",
	"https://www.googleapis.com/auth/gmail.send",
	GMAIL_READONLY_SCOPE,
	"https://www.googleapis.com/auth/calendar.events",
] as const;

interface GoogleWorkspaceOAuthRecord {
	version: 1;
	clientId: string;
	refreshToken: string;
	email: string;
	scopes: string[];
	connectedAt: string;
}

export interface GoogleWorkspaceOAuthStatus {
	connected: boolean;
	email?: string;
	scopes: string[];
	connectedAt?: string;
	clientIdSuffix?: string;
	bundledClientAvailable: boolean;
}

interface GoogleWorkspaceOAuthManagerOptions {
	broker: Pick<CredentialBroker, "getOpaqueSecret" | "setOpaqueSecret" | "removeOpaqueSecret">;
	openExternal(url: string, signal?: AbortSignal): Promise<unknown>;
	/** Guard only the durable secret write, after consent and token verification. */
	persistSecret?: (write: () => Promise<void>, signal: AbortSignal) => Promise<void>;
	/** Native hosts can remove transactionally before revoking the old token. */
	disconnectSecret?: (remove: () => Promise<void>, revoke: (signal?: AbortSignal) => Promise<void>) => Promise<void>;
	fetcher?: typeof fetch;
	now?: () => Date;
	timeoutMs?: number;
	/** Injectable for deterministic deadline tests; production uses 30 seconds. */
	requestTimeoutMs?: number;
}

function abortError(signal: AbortSignal, label: string): Error {
	if (signal.reason instanceof Error) return signal.reason;
	return new Error(`${label} was cancelled.`);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError(signal, label));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(abortError(signal, label));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

async function boundedJson(
	response: Response,
	limit: number,
	label: string,
	signal: AbortSignal,
	): Promise<Record<string, unknown>> {
	if (signal.aborted) throw abortError(signal, label);
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > limit)
		throw new Error(`${label} response exceeds its size limit.`);
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		const cancel = () => { void reader.cancel().catch(() => undefined); };
		signal.addEventListener("abort", cancel, { once: true });
		try {
			while (true) {
				const { done, value } = await raceAbort(reader.read(), signal, label);
				if (done) break;
				size += value.byteLength;
				if (size > limit) {
					await reader.cancel().catch(() => undefined);
					throw new Error(`${label} response exceeds its size limit.`);
				}
				chunks.push(value);
			}
		} catch (error) {
			if (error instanceof Error && error.message === `${label} response exceeds its size limit.`) throw error;
			throw new Error(`${label} response could not be read.`);
		} finally { signal.removeEventListener("abort", cancel); try { reader.releaseLock(); } catch { /* A cancelled read may still be unwinding. */ } }
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	try {
		const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new Error(`${label} returned an invalid JSON response.`);
	}
}

function validClientId(clientId: string): boolean {
	return /^[0-9]+-[A-Za-z0-9_-]{20,200}\.apps\.googleusercontent\.com$/.test(
		clientId,
	);
}

export function readBundledGoogleOAuthClientId(): string | undefined {
	const clientId = process.env.KESTREL_GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "";
	return validClientId(clientId) ? clientId : undefined;
}

function withBundledAvailability(
	status: Omit<GoogleWorkspaceOAuthStatus, "bundledClientAvailable">,
): GoogleWorkspaceOAuthStatus {
	return {
		...status,
		bundledClientAvailable: Boolean(readBundledGoogleOAuthClientId()),
	};
}

function isLoopback(address: string | undefined): boolean {
	return (
		address === "127.0.0.1" ||
		address === "::1" ||
		address === "::ffff:127.0.0.1"
	);
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
	if (!server.listening) return;
	// An incomplete local HTTP request must not keep a cancelled sign-in alive.
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

export class GoogleWorkspaceOAuthManager {
	private readonly fetcher: typeof fetch;
	private readonly now: () => Date;
	private readonly timeoutMs: number;
	private readonly requestTimeoutMs: number;

	constructor(private readonly options: GoogleWorkspaceOAuthManagerOptions) {
		this.fetcher = options.fetcher ?? fetch;
		this.now = options.now ?? (() => new Date());
		this.timeoutMs = Math.max(
			30_000,
			Math.min(10 * 60_000, options.timeoutMs ?? 5 * 60_000),
		);
		this.requestTimeoutMs = Math.max(1, Math.min(60_000, options.requestTimeoutMs ?? 30_000));
	}

	static get secretId(): string { return GOOGLE_WORKSPACE_SECRET_ID; }

	private async request(url: URL | string, init: RequestInit, label: string, responseLimit?: number): Promise<{ response: Response; body?: Record<string, unknown> }> {
		const parentSignal = init.signal ?? undefined;
		const controller = new AbortController();
		const abortFromParent = () => controller.abort(parentSignal?.reason ?? new Error(`${label} was cancelled.`));
		if (parentSignal?.aborted) abortFromParent();
		else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
		const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out.`)), this.requestTimeoutMs);
		timeout.unref();
		const requestInit: RequestInit = { ...init, signal: controller.signal };
		try {
			controller.signal.throwIfAborted();
			const response = await raceAbort(Promise.resolve().then(() => this.fetcher(url, requestInit)), controller.signal, label);
			if (responseLimit !== undefined) {
				const body = await boundedJson(response, responseLimit, label, controller.signal);
				return { response, body };
			}
			if (response.body) await raceAbort(response.body.cancel(), controller.signal, label);
			return { response };
		} catch (error) {
			if (controller.signal.aborted) throw abortError(controller.signal, label);
			if (error instanceof Error && /response exceeds its size limit|returned an invalid JSON response|response could not be read/.test(error.message)) throw error;
			throw new Error(`${label} could not be completed.`);
		} finally {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", abortFromParent);
		}
	}

	async status(): Promise<GoogleWorkspaceOAuthStatus> {
		const record = await this.readRecord();
		if (!record)
			return withBundledAvailability({ connected: false, scopes: [] });
		return withBundledAvailability({
			connected: true,
			email: record.email,
			scopes: [...record.scopes],
			connectedAt: record.connectedAt,
			clientIdSuffix: record.clientId.slice(-24),
		});
	}

	async connect(
		rawClientId: string | undefined,
		signal?: AbortSignal,
	): Promise<GoogleWorkspaceOAuthStatus> {
		const clientId =
			rawClientId?.trim() || readBundledGoogleOAuthClientId() || "";
		if (!validClientId(clientId))
			throw new Error(
				readBundledGoogleOAuthClientId()
					? "Google sign-in is unavailable because the bundled OAuth client is misconfigured."
					: "Enter a Google OAuth client ID created for a Desktop app.",
			);
		if (signal?.aborted)
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("Google sign-in was cancelled.");

		const state = randomBytes(32).toString("base64url");
		const codeVerifier = randomBytes(64).toString("base64url");
		const codeChallenge = createHash("sha256")
			.update(codeVerifier)
			.digest("base64url");
		let settleCallback:
			| ((result: { code?: string; error?: string }) => void)
			| undefined;
		const callback = new Promise<{ code?: string; error?: string }>(
			(resolve) => {
				settleCallback = resolve;
			},
		);
		let settled = false;
		const settle = (result: { code?: string; error?: string }) => {
			if (settled) return;
			settled = true;
			settleCallback?.(result);
		};
		let expectedHost = "";
		const server = createServer((request, response) => {
			if (
				!isLoopback(request.socket.remoteAddress) ||
				request.method !== "GET" ||
				!request.url ||
				Buffer.byteLength(request.url) > 8_192 ||
				request.headers.host !== expectedHost ||
				settled
			) {
				response.writeHead(403, {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-store",
				});
				response.end("Forbidden");
				return;
			}
			let url: URL;
			try {
				url = new URL(request.url, `http://${expectedHost}`);
			} catch {
				response.writeHead(400, {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-store",
				});
				response.end(
					"Invalid OAuth callback. Return to Kestrel and try again.",
				);
				return;
			}
			const states = url.searchParams.getAll("state");
			const codes = url.searchParams.getAll("code");
			const errors = url.searchParams.getAll("error");
			if (url.origin !== `http://${expectedHost}` || url.pathname !== "/oauth/google/callback" ||
				states.length !== 1 || states[0] !== state || codes.length + errors.length !== 1 ||
				(codes.length === 1 && (!codes[0] || codes[0].length > 4_096)) || (errors.length === 1 && (!errors[0] || errors[0].length > 200))) {
				response.writeHead(400, {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-store",
				});
				response.end(
					"Invalid OAuth callback. Return to Kestrel and try again.",
				);
				return;
			}
			const error = errors[0];
			const code = codes[0];
			response.writeHead(error || !code ? 400 : 200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"content-security-policy":
					"default-src 'none'; style-src 'unsafe-inline'",
			});
			response.end(
				error || !code
					? "<!doctype html><title>Kestrel sign-in cancelled</title><p>Google sign-in was not completed. You can close this window and return to Kestrel.</p>"
					: "<!doctype html><title>Kestrel connected</title><p>Google Workspace is connected. You can close this window and return to Kestrel.</p>",
			);
			settle(error ? { error } : code ? { code } : { error: "missing_code" });
		});

		const port = await listen(server);
		expectedHost = `127.0.0.1:${port}`;
		const redirectUri = `http://127.0.0.1:${port}/oauth/google/callback`;
		const authorization = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
		authorization.search = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: REQUESTED_SCOPES.join(" "),
			access_type: "offline",
			prompt: "consent",
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		}).toString();

		let timeout: NodeJS.Timeout | undefined;
		const requestController = new AbortController();
		const abort = () => {
			requestController.abort(signal?.reason ?? new Error("Google sign-in was cancelled."));
			settle({ error: "cancelled" });
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try {
			timeout = setTimeout(() => {
				requestController.abort(new Error("Google sign-in timed out."));
				settle({ error: "timeout" });
			}, this.timeoutMs);
			timeout.unref();
			await this.options.openExternal(authorization.toString(), requestController.signal);
			const result = await callback;
			requestController.signal.throwIfAborted();
			if (!result.code) {
				if (result.error === "cancelled")
					throw signal?.reason instanceof Error
						? signal.reason
						: new Error("Google sign-in was cancelled.");
				if (result.error === "timeout")
					throw new Error(
						"Google sign-in timed out. Try again when you can finish the browser consent flow.",
					);
				throw new Error("Google sign-in was not completed.");
			}
			const token = await this.exchangeCode({
				clientId,
				code: result.code,
				codeVerifier,
				redirectUri,
			}, requestController.signal);
			requestController.signal.throwIfAborted();
			const grantedScopes = String(token.scope ?? "")
				.split(/\s+/)
				.filter(Boolean);
			for (const scope of REQUESTED_SCOPES) {
				if (!grantedScopes.includes(scope))
					throw new Error(`Google did not grant the required ${scope} scope.`);
			}
			const accessToken =
				typeof token.access_token === "string" ? token.access_token : "";
			const refreshToken =
				typeof token.refresh_token === "string" ? token.refresh_token : "";
			if (accessToken.length < 20 || refreshToken.length < 20)
				throw new Error(
					"Google did not return usable access and refresh tokens.",
				);
			const email = await this.verifyIdentityAndCalendar(accessToken, requestController.signal);
			requestController.signal.throwIfAborted();
			const record: GoogleWorkspaceOAuthRecord = {
				version: 1,
				clientId,
				refreshToken,
				email,
				scopes: grantedScopes.sort(),
				connectedAt: this.now().toISOString(),
			};
			const write = () => this.options.broker.setOpaqueSecret(
				GOOGLE_WORKSPACE_SECRET_ID,
				JSON.stringify(record),
			);
			requestController.signal.throwIfAborted();
			if (this.options.persistSecret) await this.options.persistSecret(write, requestController.signal);
			else await write();
			return this.status();
		} finally {
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			await close(server);
		}
	}

	async disconnect(signal?: AbortSignal): Promise<GoogleWorkspaceOAuthStatus> {
		signal?.throwIfAborted();
		const record = await this.readRecord();
		if (record) {
			const revoke = async (revokeSignal = signal) => {
				const { response } = await this.request(GOOGLE_REVOCATION_ENDPOINT, {
					method: "POST",
					redirect: "error",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ token: record.refreshToken }),
					...(revokeSignal ? { signal: revokeSignal } : {}),
				}, "Google revocation");
				if (!response.ok) throw new Error("Google revocation was not confirmed.");
			};
			const remove = () => this.options.broker.removeOpaqueSecret(GOOGLE_WORKSPACE_SECRET_ID);
			if (this.options.disconnectSecret) await this.options.disconnectSecret(remove, revoke);
			else { try { await revoke(); } finally { await remove(); } }
		}
		return withBundledAvailability({ connected: false, scopes: [] });
	}

	private async exchangeCode(input: {
		clientId: string;
		code: string;
		codeVerifier: string;
		redirectUri: string;
	}, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const { response, body } = await this.request(GOOGLE_TOKEN_ENDPOINT, {
			method: "POST",
			redirect: "error",
			headers: {
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: input.clientId,
				code: input.code,
				code_verifier: input.codeVerifier,
				redirect_uri: input.redirectUri,
				grant_type: "authorization_code",
			}),
			...(signal ? { signal } : {}),
		}, "Google token exchange", 64_000);
		if (!response.ok)
			throw new Error("Google token exchange failed.");
		return body!;
	}

	private async verifyIdentityAndCalendar(
		accessToken: string,
		signal?: AbortSignal,
	): Promise<string> {
		const headers = {
			accept: "application/json",
			authorization: `Bearer ${accessToken}`,
		};
		const { response: identityResponse, body: identity } = await this.request(GOOGLE_USERINFO_ENDPOINT, {
			redirect: "error",
			headers,
			...(signal ? { signal } : {}),
		}, "Google identity verification", 64_000);
		if (
			!identityResponse.ok ||
			typeof identity?.email !== "string" ||
			!identity.email.includes("@")
		)
			throw new Error("Google identity verification failed.");
		const calendarUrl = new URL(GOOGLE_CALENDAR_PROBE_ENDPOINT);
		calendarUrl.search = new URLSearchParams({
			maxResults: "1",
			singleEvents: "true",
			timeMin: this.now().toISOString(),
		}).toString();
		const { response: calendarResponse, body: calendar } = await this.request(calendarUrl, {
			redirect: "error",
			headers,
			...(signal ? { signal } : {}),
		}, "Google Calendar verification", 256_000);
		if (!calendarResponse.ok || !Array.isArray(calendar?.items))
			throw new Error("Google Calendar verification failed.");
		return identity!.email as string;
	}

	private async readRecord(): Promise<GoogleWorkspaceOAuthRecord | undefined> {
		const raw = await this.options.broker.getOpaqueSecret(
			GOOGLE_WORKSPACE_SECRET_ID,
		);
		if (!raw) return undefined;
		try {
			const record = JSON.parse(raw) as Partial<GoogleWorkspaceOAuthRecord>;
			if (
				record.version !== 1 ||
				!record.clientId ||
				!record.refreshToken ||
				!record.email ||
				!Array.isArray(record.scopes) ||
				!record.connectedAt
			)
				throw new Error();
			return record as GoogleWorkspaceOAuthRecord;
		} catch {
			throw new Error(
				"Stored Google Workspace authorization is invalid. Disconnect it and sign in again.",
			);
		}
	}
}

export const GOOGLE_WORKSPACE_OAUTH_ENVIRONMENT_KEY =
	"KESTREL_GOOGLE_WORKSPACE_OAUTH";
export const GOOGLE_WORKSPACE_OAUTH_SECRET_ID = GOOGLE_WORKSPACE_SECRET_ID;
