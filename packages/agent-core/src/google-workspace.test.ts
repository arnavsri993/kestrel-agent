import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import {
	environmentGoogleWorkspaceClient,
	installGoogleWorkspaceTools,
} from "./google-workspace";
import { AgentRuntime } from "./runtime";

const authorization = JSON.stringify({
	version: 1,
	clientId:
		"1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com",
	refreshToken: "refresh-token-value-that-is-long-enough",
	email: "person@example.test",
	scopes: [
		"openid",
		"email",
		"https://www.googleapis.com/auth/gmail.send",
		"https://www.googleapis.com/auth/gmail.readonly",
		"https://www.googleapis.com/auth/calendar.events",
	],
	connectedAt: "2026-07-23T07:00:00.000Z",
});

describe("Google Workspace runtime connector", () => {
	it("refreshes in memory, sends Gmail, and read-back verifies idempotent Calendar events", async () => {
		const requests: Array<{
			url: string;
			authorization: string;
			method: string;
			body?: string;
		}> = [];
		let event: Record<string, unknown> | undefined;
		const fetcher: typeof fetch = async (input, init) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			requests.push({
				url,
				authorization: headers.get("authorization") ?? "",
				method: init?.method ?? "GET",
				...(init?.body ? { body: String(init.body) } : {}),
			});
			if (url === "https://oauth2.googleapis.com/token")
				return new Response(
					JSON.stringify({
						access_token: "runtime-access-token-that-is-long-enough",
						expires_in: 3600,
						token_type: "Bearer",
					}),
					{ status: 200 },
				);
			if (url.includes("gmail.googleapis.com")) {
				if (url.includes("format=full"))
					return new Response(
						JSON.stringify({
							internalDate: "1784790000000",
							snippet: "Your verification code is 481902.",
							payload: {
								headers: [
									{ name: "Subject", value: "Sign in" },
									{ name: "From", value: "security@example.test" },
								],
							},
						}),
						{ status: 200 },
					);
				if (url.includes("/messages?") || url.endsWith("/messages"))
					return new Response(JSON.stringify({ messages: [{ id: "message-1" }] }), {
						status: 200,
					});
				return new Response(JSON.stringify({ id: "gmail-message-1" }), {
					status: 200,
				});
			}
			if (url.includes("/calendar/v3/calendars/primary/events/")) {
				if (!event)
					return new Response(JSON.stringify({ error: { code: 404 } }), {
						status: 404,
					});
				return new Response(JSON.stringify(event), { status: 200 });
			}
			if (
				url.includes("/calendar/v3/calendars/primary/events") &&
				init?.method === "POST"
			) {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>;
				event = {
					...body,
					status: "confirmed",
					htmlLink: "https://calendar.google.test/event",
				};
				return new Response(JSON.stringify(event), { status: 200 });
			}
			if (url.includes("/calendar/v3/calendars/primary/events"))
				return new Response(
					JSON.stringify({
						items: [
							{
								id: "existing-1",
								summary: "Existing",
								start: { dateTime: "2026-07-24T14:00:00.000Z" },
								end: { dateTime: "2026-07-24T15:00:00.000Z" },
								status: "confirmed",
							},
						],
					}),
					{ status: 200 },
				);
			return new Response(JSON.stringify({ error: "unexpected" }), {
				status: 500,
			});
		};
		const client = environmentGoogleWorkspaceClient(
			{ KESTREL_GOOGLE_WORKSPACE_OAUTH: authorization },
			fetcher,
			() => new Date("2026-07-23T07:30:00.000Z"),
		);
		expect(client?.email).toBe("person@example.test");
		const gmail = await client!.gmailAdapter.send({
			conversationId: "teacher@example.test",
			text: "Hello",
			idempotencyKey: "gmail-operation-1",
			signal: new AbortController().signal,
		});
		expect(gmail.externalId).toBe("gmail-message-1");
		const codes = await client!.searchLoginCodes({
			after: "2026-07-23T07:00:00.000Z",
			domain: "example.test",
			maxResults: 5,
			signal: new AbortController().signal,
		});
		expect(codes).toMatchObject([
			{
				sourceId: "gmail",
				code: "481902",
				subject: "Sign in",
			},
		]);
		const gmailListRequest = requests.find((request) => {
			const url = new URL(request.url);
			return (
				url.hostname === "gmail.googleapis.com" &&
				url.pathname.endsWith("/messages") &&
				url.searchParams.has("q")
			);
		});
		expect(gmailListRequest).toBeDefined();
		const gmailQuery = new URL(gmailListRequest!.url).searchParams.get("q");
		expect(gmailQuery).toContain("from:example.test");
		expect(gmailQuery).toContain('"example.test"');

		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const runtime = new AgentRuntime(database);
		const session = runtime.createSession({ title: "Google Workspace" });
		installGoogleWorkspaceTools(runtime, client!, session.id);
		const listed = await runtime.callTool(
			session.id,
			"google.calendar.list-events",
			{ timeMin: "2026-07-23T00:00:00.000Z", maxResults: 10 },
		);
		expect(listed.output).toMatchObject({
			calendar: "primary",
			items: [{ id: "existing-1", title: "Existing" }],
		});
		const malformedCount = await client!.listEvents({
			timeMin: "2026-07-23T00:00:00.000Z",
			maxResults: Number.NaN,
			signal: new AbortController().signal,
		});
		expect(malformedCount).toMatchObject({ items: [{ id: "existing-1" }] });
		expect(new URL(requests.at(-1)!.url).searchParams.get("maxResults")).toBe(
			"20",
		);
		const fractionalCount = await client!.listEvents({
			timeMin: "2026-07-23T00:00:00.000Z",
			maxResults: 1.9,
			signal: new AbortController().signal,
		});
		expect(fractionalCount).toMatchObject({ items: [{ id: "existing-1" }] });
		expect(new URL(requests.at(-1)!.url).searchParams.get("maxResults")).toBe(
			"1",
		);
		const createInput = {
			operationId: "calendar-operation-1",
			title: "Project review",
			startsAt: "2026-07-24T16:00:00.000Z",
			endsAt: "2026-07-24T17:00:00.000Z",
		};
		expect(
			(
				await runtime.callTool(
					session.id,
					"google.calendar.create-event",
					createInput,
					{ idempotencyKey: "calendar-operation-1" },
				)
			).status,
		).toBe("blocked");
		const created = await runtime.callTool(
			session.id,
			"google.calendar.create-event",
			createInput,
			{ approvalStatus: "approved", idempotencyKey: "calendar-operation-1" },
		);
		expect(created).toMatchObject({
			status: "verified",
			output: { status: "confirmed", repeated: false, verified: true },
			verification: { method: "google-calendar-read-back" },
		});
		expect(
			(
				await runtime.callTool(
					session.id,
					"google.calendar.create-event",
					createInput,
					{
						approvalStatus: "approved",
						idempotencyKey: "calendar-operation-1",
					},
				)
			).id,
		).toBe(created.id);
		expect(
			requests.filter(
				(request) => request.url === "https://oauth2.googleapis.com/token",
			),
		).toHaveLength(1);
		expect(
			requests.filter(
				(request) =>
					request.method === "POST" &&
					request.url.includes("/calendar/v3/calendars/primary/events"),
			),
		).toHaveLength(1);
		expect(
			requests
				.filter((request) => request.authorization)
				.every(
					(request) =>
						request.authorization ===
						"Bearer runtime-access-token-that-is-long-enough",
				),
		).toBe(true);
		database.close();
	});

	it("rejects records without the exact narrow grants", () => {
		const missingScope = JSON.stringify({
			...JSON.parse(authorization),
			scopes: ["openid", "email"],
		});
		expect(() =>
			environmentGoogleWorkspaceClient({
				KESTREL_GOOGLE_WORKSPACE_OAUTH: missingScope,
			}),
		).toThrow("missing");
	});
});
