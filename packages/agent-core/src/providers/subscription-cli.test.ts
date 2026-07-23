import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderPool } from "./provider-pool";
import { ClaudeSubscriptionProvider, CodexSubscriptionProvider } from "./subscription-cli";
import { textContent } from "./types";

const roots: string[] = [];

async function fakeCli(kind: "codex" | "claude"): Promise<{ executable: string; capture: string }> {
  const root = await mkdtemp(join(tmpdir(), `kestrel-${kind}-fake-`));
  roots.push(root);
  const executable = join(root, kind);
  const capture = `${executable}.capture.json`;
  const body = kind === "codex" ? `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "login") { process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(process.argv[1] + ".capture.json", JSON.stringify({ args, input, leaked: process.env.OPENAI_API_KEY }));
  const outputIndex = args.indexOf("--output-last-message");
  fs.writeFileSync(args[outputIndex + 1], "Codex subscription answer");
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 4 } }) + "\\n");
});
` : `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true, subscriptionType: "max" }) + "\\n"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(process.argv[1] + ".capture.json", JSON.stringify({ args, input, leaked: process.env.ANTHROPIC_API_KEY }));
  process.stdout.write(JSON.stringify({ type: "stream_event", session_id: "claude-session", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Claude " } } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "stream_event", session_id: "claude-session", event: { type: "content_block_delta", delta: { type: "text_delta", text: "subscription answer" } } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", session_id: "claude-session", result: "Claude subscription answer", usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 2 } }) + "\\n");
});
`;
  await writeFile(executable, body, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, capture };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("vendor subscription CLI providers", () => {
  it("delegates to the authenticated Codex CLI in an ephemeral read-only workspace", async () => {
    const fake = await fakeCli("codex");
    const provider = new CodexSubscriptionProvider({ executable: fake.executable, environment: { PATH: process.env.PATH, HOME: process.env.HOME, OPENAI_API_KEY: "must-not-leak" } });
    await expect(provider.probe()).resolves.toBeUndefined();
    const deltas: string[] = [];
    const result = await provider.complete({ model: "gpt-test", messages: [{ role: "user", content: textContent("Explain the result") }] }, { onEvent: (event) => { if (event.type === "text_delta") deltas.push(event.delta); } });
    const capture = JSON.parse(await readFile(fake.capture, "utf8")) as { args: string[]; input: string; leaked?: string };
    expect(capture.args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--skip-git-repo-check", "--model", "gpt-test", "-"]));
    expect(capture.args.join(" ")).not.toContain("Explain the result");
    expect(capture.input).toContain("Explain the result");
    expect(capture.leaked).toBeUndefined();
    expect(result).toMatchObject({ providerId: "codex-subscription", responseId: "codex-thread", text: "Codex subscription answer", usage: { inputTokens: 11, outputTokens: 4 }, toolCalls: [] });
    expect(deltas).toEqual(["Codex subscription answer"]);
  });

  it("delegates to Claude subscription auth with customizations and tools disabled", async () => {
    const fake = await fakeCli("claude");
    const provider = new ClaudeSubscriptionProvider({ executable: fake.executable, environment: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: "must-not-leak" } });
    await expect(provider.probe()).resolves.toBeUndefined();
    const deltas: string[] = [];
    const result = await provider.complete({ model: "sonnet", messages: [{ role: "user", content: textContent("Summarize this") }] }, { onEvent: (event) => { if (event.type === "text_delta") deltas.push(event.delta); } });
    const capture = JSON.parse(await readFile(fake.capture, "utf8")) as { args: string[]; input: string; leaked?: string };
    expect(capture.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--no-session-persistence", "--permission-mode", "plan", "--max-turns", "1", "--safe-mode", "--tools", "", "--strict-mcp-config"]));
    expect(capture.args).not.toContain("--bare");
    expect(capture.input).toContain("Summarize this");
    expect(capture.leaked).toBeUndefined();
    expect(result).toMatchObject({ providerId: "claude-subscription", responseId: "claude-session", text: "Claude subscription answer", usage: { inputTokens: 9, outputTokens: 3, cachedInputTokens: 2 }, toolCalls: [] });
    expect(deltas).toEqual(["Claude ", "subscription answer"]);
  });

  it("strips Workstrand tool definitions before invoking a text-only subscription provider", async () => {
    const fake = await fakeCli("codex");
    const pool = new ProviderPool([new CodexSubscriptionProvider({ executable: fake.executable, environment: { PATH: process.env.PATH, HOME: process.env.HOME } })]);
    const result = await pool.complete({ model: "gpt-test", messages: [{ role: "user", content: textContent("Answer without tools") }], tools: [{ name: "workspace.read", description: "Read", inputSchema: { type: "object" } }] });
    expect(result.result).toMatchObject({ providerId: "codex-subscription", text: "Codex subscription answer", toolCalls: [] });
    expect((JSON.parse(await readFile(fake.capture, "utf8")) as { input: string }).input).not.toContain("workspace.read");
  });
});
