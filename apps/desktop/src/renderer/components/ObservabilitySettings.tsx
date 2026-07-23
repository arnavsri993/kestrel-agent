import { useEffect, useState } from "react";
import type { ObservabilityConfiguration, ObservabilityStatus } from "@kestrel/shared-types";

const EMPTY: ObservabilityConfiguration = {
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

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export function ObservabilitySettings() {
  const [configuration, setConfiguration] = useState<ObservabilityConfiguration>(() => structuredClone(EMPTY));
  const [status, setStatus] = useState<ObservabilityStatus | null>(null);
  const [headerValue, setHeaderValue] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function receive(response: Awaited<ReturnType<typeof window.kestrel.request>>) {
    if (!response.ok) throw new Error(response.error);
    if ("observabilityConfiguration" in response && response.observabilityConfiguration && response.observabilityStatus) {
      setConfiguration(response.observabilityConfiguration);
      setStatus(response.observabilityStatus);
    }
  }

  useEffect(() => {
    void window.kestrel.request({ type: "observability-get" }).then(receive)
      .catch((cause) => setError(errorMessage(cause, "Observability status failed.")));
  }, []);

  async function save() {
    setBusy("save"); setError(""); setNotice("");
    try {
      const saved = await window.kestrel.request({
        type: "observability-set",
        configuration,
        ...(headerValue.trim() ? { headerValue: headerValue.trim() } : {})
      });
      receive(saved);
      setHeaderValue("");
      setNotice(configuration.enabled ? "Observability configuration saved and applied." : "External observability disabled.");
    } catch (cause) {
      setError(errorMessage(cause, "Observability configuration could not be saved."));
    } finally {
      setBusy("");
    }
  }

  async function testCollector() {
    setBusy("test"); setError(""); setNotice("");
    try {
      const checked = await window.kestrel.request({ type: "observability-test" });
      receive(checked);
      setNotice("Collector accepted content-free OTLP metrics and traces.");
    } catch (cause) {
      setError(errorMessage(cause, "Collector test failed."));
    } finally {
      setBusy("");
    }
  }

  const canSave = !configuration.enabled || configuration.prometheus.enabled || configuration.otlp.enabled;
  const canTest = configuration.enabled && configuration.otlp.enabled && Boolean(configuration.otlp.endpoint) && (configuration.otlp.metrics || configuration.otlp.traces);

  return <article className="setting-row observability-setting">
    <div>
      <strong>External observability</strong>
      <p>Export bounded operational counts to your own monitoring stack. Prompt and response text, tool payloads, session IDs, paths, hostnames, and credentials are never eligible for export.</p>
      <label className="checkbox-label"><input type="checkbox" checked={configuration.enabled} onChange={(event) => setConfiguration((current) => ({ ...current, enabled: event.target.checked }))} /><span>Enable content-free diagnostics</span></label>
      {configuration.enabled && <div className="observability-controls">
        <details open={configuration.otlp.enabled}>
          <summary><span><b>OpenTelemetry · OTLP/HTTP protobuf</b><small>Push metrics and sampled runtime traces to an HTTPS or loopback collector.</small></span><span className={`external-secret-state ${configuration.otlp.enabled ? "ready" : "disabled"}`}>{configuration.otlp.enabled ? "enabled" : "disabled"}</span></summary>
          <div className="observability-form">
            <label className="checkbox-label"><input type="checkbox" checked={configuration.otlp.enabled} onChange={(event) => setConfiguration((current) => ({ ...current, otlp: { ...current.otlp, enabled: event.target.checked } }))} /><span>Enable OTLP push</span></label>
            <div className="external-secret-grid">
              <label className="wide">Collector base URL <input value={configuration.otlp.endpoint} placeholder="https://collector.example.com:4318" autoComplete="off" spellCheck={false} onChange={(event) => setConfiguration((current) => ({ ...current, otlp: { ...current.otlp, endpoint: event.target.value } }))} /></label>
              <label>Service name <input value={configuration.otlp.serviceName} autoComplete="off" spellCheck={false} onChange={(event) => setConfiguration((current) => ({ ...current, otlp: { ...current.otlp, serviceName: event.target.value } }))} /></label>
              <label>Export interval <select value={configuration.otlp.exportIntervalMs} onChange={(event) => setConfiguration((current) => ({ ...current, otlp: { ...current.otlp, exportIntervalMs: Number(event.target.value) } }))}><option value={10_000}>10 seconds</option><option value={30_000}>30 seconds</option><option value={60_000}>1 minute</option><option value={300_000}>5 minutes</option></select></label>
              <label>Auth header name <input value={configuration.otlp.headerName} autoComplete="off" spellCheck={false} onChange={(event) => setConfiguration((current) => ({ ...current, otlp: { ...current.otlp, headerName: event.target.value } }))} /></label>
              <label>Auth header value <input type="password" value={headerValue} placeholder={status?.hasHeaderValue ? "Stored; enter a replacement" : "Optional collector credential"} autoComplete="new-password" spellCheck={false} onChange={(event) => setHeaderValue(event.target.value)} /></label>
              <label>Trace sample rate · 0 to 1 <input type="number" min={0} max={1} step={0.05} inputMode="decimal" value={configuration.otlp.sampleRate} onChange={(event) => setConfiguration((current) => ({ ...current, otlp: { ...current.otlp, sampleRate: Number(event.target.value) } }))} /></label>
            </div>
            <div className="observability-signal-row">
              <label className="checkbox-label"><input type="checkbox" checked={configuration.otlp.metrics} onChange={(event) => setConfiguration((current) => ({ ...current, otlp: { ...current.otlp, metrics: event.target.checked } }))} /><span>Metrics</span></label>
              <label className="checkbox-label"><input type="checkbox" checked={configuration.otlp.traces} onChange={(event) => setConfiguration((current) => ({ ...current, otlp: { ...current.otlp, traces: event.target.checked } }))} /><span>Traces</span></label>
            </div>
            <small>Kestrel appends <code>/v1/metrics</code> and <code>/v1/traces</code>. The auth value is encrypted and never read back.</small>
          </div>
        </details>
        <details open={configuration.prometheus.enabled}>
          <summary><span><b>Prometheus</b><small>Pull metrics through the authenticated remote operator endpoint.</small></span><span className={`external-secret-state ${configuration.prometheus.enabled ? "ready" : "disabled"}`}>{configuration.prometheus.enabled ? "enabled" : "disabled"}</span></summary>
          <div className="observability-form">
            <label className="checkbox-label"><input type="checkbox" checked={configuration.prometheus.enabled} onChange={(event) => setConfiguration((current) => ({ ...current, prometheus: { enabled: event.target.checked } }))} /><span>Expose metrics when remote serve is running</span></label>
            <small>Scrape <code>GET /v1/diagnostics/prometheus</code> with a paired read-scope bearer token. There is no public unauthenticated metrics route, and new series are capped at 2,048.</small>
          </div>
        </details>
      </div>}
      <div className="button-row observability-actions">
        <button className="button secondary" disabled={Boolean(busy) || !canSave} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save observability"}</button>
        <button className="button primary" disabled={Boolean(busy) || !canTest} onClick={() => void testCollector()}>{busy === "test" ? "Sending test…" : "Test collector"}</button>
      </div>
      <div className="observability-feedback" aria-live="polite">
        {status && <small>{status.detail}{status.lastExportAt ? ` Last ${status.lastExportState} test: ${new Date(status.lastExportAt).toLocaleString()}.` : ""}</small>}
        {notice && <small role="status">{notice}</small>}
        {error && <small role="alert">{error}</small>}
      </div>
    </div>
    <span className="status">{status?.running ? "Active" : "Off"}</span>
  </article>;
}
