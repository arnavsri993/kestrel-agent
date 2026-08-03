import type { Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { KestrelDatabase } from "@kestrel/database";
import {
  ObservabilityConfigurationSchema,
  type ModelCallAudit,
  type ObservabilityConfiguration,
  type ObservabilityStatus,
  type RuntimeEvent
} from "@kestrel/shared-types";
import type { AgentRuntime } from "./runtime";

const CONFIGURATION_KEY = "observability.configuration";
const HEADER_VALUE_KEY = "observability.otlp-header-value";
const STATUS_KEY = "observability.status";
const SERIES_CAP = 2_048;
const HISTOGRAM_BUCKETS_SECONDS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300] as const;

interface StoredExportStatus {
  state: "success" | "error";
  at: string;
}

export const DEFAULT_OBSERVABILITY_CONFIGURATION: ObservabilityConfiguration = {
  enabled: false,
  otlp: {
    enabled: false,
    endpoint: "",
    serviceName: "workstrand-agent",
    headerName: "authorization",
    metrics: true,
    traces: true,
    sampleRate: 0.2,
    exportIntervalMs: 60_000
  },
  prometheus: { enabled: false }
};

function boundedLabel(value: string | undefined): string {
  const clean = value?.trim() ?? "";
  if (!clean || clean.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(clean) || /^agent:/i.test(clean)) return "unknown";
  return clean;
}

function validateEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("The OTLP endpoint must be a valid URL.");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("The OTLP endpoint must use HTTPS, except for a loopback collector.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("The OTLP endpoint must not contain credentials, query parameters, or a fragment.");
  }
  return endpoint;
}

function validateConfiguration(value: ObservabilityConfiguration): ObservabilityConfiguration {
  const configuration = ObservabilityConfigurationSchema.parse(value);
  if (configuration.enabled && !configuration.otlp.enabled && !configuration.prometheus.enabled) {
    throw new Error("Enable OTLP or Prometheus before turning on observability.");
  }
  if (configuration.otlp.enabled) {
    validateEndpoint(configuration.otlp.endpoint);
    if (!configuration.otlp.metrics && !configuration.otlp.traces) throw new Error("Enable OTLP metrics or traces.");
  }
  return configuration;
}

function signalEndpoint(base: URL, signal: "metrics" | "traces"): string {
  const endpoint = new URL(base);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/v1/${signal}`.replace(/^\/?/, "/");
  return endpoint.toString();
}

function escapePrometheusLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\"", "\\\"");
}

function labels(values: Record<string, string>): string {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `{${entries.map(([key, value]) => `${key}="${escapePrometheusLabel(value)}"`).join(",")}}` : "";
}

function aggregateModelCalls(stats: Array<{ provider: string | null; model: string | null; outcome: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number; durations: number[] }>) {
  const groups = new Map<string, {
    provider: string;
    model: string;
    outcome: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durations: number[];
  }>();
  for (const stat of stats) {
    const provider = boundedLabel(stat.provider ?? undefined);
    const model = boundedLabel(stat.model ?? undefined);
    const outcome = stat.outcome;
    const key = `${provider}\0${model}\0${outcome}`;
    const group = groups.get(key) ?? { provider, model, outcome, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durations: [] };
    group.calls += stat.calls;
    group.inputTokens += stat.inputTokens;
    group.outputTokens += stat.outputTokens;
    group.costUsd += stat.costUsd;
    group.durations.push(...stat.durations);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function renderPrometheusMetrics(database: KestrelDatabase): string {
  const analytics = database.organizationAnalytics();
  const modelGroups = aggregateModelCalls(database.aggregateModelCallStats());

  const toolGroups = new Map<string, { tool: string; outcome: string; count: number }>();
  for (const stat of database.aggregateToolExecutionStats()) {
    const tool = boundedLabel(stat.tool);
    const outcome = stat.outcome;
    const key = `${tool}\0${outcome}`;
    const group = toolGroups.get(key) ?? { tool, outcome, count: 0 };
    group.count += stat.count;
    toolGroups.set(key, group);
  }

  const output: string[] = [
    "# HELP workstrand_build_info Static build information.",
    "# TYPE workstrand_build_info gauge",
    "workstrand_build_info{version=\"0.1.0\"} 1",
    "# HELP workstrand_sessions_total Durable task sessions.",
    "# TYPE workstrand_sessions_total counter",
    `workstrand_sessions_total ${analytics.sessions}`,
    "# HELP workstrand_messages_total Durable message envelopes; message content is never exported.",
    "# TYPE workstrand_messages_total counter",
    `workstrand_messages_total ${analytics.messages}`,
    "# HELP workstrand_runs_total Agent runs.",
    "# TYPE workstrand_runs_total counter",
    `workstrand_runs_total ${analytics.runs}`,
    "# HELP workstrand_tool_executions_total Tool executions by bounded tool name and outcome.",
    "# TYPE workstrand_tool_executions_total counter"
  ];
  let series = 4;
  let dropped = 0;
  const push = (line: string) => {
    if (series >= SERIES_CAP) { dropped += 1; return; }
    output.push(line);
    series += 1;
  };
  for (const group of toolGroups.values()) push(`workstrand_tool_executions_total${labels({ outcome: group.outcome, tool: group.tool })} ${group.count}`);
  output.push(
    "# HELP workstrand_model_calls_total Observable provider requests by bounded provider, model, and outcome.",
    "# TYPE workstrand_model_calls_total counter",
    "# HELP workstrand_model_tokens_total Provider-reported token usage.",
    "# TYPE workstrand_model_tokens_total counter",
    "# HELP workstrand_model_cost_usd_total Configured-rate estimated model spend.",
    "# TYPE workstrand_model_cost_usd_total counter",
    "# HELP workstrand_model_call_duration_seconds Provider request duration.",
    "# TYPE workstrand_model_call_duration_seconds histogram"
  );
  for (const group of modelGroups) {
    const base = { model: group.model, outcome: group.outcome, provider: group.provider };
    push(`workstrand_model_calls_total${labels(base)} ${group.calls}`);
    push(`workstrand_model_tokens_total${labels({ ...base, token_type: "input" })} ${group.inputTokens}`);
    push(`workstrand_model_tokens_total${labels({ ...base, token_type: "output" })} ${group.outputTokens}`);
    push(`workstrand_model_cost_usd_total${labels(base)} ${group.costUsd.toFixed(8)}`);
    let cumulative = 0;
    for (const bucket of HISTOGRAM_BUCKETS_SECONDS) {
      cumulative += group.durations.filter((duration) => duration > (HISTOGRAM_BUCKETS_SECONDS[HISTOGRAM_BUCKETS_SECONDS.indexOf(bucket) - 1] ?? -Infinity) && duration <= bucket).length;
      push(`workstrand_model_call_duration_seconds_bucket${labels({ ...base, le: String(bucket) })} ${cumulative}`);
    }
    push(`workstrand_model_call_duration_seconds_bucket${labels({ ...base, le: "+Inf" })} ${group.durations.length}`);
    push(`workstrand_model_call_duration_seconds_sum${labels(base)} ${group.durations.reduce((sum, value) => sum + value, 0).toFixed(6)}`);
    push(`workstrand_model_call_duration_seconds_count${labels(base)} ${group.durations.length}`);
  }
  const memory = process.memoryUsage();
  output.push(
    "# HELP workstrand_process_memory_bytes Current exporter process memory by bounded kind.",
    "# TYPE workstrand_process_memory_bytes gauge"
  );
  for (const [kind, value] of Object.entries({ rss: memory.rss, heap_used: memory.heapUsed, heap_total: memory.heapTotal, external: memory.external, array_buffers: memory.arrayBuffers })) {
    push(`workstrand_process_memory_bytes${labels({ kind })} ${value}`);
  }
  output.push(
    "# HELP workstrand_prometheus_series_dropped_total Series rejected by the fixed in-memory cardinality cap.",
    "# TYPE workstrand_prometheus_series_dropped_total counter",
    `workstrand_prometheus_series_dropped_total ${dropped}`,
    ""
  );
  return output.join("\n");
}

export class ObservabilityManager {
  private meterProvider: MeterProvider | undefined;
  private tracerProvider: BasicTracerProvider | undefined;
  private modelScanTimer: NodeJS.Timeout | undefined;
  private readonly activeToolSpans = new Map<string, Span>();
  private readonly seenModelCalls = new Set<string>();
  private runtimeListener: ((event: RuntimeEvent) => void) | undefined;

  constructor(
    private readonly database: KestrelDatabase,
    private readonly runtime: AgentRuntime,
    private readonly now: () => Date = () => new Date()
  ) {
    for (const call of database.listAllModelCallAudits()) this.seenModelCalls.add(call.id);
    this.start();
  }

  configuration(): ObservabilityConfiguration {
    const stored = this.database.getPrivateState<ObservabilityConfiguration>(CONFIGURATION_KEY);
    return stored ? validateConfiguration(stored) : structuredClone(DEFAULT_OBSERVABILITY_CONFIGURATION);
  }

  status(): ObservabilityStatus {
    const configuration = this.configuration();
    const exported = this.database.getState<StoredExportStatus>(STATUS_KEY);
    const hasHeaderValue = Boolean(this.database.getPrivateState<string>(HEADER_VALUE_KEY));
    return {
      running: Boolean(configuration.enabled && ((configuration.otlp.enabled && (this.meterProvider || this.tracerProvider)) || configuration.prometheus.enabled)),
      otlpConfigured: Boolean(configuration.otlp.enabled && configuration.otlp.endpoint),
      prometheusAvailable: Boolean(configuration.enabled && configuration.prometheus.enabled),
      hasHeaderValue,
      detail: !configuration.enabled
        ? "Disabled; no diagnostics leave this Mac."
        : configuration.otlp.enabled
          ? "Content-free OTLP protobuf export is active; authenticated Prometheus is available when enabled through remote serve."
          : "Content-free Prometheus metrics are available through authenticated remote serve.",
      ...(exported ? { lastExportAt: exported.at, lastExportState: exported.state } : {})
    };
  }

  prometheusEnabled(): boolean {
    const configuration = this.configuration();
    return configuration.enabled && configuration.prometheus.enabled;
  }

  prometheus(): string {
    if (!this.prometheusEnabled()) return "";
    return renderPrometheusMetrics(this.database);
  }

  async configure(configuration: ObservabilityConfiguration, headerValue?: string): Promise<void> {
    const normalized = validateConfiguration(configuration);
    if (headerValue !== undefined) {
      const clean = headerValue.trim();
      if (!clean || clean.length > 20_000 || /[\r\n\0]/.test(clean)) throw new Error("The OTLP header value is invalid.");
      this.database.setPrivateState(HEADER_VALUE_KEY, clean);
    }
    this.database.setPrivateState(CONFIGURATION_KEY, normalized);
    await this.restart();
  }

  async test(): Promise<void> {
    const configuration = this.configuration();
    if (!configuration.enabled || !configuration.otlp.enabled) throw new Error("Enable and save OTLP export before testing it.");
    try {
      this.scanModelCalls();
      await Promise.all([this.meterProvider?.forceFlush(), this.tracerProvider?.forceFlush()]);
      this.database.setState(STATUS_KEY, { state: "success", at: this.now().toISOString() } satisfies StoredExportStatus);
    } catch {
      this.database.setState(STATUS_KEY, { state: "error", at: this.now().toISOString() } satisfies StoredExportStatus);
      throw new Error("The OTLP collector did not accept the content-free test export.");
    }
  }

  async shutdown(): Promise<void> {
    if (this.modelScanTimer) clearInterval(this.modelScanTimer);
    this.modelScanTimer = undefined;
    if (this.runtimeListener) this.runtime.off("event", this.runtimeListener);
    this.runtimeListener = undefined;
    for (const span of this.activeToolSpans.values()) span.end();
    this.activeToolSpans.clear();
    const meter = this.meterProvider;
    const tracer = this.tracerProvider;
    this.meterProvider = undefined;
    this.tracerProvider = undefined;
    await Promise.all([meter?.shutdown(), tracer?.shutdown()]);
  }

  private start(): void {
    const configuration = this.configuration();
    if (!configuration.enabled || !configuration.otlp.enabled) return;
    const endpoint = validateEndpoint(configuration.otlp.endpoint);
    const headerValue = this.database.getPrivateState<string>(HEADER_VALUE_KEY);
    const headers = headerValue ? { [configuration.otlp.headerName]: headerValue } : {};
    const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: configuration.otlp.serviceName });
    if (configuration.otlp.metrics) {
      const exporter = new OTLPMetricExporter({ url: signalEndpoint(endpoint, "metrics"), headers, timeoutMillis: 10_000 });
      const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: configuration.otlp.exportIntervalMs, exportTimeoutMillis: 10_000 });
      this.meterProvider = new MeterProvider({ resource, readers: [reader] });
      this.registerMetrics(this.meterProvider);
    }
    if (configuration.otlp.traces) {
      const exporter = new OTLPTraceExporter({ url: signalEndpoint(endpoint, "traces"), headers, timeoutMillis: 10_000 });
      this.tracerProvider = new BasicTracerProvider({
        resource,
        sampler: new TraceIdRatioBasedSampler(configuration.otlp.sampleRate),
        spanProcessors: [new BatchSpanProcessor(exporter, { maxQueueSize: 2_048, maxExportBatchSize: 256, scheduledDelayMillis: Math.min(configuration.otlp.exportIntervalMs, 5_000), exportTimeoutMillis: 10_000 })],
        spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 128, eventCountLimit: 16, linkCountLimit: 0 }
      });
      this.attachTraces(this.tracerProvider);
    }
    this.modelScanTimer = setInterval(() => this.scanModelCalls(), Math.max(1_000, configuration.otlp.exportIntervalMs));
    this.modelScanTimer.unref();
  }

  private async restart(): Promise<void> {
    await this.shutdown();
    this.start();
  }

  private registerMetrics(provider: MeterProvider): void {
    const meter = provider.getMeter("workstrand.observability", "0.1.0");
    const aggregate = [
      ["workstrand.sessions", "Durable task sessions.", (value: ReturnType<KestrelDatabase["organizationAnalytics"]>) => value.sessions],
      ["workstrand.messages", "Durable message envelopes without message content.", (value: ReturnType<KestrelDatabase["organizationAnalytics"]>) => value.messages],
      ["workstrand.runs", "Agent runs.", (value: ReturnType<KestrelDatabase["organizationAnalytics"]>) => value.runs],
      ["workstrand.tool.executions", "Tool executions.", (value: ReturnType<KestrelDatabase["organizationAnalytics"]>) => value.toolExecutions],
      ["workstrand.model.calls", "Provider model requests.", (value: ReturnType<KestrelDatabase["organizationAnalytics"]>) => value.modelCalls],
      ["workstrand.model.failures", "Failed provider model requests.", (value: ReturnType<KestrelDatabase["organizationAnalytics"]>) => value.failedModelCalls],
      ["workstrand.model.input_tokens", "Provider-reported input tokens.", (value: ReturnType<KestrelDatabase["organizationAnalytics"]>) => value.inputTokens],
      ["workstrand.model.output_tokens", "Provider-reported output tokens.", (value: ReturnType<KestrelDatabase["organizationAnalytics"]>) => value.outputTokens]
    ] as const;
    for (const [name, description, select] of aggregate) {
      meter.createObservableCounter(name, { description }).addCallback((result) => result.observe(select(this.database.organizationAnalytics())));
    }
    meter.createObservableCounter("workstrand.model.cost_usd", { description: "Configured-rate estimated model spend.", unit: "USD" })
      .addCallback((result) => result.observe(this.database.organizationAnalytics().estimatedCostUsd));
    meter.createObservableGauge("workstrand.process.memory_bytes", { description: "Current exporter process memory.", unit: "By" })
      .addCallback((result) => {
        const memory = process.memoryUsage();
        result.observe(memory.rss, { kind: "rss" });
        result.observe(memory.heapUsed, { kind: "heap_used" });
        result.observe(memory.heapTotal, { kind: "heap_total" });
        result.observe(memory.external, { kind: "external" });
        result.observe(memory.arrayBuffers, { kind: "array_buffers" });
      });
  }

  private attachTraces(provider: BasicTracerProvider): void {
    const tracer = provider.getTracer("workstrand.runtime", "0.1.0");
    this.runtimeListener = (event) => {
      if (event.type === "tool.progress") return;
      const toolName = typeof event.payload.toolName === "string" ? boundedLabel(event.payload.toolName) : "unknown";
      if (event.type === "tool.started" && event.executionId) {
        this.activeToolSpans.set(event.executionId, tracer.startSpan("workstrand.tool.execution", {
          attributes: { "gen_ai.tool.name": toolName, "workstrand.outcome": "started" },
          startTime: new Date(event.createdAt)
        }));
        return;
      }
      if (event.type === "tool.completed" && event.executionId) {
        const span = this.activeToolSpans.get(event.executionId) ?? tracer.startSpan("workstrand.tool.execution", { attributes: { "gen_ai.tool.name": toolName }, startTime: new Date(event.createdAt) });
        const outcome = typeof event.payload.status === "string" ? boundedLabel(event.payload.status) : "unknown";
        span.setAttribute("workstrand.outcome", outcome);
        if (outcome === "failed" || outcome === "blocked") span.setStatus({ code: SpanStatusCode.ERROR });
        span.end(new Date(event.createdAt));
        this.activeToolSpans.delete(event.executionId);
        return;
      }
      const span = tracer.startSpan(`workstrand.${event.type}`, {
        attributes: event.type === "message.appended" && typeof event.payload.role === "string"
          ? { "workstrand.message.role": boundedLabel(event.payload.role) }
          : {},
        startTime: new Date(event.createdAt)
      });
      span.end(new Date(event.createdAt));
    };
    this.runtime.on("event", this.runtimeListener);
  }

  private scanModelCalls(): void {
    if (!this.tracerProvider) return;
    const tracer = this.tracerProvider.getTracer("workstrand.model", "0.1.0");
    const calls = this.database.listAllModelCallAudits();
    const liveIds = new Set(calls.map((call) => call.id));
    for (const id of this.seenModelCalls) {
      if (!liveIds.has(id)) this.seenModelCalls.delete(id);
    }
    for (const call of calls) {
      if (this.seenModelCalls.has(call.id)) continue;
      this.seenModelCalls.add(call.id);
      const span = tracer.startSpan("workstrand.model.call", {
        attributes: {
          "gen_ai.provider.name": boundedLabel(call.providerId),
          "gen_ai.request.model": boundedLabel(call.model),
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": call.inputTokens,
          "gen_ai.usage.output_tokens": call.outputTokens,
          "workstrand.model.duration_ms": call.durationMs,
          "workstrand.outcome": call.status === "completed" ? "success" : "error"
        },
        startTime: new Date(call.startedAt)
      });
      if (call.status === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
      span.end(new Date(call.completedAt));
    }
  }
}
