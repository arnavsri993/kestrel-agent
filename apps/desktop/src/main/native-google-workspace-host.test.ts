import { afterEach, describe, expect, it, vi } from "vitest";
import { GMAIL_READONLY_SCOPE } from "@kestrel/shared-types";
import { NativeGoogleWorkspaceHost } from "./native-google-workspace-host";

const CLIENT_ID = "1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com";
const scopes = `openid email https://www.googleapis.com/auth/gmail.send ${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/calendar.events`;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

function setup(overrides: Record<string, unknown> = {}) {
	const data = new Map<string, string>();
	const broker = {
		getOpaqueSecret: vi.fn(async (id: string) => data.get(id)),
		setOpaqueSecret: vi.fn(async (id: string, value: string) => { data.set(id, value); }),
		removeOpaqueSecret: vi.fn(async (id: string) => { data.delete(id); }),
	};
	const events: string[] = [];
	const reconfigure = vi.fn(async (mutation: () => Promise<unknown>, rollback?: () => Promise<void>, validate?: () => void) => {
		events.push("reconfigure-start");
		try {
			const value = await mutation();
			validate?.();
			events.push("reconfigure-commit");
			return value;
		} catch (error) {
			await rollback?.();
			events.push("reconfigure-rollback");
			throw error;
		}
	});
	const fetcher: typeof fetch = vi.fn(async (input, init) => {
		const url = String(input);
		events.push(url.endsWith("/revoke") ? "revoke" : "fetch");
		if (url.endsWith("/token")) return new Response(JSON.stringify({
			access_token: "access-token-value-that-is-long-enough",
			refresh_token: "refresh-token-value-that-is-long-enough",
			scope: scopes,
		}), { status: 200 });
		if (url.endsWith("/userinfo")) return new Response(JSON.stringify({ email: "person@example.test" }), { status: 200 });
		if (url.includes("/calendars/primary/events")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
		if (url.endsWith("/revoke")) return new Response("", { status: 200 });
		return new Response("{}", { status: 404 });
	});
	let authUrl = "";
	let authGate: Promise<void> | undefined;
	const openAuthUrl = vi.fn(async (url: string, signal: AbortSignal) => {
		authUrl = url;
		if (authGate) await Promise.race([authGate, new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
		const auth = new URL(url);
		const callback = new URL(auth.searchParams.get("redirect_uri")!);
		callback.searchParams.set("state", auth.searchParams.get("state")!);
		callback.searchParams.set("code", "one-time-code");
		await fetch(callback);
	});
	let busy = false;
	const host = new NativeGoogleWorkspaceHost({
		broker,
		openAuthUrl,
		reconfigure: reconfigure as never,
		isBusy: () => busy,
		fetcher,
		now: () => new Date("2026-10-12T12:00:00.000Z"),
		timeoutMs: 30_000,
		...overrides,
	} as never);
	return { host, broker, events, reconfigure, fetcher, openAuthUrl, get authUrl() { return authUrl; }, set authGate(value: Promise<void> | undefined) { authGate = value; }, set busy(value: boolean) { busy = value; }, data };
}

afterEach(() => vi.restoreAllMocks());

describe("native Google Workspace host", () => {
	it("exposes only safe account metadata and explicit native Messages unavailability", async () => {
		const f = setup();
		expect(await f.host.handle({ type: "invalid" })).toEqual({ ok: false, error: "Invalid native Google Workspace request." });
		const status = await f.host.handle({ type: "oauth-google-status" });
		expect(status).toEqual({ ok: true, googleWorkspaceOAuth: expect.objectContaining({ connected: false, scopes: [] }) });
		const sources = await f.host.handle({ type: "communication-sources" });
		expect(sources).toMatchObject({ ok: true, communicationSources: [
			{ id: "mac-messages", state: "unavailable" }, { id: "gmail", state: "not_connected" },
		] });
		expect(JSON.stringify([status, sources])).not.toMatch(/refresh-token|access-token|client_secret/);
	});

	it("waits for consent before reserving Core and commits only the opaque profile secret", async () => {
		const f = setup();
		const gate = deferred<void>();
		f.authGate = gate.promise;
		const connecting = f.host.handle({ type: "oauth-google-connect", clientId: CLIENT_ID });
		await vi.waitFor(() => expect(f.authUrl).toContain("accounts.google.com"));
		expect(f.reconfigure).not.toHaveBeenCalled();
		await expect(f.host.handle({ type: "oauth-google-connect", clientId: CLIENT_ID })).rejects.toThrow("already in progress");
		gate.resolve();
		const result = await connecting;
		expect(result).toMatchObject({ ok: true, googleWorkspaceOAuth: { connected: true, email: "person@example.test" } });
		expect(f.reconfigure).toHaveBeenCalledTimes(1);
		expect(f.data.get("google-workspace-oauth")).toContain("refresh-token-value");
		expect(JSON.stringify(result)).not.toContain("refresh-token-value");
	});

	it("cancels consent before commit and leaves the existing secret unchanged", async () => {
		const f = setup();
		f.data.set("google-workspace-oauth", JSON.stringify({ version: 1, clientId: CLIENT_ID, refreshToken: "existing-refresh-token-value", email: "prior@example.test", scopes: scopes.split(" "), connectedAt: "2026-10-01T00:00:00.000Z" }));
		const gate = deferred<void>();
		f.authGate = gate.promise;
		const connecting = f.host.handle({ type: "oauth-google-connect", clientId: CLIENT_ID });
		await vi.waitFor(() => expect(f.authUrl).toContain("accounts.google.com"));
		await f.host.handle({ type: "oauth-google-cancel" });
		await expect(connecting).rejects.toThrow();
		expect(f.reconfigure).not.toHaveBeenCalled();
		expect(f.data.get("google-workspace-oauth")).toContain("existing-refresh-token-value");
		gate.resolve();
	});

	it("rolls back a secret write when commit validation is cancelled", async () => {
		const commitReached = deferred<void>();
		const continueCommit = deferred<void>();
		const f = setup({ reconfigure: async (mutation: () => Promise<unknown>, rollback?: () => Promise<void>, validate?: () => void) => {
			try {
				await mutation();
				commitReached.resolve();
				await continueCommit.promise;
				validate?.();
			} catch (error) { await rollback?.(); throw error; }
		} });
		f.data.set("google-workspace-oauth", "prior-secret-record");
		const pending = f.host.handle({ type: "oauth-google-connect", clientId: CLIENT_ID });
		await commitReached.promise;
		const closing = f.host.close();
		continueCommit.resolve();
		await closing;
		await expect(pending).rejects.toThrow();
		expect(f.data.get("google-workspace-oauth")).toBe("prior-secret-record");
	});

	it("rejects busy disconnect before revocation and removes the profile secret before revoking", async () => {
		const f = setup();
		await f.host.handle({ type: "oauth-google-connect", clientId: CLIENT_ID });
		f.busy = true;
		await expect(f.host.handle({ type: "oauth-google-disconnect" })).rejects.toThrow("active task");
		expect(f.fetcher).not.toHaveBeenCalledWith(expect.stringContaining("/revoke"), expect.anything());
		expect(f.data.has("google-workspace-oauth")).toBe(true);
		f.busy = false;
		await f.host.handle({ type: "oauth-google-disconnect" });
		expect(f.events.indexOf("reconfigure-commit")).toBeLessThan(f.events.indexOf("revoke"));
		expect(f.data.has("google-workspace-oauth")).toBe(false);
	});

	it("aborts and awaits an outstanding sign-in on close without orphaning OAuth work", async () => {
		const f = setup();
		const gate = deferred<void>(); f.authGate = gate.promise;
		const connecting = f.host.handle({ type: "oauth-google-connect", clientId: CLIENT_ID });
		await vi.waitFor(() => expect(f.authUrl).toContain("accounts.google.com"));
		await f.host.close();
		await expect(connecting).rejects.toThrow();
		expect(f.reconfigure).not.toHaveBeenCalled();
		expect(f.data.has("google-workspace-oauth")).toBe(false);
		gate.resolve();
	});
	it("closes a stalled post-disconnect revocation while keeping the local profile disconnected", async () => {
		const f = setup();
		await f.host.handle({ type: "oauth-google-connect", clientId: CLIENT_ID });
		vi.mocked(f.fetcher).mockImplementation(async () => new Promise<Response>(() => {}));
		const disconnecting = f.host.handle({ type: "oauth-google-disconnect" });
		const rejected = expect(disconnecting).rejects.toThrow("disconnected locally");
		await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledWith(expect.stringContaining("/revoke"), expect.anything()));
		await f.host.close(); await rejected;
		expect(f.data.has("google-workspace-oauth")).toBe(false);
	});
	it("does not start a fresh revocation when shutdown occurs at the local disconnect commit boundary", async () => {
		let closing: Promise<void> | undefined;
		let disconnecting = false;
		const f = setup({ reconfigure: async (mutation: () => Promise<unknown>, _rollback?: () => Promise<void>, validate?: () => void) => {
			const result = await mutation(); validate?.();
			if (disconnecting) closing = f.host.close();
			return result;
		} });
		await f.host.handle({ type: "oauth-google-connect", clientId: CLIENT_ID });
		disconnecting = true;
		await expect(f.host.handle({ type: "oauth-google-disconnect" })).rejects.toThrow("disconnected locally");
		await closing;
		expect(f.data.has("google-workspace-oauth")).toBe(false);
		expect(f.fetcher).not.toHaveBeenCalledWith(expect.stringContaining("/revoke"), expect.anything());
	});

	it("rejects host requests after close and pre-aborted renderer requests", async () => {
		const f = setup();
		const cancelled = new AbortController(); cancelled.abort(new Error("request cancelled"));
		await expect(f.host.handle({ type: "oauth-google-status" }, cancelled.signal)).rejects.toThrow("cancelled");
		await f.host.close();
		await expect(f.host.handle({ type: "oauth-google-status" })).rejects.toThrow("shutting down");
	});

	it("does not persist when an OAuth endpoint ignores cancellation past its request deadline", async () => {
		const f = setup({
			requestTimeoutMs: 5,
			fetcher: async (input: RequestInfo | URL) => String(input).endsWith("/token")
				? await new Promise<Response>(() => {})
				: new Response("{}", { status: 404 }),
		});
		await expect(f.host.handle({ type: "oauth-google-connect", clientId: CLIENT_ID })).rejects.toThrow("timed out");
		expect(f.broker.setOpaqueSecret).not.toHaveBeenCalled();
	});

	it("cancels a response body that stalls past its request deadline", async () => {
		const f = setup({
			requestTimeoutMs: 5,
			fetcher: async (input: RequestInfo | URL) => String(input).endsWith("/token")
				? new Response(new ReadableStream<Uint8Array>({ start() {} }))
				: new Response("{}", { status: 404 }),
		});
		await expect(f.host.handle({ type: "oauth-google-connect", clientId: CLIENT_ID })).rejects.toThrow("timed out");
		expect(f.broker.setOpaqueSecret).not.toHaveBeenCalled();
	});

	it("reports remote revocation failure after the profile has been disconnected", async () => {
		const f = setup({ fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/revoke")) return new Response("", { status: 503 });
			return f.fetcher(input, init);
		} });
		await f.host.handle({ type: "oauth-google-connect", clientId: CLIENT_ID });
		await expect(f.host.handle({ type: "oauth-google-disconnect" })).rejects.toThrow("remote revocation could not be confirmed");
		expect(f.data.has("google-workspace-oauth")).toBe(false);
	});
});
