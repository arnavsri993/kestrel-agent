import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerProvider } from "./codex-app-server";
import { textContent } from "./types";

const roots: string[] = [];

async function fakeAppServer(): Promise<{
  executable: string;
  capture: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-codex-app-server-test-"));
  roots.push(root);
  const executable = join(root, "codex");
  const capture = `${executable}.capture.jsonl`;
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const capture = process.argv[1] + ".capture.jsonl";
let turn = 0;
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function record(value) { fs.appendFileSync(capture, JSON.stringify({ pid: process.pid, value }) + "\\n"); }
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  record(message);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" } });
  if (message.method === "initialized") return;
  if (message.method === "account/read") return send({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "thread-1" }, model: message.params.model } });
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === "turn/start") {
    turn += 1;
    const turnId = "turn-" + turn;
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ id: 900 + turn, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId, itemId: "cmd-" + turn, command: "touch forbidden" } });
    return;
  }
  if (typeof message.id === "number" && message.id >= 901) {
    const current = message.id - 900;
    const turnId = "turn-" + current;
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "answer-" + current, delta: "Persistent answer " + current } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId, tokenUsage: { last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: current > 1 ? 5 : 0, reasoningOutputTokens: 1 } } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", error: null } } });
  }
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { executable, capture };
}

async function retryableFakeAppServer(): Promise<{ executable: string }> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-codex-app-server-retry-test-"));
  roots.push(root);
  const executable = join(root, "codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const attemptsPath = process.argv[1] + ".initialize-attempts";
let initialized = false;
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function attempts() {
  const current = Number(fs.existsSync(attemptsPath) ? fs.readFileSync(attemptsPath, "utf8") : "0") + 1;
  fs.writeFileSync(attemptsPath, String(current));
  return current;
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (attempts() === 1) {
      return send({ id: message.id, error: { code: -32000, message: "fake initialize failed" } });
    }
    initialized = true;
    return send({ id: message.id, result: { userAgent: "fake", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" } });
  }
  if (message.method === "initialized") return;
  if (message.method === "account/read" && initialized) {
    return send({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  }
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { executable };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("persistent Codex app-server provider", () => {
  it("restarts after initialization failure instead of reusing an uninitialized process", async () => {
    const fake = await retryableFakeAppServer();
    const provider = new CodexAppServerProvider({
      executable: fake.executable,
      environment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
      requestTimeoutMs: 2_000,
    });

    await expect(provider.probe()).rejects.toThrow("fake initialize failed");
    await expect(provider.probe()).resolves.toBeUndefined();
    await provider.close();
  });

  it("initializes once, preserves a durable thread, streams turns, and declines vendor-side execution", async () => {
    const fake = await fakeAppServer();
    const provider = new CodexAppServerProvider({
      executable: fake.executable,
      environment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENAI_API_KEY: "must-not-leak",
      },
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    });
    await provider.probe();
    const deltas: string[] = [];
    const first = await provider.complete(
      {
        model: "gpt-test",
        metadata: { session_id: "session-1", workspace_root: process.cwd() },
        messages: [
          { role: "system", content: textContent("Private system context") },
          { role: "user", content: textContent("First prompt") },
        ],
      },
      {
        onEvent: (event) => {
          if (event.type === "text_delta") deltas.push(event.delta);
        },
      },
    );
    const second = await provider.complete({
      model: "gpt-test",
      metadata: { session_id: "session-1", workspace_root: process.cwd() },
      messages: [
        { role: "system", content: textContent("Private system context") },
        { role: "user", content: textContent("First prompt") },
        { role: "assistant", content: textContent("Persistent answer 1") },
        { role: "user", content: textContent("Second prompt") },
      ],
    });
    await provider.close();

    expect(first).toMatchObject({
      responseId: "turn-1",
      text: "Persistent answer 1",
      usage: { inputTokens: 12, outputTokens: 3, reasoningTokens: 1 },
    });
    expect(second).toMatchObject({
      responseId: "turn-2",
      text: "Persistent answer 2",
      usage: { cachedInputTokens: 5 },
    });
    expect(deltas.join("")).toBe("Persistent answer 1");

    const records = (await readFile(fake.capture, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            pid: number;
            value: Record<string, unknown> & {
              params?: Record<string, unknown>;
              result?: Record<string, unknown>;
            };
          },
      );
    expect(new Set(records.map((record) => record.pid))).toHaveLength(1);
    expect(
      records.filter((record) => record.value.method === "initialize"),
    ).toHaveLength(1);
    expect(
      records.filter((record) => record.value.method === "thread/start"),
    ).toHaveLength(1);
    const turns = records.filter(
      (record) => record.value.method === "turn/start",
    );
    expect(turns).toHaveLength(2);
    expect(
      (
        (turns[0]!.value.params!.input as Array<{ text: string }>)[0]!.text
      ),
    ).toContain("Private system context");
    expect(
      (
        (turns[1]!.value.params!.input as Array<{ text: string }>)[0]!.text
      ),
    ).toBe("Second prompt");
    expect(
      records.filter(
        (record) =>
          record.value.result &&
          record.value.result.decision === "decline",
      ),
    ).toHaveLength(2);
    expect(
      records.some((record) =>
        JSON.stringify(record.value).includes("must-not-leak"),
      ),
    ).toBe(false);
  });
});
