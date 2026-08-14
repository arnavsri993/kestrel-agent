import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
	type AgentApp,
	agent,
	type ContentBlock,
	PROTOCOL_VERSION,
	type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AgentLoop, AgentLoopResult } from "./agent-loop";
import {
	bridgeMcpTools,
	McpClient,
	StdioMcpTransport,
	StreamableHttpMcpTransport,
} from "./extensions/mcp";
import { type ModelContentPart, textContent } from "./providers";
import type { AgentRuntime } from "./runtime";

export interface KestrelAcpOptions {
	runtime: AgentRuntime;
	loop: AgentLoop;
	model: string;
	providerIds: string[];
	providerModels?: Record<string, string>;
}

function modelParts(blocks: ContentBlock[]): ModelContentPart[] {
	const parts: ModelContentPart[] = [];
	for (const block of blocks) {
		if (block.type === "text") parts.push({ type: "text", text: block.text });
		else if (block.type === "image")
			parts.push({
				type: "image",
				data: block.data,
				mediaType: block.mimeType,
				source: "base64",
			});
		else if (block.type === "audio")
			parts.push({
				type: "audio",
				data: block.data,
				mediaType: block.mimeType,
				source: "base64",
			});
		else if (block.type === "resource_link")
			parts.push(...textContent(`[Resource link: ${block.name} ${block.uri}]`));
		else if (block.type === "resource")
			parts.push(...textContent(`[Embedded resource: ${block.resource.uri}]`));
	}
	return parts.length ? parts : textContent("[Empty ACP prompt]");
}

function acpToolKind(
	name: string,
):
	| "read"
	| "edit"
	| "delete"
	| "move"
	| "search"
	| "execute"
	| "fetch"
	| "other" {
	if (name.includes("delete")) return "delete";
	if (name.includes("move")) return "move";
	if (name.includes("search") || name.includes("list")) return "search";
	if (name.includes("read")) return "read";
	if (name.includes("write") || name.includes("patch")) return "edit";
	if (name.includes("run") || name.includes("exec")) return "execute";
	if (name.includes("fetch") || name.includes("browser")) return "fetch";
	return "other";
}

export function createKestrelAcpAgent(options: KestrelAcpOptions): AgentApp {
	const active = new Map<string, AbortController>();
	const editorClients = new Map<
		string,
		{
			request<Response = unknown, Params = unknown>(
				method: string,
				params?: Params,
			): Promise<Response>;
		}
	>();
	const mcpClients = new Map<
		string,
		Array<{ client: McpClient; tools: string[] }>
	>();
	let editorToolsRegistered = false;
	const editorPath = (sessionId: string, requested: string, write = false) => {
		const root = realpathSync(
			options.runtime.getSession(sessionId).workspaceRoot!,
		);
		if (!isAbsolute(requested))
			throw new Error("Editor-delegated paths must be absolute.");
		const candidate =
			write && !existsSync(requested)
				? resolve(requested)
				: realpathSync(requested);
		const parent =
			write && !existsSync(candidate)
				? realpathSync(dirname(candidate))
				: candidate;
		if (
			(candidate !== root && !candidate.startsWith(`${root}${sep}`)) ||
			(parent !== root && !parent.startsWith(`${root}${sep}`))
		)
			throw new Error("Editor-delegated path escapes the session workspace.");
		return candidate;
	};
	const installEditorTools = (sessionId: string) => {
		if (!editorToolsRegistered) {
			options.runtime.registerExternalTool({
				descriptor: {
					name: "editor.fs.read_text",
					title: "Read text through editor",
					description:
						"Read a workspace text file through the connected ACP editor client.",
					category: "workspace",
					riskLevel: "read_only",
					readOnly: true,
					requiresWorkspace: true,
					source: "connector",
					tags: ["editor", "acp", "filesystem"],
				},
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string" },
						line: { type: "integer" },
						limit: { type: "integer" },
					},
					required: ["path"],
				},
				execute: async ({ session }, input) => {
					const editor = editorClients.get(session.id);
					if (!editor)
						throw new Error("The ACP editor client is no longer connected.");
					const path = editorPath(session.id, String(input.path));
					const result = await editor.request<{ content: string }>(
						"fs/read_text_file",
						{
							sessionId: session.id,
							path,
							...(typeof input.line === "number" ? { line: input.line } : {}),
							...(typeof input.limit === "number"
								? { limit: input.limit }
								: {}),
						},
					);
					if (
						typeof result.content !== "string" ||
						result.content.length > 1_000_000
					)
						throw new Error(
							"ACP editor returned invalid or oversized file content.",
						);
					return { path, content: result.content };
				},
			});
			options.runtime.registerExternalTool({
				descriptor: {
					name: "editor.fs.write_text",
					title: "Write text through editor",
					description:
						"Write a workspace text file through the connected ACP editor client.",
					category: "workspace",
					riskLevel: "sensitive",
					readOnly: false,
					requiresWorkspace: true,
					source: "connector",
					tags: ["editor", "acp", "filesystem", "write"],
				},
				inputSchema: {
					type: "object",
					properties: { path: { type: "string" }, content: { type: "string" } },
					required: ["path", "content"],
				},
				execute: async ({ session }, input) => {
					const editor = editorClients.get(session.id);
					if (!editor)
						throw new Error("The ACP editor client is no longer connected.");
					const content = String(input.content);
					if (content.length > 1_000_000)
						throw new Error("Editor write exceeds 1 MB.");
					const path = editorPath(session.id, String(input.path), true);
					await editor.request("fs/write_text_file", {
						sessionId: session.id,
						path,
						content,
					});
					return { path, bytes: Buffer.byteLength(content), delegated: true };
				},
			});
			options.runtime.registerExternalTool({
				descriptor: {
					name: "editor.terminal.run",
					title: "Run in editor terminal",
					description:
						"Run an argv-only command in the ACP editor terminal and return bounded output.",
					category: "execution",
					riskLevel: "high_consequence",
					readOnly: false,
					requiresWorkspace: true,
					source: "connector",
					tags: ["editor", "acp", "terminal"],
				},
				inputSchema: {
					type: "object",
					properties: {
						command: { type: "string" },
						args: { type: "array", items: { type: "string" } },
						cwd: { type: "string" },
					},
					required: ["command"],
				},
				execute: async ({ session, signal }, input) => {
					const editor = editorClients.get(session.id);
					if (!editor)
						throw new Error("The ACP editor client is no longer connected.");
					const command = String(input.command);
					const args = Array.isArray(input.args) ? input.args.map(String) : [];
					if (
						!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(command) ||
						args.length > 200 ||
						args.some((arg) => arg.length > 10_000)
					)
						throw new Error("Editor terminal command is invalid.");
					const cwd = editorPath(
						session.id,
						typeof input.cwd === "string"
							? input.cwd
							: options.runtime.getSession(session.id).workspaceRoot!,
					);
					const created = await editor.request<{ terminalId: string }>(
						"terminal/create",
						{
							sessionId: session.id,
							command,
							args,
							cwd,
							outputByteLimit: 1_000_000,
						},
					);
					const abort = () => {
						void editor.request("terminal/kill", {
							sessionId: session.id,
							terminalId: created.terminalId,
						});
					};
					signal.addEventListener("abort", abort, { once: true });
					try {
						const exit = await editor.request<{
							exitCode?: number | null;
							signal?: string | null;
						}>("terminal/wait_for_exit", {
							sessionId: session.id,
							terminalId: created.terminalId,
						});
						const output = await editor.request<{
							output: string;
							truncated: boolean;
						}>("terminal/output", {
							sessionId: session.id,
							terminalId: created.terminalId,
						});
						return {
							...exit,
							output: output.output.slice(0, 1_000_000),
							truncated: output.truncated,
							delegated: true,
						};
					} finally {
						signal.removeEventListener("abort", abort);
						await editor
							.request("terminal/release", {
								sessionId: session.id,
								terminalId: created.terminalId,
							})
							.catch(() => undefined);
					}
				},
			});
			editorToolsRegistered = true;
		}
		for (const name of [
			"editor.fs.read_text",
			"editor.fs.write_text",
			"editor.terminal.run",
		])
			options.runtime.allowTool(sessionId, name);
	};
	return agent({ name: "Kestrel" })
		.onRequest("initialize", ({ params }) => ({
			protocolVersion:
				params.protocolVersion === PROTOCOL_VERSION
					? params.protocolVersion
					: PROTOCOL_VERSION,
			agentInfo: { name: "Kestrel", version: "0.1.0" },
			agentCapabilities: {
				promptCapabilities: { image: true, audio: true, embeddedContext: true },
				mcpCapabilities: { http: true, sse: false },
				sessionCapabilities: {
					list: {},
					resume: {},
					close: {},
					additionalDirectories: {},
				},
			},
		}))
		.onRequest("session/new", async ({ params, client }) => {
			const session = options.runtime.createSession({
				title: "ACP editor session",
				workspaceRoot: realpathSync(params.cwd),
			});
			editorClients.set(session.id, client);
			installEditorTools(session.id);
			const connected: Array<{ client: McpClient; tools: string[] }> = [];
			try {
				for (const [index, server] of params.mcpServers.entries()) {
					let transport;
					if ("type" in server && server.type === "http") {
						const unsupported = server.headers.filter(
							(header) => header.name.toLowerCase() !== "authorization",
						);
						if (unsupported.length)
							throw new Error(
								"ACP MCP HTTP handoff supports only the Authorization header.",
							);
						transport = new StreamableHttpMcpTransport(server.url, {
							...(server.headers.find(
								(header) => header.name.toLowerCase() === "authorization",
							)?.value
								? {
										authorization: server.headers.find(
											(header) => header.name.toLowerCase() === "authorization",
										)!.value,
									}
								: {}),
						});
					} else if (!("type" in server)) {
						const command = realpathSync(server.command);
						const environment = Object.fromEntries(
							server.env.map(({ name, value }) => [name, value]),
						);
						transport = new StdioMcpTransport({
							command,
							args: server.args,
							cwd: session.workspaceRoot!,
							environment,
						});
					} else
						throw new Error(
							`ACP MCP transport ${"type" in server ? server.type : "unknown"} is not supported by the stable bridge.`,
						);
					const mcp = new McpClient(transport);
					const tools = await bridgeMcpTools(
						mcp,
						options.runtime,
						session.id,
						`acp-${session.id}-${index}-${server.name}`,
					);
					connected.push({ client: mcp, tools });
				}
				mcpClients.set(session.id, connected);
			} catch (error) {
				await Promise.all(
					connected.map(({ client }) => client.close().catch(() => undefined)),
				);
				editorClients.delete(session.id);
				options.runtime.cancelSession(session.id);
				throw error;
			}
			return { sessionId: session.id };
		})
		.onRequest("session/list", ({ params }) => ({
			sessions: options.runtime
				.listSessions()
				.filter(
					(session) =>
						session.workspaceRoot &&
						(!params.cwd || session.workspaceRoot === realpathSync(params.cwd)),
				)
				.map((session) => ({
					sessionId: session.id,
					cwd: session.workspaceRoot!,
					title: session.title,
					updatedAt: session.updatedAt,
				})),
		}))
		.onRequest("session/resume", ({ params }) => {
			const session = options.runtime.getSession(params.sessionId);
			if (session.status !== "active")
				options.runtime.resumeSession(session.id);
			return {};
		})
		.onRequest("session/close", ({ params }) => {
			active.get(params.sessionId)?.abort(new Error("ACP session closed."));
			editorClients.delete(params.sessionId);
			for (const connection of mcpClients.get(params.sessionId) ?? []) {
				for (const tool of connection.tools)
					options.runtime.unregisterExternalTool(tool);
				void connection.client.close();
			}
			mcpClients.delete(params.sessionId);
			options.runtime.cancelSession(params.sessionId);
			return {};
		})
		.onRequest("session/prompt", async ({ params, client, signal }) => {
			const controller = new AbortController();
			active.set(params.sessionId, controller);
			const abort = () => controller.abort(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			try {
				let result: AgentLoopResult = await options.loop.run({
					sessionId: params.sessionId,
					model: options.model,
					providerIds: options.providerIds,
					...(options.providerModels
						? { providerModels: options.providerModels }
						: {}),
					userContent: modelParts(params.prompt),
					signal: controller.signal,
					onTextDelta: (delta) => {
						void client.notify("session/update", {
							sessionId: params.sessionId,
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: delta },
							},
						});
					},
				});
				while (
					result.run.status === "waiting_approval" &&
					result.pendingExecution
				) {
					const pending = result.pendingExecution;
					const toolCallId = result.run.pendingProviderToolCallId ?? pending.id;
					const toolCall = {
						toolCallId,
						title: `Allow ${pending.toolName}`,
						name: pending.toolName,
						kind: acpToolKind(pending.toolName),
						status: "pending" as const,
						rawInput: pending.input,
					};
					await client.notify("session/update", {
						sessionId: params.sessionId,
						update: { sessionUpdate: "tool_call", ...toolCall },
					});
					const permission = await client.request<RequestPermissionResponse>(
						"session/request_permission",
						{
							sessionId: params.sessionId,
							toolCall,
							options: [
								{
									optionId: "allow-once",
									name: "Allow once",
									kind: "allow_once",
								},
								{
									optionId: "reject-once",
									name: "Reject",
									kind: "reject_once",
								},
							],
							_meta: {
								kestrel: { runId: result.run.id, riskLevel: pending.riskLevel },
							},
						},
					);
					if (permission.outcome.outcome === "cancelled")
						return {
							stopReason: "cancelled",
							_meta: {
								kestrel: { status: "waiting_approval", runId: result.run.id },
							},
						};
					const approved = permission.outcome.optionId === "allow-once";
					await client.notify("session/update", {
						sessionId: params.sessionId,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId,
							status: approved ? "in_progress" : "failed",
							rawOutput: approved ? undefined : { error: "Rejected by user" },
						},
					});
					result = await options.loop.resume({
						runId: result.run.id,
						approvalDecision: approved ? "approved" : "rejected",
						signal: controller.signal,
						onTextDelta: (delta) => {
							void client.notify("session/update", {
								sessionId: params.sessionId,
								update: {
									sessionUpdate: "agent_message_chunk",
									content: { type: "text", text: delta },
								},
							});
						},
					});
					if (approved)
						await client.notify("session/update", {
							sessionId: params.sessionId,
							update: {
								sessionUpdate: "tool_call_update",
								toolCallId,
								status: "completed",
							},
						});
				}
				if (result.run.status === "cancelled")
					return { stopReason: "cancelled" };
				if (result.run.status === "failed") return { stopReason: "refusal" };
				return {
					stopReason: "end_turn",
					_meta: { kestrel: { runId: result.run.id } },
				};
			} finally {
				signal.removeEventListener("abort", abort);
				active.delete(params.sessionId);
			}
		})
		.onNotification("session/cancel", ({ params }) => {
			active
				.get(params.sessionId)
				?.abort(new Error("Cancelled by ACP client."));
		});
}
