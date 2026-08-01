import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatGptOAuthManager } from "./chatgpt-oauth";

const roots: string[] = [];

class TrackedAbortSignal {
  aborted = false;
  reason: unknown;
  added = 0;
  removed = 0;
  private readonly listeners = new Set<EventListenerOrEventListenerObject>();

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.added += 1;
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.removed += 1;
    this.listeners.delete(listener);
  }
}

async function fakeCodex(): Promise<{ executable: string; capture: string }> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-chatgpt-oauth-test-"));
  roots.push(root);
  const executable = join(root, "codex");
  const capture = `${executable}.capture.jsonl`;
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const capture = process.argv[1] + ".capture.jsonl";
let connected = false;
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync(capture, JSON.stringify({ message, leaked: process.env.OPENAI_API_KEY || null }) + "\\n");
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "initialized") return;
  if (message.method === "account/read") return send({ id: message.id, result: { account: connected ? { type: "chatgpt", email: "owner@example.com", planType: "plus" } : null, requiresOpenaiAuth: true } });
  if (message.method === "account/login/start") {
    send({ id: message.id, result: { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/oauth/authorize?test=1" } });
    setTimeout(() => {
      connected = true;
      send({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } });
    }, 10);
  }
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { executable, capture };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ChatGPT OAuth through Codex", () => {
  it("opens the official URL, reports the account, and never forwards provider secrets", async () => {
    const fake = await fakeCodex();
    const opened: string[] = [];
    const manager = new ChatGptOAuthManager({
      executable: fake.executable,
      openExternal: async (url) => {
        opened.push(url);
      },
      environment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENAI_API_KEY: "must-not-leak",
      },
      requestTimeoutMs: 5_000,
      loginTimeoutMs: 2_000,
    });

    await expect(manager.connect()).resolves.toEqual({
      connected: true,
      accountType: "chatgpt",
      email: "owner@example.com",
      planType: "plus",
    });
    expect(opened).toEqual([
      "https://auth.openai.com/oauth/authorize?test=1",
    ]);
    const records = (await readFile(fake.capture, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            message: { method?: string; params?: unknown };
            leaked: string | null;
          },
      );
    expect(
      records.find((record) => record.message.method === "account/login/start")
        ?.message.params,
    ).toEqual({ type: "chatgpt" });
    expect(records.every((record) => record.leaked === null)).toBe(true);
  });

  it("removes the caller abort listener when a request times out", async () => {
    const manager = new ChatGptOAuthManager({
      executable: "unused",
      openExternal: async () => undefined,
      requestTimeoutMs: 20,
    });
    const internals = manager as unknown as {
      child: { exitCode: null; stdin: { write(value: string): void } };
      request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    };
    internals.child = { exitCode: null, stdin: { write: () => undefined } };
    const signal = new TrackedAbortSignal();

    await expect(internals.request("account/read", {}, signal as unknown as AbortSignal)).rejects.toThrow("account/read request timed out");
    expect(signal.added).toBe(1);
    expect(signal.removed).toBe(1);
  });
});
