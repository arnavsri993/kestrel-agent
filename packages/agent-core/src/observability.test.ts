import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentRuntime } from "./runtime";
import {
  DEFAULT_OBSERVABILITY_CONFIGURATION,
  ObservabilityManager,
  renderPrometheusMetrics,
} from "./observability";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture() {
  const database = new KestrelDatabase(":memory:", createEncryptionKey());
  const runtime = new AgentRuntime(database);
  cleanup.push(() => { runtime.close(); database.close(); });
  return { database, runtime };
}

describe("privacy-safe external observability", () => {
  it("recovers to disabled defaults when persisted configuration is malformed", () => {
    const { database, runtime } = fixture();
    database.setPrivateState("observability.configuration", {
      enabled: "yes",
    });
    const manager = new ObservabilityManager(database, runtime);
    cleanup.push(() => manager.shutdown());

    expect(manager.configuration()).toEqual(DEFAULT_OBSERVABILITY_CONFIGURATION);
    expect(manager.status()).toMatchObject({ running: false });
  });

  it("renders bounded Prometheus text without content, paths, session IDs, or secret values", () => {
    const { database, runtime } = fixture();
    const session = runtime.createSession({ title: "private project title" });
    runtime.appendMessage({ sessionId: session.id, role: "user", content: "private prompt with sk-do-not-export" });
    database.saveToolExecution({
      id: "tool-private-id",
      sessionId: session.id,
      toolName: "workspace.read",
      status: "verified",
      riskLevel: "low",
      input: { path: "/Users/private/project/secret.txt" },
      output: { content: "private file contents" },
      startedAt: "2026-07-23T08:00:00.000Z",
      completedAt: "2026-07-23T08:00:00.100Z"
    });
    database.saveAgentRun({
      id: "run-private-id",
      sessionId: session.id,
      model: "gpt-5.4",
      providerIds: ["openai"],
      status: "failed",
      turn: 1,
      createdAt: "2026-07-23T08:00:00.000Z",
      updatedAt: "2026-07-23T08:00:02.500Z"
    });
    database.saveModelCallAudit({
      id: "audit-private-upstream-id",
      runId: "run-private-id",
      sessionId: session.id,
      providerId: "openai",
      model: "gpt-5.4",
      status: "failed",
      inputTokens: 120,
      outputTokens: 7,
      estimatedCostUsd: 0.0123,
      durationMs: 2_500,
      error: "provider leaked sk-secret-in-error",
      startedAt: "2026-07-23T08:00:00.000Z",
      completedAt: "2026-07-23T08:00:02.500Z"
    });
    const metrics = renderPrometheusMetrics(database);
    expect(metrics).toContain("workstrand_model_calls_total");
    expect(metrics).toContain('provider="openai"');
    expect(metrics).toContain('tool="workspace.read"');
    expect(metrics).toContain("workstrand_model_call_duration_seconds_bucket");
    for (const secret of ["private prompt", "sk-do-not-export", "secret.txt", "private file contents", session.id, "audit-private-upstream-id", "sk-secret-in-error"]) {
      expect(metrics).not.toContain(secret);
    }
    expect(Buffer.byteLength(metrics)).toBeLessThan(1_000_000);
  });

  it("pushes real OTLP/HTTP protobuf metrics and traces with an encrypted custom header and no raw content", async () => {
    const { database, runtime } = fixture();
    const received: Array<{ url: string; contentType: string; authorization: string; body: Buffer }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        url: request.url ?? "",
        contentType: String(request.headers["content-type"] ?? ""),
        authorization: String(request.headers.authorization ?? ""),
        body: Buffer.concat(chunks)
      });
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address() as AddressInfo;
    const manager = new ObservabilityManager(database, runtime, () => new Date("2026-07-23T09:00:00.000Z"));
    cleanup.push(() => manager.shutdown());
    await manager.configure({
      enabled: true,
      otlp: {
        enabled: true,
        endpoint: `http://127.0.0.1:${address.port}`,
        serviceName: "workstrand-test",
        headerName: "authorization",
        metrics: true,
        traces: true,
        sampleRate: 1,
        exportIntervalMs: 60_000
      },
      prometheus: { enabled: true }
    }, "Bearer collector-secret");
    const session = runtime.createSession({ title: "never export this title" });
    runtime.appendMessage({ sessionId: session.id, role: "user", content: "never export this prompt sk-private" });
    database.saveAgentRun({
      id: "run-raw-id-must-not-export",
      sessionId: session.id,
      model: "claude-sonnet-4-5",
      providerIds: ["anthropic"],
      status: "completed",
      turn: 1,
      createdAt: "2026-07-23T08:59:59.000Z",
      updatedAt: "2026-07-23T08:59:59.400Z"
    });
    database.saveModelCallAudit({
      id: "audit-raw-id-must-not-export",
      runId: "run-raw-id-must-not-export",
      sessionId: session.id,
      providerId: "anthropic",
      model: "claude-sonnet-4-5",
      status: "completed",
      inputTokens: 20,
      outputTokens: 5,
      estimatedCostUsd: 0.001,
      durationMs: 400,
      startedAt: "2026-07-23T08:59:59.000Z",
      completedAt: "2026-07-23T08:59:59.400Z"
    });
    await manager.test();
    expect(received.map((request) => request.url).sort()).toEqual(["/v1/metrics", "/v1/traces"]);
    expect(received.every((request) => request.contentType === "application/x-protobuf")).toBe(true);
    expect(received.every((request) => request.authorization === "Bearer collector-secret")).toBe(true);
    expect(received.every((request) => request.body.byteLength > 0)).toBe(true);
    const wire = Buffer.concat(received.map((request) => request.body)).toString("utf8");
    expect(wire).toContain("workstrand-test");
    expect(wire).toContain("anthropic");
    for (const secret of ["never export this title", "never export this prompt", "sk-private", session.id, "audit-raw-id-must-not-export", "collector-secret"]) {
      expect(wire).not.toContain(secret);
    }
    expect(manager.status()).toMatchObject({ running: true, prometheusAvailable: true, hasHeaderValue: true, lastExportState: "success" });
  });

  it("rejects public plaintext collectors and observability with no active signal", async () => {
    const { database, runtime } = fixture();
    const manager = new ObservabilityManager(database, runtime);
    cleanup.push(() => manager.shutdown());
    await expect(manager.configure({
      enabled: true,
      otlp: { ...manager.configuration().otlp, enabled: true, endpoint: "http://collector.example.test:4318" },
      prometheus: { enabled: false }
    })).rejects.toThrow("HTTPS");
    await expect(manager.configure({
      enabled: true,
      otlp: { ...manager.configuration().otlp, enabled: false },
      prometheus: { enabled: false }
    })).rejects.toThrow("Enable OTLP or Prometheus");
  });

  it("releases exported audit IDs after database retention removes them", async () => {
    const { database, runtime } = fixture();
    const session = runtime.createSession({ title: "Observability retention" });
    database.saveAgentRun({
      id: "run-retention",
      sessionId: session.id,
      model: "fixture",
      providerIds: ["fixture"],
      status: "completed",
      turn: 1,
      createdAt: "2026-07-23T08:00:00.000Z",
      updatedAt: "2026-07-23T08:00:01.000Z"
    });
    database.saveModelCallAudit({
      id: "audit-retained",
      runId: "run-retention",
      sessionId: session.id,
      providerId: "fixture",
      model: "fixture",
      status: "completed",
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
      durationMs: 1,
      startedAt: "2026-07-23T08:00:00.000Z",
      completedAt: "2026-07-23T08:00:01.000Z"
    });
    const manager = new ObservabilityManager(database, runtime);
    cleanup.push(() => manager.shutdown());
    const spans: string[] = [];
    const internals = manager as unknown as {
      tracerProvider: { getTracer(): { startSpan(_name: string): { end(): void } }; shutdown(): Promise<void> };
      seenModelCalls: Set<string>;
      scanModelCalls(): void;
    };
    internals.tracerProvider = {
      getTracer: () => ({ startSpan: (name: string) => { spans.push(name); return { end: () => undefined }; } }),
      shutdown: async () => undefined
    };

    internals.scanModelCalls();
    expect(internals.seenModelCalls).toContain("audit-retained");
    database.enforceRetention("2026-07-24T00:00:00.000Z");
    internals.scanModelCalls();
    expect(internals.seenModelCalls).not.toContain("audit-retained");
    database.saveAgentRun({
      id: "run-new",
      sessionId: session.id,
      model: "fixture",
      providerIds: ["fixture"],
      status: "completed",
      turn: 2,
      createdAt: "2026-07-24T01:00:00.000Z",
      updatedAt: "2026-07-24T01:00:01.000Z"
    });
    database.saveModelCallAudit({
      id: "audit-new",
      runId: "run-new",
      sessionId: session.id,
      providerId: "fixture",
      model: "fixture",
      status: "completed",
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
      durationMs: 1,
      startedAt: "2026-07-24T01:00:00.000Z",
      completedAt: "2026-07-24T01:00:01.000Z"
    });
    internals.scanModelCalls();
    expect(spans).toHaveLength(1);
    expect(internals.seenModelCalls).toContain("audit-new");
  });
});
