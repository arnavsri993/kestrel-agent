import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BrowserAction,
	type BrowserAutomationBackend,
	BrowserController,
	installBrowserTools,
	type ScreenshotFrame,
} from "./browser-automation";
import {
	MCP_PROTOCOL_VERSION,
	McpClient,
	StreamableHttpMcpTransport,
} from "./extensions/mcp";
import { LocalBrowserMcpServer } from "./local-mcp-http";
import { AgentRuntime } from "./runtime";

const directories: string[] = [];
const databases: KestrelDatabase[] = [];
const servers: LocalBrowserMcpServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop();
	for (const database of databases.splice(0)) database.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

class FakeBrowser implements BrowserAutomationBackend {
	visibleTabsCalls = 0;
	async createSession(): Promise<string> {
		return "backend-1";
	}
	async navigate(): Promise<void> {}
	async act(_id: string, _action: BrowserAction): Promise<void> {}
	async snapshot(): Promise<{
		url: string;
		title: string;
		accessibilityTree: unknown;
	}> {
		return {
			url: "https://example.test/",
			title: "Example",
			accessibilityTree: { role: "document" },
		};
	}
	async screenshot(): Promise<ScreenshotFrame> {
		return { width: 1, height: 1, rgba: Uint8Array.from([0, 0, 0, 255]) };
	}
	async close(): Promise<void> {}
	async visibleTabs() {
		this.visibleTabsCalls += 1;
		return [
			{
				id: "tab-00000000-0000-4000-8000-000000000000",
				title: "Visible",
				url: "https://example.test/",
				active: true,
				loading: false,
				discarded: false,
				trust: "untrusted_browser" as const,
			},
		];
	}
}

async function startFixture() {
	const root = mkdtempSync(join(tmpdir(), "kestrel-local-mcp-"));
	directories.push(root);
	writeFileSync(join(root, "README.md"), "# local-mcp\n");
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	databases.push(database);
	const runtime = new AgentRuntime(database, [root]);
	const session = runtime.createSession({
		title: "Local MCP",
		workspaceRoot: root,
	});
	const backend = new FakeBrowser();
	installBrowserTools(runtime, new BrowserController(backend), session.id);
	const server = new LocalBrowserMcpServer({
		runtime,
		sessionId: session.id,
	});
	const started = await server.start();
	servers.push(server);
	return { ...started, server, backend, runtime, session, database };
}

function postWithHost(
	url: string,
	host: string,
	token: string,
	origin?: string,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
		const request = httpRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname,
				method: "POST",
				headers: {
					host,
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body),
					...(origin ? { origin } : {}),
				},
			},
			(response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			},
		);
		request.once("error", reject);
		request.end(body);
	});
}

describe("LocalBrowserMcpServer", () => {
	it("starts on loopback and exposes an /mcp URL", async () => {
		const started = await startFixture();
		expect(started.url).toBe(`http://127.0.0.1:${started.port}/mcp`);
		expect(started.url.endsWith("/mcp")).toBe(true);
	});

	it("rejects a missing bearer token with 401", async () => {
		const started = await startFixture();
		const response = await fetch(started.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			}),
		});
		expect(response.status).toBe(401);
	});

	it("lists only underscore-form browser tools over Streamable HTTP", async () => {
		const started = await startFixture();
		const transport = new StreamableHttpMcpTransport(started.url, {
			authorization: `Bearer ${started.token}`,
		});
		const client = new McpClient(transport);
		const initialized = await client.initialize();
		expect(initialized.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
		expect(initialized).toMatchObject({
			serverInfo: { name: "kestrel-browser", title: "Kestrel Browser" },
		});
		const tools = await client.listTools();
		const names = tools.map((tool) => tool.name);
		expect(names.length).toBeGreaterThan(0);
		expect(names.every((name) => name.startsWith("browser_"))).toBe(true);
		expect(names.some((name) => name.includes("."))).toBe(false);
		expect(names).toContain("browser_tabs");
		expect(names).not.toContain("browser_visible-act");
		expect(names).not.toContain("browser_act");
		expect(names).not.toContain("browser_navigate");
		expect(names).not.toContain("workspace.write");
		expect(names).not.toContain("workspace_write");
		expect(names).not.toContain("computer.act");
		expect(names).not.toContain("computer_act");
		await client.close();
	});

	it("does not include non-browser tools in tools/list", async () => {
		const started = await startFixture();
		const transport = new StreamableHttpMcpTransport(started.url, {
			authorization: `Bearer ${started.token}`,
		});
		const client = new McpClient(transport);
		await client.initialize();
		const names = (await client.listTools()).map((tool) => tool.name);
		expect(names.some((name) => name.startsWith("workspace"))).toBe(false);
		expect(names.some((name) => name.startsWith("computer"))).toBe(false);
		expect(names.some((name) => name.startsWith("tools"))).toBe(false);
		await client.close();
	});

	it("invokes browser_tabs through runtime.callTool", async () => {
		const started = await startFixture();
		const transport = new StreamableHttpMcpTransport(started.url, {
			authorization: `Bearer ${started.token}`,
		});
		const client = new McpClient(transport);
		await client.initialize();
		const result = await client.callTool("browser_tabs", {});
		expect(result).toMatchObject({
			content: expect.any(Array),
		});
		if (!result.isError)
			expect(started.backend.visibleTabsCalls).toBeGreaterThan(0);
		await client.close();
	});

	it("rejects workspace and execution tools on tools/call", async () => {
		const started = await startFixture();
		const transport = new StreamableHttpMcpTransport(started.url, {
			authorization: `Bearer ${started.token}`,
		});
		const client = new McpClient(transport);
		await client.initialize();
		for (const name of [
			"workspace.write",
			"workspace_write",
			"execution.run",
			"computer.act",
		]) {
			await expect(client.callTool(name, {})).rejects.toThrow(
				/not exposed by this MCP server/i,
			);
		}
		await client.close();
	});

	it("does not execute mutating browser tools over the loopback MCP", async () => {
		const started = await startFixture();
		const transport = new StreamableHttpMcpTransport(started.url, {
			authorization: `Bearer ${started.token}`,
		});
		const client = new McpClient(transport);
		await client.initialize();
		await expect(
			client.callTool("browser_visible-act", {
				tabId: "tab-00000000-0000-4000-8000-000000000000",
				action: { type: "click", target: "#save" },
			}),
		).rejects.toThrow(/mutating MCP tools require task authorization/i);
		await client.close();
	});

	it("stops accepting connections after stop()", async () => {
		const started = await startFixture();
		await started.server.stop();
		await expect(
			fetch(started.url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${started.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			}),
		).rejects.toThrow();
	});

	it("rejects a non-loopback Origin header", async () => {
		const started = await startFixture();
		const status = await postWithHost(
			started.url,
			"127.0.0.1",
			started.token,
			"https://evil.example",
		);
		expect(status).toBe(403);
	});

	it("rejects an unparseable Origin header", async () => {
		const started = await startFixture();
		const status = await postWithHost(
			started.url,
			"127.0.0.1",
			started.token,
			"not a url",
		);
		expect(status).toBe(403);
	});
});
