import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentLoop } from "./agent-loop";
import { TaskOrchestrator } from "./orchestration";
import { ProviderPool, type ModelProvider } from "./providers";
import { DockerCliRemoteBackend, KubernetesCliRemoteBackend, RemoteBackendManager, RemoteControl, ServerlessHttpRemoteBackend, SshCliRemoteBackend, environmentRemoteExecutionConfiguration, installRemoteExecutionTool } from "./remote";
import { AgentRuntime } from "./runtime";

const provider: ModelProvider = { id: "fake", capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: true }, complete: async (request) => ({ providerId: "fake", model: request.model, text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }) };

describe("remote backends and scoped supervision", () => {
  it("approval-gates argv-only allowlisted remote execution", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const manager = new RemoteBackendManager(database, [{ id: "ssh-adapter", execute: async ({ command }) => ({ exitCode: 0, stdout: command, stderr: "", remoteExecutionId: "remote-1" }) }]);
    manager.setTargets([{ id: "build-host", kind: "ssh", backendId: "ssh-adapter", allowedCommands: ["git"], enabled: true }]);
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Remote" });
    installRemoteExecutionTool(runtime, manager, session.id);
    await expect(manager.execute("build-host", "rm", [], 1000, new AbortController().signal)).rejects.toThrow("allowlist");
    const input = { targetId: "build-host", command: "git", args: ["status"] };
    expect((await runtime.callTool(session.id, "remote.execute", input, { idempotencyKey: "remote" })).status).toBe("blocked");
    expect(await runtime.callTool(session.id, "remote.execute", input, { approvalStatus: "approved", idempotencyKey: "remote" })).toMatchObject({ status: "verified", output: { targetId: "build-host", attestedBy: "ssh-adapter" } });
    database.close();
  });

  it("pairs scoped devices, returns redacted remote state, and supports revocation", async () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Main" });
    const orchestrator = new TaskOrchestrator(database, runtime, new AgentLoop(database, runtime, new ProviderPool([provider])));
    const remote = new RemoteControl(database, runtime, orchestrator, () => new Date("2026-07-23T00:00:00.000Z"));
    const pairing = remote.beginPairing("Phone", ["read", "tasks"]);
    expect(() => remote.completePairing(pairing.pairingId, "wrong")).toThrow("invalid");
    const device = remote.completePairing(pairing.pairingId, pairing.code);
    expect(remote.listSessions(device.token)).toMatchObject([{ id: session.id }]);
    expect(remote.listSessions(device.token)[0]).not.toHaveProperty("workspaceRoot");
    const job = remote.submitJob(device.token, { title: "Remote task", sessionId: session.id, model: "fake", providerIds: ["fake"], prompt: "private remote prompt", schedule: { kind: "once", nextRunAt: "2026-07-23T00:00:00.000Z" } });
    expect(job).not.toHaveProperty("prompt");
    expect(remote.listJobs(device.token)).toMatchObject([{ id: job.id, title: "Remote task" }]);
    await expect(remote.resumeJob(device.token, job.id)).rejects.toThrow("lacks");
    remote.revoke(device.deviceId);
    expect(() => remote.listSessions(device.token)).toThrow("invalid");
    const ciphertext = database.db.prepare("SELECT value_ciphertext FROM private_runtime_state WHERE key = ?").get("remote.devices") as { value_ciphertext: string };
    expect(ciphertext.value_ciphertext).not.toContain(device.token);
    database.close();
  });

  it("locks a pairing after five failed guesses", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database);
    const orchestrator = new TaskOrchestrator(database, runtime, new AgentLoop(database, runtime, new ProviderPool([provider])));
    const remote = new RemoteControl(database, runtime, orchestrator);
    const pairing = remote.beginPairing("Untrusted device", ["read"]);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(() => remote.completePairing(pairing.pairingId, `wrong-${attempt}`)).toThrow("invalid");
    expect(() => remote.completePairing(pairing.pairingId, pairing.code)).toThrow("invalid or expired");
    database.close();
  });

  it("rejects oversized pairing labels before persistence", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const runtime = new AgentRuntime(database);
    const orchestrator = new TaskOrchestrator(database, runtime, new AgentLoop(database, runtime, new ProviderPool([provider])));
    const remote = new RemoteControl(database, runtime, orchestrator);
    expect(() => remote.beginPairing("x".repeat(201), ["read"])).toThrow("bounded label");
    expect(database.getPrivateState("remote.pairings")).toBeUndefined();
    database.close();
  });

  it("runs concrete Docker, SSH, and Kubernetes CLI adapters with argv containment", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-remote-cli-")); const bin = join(root, "bin");
    writeFileSync(join(root, "placeholder"), "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
    for (const executable of ["docker", "ssh", "kubectl"]) { const path = join(bin, executable); writeFileSync(path, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n"); chmodSync(path, 0o700); }
    const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const signal = new AbortController().signal;
      const docker = await new DockerCliRemoteBackend().execute({ target: { id: "container", kind: "docker", backendId: "docker-cli", allowedCommands: ["node"], enabled: true, configuration: { image: "node:24", workspaceRoot: root } }, command: "node", args: ["--version"], timeoutMs: 5_000, signal });
      expect(docker.stdout).toContain("--network\nnone\nnode:24\nnode\n--version");
      expect(docker.stdout).toContain(`type=bind,src=${realpathSync(root)},dst=/workspace`);
      const ssh = await new SshCliRemoteBackend().execute({ target: { id: "host", kind: "ssh", backendId: "ssh-cli", allowedCommands: ["git"], enabled: true, configuration: { host: "build.example.com", user: "builder", remoteWorkdir: "/srv/app" } }, command: "git", args: ["status; touch /tmp/not-run"], timeoutMs: 5_000, signal });
      expect(ssh.stdout).toContain("builder@build.example.com"); expect(ssh.stdout).toContain("exec 'git' 'status; touch /tmp/not-run'");
      const cluster = await new KubernetesCliRemoteBackend().execute({ target: { id: "cluster", kind: "cluster", backendId: "kubernetes-cli", allowedCommands: ["pnpm"], enabled: true, configuration: { image: "node:24", namespace: "builds" } }, command: "pnpm", args: ["test"], timeoutMs: 5_000, signal });
      expect(cluster.stdout).toContain("--namespace\nbuilds\nrun\nkestrel-"); expect(cluster.stdout).toContain("--image=node:24\n--command\n--\npnpm\ntest");
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }); }
  });

  it("uses authenticated HTTPS serverless execution and stores only hash-verified artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-remote-artifacts-"));
    const database = new KestrelDatabase(":memory:", createEncryptionKey()); const bytes = Buffer.from("verified remote artifact"); const sha256 = createHash("sha256").update(bytes).digest("hex");
    let authorization = ""; let requestBody = "";
    const backend = new ServerlessHttpRemoteBackend(async (_input, init) => { authorization = String(new Headers(init?.headers).get("authorization")); requestBody = String(init?.body); return new Response(JSON.stringify({ exitCode: 0, stdout: "built", stderr: "", remoteExecutionId: "lambda-1", artifacts: [{ filename: "report.txt", mediaType: "text/plain", dataBase64: bytes.toString("base64"), sha256 }] }), { status: 200, headers: { "content-type": "application/json" } }); });
    const manager = new RemoteBackendManager(database, [backend], root);
    manager.setTargets([{ id: "function", kind: "serverless", backendId: "serverless-http", allowedCommands: ["build"], enabled: true, configuration: { endpoint: "https://functions.example.test/run", bearerToken: "serverless-secret" } }]);
    const result = await manager.execute("function", "build", ["release"], 5_000, new AbortController().signal);
    expect(authorization).toBe("Bearer serverless-secret"); expect(requestBody).toContain('"command":"build"');
    expect(result).toMatchObject({ exitCode: 0, remoteExecutionId: "lambda-1", artifacts: [{ filename: "report.txt", bytes: bytes.length, sha256 }] });
    const artifact = (result.artifacts as Array<{ path: string }>)[0]!; expect(existsSync(artifact.path)).toBe(true); expect(readFileSync(artifact.path)).toEqual(bytes); expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
    const ciphertext = database.db.prepare("SELECT value_ciphertext FROM private_runtime_state WHERE key = ?").get("providers.remote-targets") as { value_ciphertext: string }; expect(ciphertext.value_ciphertext).not.toContain("serverless-secret");
    database.close(); rmSync(root, { recursive: true, force: true });
  });

  it("cancels chunked oversized serverless responses before parsing or emitting output", async () => {
    let pulls = 0;
    let cancellations = 0;
    let outputEvents = 0;
    const chunk = new Uint8Array(12_000_001);
    const backend = new ServerlessHttpRemoteBackend(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 20) controller.close();
      },
      cancel() {
        cancellations += 1;
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(backend.execute({
      target: { id: "function", kind: "serverless", backendId: "serverless-http", allowedCommands: ["build"], enabled: true, configuration: { endpoint: "https://functions.example.test/run" } },
      command: "build",
      args: [],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      onOutput: () => {
        outputEvents += 1;
      },
    })).rejects.toThrow("exceeds 36 MB");
    expect(cancellations).toBe(1);
    expect(pulls).toBeLessThan(20);
    expect(outputEvents).toBe(0);
  });

  it("constructs all production remote adapters from bounded environment configuration", () => {
    const config = environmentRemoteExecutionConfiguration({ KESTREL_REMOTE_TARGETS: JSON.stringify([{ id: "docker", kind: "docker", backendId: "docker-cli", allowedCommands: ["node"], enabled: true, configuration: { image: "node:24" } }]) });
    expect(config?.backends.map((backend) => backend.id)).toEqual(["docker-cli", "ssh-cli", "kubernetes-cli", "serverless-http"]); expect(config?.targets).toHaveLength(1);
    expect(() => environmentRemoteExecutionConfiguration({ KESTREL_REMOTE_TARGETS: "not-json" })).toThrow("valid JSON");
  });
});
