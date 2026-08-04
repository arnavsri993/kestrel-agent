import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSubscriptionProvider } from "./subscription-cli";
import { textContent } from "./types";

const roots: string[] = [];

async function fakeCli(): Promise<{ executable: string; capture: string }> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-claude-fake-"));
  roots.push(root);
  const executable = join(root, "claude");
  const capture = `${executable}.capture.json`;
  const body = `#!/usr/bin/env node
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
  it("delegates to Claude subscription auth with customizations and tools disabled", async () => {
    const fake = await fakeCli();
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("normalizes malformed provider timeouts: %s", async (timeoutMs) => {
    const fake = await fakeCli();
    const provider = new ClaudeSubscriptionProvider({ executable: fake.executable, timeoutMs });

    await expect(provider.complete({ model: "sonnet", messages: [{ role: "user", content: textContent("Summarize this") }] })).resolves.toMatchObject({
      providerId: "claude-subscription",
      text: "Claude subscription answer"
    });
  });
});
