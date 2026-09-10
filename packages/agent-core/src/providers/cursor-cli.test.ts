import { chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CursorCliManager,
	CursorSubscriptionProvider,
} from "./cursor-cli";
import { ModelProviderError, textContent } from "./types";

const roots: string[] = [];

async function fakeCursorCli(options: { authenticated?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "kestrel-cursor-fake-"));
	roots.push(root);
	const executable = join(root, "cursor");
	const capture = `${executable}.capture.json`;
	const authenticated = options.authenticated ?? true;
	const body = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const capture = process.argv[1] + ".capture.json";
if (args[0] === "agent" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ status: ${JSON.stringify(authenticated ? "authenticated" : "unauthenticated")}, isAuthenticated: ${authenticated} }) + "\\n");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "login") {
  fs.writeFileSync(capture, JSON.stringify({ login: true, args, leaked: process.env.CURSOR_API_KEY }));
  process.exit(0);
}
if (args[0] === "agent" && args.includes("--list-models")) {
  process.stdout.write(JSON.stringify({ models: [{ id: "gpt-5", displayName: "GPT 5" }] }) + "\\n");
  process.exit(0);
}
fs.writeFileSync(capture, JSON.stringify({ args, cwd: process.cwd(), leaked: process.env.CURSOR_API_KEY }));
process.stdout.write(JSON.stringify({ type: "assistant", sessionId: "cursor-session", delta: "Cursor " }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", delta: "answer" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", result: "Cursor answer" }) + "\\n");
`;
	await writeFile(executable, body, { mode: 0o700 });
	await chmod(executable, 0o700);
	return { executable, capture };
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("Cursor CLI provider", () => {
	it("keeps Cursor sign-in in the official CLI and exposes only a status result", async () => {
		const fake = await fakeCursorCli();
		const manager = new CursorCliManager({
			executable: fake.executable,
			environment: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				CURSOR_API_KEY: "must-not-leak",
			},
		});

		await expect(manager.status()).resolves.toEqual({ connected: true });
		await expect(manager.connect()).resolves.toEqual({ connected: true });
		const capture = JSON.parse(await readFile(fake.capture, "utf8")) as {
			login?: boolean;
			leaked?: string;
		};
		expect(capture.login).toBe(true);
		expect(capture.leaked).toBeUndefined();
	});

	it("routes Cursor Auto through a temporary read-only request without leaking API keys", async () => {
		const fake = await fakeCursorCli();
		const provider = new CursorSubscriptionProvider({
			executable: fake.executable,
			environment: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				CURSOR_API_KEY: "must-not-leak",
			},
		});
		await expect(provider.probe()).resolves.toBeUndefined();
		await expect(provider.discoverModels()).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "cursor-auto",
					availability: "available",
					source: "cli",
				}),
				expect.objectContaining({
					id: "gpt-5",
					displayName: "GPT 5",
					availability: "available",
				}),
			]),
		);
		const deltas: string[] = [];
		const result = await provider.complete(
			{
				model: "cursor-auto",
				messages: [{ role: "user", content: textContent("Explain this safely") }],
			},
			{
				onEvent: (event) => {
					if (event.type === "text_delta") deltas.push(event.delta);
				},
			},
		);
		const capture = JSON.parse(await readFile(fake.capture, "utf8")) as {
			args: string[];
			cwd: string;
			leaked?: string;
		};
		expect(capture.args).toEqual(
			expect.arrayContaining([
				"agent",
				"--print",
				"--output-format",
				"stream-json",
				"--stream-partial-output",
				"--mode",
				"ask",
				"--sandbox",
				"enabled",
			]),
		);
		expect(capture.args).not.toContain("--model");
		expect(capture.args.at(-1)).toContain("Explain this safely");
		expect(capture.args.at(-1)).toContain("Kestrel owns browser control, tools, and approvals.");
		expect(capture.cwd).not.toBe(process.cwd());
		expect(existsSync(capture.cwd)).toBe(false);
		expect(capture.leaked).toBeUndefined();
		expect(result).toMatchObject({
			providerId: "cursor-subscription",
			responseId: "cursor-session",
			text: "Cursor answer",
			toolCalls: [],
		});
		expect(deltas).toEqual(["Cursor ", "answer"]);
	});

	it("marks an unauthenticated Cursor profile as requiring sign-in", async () => {
		const fake = await fakeCursorCli({ authenticated: false });
		const provider = new CursorSubscriptionProvider({ executable: fake.executable });

		await expect(provider.probe()).rejects.toMatchObject({
			name: ModelProviderError.name,
			status: 401,
			message: "Cursor is not signed in. Complete sign-in with the official Cursor CLI.",
		});
	});
});
