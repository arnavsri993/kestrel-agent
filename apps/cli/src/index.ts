import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { AutomationDaemon, MigrationManager, RemoteHttpServer, environmentLanguageServerClient, installCodeIntelligenceTools, parseScheduleExpression, textContent, type MigrationPlan } from "@kestrel/agent-core";
import { parseCliArguments } from "./arguments";
import { runAcpStdio } from "./acp-stdio";
import { openKestrel } from "./state";
import { runTui } from "./tui";

const help = `Workstrand CLI

  kestrel tui [--model <id> --providers <id,id>] [--workspace <path>]
  kestrel acp [--model <id> --providers <id,id>] [--workspace <path>]
  kestrel session list
  kestrel session create --title <title> [--workspace <path>]
  kestrel session fork --session <id> [--title <title>]
  kestrel session checkpoint --session <id> --summary <text>
  kestrel session restore --session <id> --checkpoint <id>
  kestrel session resume|cancel|messages --session <id>
  kestrel tools --session <id> [--query <text>]
  kestrel run --session <id> --prompt <text> --model <id> --providers <id,id>
  kestrel retry --session <id> --model <id> --providers <id,id>
  kestrel resume --run <run-id> [--decision approved|rejected]
  kestrel jobs
  kestrel automation schedule --session <id> --title <title> --prompt <text>
                              --model <id> --providers <id,id>
                              (--when <iso|natural-language|cron> | --at <iso>
                               | --interval-seconds <seconds>)
  kestrel automation cancel --job <id>
  kestrel automation run-due
  kestrel automation serve [--poll-ms 5000]
  kestrel migration plan --product <openclaw|hermes|codex|claude-code>
                         --source <path> --target <path>
  kestrel migration apply --plan <path> --approve yes [--overwrite yes|no]
  kestrel remote pair --label <name> --scopes <read,tasks,approve>
  kestrel remote revoke --device <id>
  kestrel remote serve [--host 127.0.0.1 --port 0]
                       [--tls-key <path> --tls-cert <path>]
                       [--allowed-origins <origin,origin>]

State is local. Set KESTREL_DATA_DIR to choose its directory. TUI/ACP can read
KESTREL_MODEL and KESTREL_PROVIDERS instead of command-line model options.`;

function boundedTlsFile(path: string): Buffer {
  const resolved = realpathSync(path);
  const metadata = lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_000_000) throw new Error("TLS credentials must be regular files no larger than 1 MB.");
  return readFileSync(resolved);
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

export async function runCli(args: string[]): Promise<void> {
  const command = parseCliArguments(args);
  if (command.name === "help") { process.stdout.write(`${help}\n`); return; }
  if (command.name === "acp") { await runAcpStdio(command); return; }
  if (command.name === "tui") { await runTui(command); return; }
  const workspaceRoots = command.name === "session-create" && command.workspace ? [realpathSync(command.workspace)] : [];
  const core = openKestrel(workspaceRoots);
  const languageServer = await environmentLanguageServerClient();
  if (languageServer) for (const session of core.runtime.listSessions()) installCodeIntelligenceTools(core.runtime, languageServer.client, session.id);
  try {
    if (command.name === "session-list") process.stdout.write(`${JSON.stringify(core.runtime.listSessions(), null, 2)}\n`);
    else if (command.name === "session-create") {
      const session = core.runtime.createSession({ title: command.title, ...(command.workspace ? { workspaceRoot: realpathSync(command.workspace) } : {}) });
      process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
    } else if (command.name === "session-fork") process.stdout.write(`${JSON.stringify(core.runtime.forkSession(command.sessionId, command.title), null, 2)}\n`);
    else if (command.name === "session-checkpoint") process.stdout.write(`${JSON.stringify(core.runtime.checkpoint(command.sessionId, command.summary), null, 2)}\n`);
    else if (command.name === "session-restore") process.stdout.write(`${JSON.stringify(core.runtime.restoreCheckpoint(command.sessionId, command.checkpointId), null, 2)}\n`);
    else if (command.name === "session-resume") process.stdout.write(`${JSON.stringify(core.runtime.resumeSession(command.sessionId), null, 2)}\n`);
    else if (command.name === "session-cancel") process.stdout.write(`${JSON.stringify(core.runtime.cancelSession(command.sessionId), null, 2)}\n`);
    else if (command.name === "session-messages") process.stdout.write(`${JSON.stringify(core.runtime.listMessages(command.sessionId), null, 2)}\n`);
    else if (command.name === "tools") process.stdout.write(`${JSON.stringify(core.runtime.discoverTools(command.sessionId, command.query), null, 2)}\n`);
    else if (command.name === "run") {
      const result = await core.agentLoop.run({ sessionId: command.sessionId, model: command.model, providerIds: command.providers, userContent: textContent(command.prompt), onTextDelta: (delta) => process.stdout.write(delta) });
      process.stdout.write(`\n${JSON.stringify({ run: result.run, pendingExecution: result.pendingExecution }, null, 2)}\n`);
      if (result.run.status === "waiting_approval") process.exitCode = 2;
    } else if (command.name === "retry") {
      const prior = core.runtime.rewindLastTurn(command.sessionId);
      const result = await core.agentLoop.run({ sessionId: command.sessionId, model: command.model, providerIds: command.providers, userContent: textContent(prior.message), onTextDelta: (delta) => process.stdout.write(delta) });
      process.stdout.write(`\n${JSON.stringify({ run: result.run, pendingExecution: result.pendingExecution }, null, 2)}\n`);
      if (result.run.status === "waiting_approval") process.exitCode = 2;
    } else if (command.name === "resume") {
      const result = await core.agentLoop.resume({ runId: command.runId, approvalDecision: command.decision, onTextDelta: (delta) => process.stdout.write(delta) });
      process.stdout.write(`\n${JSON.stringify({ run: result.run, pendingExecution: result.pendingExecution }, null, 2)}\n`);
      if (result.run.status === "waiting_approval") process.exitCode = 2;
    } else if (command.name === "jobs") process.stdout.write(`${JSON.stringify(core.orchestrator.listJobs().map(({ prompt: _prompt, instructions: _instructions, ...job }) => job), null, 2)}\n`);
    else if (command.name === "automation-schedule") process.stdout.write(`${JSON.stringify(core.orchestrator.schedule({ title: command.title, sessionId: command.sessionId, model: command.model, providerIds: command.providers, prompt: command.prompt, schedule: parseScheduleExpression(command.expression) }), null, 2)}\n`);
    else if (command.name === "automation-cancel") process.stdout.write(`${JSON.stringify(core.orchestrator.cancelJob(command.jobId), null, 2)}\n`);
    else if (command.name === "automation-run-due") process.stdout.write(`${JSON.stringify(await core.orchestrator.runDue(), null, 2)}\n`);
    else if (command.name === "automation-serve") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.stdout.write(`${JSON.stringify({ automation: "ready", pid: process.pid, pollMs: command.pollMs })}\n`);
      await new AutomationDaemon(core.orchestrator, command.pollMs).run(controller.signal);
    }
    else if (command.name === "migration-plan") process.stdout.write(`${JSON.stringify(new MigrationManager().plan([{ product: command.product, root: command.source }], command.target), null, 2)}\n`);
    else if (command.name === "migration-apply") {
      const path = realpathSync(command.planPath);
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 10_000_000) throw new Error("Migration plan must be a bounded regular file.");
      const plan = JSON.parse(readFileSync(path, "utf8")) as MigrationPlan;
      process.stdout.write(`${JSON.stringify(new MigrationManager().apply(plan, { approved: true, overwrite: command.overwrite }), null, 2)}\n`);
    }
    else if (command.name === "remote-pair") process.stdout.write(`${JSON.stringify(core.remote.beginPairing(command.label, command.scopes, command.lifetimeMs), null, 2)}\n`);
    else if (command.name === "remote-revoke") { core.remote.revoke(command.deviceId); process.stdout.write(`${JSON.stringify({ revoked: command.deviceId })}\n`); }
    else if (command.name === "remote-serve") {
      const server = new RemoteHttpServer({
        remote: core.remote,
        runtime: core.runtime,
        host: command.host,
        port: command.port,
        allowedOrigins: command.allowedOrigins,
        ...(core.channelGateway ? { channelGateway: core.channelGateway, resolveChannelSession: (envelope) => core.resolveChannelSession(envelope) } : {}),
        ...(command.tlsKey && command.tlsCert ? { tls: { key: boundedTlsFile(command.tlsKey), cert: boundedTlsFile(command.tlsCert), minVersion: "TLSv1.2" as const } } : {})
      });
      const address = await server.start();
      process.stdout.write(`${JSON.stringify({ ...address, pid: process.pid })}\n`);
      try { await waitForShutdown(); } finally { await server.stop(); }
    }
  } finally { await languageServer?.client.close(); await core.close(); }
}

runCli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`kestrel: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
