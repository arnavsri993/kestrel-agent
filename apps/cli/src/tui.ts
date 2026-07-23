import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import type { AgentLoopResult } from "@kestrel/agent-core";
import { textContent } from "@kestrel/agent-core";
import { openKestrel, resolveModelConfig } from "./state";

export interface TuiOptions {
  model?: string;
  providers?: string[];
  workspace?: string;
}

export async function runTui(options: TuiOptions): Promise<void> {
  const config = resolveModelConfig(options);
  const core = openKestrel(options.workspace ? [options.workspace] : []);
  let session = options.workspace
    ? core.runtime.createSession({ title: "Terminal session", workspaceRoot: realpathSync(options.workspace) })
    : core.runtime.ensureMainSession();
  let pendingRunId: string | undefined;
  let active: AbortController | undefined;
  let activeRun: Promise<void> | undefined;
  const steering: string[] = [];
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const commands = ["/help", "/new", "/sessions", "/use", "/messages", "/tools", "/diff", "/approve", "/reject", "/cancel", "/clear", "/quit"];
  const completer = (line: string): [string[], string] => {
    const candidates = line.startsWith("/use ") ? core.runtime.listSessions().map((item) => `/use ${item.id}`)
      : line.startsWith("/tools ") ? core.runtime.discoverTools(session.id).map((tool) => `/tools ${tool.name}`)
      : commands;
    const hits = candidates.filter((candidate) => candidate.startsWith(line));
    return [hits.length ? hits : candidates, line];
  };
  if (interactive) process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive, historySize: 200, completer });
  const write = (value: string) => process.stdout.write(value);
  const prompt = () => { if (interactive) { terminal.setPrompt(`\x1b[38;5;190mkestrel\x1b[0m:${session.id.slice(-8)}${active ? " · running" : pendingRunId ? " · approval" : ""}> `); terminal.prompt(); } };
  const header = () => write(interactive
    ? `\x1b[1mWorkstrand terminal\x1b[0m · session ${session.id}\n\x1b[2mTab completes commands · /help lists controls · sensitive tools pause for approval\x1b[0m\n${"─".repeat(Math.max(24, Math.min(100, process.stdout.columns ?? 80)))}\n`
    : `Workstrand terminal · session ${session.id}\nType /help for commands. Sensitive tools always pause for approval.\n`);
  const renderDiff = (diff: string) => diff.split("\n").map((line) => interactive && line.startsWith("+") && !line.startsWith("+++") ? `\x1b[32m${line}\x1b[0m` : interactive && line.startsWith("-") && !line.startsWith("---") ? `\x1b[31m${line}\x1b[0m` : interactive && line.startsWith("@@") ? `\x1b[36m${line}\x1b[0m` : line).join("\n");
  const showResult = (result: AgentLoopResult) => {
    if (result.run.status === "waiting_approval" && result.pendingExecution) {
      pendingRunId = result.run.id;
      write(`\nApproval required: ${result.pendingExecution.toolName} [${result.pendingExecution.riskLevel}]\n${JSON.stringify(result.pendingExecution.input, null, 2)}\nUse /approve or /reject.\n`);
    } else pendingRunId = undefined;
  };
  const resume = (approvalDecision: "approved" | "rejected") => {
    if (!pendingRunId) { write("No run is waiting for approval.\n"); return; }
    active = new AbortController();
    const controller = active;
    activeRun = core.agentLoop.resume({ runId: pendingRunId, approvalDecision, signal: controller.signal, onTextDelta: write, takeSteering: () => steering.splice(0) })
      .then((result) => { write("\n"); showResult(result); })
      .catch((error) => { write(`\nError: ${error instanceof Error ? error.message : "unknown error"}\n`); })
      .finally(() => { if (active === controller) active = undefined; activeRun = undefined; prompt(); });
  };

  header();
  terminal.on("SIGINT", () => {
    if (active) { active.abort(new Error("Cancelled from terminal.")); write("\nCancelling…\n"); }
    else terminal.close();
  });
  prompt();
  try {
    for await (const raw of terminal) {
      const line = raw.trim();
      try {
        if (!line) { prompt(); continue; }
        if (line === "/quit" || line === "/exit") break;
        if (line === "/help") write("/new [title] · /sessions · /use <id> · /messages · /tools [query] · /diff [--staged] · /approve · /reject · /cancel · /clear · /quit\n");
        else if (line === "/sessions") write(`${JSON.stringify(core.runtime.listSessions(), null, 2)}\n`);
        else if (line.startsWith("/new")) {
          const title = line.slice(4).trim() || "Terminal session";
          session = core.runtime.createSession({ title, ...(options.workspace ? { workspaceRoot: realpathSync(options.workspace) } : {}) });
          pendingRunId = undefined;
          write(`Using ${session.id}.\n`);
        } else if (line.startsWith("/use ")) {
          session = core.runtime.getSession(line.slice(5).trim());
          pendingRunId = undefined;
          write(`Using ${session.id}.\n`);
        } else if (line === "/messages") write(`${JSON.stringify(core.runtime.listMessages(session.id), null, 2)}\n`);
        else if (line === "/tools" || line.startsWith("/tools ")) write(`${JSON.stringify(core.runtime.discoverTools(session.id, line.slice(6).trim() || undefined), null, 2)}\n`);
        else if (line === "/diff" || line === "/diff --staged") {
          const result = await core.runtime.callTool(session.id, "git.diff", { staged: line.endsWith("--staged"), pathspec: [] });
          if (result.status !== "verified") throw new Error(result.error ?? "Git diff failed.");
          write(`${renderDiff(String(result.output?.diff ?? ""))}\n`);
        } else if (line === "/clear") { if (interactive) { write("\x1b[2J\x1b[H"); header(); } }
        else if (line === "/approve") resume("approved");
        else if (line === "/reject") resume("rejected");
        else if (line === "/cancel") {
          if (active) active.abort(new Error("Cancelled from terminal."));
          else write("No active model or tool call.\n");
        } else if (line.startsWith("/")) write("Unknown command. Type /help.\n");
        else {
          if (active) {
            if (steering.length >= 20) write("Steering queue is full. Wait for the agent to consume an update.\n");
            else { steering.push(line); write("Queued update for the active run.\n"); }
            prompt();
            continue;
          }
          if (pendingRunId) { write("Resolve the pending approval with /approve or /reject first.\n"); prompt(); continue; }
          active = new AbortController();
          const controller = active;
          activeRun = core.agentLoop.run({ sessionId: session.id, model: config.model, providerIds: config.providers, userContent: textContent(line), signal: controller.signal, onTextDelta: write, takeSteering: () => steering.splice(0) })
            .then((result) => { write("\n"); showResult(result); })
            .catch((error) => { write(`\nError: ${error instanceof Error ? error.message : "unknown error"}\n`); })
            .finally(() => { if (active === controller) active = undefined; activeRun = undefined; prompt(); });
        }
      } catch (error) { write(`Error: ${error instanceof Error ? error.message : "unknown error"}\n`); }
      prompt();
    }
  } finally {
    terminal.close();
    active?.abort(new Error("Terminal closed."));
    await activeRun;
    await core.close();
    if (interactive) process.stdout.write("\x1b[?1049l");
  }
}
