import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { BrowserActivityEventSchema } from "@kestrel/shared-types";
import {
	type BrowserAutomationBackend,
	BrowserController,
	installBrowserTools,
	type ScreenshotFrame,
} from "./browser-automation";
import { summarizeBrowserActivity } from "./browser-activity";
import { AgentRuntime } from "./runtime";

class FakeBrowser implements BrowserAutomationBackend {
	async createSession(): Promise<string> {
		return "backend-1";
	}
	async navigate(): Promise<void> {}
	async act(): Promise<void> {}
	async snapshot() {
		return {
			url: "https://example.test/",
			title: "Example",
			accessibilityTree: { role: "document" },
		};
	}
	async screenshot(): Promise<ScreenshotFrame> {
		return { width: 1, height: 1, rgba: Uint8Array.from([0, 0, 0, 255]) };
	}
	async visibleAct(): Promise<void> {}
	async visibleSnapshot() {
		return {
			url: "https://example.test/",
			title: "Visible",
			accessibilityTree: { role: "document" },
			trust: "untrusted_browser" as const,
		};
	}
	async close(): Promise<void> {}
}

describe("browser activity summarizer", () => {
	it("rejects forbidden payload fields and truncates oversized titles", () => {
		expect(
			BrowserActivityEventSchema.safeParse({
				id: "browser-activity-00000000-0000-4000-8000-000000000001",
				ownerSessionId: "session-1",
				surface: "autonomous",
				toolName: "browser.act",
				target: { kind: "session", browserSessionId: "browser-1" },
				intent: { type: "click", target: "#save", text: "secret" },
				approval: { required: true, result: "approved" },
				outcome: "performed",
				createdAt: "2026-08-19T18:00:00.000Z",
				completedAt: "2026-08-19T18:00:01.000Z",
				trust: "untrusted_browser",
			}).success,
		).toBe(false);
		expect(
			BrowserActivityEventSchema.safeParse({
				id: "browser-activity-00000000-0000-4000-8000-000000000001",
				ownerSessionId: "session-1",
				surface: "autonomous",
				toolName: "browser.act",
				target: { kind: "session", browserSessionId: "browser-1" },
				intent: { type: "click", target: "#save" },
				approval: { required: true, result: "approved" },
				cookies: [],
				outcome: "performed",
				createdAt: "2026-08-19T18:00:00.000Z",
				completedAt: "2026-08-19T18:00:01.000Z",
				trust: "untrusted_browser",
			}).success,
		).toBe(false);
		const summarized = summarizeBrowserActivity({
			id: "tool-00000000-0000-4000-8000-000000000009",
			sessionId: "session-1",
			toolName: "browser.act",
			status: "verified",
			riskLevel: "sensitive",
			input: {
				browserSessionId: "browser-1",
				action: { type: "type", target: "#q", text: "typed-secret" },
			},
			output: {
				performed: true,
				observation: {
					before: {
						url: "https://example.test/?token=hidden",
						title: "a".repeat(800),
					},
					after: { url: "https://example.test/", title: "After" },
					added: [],
					removed: [],
					changed: [{ key: "node:1" }],
					truncated: true,
					trust: "untrusted_browser",
				},
			},
			startedAt: "2026-08-19T18:00:00.000Z",
			completedAt: "2026-08-19T18:00:01.000Z",
		});
		expect(summarized?.intent).toEqual({
			type: "type",
			target: "#q",
			textChars: 12,
		});
		expect(JSON.stringify(summarized)).not.toContain("typed-secret");
		expect(summarized?.observation?.before.title).toHaveLength(500);
		expect(summarized?.observation?.truncated).toBe(true);
		expect(summarized?.observation?.before.url).not.toContain("token=");
	});

	it("records autonomous performed acts and blocked visible acts", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const backend = new FakeBrowser();
		const controller = new BrowserController(backend);
		const runtime = new AgentRuntime(database);
		const session = runtime.createSession({ title: "Ledger" });
		installBrowserTools(runtime, controller, session.id);
		const created = await runtime.callTool(
			session.id,
			"browser.create",
			{ allowedOrigins: ["https://example.test"] },
			{ approvalStatus: "approved", idempotencyKey: "create" },
		);
		const browserSessionId = String(created.output?.browserSessionId);
		await runtime.callTool(
			session.id,
			"browser.act",
			{
				browserSessionId,
				action: { type: "click", target: "#save" },
			},
			{ approvalStatus: "approved", idempotencyKey: "act" },
		);
		const visible = await runtime.callTool(
			session.id,
			"browser.visible-act",
			{
				tabId: "tab-00000000-0000-4000-8000-000000000000",
				action: { type: "click", target: "#buy" },
			},
			{ idempotencyKey: "visible" },
		);
		expect(visible.status).toBe("blocked");
		const rows = database.listBrowserActivity({ ownerSessionId: session.id });
		expect(rows.map((row) => row.outcome)).toEqual(["performed", "blocked"]);
		expect(rows[0]).toMatchObject({
			surface: "autonomous",
			approval: { result: "approved" },
			observation: { trust: "untrusted_browser" },
		});
		expect(rows[1]).toMatchObject({
			surface: "visible",
			approval: { result: "pending" },
		});
		expect(rows[1]?.observation).toBeUndefined();
		expect(JSON.stringify(rows)).not.toMatch(/typed-secret|accessibilityTree/);
		database.close();
	});
});
