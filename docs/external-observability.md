# External observability

Kestrel exports operational evidence without exporting work content. External observability is off by default and can be enabled in **Settings → External observability**.

## Hard privacy boundary

The exporter is built from typed database counts and bounded runtime lifecycle events. It has no content-capture option. It never exports:

- prompt, response, system-prompt, reasoning, or message text;
- tool inputs, outputs, progress payloads, or error bodies;
- session, run, message, call, tool-call, or upstream request identifiers;
- workspace names, file paths, hostnames, user names, or project titles;
- API keys, OAuth records, collector credentials, or other secret values.

Provider and model names plus tool names are the only dynamic labels. Values must satisfy a short low-cardinality character policy or become `unknown`. Prometheus output has a fixed 2,048-series cap.

## OpenTelemetry

Kestrel uses the official OpenTelemetry JavaScript SDK and sends OTLP over HTTP with protobuf bodies:

- `<collector base>/v1/metrics`
- `<collector base>/v1/traces`

The collector must use HTTPS. Plain HTTP is accepted only for `127.0.0.1`, `::1`, or `localhost`. URLs containing credentials, query parameters, or fragments are rejected.

Metrics contain durable counts, provider-reported token use, configured-rate cost estimates, and process memory. Runtime traces cover session lifecycle, message envelope roles, tool duration/outcome, and model-call metadata. Trace sampling is configurable from 0 to 1; metrics remain cumulative.

One custom collector header can be configured. Its value is stored in the encrypted private database state, passed only to the OTLP exporters, and never returned to the renderer.

Use **Test collector** after saving. The test forces both enabled pipelines to flush and stores only a success/error state and timestamp.

## Prometheus

Enable Prometheus in Settings, then run the authenticated remote server against the same Kestrel data directory. Scrape:

```text
GET /v1/diagnostics/prometheus
Authorization: Bearer <paired read-scope token>
```

The response uses `text/plain; version=0.0.4; charset=utf-8`. The route has no unauthenticated mode and is not exposed as a public `/metrics` endpoint. Non-loopback remote serving already requires TLS.

Counters reset with a new local database or retention cleanup. Dashboards should use `rate()` and `increase()` where resets matter.

## Recovery

Disable the top-level switch to stop OTLP readers and trace processors immediately. The encrypted configuration remains available for re-enabling. Replacing the header value is write-only; it is never displayed again.
