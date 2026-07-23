import { describe, expect, it } from "vitest";
import { parseCliArguments } from "./arguments";

describe("Kestrel CLI arguments", () => {
  it("parses run and session commands without evaluating shell text", () => {
    expect(
      parseCliArguments([
        "run",
        "--session",
        "s-1",
        "--prompt",
        "inspect; rm -rf nope",
        "--model",
        "local",
        "--providers",
        "ollama,openai",
      ]),
    ).toEqual({
      name: "run",
      sessionId: "s-1",
      prompt: "inspect; rm -rf nope",
      model: "local",
      providers: ["ollama", "openai"],
    });
    expect(
      parseCliArguments([
        "session",
        "create",
        "--title",
        "Project",
        "--workspace",
        "/tmp/project",
      ]),
    ).toEqual({
      name: "session-create",
      title: "Project",
      workspace: "/tmp/project",
    });
    expect(
      parseCliArguments([
        "session",
        "checkpoint",
        "--session",
        "s-1",
        "--summary",
        "safe point",
      ]),
    ).toEqual({
      name: "session-checkpoint",
      sessionId: "s-1",
      summary: "safe point",
    });
    expect(
      parseCliArguments([
        "session",
        "restore",
        "--session",
        "s-1",
        "--checkpoint",
        "checkpoint-1",
      ]),
    ).toEqual({
      name: "session-restore",
      sessionId: "s-1",
      checkpointId: "checkpoint-1",
    });
    expect(
      parseCliArguments([
        "retry",
        "--session",
        "s-1",
        "--model",
        "local",
        "--providers",
        "ollama",
      ]),
    ).toEqual({
      name: "retry",
      sessionId: "s-1",
      model: "local",
      providers: ["ollama"],
    });
    expect(
      parseCliArguments(["resume", "--run", "r-1", "--decision", "rejected"]),
    ).toEqual({ name: "resume", runId: "r-1", decision: "rejected" });
    expect(
      parseCliArguments([
        "acp",
        "--model",
        "model-1",
        "--providers",
        "openai,ollama",
        "--workspace",
        "/tmp/project",
      ]),
    ).toEqual({
      name: "acp",
      model: "model-1",
      providers: ["openai", "ollama"],
      workspace: "/tmp/project",
    });
    expect(
      parseCliArguments([
        "automation",
        "schedule",
        "--session",
        "s-1",
        "--title",
        "Digest",
        "--prompt",
        "Summarize",
        "--model",
        "local",
        "--providers",
        "ollama",
        "--when",
        "*/15 * * * *",
      ]),
    ).toEqual({
      name: "automation-schedule",
      sessionId: "s-1",
      title: "Digest",
      prompt: "Summarize",
      model: "local",
      providers: ["ollama"],
      expression: "*/15 * * * *",
    });
    expect(
      parseCliArguments([
        "automation",
        "schedule",
        "--session",
        "s-1",
        "--title",
        "Digest",
        "--prompt",
        "Summarize",
        "--model",
        "local",
        "--providers",
        "ollama",
        "--interval-seconds",
        "900",
      ]),
    ).toMatchObject({
      name: "automation-schedule",
      expression: "every 900 seconds",
    });
    expect(parseCliArguments(["skin", "list"])).toEqual({ name: "skin-list" });
    expect(parseCliArguments(["skin", "select", "--id", "slate"])).toEqual({
      name: "skin-select",
      skinId: "slate",
    });
    expect(
      parseCliArguments(["skin", "import", "--path", "/tmp/field-notes.json"]),
    ).toEqual({ name: "skin-import", path: "/tmp/field-notes.json" });
    expect(parseCliArguments(["pets", "list", "cat", "--limit", "12"])).toEqual(
      { name: "pet-list", query: "cat", limit: 12, installed: false },
    );
    expect(parseCliArguments(["pets", "list", "--installed"])).toEqual({
      name: "pet-list",
      query: "",
      limit: 24,
      installed: true,
    });
    expect(
      parseCliArguments([
        "pets",
        "install",
        "paperclip",
        "--select",
        "--force",
      ]),
    ).toEqual({
      name: "pet-install",
      slug: "paperclip",
      select: true,
      force: true,
    });
    expect(
      parseCliArguments([
        "pets",
        "show",
        "paperclip",
        "--state",
        "review",
        "--mode",
        "unicode",
        "--scale",
        "0.5",
        "--once",
      ]),
    ).toEqual({
      name: "pet-show",
      slug: "paperclip",
      state: "review",
      cycle: false,
      once: true,
      mode: "unicode",
      scale: 0.5,
    });
    expect(
      parseCliArguments([
        "pets",
        "hatch-drafts",
        "--concept",
        "a blue bird",
        "--style",
        "plush",
        "--count",
        "3",
      ]),
    ).toEqual({
      name: "pet-hatch-drafts",
      concept: "a blue bird",
      style: "plush",
      count: 3,
    });
    expect(
      parseCliArguments([
        "pets",
        "hatch",
        "--draft",
        "draft-id",
        "--slug",
        "bluebird",
        "--name",
        "Bluebird",
      ]),
    ).toEqual({
      name: "pet-hatch-complete",
      draftId: "draft-id",
      slug: "bluebird",
      displayName: "Bluebird",
      description: "",
    });
    expect(
      parseCliArguments([
        "remote",
        "serve",
        "--host",
        "0.0.0.0",
        "--trusted-proxy-config",
        "/private/proxy.json",
        "--proxy-terminated-tls",
        "yes",
      ]),
    ).toEqual({
      name: "remote-serve",
      host: "0.0.0.0",
      port: 0,
      allowedOrigins: [],
      trustedProxyConfig: "/private/proxy.json",
      proxyTerminatedTls: true,
      tailscaleMode: "off",
      tailscaleResetOnExit: true,
      tailscalePublicApproved: false,
      bonjourMode: "off",
      bonjourName: "Kestrel",
    });
    expect(
      parseCliArguments([
        "remote",
        "serve",
        "--tailscale",
        "funnel",
        "--tailscale-public-ack",
        "public",
        "--tailscale-reset-on-exit",
        "no",
      ]),
    ).toMatchObject({
      name: "remote-serve",
      host: "127.0.0.1",
      tailscaleMode: "funnel",
      tailscaleResetOnExit: false,
      tailscalePublicApproved: true,
    });
  });

  it("rejects missing values and unknown commands", () => {
    expect(() => parseCliArguments(["run", "--session"])).toThrow(
      "Missing value",
    );
    expect(() => parseCliArguments(["jobs", "--force", "yes"])).toThrow(
      "Unknown option",
    );
    expect(() =>
      parseCliArguments(["resume", "--run", "r-1", "--decision", "maybe"]),
    ).toThrow("approved or rejected");
    expect(() => parseCliArguments(["destroy"])).toThrow("Unknown command");
    expect(() =>
      parseCliArguments([
        "automation",
        "schedule",
        "--session",
        "s-1",
        "--title",
        "Digest",
        "--prompt",
        "Summarize",
        "--model",
        "local",
        "--providers",
        "ollama",
        "--at",
        "2030-01-01T00:00:00Z",
        "--when",
        "every 1 hour",
      ]),
    ).toThrow("exactly one");
    expect(() =>
      parseCliArguments(["remote", "serve", "--proxy-terminated-tls", "yes"]),
    ).toThrow("requires --trusted-proxy-config");
    expect(() =>
      parseCliArguments(["remote", "serve", "--tailscale", "funnel"]),
    ).toThrow("requires --tailscale-public-ack public");
    expect(() =>
      parseCliArguments([
        "remote",
        "serve",
        "--bonjour",
        "minimal",
        "--bonjour-cli-path",
        "/private/bin",
      ]),
    ).toThrow("require --bonjour full");
    expect(() => parseCliArguments(["skin", "select"])).toThrow(
      "Missing required --id",
    );
    expect(() => parseCliArguments(["pets", "scale", "0.05"])).toThrow(
      "0.1 through 3",
    );
  });
});
