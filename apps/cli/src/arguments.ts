export type CliCommand =
  | { name: "help" }
  | { name: "session-list" }
  | { name: "session-create"; title: string; workspace?: string }
  | { name: "session-fork"; sessionId: string; title?: string }
  | { name: "session-checkpoint"; sessionId: string; summary: string }
  | { name: "session-restore"; sessionId: string; checkpointId: string }
  | { name: "session-resume"; sessionId: string }
  | { name: "session-cancel"; sessionId: string }
  | { name: "session-messages"; sessionId: string }
  | { name: "tools"; sessionId: string; query?: string }
  | { name: "run"; sessionId: string; prompt: string; model: string; providers: string[] }
  | { name: "retry"; sessionId: string; model: string; providers: string[] }
  | { name: "resume"; runId: string; decision: "approved" | "rejected" }
  | { name: "jobs" }
  | { name: "automation-schedule"; sessionId: string; title: string; prompt: string; model: string; providers: string[]; expression: string }
  | { name: "automation-cancel"; jobId: string }
  | { name: "automation-run-due" }
  | { name: "automation-serve"; pollMs: number }
  | { name: "migration-plan"; product: "openclaw" | "hermes" | "codex" | "claude-code"; source: string; target: string }
  | { name: "migration-apply"; planPath: string; overwrite: boolean }
  | { name: "remote-pair"; label: string; scopes: Array<"read" | "tasks" | "approve">; lifetimeMs: number }
  | { name: "remote-revoke"; deviceId: string }
  | { name: "remote-serve"; host: string; port: number; tlsKey?: string; tlsCert?: string; allowedOrigins: string[] }
  | { name: "tui"; model?: string; providers?: string[]; workspace?: string }
  | { name: "acp"; model?: string; providers?: string[]; workspace?: string };

function options(args: string[], allowed: string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const item = args[index];
    const value = args[index + 1];
    if (!item?.startsWith("--")) throw new Error(`Unexpected argument ${item ?? ""}.`);
    const name = item.slice(2);
    if (!allowed.includes(name)) throw new Error(`Unknown option --${name}.`);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${item}.`);
    if (output.has(name)) throw new Error(`Duplicate option --${name}.`);
    output.set(name, value);
  }
  return output;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required --${name}.`);
  return value;
}

function modelOptions(values: Map<string, string>) {
  const model = values.get("model");
  const providerValue = values.get("providers");
  const workspace = values.get("workspace");
  return {
    ...(model ? { model } : {}),
    ...(providerValue ? { providers: providerValue.split(",").map((value) => value.trim()).filter(Boolean) } : {}),
    ...(workspace ? { workspace } : {})
  };
}

export function parseCliArguments(input: string[]): CliCommand {
  let args = input;
  if (args[0] === "--") args = args.slice(1);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") return { name: "help" };
  if (args[0] === "session") {
    const action = args[1];
    if (action === "list") { options(args.slice(2), []); return { name: "session-list" }; }
    if (action === "create") {
      const values = options(args.slice(2), ["title", "workspace"]);
      const workspace = values.get("workspace");
      return { name: "session-create", title: required(values, "title"), ...(workspace ? { workspace } : {}) };
    }
    if (action === "fork") {
      const values = options(args.slice(2), ["session", "title"]);
      const title = values.get("title");
      return { name: "session-fork", sessionId: required(values, "session"), ...(title ? { title } : {}) };
    }
    if (action === "checkpoint") { const values = options(args.slice(2), ["session", "summary"]); return { name: "session-checkpoint", sessionId: required(values, "session"), summary: required(values, "summary") }; }
    if (action === "restore") { const values = options(args.slice(2), ["session", "checkpoint"]); return { name: "session-restore", sessionId: required(values, "session"), checkpointId: required(values, "checkpoint") }; }
    if (action === "resume") { const values = options(args.slice(2), ["session"]); return { name: "session-resume", sessionId: required(values, "session") }; }
    if (action === "cancel") { const values = options(args.slice(2), ["session"]); return { name: "session-cancel", sessionId: required(values, "session") }; }
    if (action === "messages") { const values = options(args.slice(2), ["session"]); return { name: "session-messages", sessionId: required(values, "session") }; }
    throw new Error("Unknown session command.");
  }
  if (args[0] === "tools") {
    const values = options(args.slice(1), ["session", "query"]);
    const query = values.get("query");
    return { name: "tools", sessionId: required(values, "session"), ...(query ? { query } : {}) };
  }
  if (args[0] === "run") {
    const values = options(args.slice(1), ["session", "prompt", "model", "providers"]);
    return { name: "run", sessionId: required(values, "session"), prompt: required(values, "prompt"), model: required(values, "model"), providers: required(values, "providers").split(",").map((value) => value.trim()).filter(Boolean) };
  }
  if (args[0] === "retry") {
    const values = options(args.slice(1), ["session", "model", "providers"]);
    return { name: "retry", sessionId: required(values, "session"), model: required(values, "model"), providers: required(values, "providers").split(",").map((value) => value.trim()).filter(Boolean) };
  }
  if (args[0] === "resume") {
    const values = options(args.slice(1), ["run", "decision"]);
    const decision = values.get("decision") ?? "approved";
    if (decision !== "approved" && decision !== "rejected") throw new Error("--decision must be approved or rejected.");
    return { name: "resume", runId: required(values, "run"), decision };
  }
  if (args[0] === "jobs") { options(args.slice(1), []); return { name: "jobs" }; }
  if (args[0] === "automation") {
    const action = args[1];
    if (action === "schedule") {
      const values = options(args.slice(2), ["session", "title", "prompt", "model", "providers", "at", "when", "interval-seconds"]);
      const at = values.get("at");
      const when = values.get("when");
      const intervalValue = values.get("interval-seconds");
      const intervalSeconds = intervalValue ? Number(intervalValue) : undefined;
      if (intervalSeconds !== undefined && (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 31_536_000)) throw new Error("--interval-seconds must be from 60 through 31536000.");
      if ([at, when, intervalValue].filter(Boolean).length !== 1) throw new Error("Use exactly one of --when, --at, or --interval-seconds.");
      const expression = intervalSeconds ? `every ${intervalSeconds} seconds` : (when ?? at)!;
      return { name: "automation-schedule", sessionId: required(values, "session"), title: required(values, "title"), prompt: required(values, "prompt"), model: required(values, "model"), providers: required(values, "providers").split(",").map((value) => value.trim()).filter(Boolean), expression };
    }
    if (action === "cancel") { const values = options(args.slice(2), ["job"]); return { name: "automation-cancel", jobId: required(values, "job") }; }
    if (action === "run-due") { options(args.slice(2), []); return { name: "automation-run-due" }; }
    if (action === "serve") {
      const values = options(args.slice(2), ["poll-ms"]);
      const pollMs = Number(values.get("poll-ms") ?? "5000");
      if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 300_000) throw new Error("--poll-ms must be from 250 through 300000.");
      return { name: "automation-serve", pollMs };
    }
    throw new Error("Unknown automation command.");
  }
  if (args[0] === "migration") {
    const action = args[1];
    if (action === "plan") {
      const values = options(args.slice(2), ["product", "source", "target"]);
      const product = required(values, "product");
      if (!["openclaw", "hermes", "codex", "claude-code"].includes(product)) throw new Error("--product is invalid.");
      return { name: "migration-plan", product: product as "openclaw" | "hermes" | "codex" | "claude-code", source: required(values, "source"), target: required(values, "target") };
    }
    if (action === "apply") {
      const values = options(args.slice(2), ["plan", "approve", "overwrite"]);
      if (required(values, "approve") !== "yes") throw new Error("Migration apply requires --approve yes.");
      const overwrite = values.get("overwrite") ?? "no";
      if (overwrite !== "yes" && overwrite !== "no") throw new Error("--overwrite must be yes or no.");
      return { name: "migration-apply", planPath: required(values, "plan"), overwrite: overwrite === "yes" };
    }
    throw new Error("Unknown migration command.");
  }
  if (args[0] === "remote") {
    const action = args[1];
    if (action === "pair") {
      const values = options(args.slice(2), ["label", "scopes", "lifetime-seconds"]);
      const scopes = required(values, "scopes").split(",").map((value) => value.trim()).filter(Boolean);
      if (scopes.length === 0 || scopes.some((scope) => !["read", "tasks", "approve"].includes(scope))) throw new Error("--scopes must contain read, tasks, and/or approve.");
      const lifetimeSeconds = Number(values.get("lifetime-seconds") ?? "300");
      if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 30 || lifetimeSeconds > 600) throw new Error("--lifetime-seconds must be an integer from 30 through 600.");
      return { name: "remote-pair", label: required(values, "label"), scopes: [...new Set(scopes)] as Array<"read" | "tasks" | "approve">, lifetimeMs: lifetimeSeconds * 1_000 };
    }
    if (action === "revoke") {
      const values = options(args.slice(2), ["device"]);
      return { name: "remote-revoke", deviceId: required(values, "device") };
    }
    if (action === "serve") {
      const values = options(args.slice(2), ["host", "port", "tls-key", "tls-cert", "allowed-origins"]);
      const port = Number(values.get("port") ?? "0");
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be an integer from 0 through 65535.");
      const tlsKey = values.get("tls-key");
      const tlsCert = values.get("tls-cert");
      if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error("--tls-key and --tls-cert must be supplied together.");
      const allowedOrigins = (values.get("allowed-origins") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      for (const value of allowedOrigins) {
        const parsed = new URL(value);
        if (parsed.origin !== value || !["https:", "http:"].includes(parsed.protocol)) throw new Error("--allowed-origins must contain exact HTTP(S) origins.");
      }
      return { name: "remote-serve", host: values.get("host") ?? "127.0.0.1", port, allowedOrigins, ...(tlsKey && tlsCert ? { tlsKey, tlsCert } : {}) };
    }
    throw new Error("Unknown remote command.");
  }
  if (args[0] === "tui" || args[0] === "acp") {
    const values = options(args.slice(1), ["model", "providers", "workspace"]);
    return { name: args[0], ...modelOptions(values) };
  }
  throw new Error("Unknown command. Run `kestrel help`.");
}
