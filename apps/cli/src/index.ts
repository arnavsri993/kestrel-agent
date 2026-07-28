import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  AutomationDaemon,
  BonjourAdvertiser,
  MigrationManager,
  RemoteHttpServer,
  TailscaleExposureManager,
  TrustedProxyAuthorizer,
  environmentLanguageServerClient,
  installCodeIntelligenceTools,
  parseScheduleExpression,
  textContent,
  type MigrationPlan,
  type TrustedProxyConfiguration,
} from "@kestrel/agent-core";
import { parseCliArguments } from "./arguments";
import { runAcpStdio } from "./acp-stdio";
import { dataDirectory, openKestrel } from "./state";
import { runTui } from "./tui";

const help = `Kestrel CLI

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
  kestrel resume --run <run-id> --decision <approved|rejected>
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
  kestrel skin list
  kestrel skin select --id <skin>
  kestrel skin import --path <skin.json>
  kestrel skin remove --id <skin>
  kestrel pets list [query] [--limit N] [--installed]
  kestrel pets install <slug> [--select] [--force]
  kestrel pets hatch-drafts --concept "..." [--style auto] [--count 4]
  kestrel pets hatch --draft <id> --slug <slug> --name "Name" [--description "..."]
  kestrel pets select <slug>
  kestrel pets scale <0.1-3>
  kestrel pets show [slug] [--state idle|wave|run|failed|review|jump|waiting]
                    [--cycle] [--once] [--mode auto|kitty|iterm|sixel|unicode]
                    [--scale 0.1-3]
  kestrel pets off
  kestrel pets remove <slug>
  kestrel pets doctor
  kestrel remote pair --label <name> --scopes <read,tasks,approve>
  kestrel remote revoke --device <id>
  kestrel remote serve [--host 127.0.0.1 --port 0]
                       [--tls-key <path> --tls-cert <path>]
                       [--trusted-proxy-config <owner-only-json>]
                       [--proxy-terminated-tls yes|no]
                       [--tailscale off|serve|funnel]
                       [--tailscale-service svc:<name>]
                       [--tailscale-reset-on-exit yes|no]
                       [--tailscale-public-ack public]
                       [--bonjour off|minimal|full]
                       [--bonjour-name <name>]
                       [--bonjour-tailnet-dns <name> --bonjour-ssh-port <port>
                        --bonjour-cli-path <path>]
                       [--allowed-origins <origin,origin>]

State is local. Set KESTREL_DATA_DIR to choose its directory. TUI/ACP can read
KESTREL_MODEL and KESTREL_PROVIDERS instead of command-line model options.`;

function boundedTlsFile(path: string): Buffer {
  const resolved = realpathSync(path);
  const metadata = lstatSync(resolved);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 1_000_000
  )
    throw new Error(
      "TLS credentials must be regular files no larger than 1 MB.",
    );
  return readFileSync(resolved);
}

function trustedProxyConfiguration(path: string): TrustedProxyConfiguration {
  const source = lstatSync(path);
  if (
    !source.isFile() ||
    source.isSymbolicLink() ||
    source.size > 1_000_000 ||
    (source.mode & 0o077) !== 0
  )
    throw new Error(
      "Trusted proxy configuration must be an owner-only regular file no larger than 1 MB.",
    );
  const resolved = realpathSync(path);
  const metadata = lstatSync(resolved);
  if (!metadata.isFile())
    throw new Error(
      "Trusted proxy configuration must resolve to a regular file.",
    );
  const value = JSON.parse(
    readFileSync(resolved, "utf8"),
  ) as Partial<TrustedProxyConfiguration>;
  if (
    !Array.isArray(value.trustedSources) ||
    !Array.isArray(value.requiredHeaders) ||
    !Array.isArray(value.allowUsers) ||
    !Array.isArray(value.maximumScopes) ||
    typeof value.userHeader !== "string" ||
    typeof value.allowLoopback !== "boolean"
  )
    throw new Error("Trusted proxy configuration is invalid.");
  return value as TrustedProxyConfiguration;
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function detectedPetMode(
  configured: "auto" | "kitty" | "iterm" | "sixel" | "unicode" | "off",
  override?: "auto" | "kitty" | "iterm" | "sixel" | "unicode",
): "kitty" | "iterm" | "sixel" | "unicode" | "off" {
  const requested = override && override !== "auto" ? override : configured;
  if (requested !== "auto") return requested;
  if (process.env.KITTY_WINDOW_ID || process.env.TERM?.includes("kitty"))
    return "kitty";
  if (process.env.TERM_PROGRAM === "iTerm.app") return "iterm";
  if (process.env.TERM?.includes("sixel")) return "sixel";
  return "unicode";
}

async function showPet(
  core: ReturnType<typeof openKestrel>,
  command: Extract<ReturnType<typeof parseCliArguments>, { name: "pet-show" }>,
): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stdout.write(
      "Pet rendering is disabled because stdout is not a TTY.\n",
    );
    return;
  }
  const pets = core.pets;
  if (!pets) throw new Error("Pet storage is unavailable.");
  const status = pets.status();
  const slug = command.slug ?? status.configuration.selectedSlug;
  if (!slug) throw new Error("Install and select a pet first.");
  const mode = detectedPetMode(status.configuration.renderMode, command.mode);
  if (mode === "off") throw new Error("Terminal pet rendering is off.");
  const columns = Math.max(
    8,
    Math.min(
      80,
      Math.round(24 * ((command.scale ?? status.configuration.scale) / 0.33)),
    ),
  );
  const states = [
    "idle",
    "wave",
    "run",
    "failed",
    "review",
    "jump",
    "waiting",
  ] as const;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  try {
    let index = 0;
    do {
      const state = command.cycle
        ? states[Math.floor(index / 8) % states.length]!
        : command.state;
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(
        await pets.terminalFrame(slug, state, mode, columns, index % 8),
      );
      process.stdout.write(`${slug} · ${state} · ${mode} · Ctrl+C to stop\n`);
      index += 1;
      if (command.once || stopped) break;
      await new Promise((resolve) =>
        setTimeout(resolve, state === "run" ? 110 : 170),
      );
    } while (!stopped);
  } finally {
    process.removeListener("SIGINT", stop);
  }
}

export async function runCli(args: string[]): Promise<void> {
  const command = parseCliArguments(args);
  if (command.name === "help") {
    process.stdout.write(`${help}\n`);
    return;
  }
  if (command.name === "acp") {
    await runAcpStdio(command);
    return;
  }
  if (command.name === "tui") {
    await runTui(command);
    return;
  }
  const workspaceRoots =
    command.name === "session-create" && command.workspace
      ? [realpathSync(command.workspace)]
      : [];
  const core = openKestrel(workspaceRoots);
  const languageServer = await environmentLanguageServerClient();
  if (languageServer)
    for (const session of core.runtime.listSessions())
      installCodeIntelligenceTools(
        core.runtime,
        languageServer.client,
        session.id,
      );
  try {
    if (command.name === "session-list")
      process.stdout.write(
        `${JSON.stringify(core.runtime.listSessions(), null, 2)}\n`,
      );
    else if (command.name === "session-create") {
      const session = core.runtime.createSession({
        title: command.title,
        ...(command.workspace
          ? { workspaceRoot: realpathSync(command.workspace) }
          : {}),
      });
      process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
    } else if (command.name === "session-fork")
      process.stdout.write(
        `${JSON.stringify(core.runtime.forkSession(command.sessionId, command.title), null, 2)}\n`,
      );
    else if (command.name === "session-checkpoint")
      process.stdout.write(
        `${JSON.stringify(core.runtime.checkpoint(command.sessionId, command.summary), null, 2)}\n`,
      );
    else if (command.name === "session-restore")
      process.stdout.write(
        `${JSON.stringify(core.runtime.restoreCheckpoint(command.sessionId, command.checkpointId), null, 2)}\n`,
      );
    else if (command.name === "session-resume")
      process.stdout.write(
        `${JSON.stringify(core.runtime.resumeSession(command.sessionId), null, 2)}\n`,
      );
    else if (command.name === "session-cancel")
      process.stdout.write(
        `${JSON.stringify(core.runtime.cancelSession(command.sessionId), null, 2)}\n`,
      );
    else if (command.name === "session-messages")
      process.stdout.write(
        `${JSON.stringify(core.runtime.listMessages(command.sessionId), null, 2)}\n`,
      );
    else if (command.name === "tools")
      process.stdout.write(
        `${JSON.stringify(core.runtime.discoverTools(command.sessionId, command.query), null, 2)}\n`,
      );
    else if (command.name === "run") {
      const result = await core.agentLoop.run({
        sessionId: command.sessionId,
        model: command.model,
        providerIds: command.providers,
        userContent: textContent(command.prompt),
        onTextDelta: (delta) => process.stdout.write(delta),
      });
      process.stdout.write(
        `\n${JSON.stringify({ run: result.run, pendingExecution: result.pendingExecution }, null, 2)}\n`,
      );
      if (result.run.status === "waiting_approval") process.exitCode = 2;
    } else if (command.name === "retry") {
      const prior = core.runtime.rewindLastTurn(command.sessionId);
      const result = await core.agentLoop.run({
        sessionId: command.sessionId,
        model: command.model,
        providerIds: command.providers,
        userContent: textContent(prior.message),
        onTextDelta: (delta) => process.stdout.write(delta),
      });
      process.stdout.write(
        `\n${JSON.stringify({ run: result.run, pendingExecution: result.pendingExecution }, null, 2)}\n`,
      );
      if (result.run.status === "waiting_approval") process.exitCode = 2;
    } else if (command.name === "resume") {
      const result = await core.agentLoop.resume({
        runId: command.runId,
        approvalDecision: command.decision,
        onTextDelta: (delta) => process.stdout.write(delta),
      });
      process.stdout.write(
        `\n${JSON.stringify({ run: result.run, pendingExecution: result.pendingExecution }, null, 2)}\n`,
      );
      if (result.run.status === "waiting_approval") process.exitCode = 2;
    } else if (command.name === "jobs")
      process.stdout.write(
        `${JSON.stringify(
          core.orchestrator
            .listJobs()
            .map(
              ({ prompt: _prompt, instructions: _instructions, ...job }) => job,
            ),
          null,
          2,
        )}\n`,
      );
    else if (command.name === "automation-schedule")
      process.stdout.write(
        `${JSON.stringify(core.orchestrator.schedule({ title: command.title, sessionId: command.sessionId, model: command.model, providerIds: command.providers, prompt: command.prompt, schedule: parseScheduleExpression(command.expression) }), null, 2)}\n`,
      );
    else if (command.name === "automation-cancel")
      process.stdout.write(
        `${JSON.stringify(core.orchestrator.cancelJob(command.jobId), null, 2)}\n`,
      );
    else if (command.name === "automation-run-due")
      process.stdout.write(
        `${JSON.stringify(await core.orchestrator.runDue(), null, 2)}\n`,
      );
    else if (command.name === "automation-serve") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.stdout.write(
        `${JSON.stringify({ automation: "ready", pid: process.pid, pollMs: command.pollMs })}\n`,
      );
      await new AutomationDaemon(core.orchestrator, command.pollMs).run(
        controller.signal,
      );
    } else if (command.name === "migration-plan")
      process.stdout.write(
        `${JSON.stringify(new MigrationManager().plan([{ product: command.product, root: command.source }], command.target), null, 2)}\n`,
      );
    else if (command.name === "migration-apply") {
      const path = realpathSync(command.planPath);
      const metadata = lstatSync(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 10_000_000
      )
        throw new Error("Migration plan must be a bounded regular file.");
      const plan = JSON.parse(readFileSync(path, "utf8")) as MigrationPlan;
      process.stdout.write(
        `${JSON.stringify(new MigrationManager().apply(plan, { approved: true, overwrite: command.overwrite }), null, 2)}\n`,
      );
    } else if (command.name === "skin-list")
      process.stdout.write(`${JSON.stringify(core.skins.status(), null, 2)}\n`);
    else if (command.name === "skin-select")
      process.stdout.write(
        `${JSON.stringify(core.skins.select(command.skinId), null, 2)}\n`,
      );
    else if (command.name === "skin-import") {
      const sourceMetadata = lstatSync(command.path);
      if (
        !sourceMetadata.isFile() ||
        sourceMetadata.isSymbolicLink() ||
        sourceMetadata.size < 1 ||
        sourceMetadata.size > 65_536
      )
        throw new Error(
          "Skin must be a regular non-symlink JSON file no larger than 64 KB.",
        );
      const path = realpathSync(command.path);
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.size !== sourceMetadata.size)
        throw new Error("Skin file changed during validation.");
      process.stdout.write(
        `${JSON.stringify(core.skins.import(readFileSync(path, "utf8")), null, 2)}\n`,
      );
    } else if (command.name === "skin-remove")
      process.stdout.write(
        `${JSON.stringify(core.skins.remove(command.skinId), null, 2)}\n`,
      );
    else if (command.name === "pet-list") {
      if (!core.pets) throw new Error("Pet storage is unavailable.");
      process.stdout.write(
        `${JSON.stringify(command.installed ? core.pets.status().installed : await core.pets.gallery(command.query, command.limit), null, 2)}\n`,
      );
    } else if (command.name === "pet-install") {
      if (!core.pets) throw new Error("Pet storage is unavailable.");
      process.stdout.write(
        `${JSON.stringify(await core.pets.install(command.slug, command.select, undefined, command.force), null, 2)}\n`,
      );
    } else if (command.name === "pet-select") {
      if (!core.pets) throw new Error("Pet storage is unavailable.");
      process.stdout.write(
        `${JSON.stringify(core.pets.select(command.slug), null, 2)}\n`,
      );
    } else if (command.name === "pet-scale") {
      if (!core.pets) throw new Error("Pet storage is unavailable.");
      process.stdout.write(
        `${JSON.stringify(core.pets.configure({ scale: command.scale }), null, 2)}\n`,
      );
    } else if (command.name === "pet-show") await showPet(core, command);
    else if (command.name === "pet-off") {
      if (!core.pets) throw new Error("Pet storage is unavailable.");
      process.stdout.write(
        `${JSON.stringify(core.pets.configure({ enabled: false }), null, 2)}\n`,
      );
    } else if (command.name === "pet-remove") {
      if (!core.pets) throw new Error("Pet storage is unavailable.");
      process.stdout.write(
        `${JSON.stringify(core.pets.remove(command.slug), null, 2)}\n`,
      );
    } else if (command.name === "pet-doctor") {
      if (!core.pets) throw new Error("Pet storage is unavailable.");
      const status = core.pets.status();
      const decoder = await core.pets.verifyDecoder();
      const effectiveMode = detectedPetMode(status.configuration.renderMode);
      const selected = status.installed.find(
        (pet) => pet.slug === status.configuration.selectedSlug,
      );
      process.stdout.write(
        `${JSON.stringify({ petsDirectory: join(dataDirectory(), "pets"), installed: status.installed.length, configuration: status.configuration, selected: selected?.slug ?? null, terminal: { tty: Boolean(process.stdout.isTTY), configuredMode: status.configuration.renderMode, effectiveMode: process.stdout.isTTY ? effectiveMode : "off", decoder }, ready: Boolean(selected && status.configuration.enabled) }, null, 2)}\n`,
      );
    } else if (command.name === "pet-hatch-drafts") {
      if (!core.petHatch) throw new Error("Pet hatch storage is unavailable.");
      const drafts = await core.petHatch.generateDrafts(
        {
          concept: command.concept,
          style: command.style,
          count: command.count,
        },
        AbortSignal.timeout(180_000),
      );
      process.stdout.write(
        `${JSON.stringify({ capability: core.petHatch.capability(), drafts: drafts.map(({ dataBase64: _data, ...draft }) => draft), next: "Preview and choose a draft in the TUI with /hatch, or pass its id to pets hatch." }, null, 2)}\n`,
      );
    } else if (command.name === "pet-hatch-complete") {
      if (!core.petHatch) throw new Error("Pet hatch storage is unavailable.");
      process.stdout.write(
        `${JSON.stringify(await core.petHatch.hatch({ draftId: command.draftId, slug: command.slug, displayName: command.displayName, description: command.description }, AbortSignal.timeout(420_000)), null, 2)}\n`,
      );
    } else if (command.name === "remote-pair")
      process.stdout.write(
        `${JSON.stringify(core.remote.beginPairing(command.label, command.scopes, command.lifetimeMs), null, 2)}\n`,
      );
    else if (command.name === "remote-revoke") {
      core.remote.revoke(command.deviceId);
      process.stdout.write(
        `${JSON.stringify({ revoked: command.deviceId })}\n`,
      );
    } else if (command.name === "remote-serve") {
      const trustedProxy = command.trustedProxyConfig
        ? new TrustedProxyAuthorizer(
            trustedProxyConfiguration(command.trustedProxyConfig),
          )
        : undefined;
      const tailscale = new TailscaleExposureManager({
        mode: command.tailscaleMode,
        ...(command.tailscaleService
          ? { serviceName: command.tailscaleService }
          : {}),
        resetOnExit: command.tailscaleResetOnExit,
        publicExposureApproved: command.tailscalePublicApproved,
      });
      const tls =
        command.tlsKey && command.tlsCert
          ? {
              key: boundedTlsFile(command.tlsKey),
              cert: boundedTlsFile(command.tlsCert),
              minVersion: "TLSv1.2" as const,
            }
          : undefined;
      const bonjour = new BonjourAdvertiser({
        mode: command.bonjourMode,
        displayName: command.bonjourName,
        tlsEnabled: Boolean(tls),
        ...(tls
          ? { tlsSha256: createHash("sha256").update(tls.cert).digest("hex") }
          : {}),
        ...(command.bonjourTailnetDns
          ? { tailnetDns: command.bonjourTailnetDns }
          : {}),
        ...(command.bonjourSshPort ? { sshPort: command.bonjourSshPort } : {}),
        ...(command.bonjourCliPath ? { cliPath: command.bonjourCliPath } : {}),
      });
      const nativeTalkSessions = new Map<string, string>();
      const server = new RemoteHttpServer({
        remote: core.remote,
        runtime: core.runtime,
        host: command.host,
        port: command.port,
        allowedOrigins: command.allowedOrigins,
        presence: core.presence,
        nativeNodes: core.nativeNodes,
        onNodeTalk: async ({ nodeId, text }) => {
          let sessionId = nativeTalkSessions.get(nodeId);
          if (!sessionId) {
            const session = core.runtime.createSession({ title: `Talk · ${nodeId}` });
            sessionId = session.id;
            nativeTalkSessions.set(nodeId, sessionId);
          }
          const response = await core.handle({
            type: "runtime-run-agent",
            sessionId,
            message: text,
            model: "auto",
            providerIds: ["auto"],
            streamId: `node-talk-${Date.now()}`,
          });
          if (!response.ok) throw new Error(response.error);
          const messages = core.runtime.listMessages(sessionId);
          const assistant = messages.filter((message) => message.role === "assistant").at(-1);
          const answer = assistant?.content.trim();
          return { text: answer || (response.run?.status === "waiting_approval" ? "I need your approval in Kestrel before I can continue." : "The agent finished without a spoken response."), sessionId };
        },
        ...(trustedProxy ? { trustedProxy } : {}),
        ...(command.proxyTerminatedTls
          ? { allowProxyTerminatedTls: true }
          : {}),
        ...(core.observability.prometheusEnabled()
          ? { prometheusMetrics: () => core.observability.prometheus() }
          : {}),
        ...(core.channelGateway
          ? {
              channelGateway: core.channelGateway,
              resolveChannelSession: (envelope) =>
                core.resolveChannelSession(envelope),
            }
          : {}),
        ...(tls ? { tls } : {}),
      });
      const address = await server.start();
      try {
        const exposure = await tailscale.apply(address.origin);
        const discovery = await bonjour.start(address.origin);
        process.stdout.write(
          `${JSON.stringify({ ...address, tailscale: exposure, discovery, pid: process.pid })}\n`,
        );
        await waitForShutdown();
      } finally {
        try {
          await bonjour.close();
        } finally {
          try {
            await tailscale.close();
          } finally {
            await server.stop();
          }
        }
      }
    }
  } finally {
    await languageServer?.client.close();
    await core.close();
  }
}

runCli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `kestrel: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
