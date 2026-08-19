import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { type JsonRpcMessage, McpRuntimeServer } from "./extensions/mcp";
import type { AgentRuntime } from "./runtime";

export interface LocalBrowserMcpServerOptions {
	runtime: AgentRuntime;
	sessionId: string;
	toolFilter?: (name: string) => boolean;
	resolveCallSession?: () => BrowserMcpCallSession;
}

export type BrowserMcpCallSession =
	| { ok: true; sessionId: string }
	| { ok: false; reason: "none" | "ambiguous" };

export function resolveUniqueMappedSession(
	activeThreadIds: Iterable<string>,
	threadToSession: ReadonlyMap<string, string>,
): BrowserMcpCallSession {
	const sessionIds = new Set<string>();
	for (const threadId of activeThreadIds) {
		const sessionId = threadToSession.get(threadId);
		if (sessionId) sessionIds.add(sessionId);
	}
	if (sessionIds.size === 0) return { ok: false, reason: "none" };
	if (sessionIds.size > 1) return { ok: false, reason: "ambiguous" };
	return { ok: true, sessionId: [...sessionIds][0]! };
}

interface McpHttpSession {
	server: McpRuntimeServer;
	listedNames: Map<string, string>;
}

const MAX_JSON_BODY_BYTES = 1_000_000;

function isMcpPath(pathname: string): boolean {
	return pathname === "/mcp" || pathname === "/mcp/";
}

function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
	);
}

function hostnameFromAuthority(value: string): string | undefined {
	const candidate = value.trim();
	if (!candidate || candidate.length > 255) return undefined;
	const colonCount = [...candidate].filter(
		(character) => character === ":",
	).length;
	const authority =
		colonCount > 1 && !candidate.startsWith("[")
			? `[${candidate}]`
			: candidate;
	try {
		return new URL(`http://${authority}`).hostname
			.replace(/^\[|\]$/g, "")
			.replace(/\.$/, "");
	} catch {
		return undefined;
	}
}

function isAllowedLoopbackHost(hostHeader: string | undefined): boolean {
	if (!hostHeader) return false;
	const hostname = hostnameFromAuthority(hostHeader);
	return hostname !== undefined && isLoopbackHostname(hostname);
}

function originTargetsNonLoopbackHost(origin: string): boolean {
	try {
		const parsed = new URL(origin);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			return true;
		return !isLoopbackHostname(parsed.hostname.replace(/^\[|\]$/g, ""));
	} catch {
		return true;
	}
}

function headerValue(
	value: string | string[] | undefined,
): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}

function bearerMatches(
	authorization: string | undefined,
	token: string,
): boolean {
	if (!authorization || !authorization.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(authorization.slice("Bearer ".length), "utf8");
	const expected = Buffer.from(token, "utf8");
	if (supplied.byteLength !== expected.byteLength) return false;
	return timingSafeEqual(supplied, expected);
}

function listedToolName(originalName: string): string {
	return originalName.replaceAll(".", "_");
}

async function readJson(
	request: IncomingMessage,
): Promise<Record<string, unknown>> {
	if (
		!(request.headers["content-type"] ?? "")
			.toString()
			.toLowerCase()
			.startsWith("application/json")
	)
		throw new Error("Request content type must be application/json.");
	const declared = Number(request.headers["content-length"] ?? 0);
	if (declared > MAX_JSON_BODY_BYTES)
		throw new Error("Request body exceeds 1 MB.");
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > MAX_JSON_BODY_BYTES)
			throw new Error("Request body exceeds 1 MB.");
		chunks.push(buffer);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("JSON request body is invalid.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("JSON request body must be an object.");
	return parsed as Record<string, unknown>;
}

function writeJson(
	response: ServerResponse,
	status: number,
	payload: unknown,
	sessionId?: string,
): void {
	const body = Buffer.from(JSON.stringify(payload));
	response.writeHead(status, {
		"content-type": "application/json",
		"content-length": body.byteLength,
		"cache-control": "no-store",
		...(sessionId ? { "mcp-session-id": sessionId } : {}),
	});
	response.end(body);
}

function writeEmpty(
	response: ServerResponse,
	status: number,
	sessionId?: string,
): void {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-length": 0,
		...(sessionId ? { "mcp-session-id": sessionId } : {}),
	});
	response.end();
}

export class LocalBrowserMcpServer {
	private readonly runtime: AgentRuntime;
	private readonly sessionId: string;
	private readonly toolFilter: (name: string) => boolean;
	private readonly resolveCallSession:
		| (() => BrowserMcpCallSession)
		| undefined;
	private readonly sessions = new Map<string, McpHttpSession>();
	private server: Server | undefined;
	private token: string | undefined;

	constructor(options: LocalBrowserMcpServerOptions) {
		this.runtime = options.runtime;
		this.sessionId = options.sessionId;
		this.toolFilter =
			options.toolFilter ?? ((name) => name.startsWith("browser."));
		this.resolveCallSession = options.resolveCallSession;
	}

	async start(): Promise<{ url: string; token: string; port: number }> {
		if (this.server)
			throw new Error("Local MCP HTTP server is already running.");
		const token = randomBytes(32).toString("hex");
		this.token = token;
		const server = createServer((request, response) => {
			void this.handle(request, response);
		});
		server.requestTimeout = 180_000;
		server.headersTimeout = 10_000;
		server.keepAliveTimeout = 5_000;
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					resolve();
				});
			});
		} catch (error) {
			await this.stop();
			throw error;
		}
		const address = server.address();
		if (
			!address ||
			typeof address === "string" ||
			address.address !== "127.0.0.1"
		) {
			await this.stop();
			throw new Error("Local MCP HTTP server must bind to 127.0.0.1.");
		}
		const port = address.port;
		return {
			url: `http://127.0.0.1:${port}/mcp`,
			token,
			port,
		};
	}

	async stop(): Promise<void> {
		this.sessions.clear();
		this.token = undefined;
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			if (typeof server.closeAllConnections === "function")
				server.closeAllConnections();
		});
	}

	private createSession(): { id: string; session: McpHttpSession } {
		const id = randomUUID();
		const session: McpHttpSession = {
			server: new McpRuntimeServer(this.runtime, this.sessionId, {
				toolFilter: this.toolFilter,
				serverName: "kestrel-browser",
				serverTitle: "Kestrel Browser",
			}),
			listedNames: new Map(),
		};
		this.sessions.set(id, session);
		return { id, session };
	}

	private resolveOriginalToolName(
		session: McpHttpSession,
		listedName: string,
		kestrelSessionId: string,
	): string {
		const mapped = session.listedNames.get(listedName);
		if (mapped) return mapped;
		const available = this.runtime
			.modelTools(kestrelSessionId)
			.filter(
				(tool) => !this.toolFilter || this.toolFilter(tool.descriptor.name),
			);
		let resolved = listedName;
		if (available.some((tool) => tool.descriptor.name === listedName))
			resolved = listedName;
		else {
			let candidate = listedName;
			while (candidate.startsWith("browser")) {
				const index = candidate.indexOf("_", "browser".length);
				if (index < 0) break;
				candidate = `${candidate.slice(0, index)}.${candidate.slice(index + 1)}`;
				if (available.some((tool) => tool.descriptor.name === candidate)) {
					resolved = candidate;
					break;
				}
			}
		}
		return resolved;
	}

	private rewriteListedTools(
		session: McpHttpSession,
		message: JsonRpcMessage,
	): void {
		if (
			!("result" in message) ||
			!message.result ||
			typeof message.result !== "object"
		)
			return;
		const result = message.result as { tools?: unknown };
		if (!Array.isArray(result.tools)) return;
		session.listedNames.clear();
		result.tools = result.tools.map((raw) => {
			if (!raw || typeof raw !== "object") return raw;
			const tool = raw as { name?: unknown };
			if (typeof tool.name !== "string") return raw;
			const listed = listedToolName(tool.name);
			session.listedNames.set(listed, tool.name);
			return { ...tool, name: listed };
		});
	}

	private async handle(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		try {
			if (!isAllowedLoopbackHost(request.headers.host)) {
				writeJson(response, 400, { error: "Host is not allowed." });
				return;
			}
			const origin = headerValue(request.headers.origin);
			if (origin && originTargetsNonLoopbackHost(origin)) {
				writeJson(response, 403, { error: "Origin is not allowed." });
				return;
			}
			const token = this.token;
			if (!token || !bearerMatches(request.headers.authorization, token)) {
				writeJson(response, 401, { error: "Unauthorized" });
				return;
			}
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (!isMcpPath(url.pathname)) {
				writeJson(response, 404, { error: "Not found." });
				return;
			}
			if (request.method === "DELETE") {
				const sessionId = headerValue(request.headers["mcp-session-id"]);
				if (!sessionId || !this.sessions.has(sessionId)) {
					writeJson(response, 400, { error: "Unknown MCP session." });
					return;
				}
				this.sessions.delete(sessionId);
				writeEmpty(response, 204, sessionId);
				return;
			}
			if (request.method !== "POST") {
				writeJson(response, 405, { error: "Method not allowed." });
				return;
			}
			const body = await readJson(request);
			if (body.jsonrpc !== "2.0" || typeof body.method !== "string")
				throw new Error("MCP JSON-RPC message is invalid.");
			const requestedSessionId = headerValue(request.headers["mcp-session-id"]);
			let sessionId = requestedSessionId;
			let session = sessionId ? this.sessions.get(sessionId) : undefined;
			if (sessionId && !session) {
				writeJson(response, 400, { error: "Unknown MCP session." });
				return;
			}
			if (body.method === "ping" && "id" in body) {
				writeJson(
					response,
					200,
					{ jsonrpc: "2.0", id: body.id, result: {} },
					sessionId,
				);
				return;
			}
			if (!session) {
				if (body.method !== "initialize") {
					writeJson(response, 400, { error: "Unknown MCP session." });
					return;
				}
				const created = this.createSession();
				sessionId = created.id;
				session = created.session;
			}
			let callSession: BrowserMcpCallSession = {
				ok: true,
				sessionId: this.sessionId,
			};
			if (this.resolveCallSession && body.method === "tools/call") {
				callSession = this.resolveCallSession();
				if (!callSession.ok) {
					writeJson(
						response,
						200,
						{
							jsonrpc: "2.0",
							id: body.id,
							error: {
								code: -32000,
								message:
									callSession.reason === "ambiguous"
										? "Browser MCP tools/call is ambiguous across concurrent Codex turns."
										: "Browser MCP tools/call requires an active Codex turn.",
							},
						},
						sessionId,
					);
					return;
				}
			}
			if (
				body.method === "tools/call" &&
				body.params &&
				typeof body.params === "object" &&
				!Array.isArray(body.params)
			) {
				const params = body.params as Record<string, unknown>;
				if (typeof params.name === "string")
					params.name = this.resolveOriginalToolName(
						session,
						params.name,
						callSession.ok ? callSession.sessionId : this.sessionId,
					);
			}
			const result = await session.server.handle(body as JsonRpcMessage, {
				allowMutatingTools: false,
				sessionId:
					body.method === "tools/call" && callSession.ok
						? callSession.sessionId
						: this.sessionId,
			});
			if (!result) {
				writeEmpty(response, 202, sessionId);
				return;
			}
			if (body.method === "tools/list") this.rewriteListedTools(session, result);
			writeJson(response, 200, result, sessionId);
		} catch (error) {
			if (response.headersSent) {
				response.end();
				return;
			}
			const message =
				error instanceof Error ? error.message : "MCP HTTP request failed.";
			const status = /exceeds|invalid|must|content type/i.test(message)
				? 400
				: 500;
			writeJson(response, status, {
				error: status === 500 ? "MCP HTTP request failed." : message,
			});
		}
	}
}
