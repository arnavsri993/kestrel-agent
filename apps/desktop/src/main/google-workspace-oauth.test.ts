import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialBroker } from "./credential-broker";
import { GoogleWorkspaceOAuthManager } from "./google-workspace-oauth";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "workstrand-google-oauth-"));
	roots.push(root);
	const protection = {
		isEncryptionAvailable: () => true,
		encryptString: async (value: string) =>
			Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
		decryptString: async (value: Buffer) =>
			Buffer.from(
				value.toString().slice("sealed:".length),
				"base64",
			).toString(),
	};
	return { root, broker: new CredentialBroker(root, protection) };
}

describe("Google Workspace desktop OAuth", () => {
	it("uses loopback PKCE, verifies narrow grants, and stores only an encrypted refresh record", async () => {
		const { root, broker } = fixture();
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		let authorizationUrl = "";
		const fetcher: typeof fetch = async (input, init) => {
			const url = String(input);
			requests.push({ url, ...(init ? { init } : {}) });
			if (url === "https://oauth2.googleapis.com/token")
				return new Response(
					JSON.stringify({
						access_token: "access-token-value-that-is-long-enough",
						refresh_token: "refresh-token-value-that-is-long-enough",
						expires_in: 3600,
						token_type: "Bearer",
						scope:
							"openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events",
					}),
					{ status: 200 },
				);
			if (url === "https://openidconnect.googleapis.com/v1/userinfo")
				return new Response(JSON.stringify({ email: "person@example.test" }), {
					status: 200,
				});
			if (
				url.startsWith(
					"https://www.googleapis.com/calendar/v3/calendars/primary/events",
				)
			)
				return new Response(JSON.stringify({ items: [] }), { status: 200 });
			if (url === "https://oauth2.googleapis.com/revoke")
				return new Response("", { status: 200 });
			return fetch(input, init);
		};
		const manager = new GoogleWorkspaceOAuthManager({
			broker,
			fetcher,
			now: () => new Date("2026-07-23T07:00:00.000Z"),
			openExternal: async (url) => {
				authorizationUrl = url;
				const authorization = new URL(url);
				const callback = new URL(
					authorization.searchParams.get("redirect_uri")!,
				);
				callback.searchParams.set(
					"state",
					authorization.searchParams.get("state")!,
				);
				callback.searchParams.set("code", "one-time-code");
				await fetch(callback);
			},
		});
		const status = await manager.connect(
			"1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com",
		);
		expect(status).toMatchObject({
			connected: true,
			email: "person@example.test",
			connectedAt: "2026-07-23T07:00:00.000Z",
		});
		const authorization = new URL(authorizationUrl);
		expect(authorization.origin).toBe("https://accounts.google.com");
		expect(authorization.searchParams.get("code_challenge_method")).toBe(
			"S256",
		);
		expect(authorization.searchParams.get("access_type")).toBe("offline");
		expect(authorization.searchParams.get("redirect_uri")).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/oauth\/google\/callback$/,
		);
		const tokenBody = String(
			requests.find((request) => request.url.endsWith("/token"))?.init?.body,
		);
		expect(tokenBody).toContain("code_verifier=");
		expect(tokenBody).not.toContain("client_secret");
		const stored = await broker.getOpaqueSecret("google-workspace-oauth");
		expect(stored).toContain("refresh-token-value");
		expect(stored).not.toContain("access-token-value");
		expect(
			readFileSync(
				join(
					root,
					"secure",
					"credentials",
					"opaque-google-workspace-oauth.bin",
				),
				"utf8",
			),
		).not.toContain("refresh-token-value");
		expect(await manager.disconnect()).toEqual({
			connected: false,
			scopes: [],
			bundledClientAvailable: false,
		});
		expect(
			await broker.getOpaqueSecret("google-workspace-oauth"),
		).toBeUndefined();
	});

	it("rejects non-desktop client IDs and incomplete grants", async () => {
		const { broker } = fixture();
		const manager = new GoogleWorkspaceOAuthManager({
			broker,
			openExternal: async () => {},
		});
		await expect(manager.connect("not-a-desktop-client")).rejects.toThrow(
			"Desktop app",
		);
	});

	it("rejects malformed callback URLs without losing the OAuth listener", async () => {
		const { broker } = fixture();
		let malformedStatus = 0;
		const manager = new GoogleWorkspaceOAuthManager({
			broker,
			timeoutMs: 30_000,
			openExternal: async (url) => {
				const authorization = new URL(url);
				const redirect = new URL(
					authorization.searchParams.get("redirect_uri")!,
				);
				malformedStatus = await new Promise<number>((resolve, reject) => {
					const request = httpRequest(
						{
							hostname: redirect.hostname,
							port: Number(redirect.port),
							path: "/%ZZ",
							method: "GET",
						},
						(response) => {
							response.resume();
							response.once("end", () => resolve(response.statusCode ?? 0));
						},
					);
					request.once("error", reject);
					request.end();
				});
				redirect.searchParams.set(
					"state",
					authorization.searchParams.get("state")!,
				);
				redirect.searchParams.set("error", "access_denied");
				await fetch(redirect);
			},
		});

		await expect(
			manager.connect(
				"1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com",
			),
		).rejects.toThrow("was not completed");
		expect(malformedStatus).toBe(400);
	});

	it("rejects duplicate callback parameters, then accepts the exact loopback callback", async () => {
		const { broker } = fixture();
		let duplicateStatus = 0;
		let hostSpoofStatus = 0;
		let validStatus = 0;
		const manager = new GoogleWorkspaceOAuthManager({
			broker,
			fetcher: async (input, init) => {
				const url = String(input);
				if (url.endsWith("/token")) return new Response(JSON.stringify({ access_token: "access-token-value-that-is-long-enough", refresh_token: "refresh-token-value-that-is-long-enough", scope: "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events" }));
				if (url.endsWith("/userinfo")) return new Response(JSON.stringify({ email: "person@example.test" }));
				if (url.includes("/calendars/primary/events")) return new Response(JSON.stringify({ items: [] }));
				return fetch(input, init);
			},
			openExternal: async (raw) => {
				const authorization = new URL(raw);
				const callback = new URL(authorization.searchParams.get("redirect_uri")!);
				callback.searchParams.set("state", authorization.searchParams.get("state")!);
				callback.searchParams.set("state", "duplicate");
				callback.searchParams.set("code", "one-time-code");
				hostSpoofStatus = await new Promise<number>((resolve, reject) => {
					const req = httpRequest({ hostname: callback.hostname, port: Number(callback.port), path: `${callback.pathname}${callback.search}`, headers: { host: "attacker.invalid" } }, response => {
						response.resume(); response.once("end", () => resolve(response.statusCode ?? 0));
					});
					req.once("error", reject); req.end();
				});
				duplicateStatus = await fetch(callback).then(response => response.status);
				callback.searchParams.delete("state");
				callback.searchParams.set("state", authorization.searchParams.get("state")!);
				validStatus = await fetch(callback).then(response => response.status);
			},
		});
		await manager.connect("1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com");
		expect(duplicateStatus).toBe(400);
		expect(hostSpoofStatus).toBe(403);
		expect(validStatus).toBe(200);
	});

	it("bounds streamed token responses before parsing", async () => {
		const { broker } = fixture();
		const manager = new GoogleWorkspaceOAuthManager({
			broker,
			fetcher: async (input, init) => String(input).endsWith("/token")
				? new Response("x".repeat(64_001))
				: fetch(input, init),
			openExternal: async (raw) => {
				const authorization = new URL(raw);
				const callback = new URL(authorization.searchParams.get("redirect_uri")!);
				callback.searchParams.set("state", authorization.searchParams.get("state")!);
				callback.searchParams.set("code", "one-time-code");
				await fetch(callback);
			},
		});
		await expect(manager.connect("1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com"))
			.rejects.toThrow("size limit");
	});

	it("aborts token exchange on owner cancellation without persisting a secret", async () => {
		const { broker } = fixture();
		let authUrl = "";
		const controller = new AbortController();
		let tokenSignal: AbortSignal | null | undefined;
		const manager = new GoogleWorkspaceOAuthManager({
			broker,
			fetcher: async (input, init) => {
				if (String(input).endsWith("/token")) {
					tokenSignal = init?.signal;
					return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
				}
				throw new Error("Unexpected fetch.");
			},
			openExternal: async (raw) => {
				authUrl = raw;
				const authorization = new URL(raw);
				const callback = new URL(authorization.searchParams.get("redirect_uri")!);
				callback.searchParams.set("state", authorization.searchParams.get("state")!);
				callback.searchParams.set("code", "one-time-code");
				await fetch(callback);
			},
		});
		const connecting = manager.connect("1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com", controller.signal);
		await vi.waitFor(() => expect(authUrl).toContain("accounts.google.com"));
		await vi.waitFor(() => expect(tokenSignal).toBeInstanceOf(AbortSignal));
		controller.abort(new Error("Google sign-in was cancelled."));
		await expect(connecting).rejects.toThrow("Google sign-in was cancelled.");
		expect(await broker.getOpaqueSecret("google-workspace-oauth")).toBeUndefined();
	});

	it("uses a bundled Desktop client ID when configured", async () => {
		const bundledClientId =
			"9876543210-bundledclientidforpublicrelease123456.apps.googleusercontent.com";
		const previous = process.env.KESTREL_GOOGLE_OAUTH_CLIENT_ID;
		process.env.KESTREL_GOOGLE_OAUTH_CLIENT_ID = bundledClientId;
		try {
			const { broker } = fixture();
			let authorizationUrl = "";
			const manager = new GoogleWorkspaceOAuthManager({
				broker,
				openExternal: async (url) => {
					authorizationUrl = url;
					throw new Error("Google sign-in was cancelled.");
				},
			});
			expect(await manager.status()).toMatchObject({
				connected: false,
				bundledClientAvailable: true,
			});
			await expect(manager.connect(undefined)).rejects.toThrow(
				"Google sign-in was cancelled.",
			);
			expect(
				new URL(authorizationUrl).searchParams.get("client_id"),
			).toBe(bundledClientId);
		} finally {
			if (previous === undefined)
				delete process.env.KESTREL_GOOGLE_OAUTH_CLIENT_ID;
			else process.env.KESTREL_GOOGLE_OAUTH_CLIENT_ID = previous;
		}
	});
});
