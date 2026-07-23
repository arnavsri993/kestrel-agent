#!/usr/bin/env node
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined) continue;
  if (message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "kestrel-readiness-fixture" } })}\n`);
  } else if (message.method === "account/read") {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { account: { type: "chatgpt", email: "fixture@example.test" } } })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  }
}
