import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArguments } from "./arguments";

function documentedCommands(source: string, prefix: string): string[] {
	const commands: string[] = [];
	let current = "";
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith(`${prefix} `)) {
			if (current) commands.push(current);
			current = trimmed;
		} else if (current && trimmed.startsWith("[--")) {
			current += ` ${trimmed}`;
		} else if (current) {
			commands.push(current);
			current = "";
		}
	}
	if (current) commands.push(current);
	return commands;
}

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
		expect(() => parseCliArguments(["resume", "--run", "r-1"])).toThrow(
			"Missing required --decision.",
		);
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
				"opencode",
				"--model",
				"opencode-model",
				"--workspace",
				"/tmp/project",
				"--setup",
			]),
		).toEqual({
			name: "opencode",
			model: "opencode-model",
			workspace: "/tmp/project",
			setup: true,
		});
		expect(
			parseCliArguments([
				"opencode",
				"--providers",
				"opencode-subscription",
			]),
		).toEqual({
			name: "opencode",
			providers: ["opencode-subscription"],
			setup: false,
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
		expect(
			parseCliArguments(["skin", "remove", "--id", "field-notes"]),
		).toEqual({ name: "skin-remove", skinId: "field-notes" });
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
		expect(parseCliArguments(["pets", "select", "paperclip"])).toEqual({
			name: "pet-select",
			slug: "paperclip",
		});
		expect(parseCliArguments(["pets", "scale", "0.5"])).toEqual({
			name: "pet-scale",
			scale: 0.5,
		});
		expect(parseCliArguments(["pets", "off"])).toEqual({ name: "pet-off" });
		expect(parseCliArguments(["pets", "remove", "paperclip"])).toEqual({
			name: "pet-remove",
			slug: "paperclip",
		});
		expect(parseCliArguments(["pets", "doctor"])).toEqual({
			name: "pet-doctor",
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

	it("keeps documented skin and pet commands aligned with CLI help", () => {
		const root = resolve(import.meta.dirname, "../../..");
		const cliSource = readFileSync(
			resolve(root, "apps/cli/src/index.ts"),
			"utf8",
		);

		expect(cliSource).not.toMatch(/^\s*workstrand (?:skin|pets)\b/m);
		expect(documentedCommands(cliSource, "kestrel skin")).toEqual([
			"kestrel skin list",
			"kestrel skin select --id <skin>",
			"kestrel skin import --path <skin.json>",
			"kestrel skin remove --id <skin>",
		]);
		expect(documentedCommands(cliSource, "kestrel pets")).toEqual([
			"kestrel pets list [query] [--limit N] [--installed]",
			"kestrel pets install <slug> [--select] [--force]",
			"kestrel pets hatch-drafts --concept \"...\" [--style auto] [--count 4]",
			"kestrel pets hatch --draft <id> --slug <slug> --name \"Name\" [--description \"...\"]",
			"kestrel pets select <slug>",
			"kestrel pets scale <0.1-3>",
			"kestrel pets show [slug] [--state idle|wave|run|failed|review|jump|waiting] [--cycle] [--once] [--mode auto|kitty|iterm|sixel|unicode] [--scale 0.1-3]",
			"kestrel pets off",
			"kestrel pets remove <slug>",
			"kestrel pets doctor",
		]);
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
			parseCliArguments(["remote", "serve", "--allowed-origins", "not a URL"]),
		).toThrow("--allowed-origins must contain exact HTTP(S) origins.");
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
		expect(
			parseCliArguments([
				"leaderboard",
				"--category",
				"efficiency",
				"--timeframe",
				"week",
			]),
		).toEqual({
			name: "leaderboard",
			category: "efficiency",
			timeframe: "week",
		});
		expect(
			parseCliArguments(["tokens", "--timeframe", "today"]),
		).toEqual({
			name: "tokens",
			timeframe: "today",
		});
	});
});

