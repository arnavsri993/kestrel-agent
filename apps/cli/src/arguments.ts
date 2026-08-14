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
	| {
			name: "run";
			sessionId: string;
			prompt: string;
			model: string;
			providers: string[];
	  }
	| { name: "retry"; sessionId: string; model: string; providers: string[] }
	| { name: "resume"; runId: string; decision: "approved" | "rejected" }
	| { name: "jobs" }
	| {
			name: "automation-schedule";
			sessionId: string;
			title: string;
			prompt: string;
			model: string;
			providers: string[];
			expression: string;
	  }
	| { name: "automation-cancel"; jobId: string }
	| { name: "automation-run-due" }
	| { name: "automation-serve"; pollMs: number }
	| {
			name: "migration-plan";
			product: "openclaw" | "hermes" | "codex" | "claude-code";
			source: string;
			target: string;
	  }
	| { name: "migration-apply"; planPath: string; overwrite: boolean }
	| { name: "skin-list" }
	| { name: "skin-select"; skinId: string }
	| { name: "skin-import"; path: string }
	| { name: "skin-remove"; skinId: string }
	| { name: "pet-list"; query: string; limit: number; installed: boolean }
	| { name: "pet-install"; slug: string; select: boolean; force: boolean }
	| { name: "pet-select"; slug: string }
	| { name: "pet-scale"; scale: number }
	| {
			name: "pet-show";
			slug?: string;
			state: "idle" | "wave" | "run" | "failed" | "review" | "jump" | "waiting";
			cycle: boolean;
			once: boolean;
			mode?: "auto" | "kitty" | "iterm" | "sixel" | "unicode";
			scale?: number;
	  }
	| { name: "pet-off" }
	| { name: "pet-remove"; slug: string }
	| { name: "pet-doctor" }
	| { name: "pet-hatch-drafts"; concept: string; style: string; count: number }
	| {
			name: "pet-hatch-complete";
			draftId: string;
			slug: string;
			displayName: string;
			description: string;
	  }
	| {
			name: "remote-pair";
			label: string;
			scopes: Array<"read" | "tasks" | "approve">;
			lifetimeMs: number;
	  }
	| { name: "remote-revoke"; deviceId: string }
	| {
			name: "remote-serve";
			host: string;
			port: number;
			tlsKey?: string;
			tlsCert?: string;
			allowedOrigins: string[];
			trustedProxyConfig?: string;
			proxyTerminatedTls: boolean;
			tailscaleMode: "off" | "serve" | "funnel";
			tailscaleService?: string;
			tailscaleResetOnExit: boolean;
			tailscalePublicApproved: boolean;
			bonjourMode: "off" | "minimal" | "full";
			bonjourName: string;
			bonjourTailnetDns?: string;
			bonjourSshPort?: number;
			bonjourCliPath?: string;
	  }
	| { name: "tui"; model?: string; providers?: string[]; workspace?: string }
	| { name: "acp"; model?: string; providers?: string[]; workspace?: string };

function options(args: string[], allowed: string[]): Map<string, string> {
	const output = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const item = args[index];
		const value = args[index + 1];
		if (!item?.startsWith("--"))
			throw new Error(`Unexpected argument ${item ?? ""}.`);
		const name = item.slice(2);
		if (!allowed.includes(name)) throw new Error(`Unknown option --${name}.`);
		if (!value || value.startsWith("--"))
			throw new Error(`Missing value for ${item}.`);
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
		...(providerValue
			? {
					providers: providerValue
						.split(",")
						.map((value) => value.trim())
						.filter(Boolean),
				}
			: {}),
		...(workspace ? { workspace } : {}),
	};
}

function parseSessionCommand(args: string[]): CliCommand {
	const action = args[1];
	if (action === "list") {
		options(args.slice(2), []);
		return { name: "session-list" };
	}
	if (action === "create") {
		const values = options(args.slice(2), ["title", "workspace"]);
		const workspace = values.get("workspace");
		return {
			name: "session-create",
			title: required(values, "title"),
			...(workspace ? { workspace } : {}),
		};
	}
	if (action === "fork") {
		const values = options(args.slice(2), ["session", "title"]);
		const title = values.get("title");
		return {
			name: "session-fork",
			sessionId: required(values, "session"),
			...(title ? { title } : {}),
		};
	}
	if (action === "checkpoint") {
		const values = options(args.slice(2), ["session", "summary"]);
		return {
			name: "session-checkpoint",
			sessionId: required(values, "session"),
			summary: required(values, "summary"),
		};
	}
	if (action === "restore") {
		const values = options(args.slice(2), ["session", "checkpoint"]);
		return {
			name: "session-restore",
			sessionId: required(values, "session"),
			checkpointId: required(values, "checkpoint"),
		};
	}
	if (action === "resume") {
		const values = options(args.slice(2), ["session"]);
		return { name: "session-resume", sessionId: required(values, "session") };
	}
	if (action === "cancel") {
		const values = options(args.slice(2), ["session"]);
		return { name: "session-cancel", sessionId: required(values, "session") };
	}
	if (action === "messages") {
		const values = options(args.slice(2), ["session"]);
		return {
			name: "session-messages",
			sessionId: required(values, "session"),
		};
	}
	throw new Error("Unknown session command.");
}

function parseAutomationCommand(args: string[]): CliCommand {
	const action = args[1];
	if (action === "schedule") {
		const values = options(args.slice(2), [
			"session",
			"title",
			"prompt",
			"model",
			"providers",
			"at",
			"when",
			"interval-seconds",
		]);
		const at = values.get("at");
		const when = values.get("when");
		const intervalValue = values.get("interval-seconds");
		const intervalSeconds = intervalValue ? Number(intervalValue) : undefined;
		if (
			intervalSeconds !== undefined &&
			(!Number.isInteger(intervalSeconds) ||
				intervalSeconds < 60 ||
				intervalSeconds > 31_536_000)
		)
			throw new Error("--interval-seconds must be from 60 through 31536000.");
		if ([at, when, intervalValue].filter(Boolean).length !== 1)
			throw new Error(
				"Use exactly one of --when, --at, or --interval-seconds.",
			);
		const expression = intervalSeconds
			? `every ${intervalSeconds} seconds`
			: (when ?? at)!;
		return {
			name: "automation-schedule",
			sessionId: required(values, "session"),
			title: required(values, "title"),
			prompt: required(values, "prompt"),
			model: required(values, "model"),
			providers: required(values, "providers")
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
			expression,
		};
	}
	if (action === "cancel") {
		const values = options(args.slice(2), ["job"]);
		return { name: "automation-cancel", jobId: required(values, "job") };
	}
	if (action === "run-due") {
		options(args.slice(2), []);
		return { name: "automation-run-due" };
	}
	if (action === "serve") {
		const values = options(args.slice(2), ["poll-ms"]);
		const pollMs = Number(values.get("poll-ms") ?? "5000");
		if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 300_000)
			throw new Error("--poll-ms must be from 250 through 300000.");
		return { name: "automation-serve", pollMs };
	}
	throw new Error("Unknown automation command.");
}

function parseMigrationCommand(args: string[]): CliCommand {
	const action = args[1];
	if (action === "plan") {
		const values = options(args.slice(2), ["product", "source", "target"]);
		const product = required(values, "product");
		if (!["openclaw", "hermes", "codex", "claude-code"].includes(product))
			throw new Error("--product is invalid.");
		return {
			name: "migration-plan",
			product: product as "openclaw" | "hermes" | "codex" | "claude-code",
			source: required(values, "source"),
			target: required(values, "target"),
		};
	}
	if (action === "apply") {
		const values = options(args.slice(2), ["plan", "approve", "overwrite"]);
		if (required(values, "approve") !== "yes")
			throw new Error("Migration apply requires --approve yes.");
		const overwrite = values.get("overwrite") ?? "no";
		if (overwrite !== "yes" && overwrite !== "no")
			throw new Error("--overwrite must be yes or no.");
		return {
			name: "migration-apply",
			planPath: required(values, "plan"),
			overwrite: overwrite === "yes",
		};
	}
	throw new Error("Unknown migration command.");
}

function parseSkinCommand(args: string[]): CliCommand {
	const action = args[1] ?? "list";
	if (action === "list") {
		options(args.slice(2), []);
		return { name: "skin-list" };
	}
	if (action === "select") {
		const values = options(args.slice(2), ["id"]);
		return { name: "skin-select", skinId: required(values, "id") };
	}
	if (action === "import") {
		const values = options(args.slice(2), ["path"]);
		return { name: "skin-import", path: required(values, "path") };
	}
	if (action === "remove") {
		const values = options(args.slice(2), ["id"]);
		return { name: "skin-remove", skinId: required(values, "id") };
	}
	throw new Error("Unknown skin command.");
}

function parsePetCommand(args: string[]): CliCommand {
	const action = args[1] ?? "list";
	if (action === "list") {
		let query = "";
		let limit = 24;
		let installed = false;
		for (let index = 2; index < args.length; index += 1) {
			const value = args[index]!;
			if (value === "--installed") installed = true;
			else if (value === "--limit") {
				const parsed = Number(args[++index]);
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100)
					throw new Error("--limit must be from 1 through 100.");
				limit = parsed;
			} else if (value.startsWith("--"))
				throw new Error(`Unknown option ${value}.`);
			else if (!query) query = value;
			else throw new Error(`Unexpected argument ${value}.`);
		}
		return { name: "pet-list", query, limit, installed };
	}
	if (action === "install") {
		const slug = args[2];
		if (!slug || slug.startsWith("--"))
			throw new Error("Pet install requires a slug.");
		const flags = new Set(args.slice(3));
		if ([...flags].some((flag) => !["--select", "--force"].includes(flag)))
			throw new Error("Pet install accepts only --select and --force.");
		return {
			name: "pet-install",
			slug,
			select: flags.has("--select"),
			force: flags.has("--force"),
		};
	}
	if (action === "hatch-drafts") {
		const values = options(args.slice(2), ["concept", "style", "count"]);
		const count = Number(values.get("count") ?? 4);
		if (!Number.isInteger(count) || count < 1 || count > 4)
			throw new Error("--count must be from 1 through 4.");
		return {
			name: "pet-hatch-drafts",
			concept: required(values, "concept"),
			style: values.get("style") ?? "auto",
			count,
		};
	}
	if (action === "hatch") {
		const values = options(args.slice(2), [
			"draft",
			"slug",
			"name",
			"description",
		]);
		return {
			name: "pet-hatch-complete",
			draftId: required(values, "draft"),
			slug: required(values, "slug"),
			displayName: required(values, "name"),
			description: values.get("description") ?? "",
		};
	}
	if (action === "select") {
		if (!args[2] || args.length !== 3)
			throw new Error("Pet select requires one slug.");
		return { name: "pet-select", slug: args[2] };
	}
	if (action === "scale") {
		if (!args[2] || args.length !== 3)
			throw new Error("Pet scale requires one factor.");
		const scale = Number(args[2]);
		if (!Number.isFinite(scale) || scale < 0.1 || scale > 3)
			throw new Error("Pet scale must be from 0.1 through 3.");
		return { name: "pet-scale", scale };
	}
	if (action === "show") {
		let slug: string | undefined;
		let state:
			| "idle"
			| "wave"
			| "run"
			| "failed"
			| "review"
			| "jump"
			| "waiting" = "idle";
		let cycle = false;
		let once = false;
		let mode: "auto" | "kitty" | "iterm" | "sixel" | "unicode" | undefined;
		let scale: number | undefined;
		for (let index = 2; index < args.length; index += 1) {
			const value = args[index]!;
			if (value === "--cycle") cycle = true;
			else if (value === "--once") once = true;
			else if (value === "--state") {
				const candidate = args[++index];
				if (
					!candidate ||
					![
						"idle",
						"wave",
						"run",
						"failed",
						"review",
						"jump",
						"waiting",
					].includes(candidate)
				)
					throw new Error("--state is invalid.");
				state = candidate as typeof state;
			} else if (value === "--mode") {
				const candidate = args[++index];
				if (
					!candidate ||
					!["auto", "kitty", "iterm", "sixel", "unicode"].includes(candidate)
				)
					throw new Error("--mode is invalid.");
				mode = candidate as typeof mode;
			} else if (value === "--scale") {
				const candidate = Number(args[++index]);
				if (!Number.isFinite(candidate) || candidate < 0.1 || candidate > 3)
					throw new Error("--scale must be from 0.1 through 3.");
				scale = candidate;
			} else if (value.startsWith("--"))
				throw new Error(`Unknown option ${value}.`);
			else if (!slug) slug = value;
			else throw new Error(`Unexpected argument ${value}.`);
		}
		return {
			name: "pet-show",
			state,
			cycle,
			once,
			...(slug ? { slug } : {}),
			...(mode ? { mode } : {}),
			...(scale ? { scale } : {}),
		};
	}
	if (action === "off") {
		options(args.slice(2), []);
		return { name: "pet-off" };
	}
	if (action === "remove") {
		if (!args[2] || args.length !== 3)
			throw new Error("Pet remove requires one slug.");
		return { name: "pet-remove", slug: args[2] };
	}
	if (action === "doctor") {
		options(args.slice(2), []);
		return { name: "pet-doctor" };
	}
	throw new Error("Unknown pet command.");
}

function parseRemoteCommand(args: string[]): CliCommand {
	const action = args[1];
	if (action === "pair") {
		const values = options(args.slice(2), [
			"label",
			"scopes",
			"lifetime-seconds",
		]);
		const scopes = required(values, "scopes")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		if (
			scopes.length === 0 ||
			scopes.some((scope) => !["read", "tasks", "approve"].includes(scope))
		)
			throw new Error("--scopes must contain read, tasks, and/or approve.");
		const lifetimeSeconds = Number(values.get("lifetime-seconds") ?? "300");
		if (
			!Number.isInteger(lifetimeSeconds) ||
			lifetimeSeconds < 30 ||
			lifetimeSeconds > 600
		)
			throw new Error(
				"--lifetime-seconds must be an integer from 30 through 600.",
			);
		return {
			name: "remote-pair",
			label: required(values, "label"),
			scopes: [...new Set(scopes)] as Array<"read" | "tasks" | "approve">,
			lifetimeMs: lifetimeSeconds * 1_000,
		};
	}
	if (action === "revoke") {
		const values = options(args.slice(2), ["device"]);
		return { name: "remote-revoke", deviceId: required(values, "device") };
	}
	if (action === "serve") {
		const values = options(args.slice(2), [
			"host",
			"port",
			"tls-key",
			"tls-cert",
			"allowed-origins",
			"trusted-proxy-config",
			"proxy-terminated-tls",
			"tailscale",
			"tailscale-service",
			"tailscale-reset-on-exit",
			"tailscale-public-ack",
			"bonjour",
			"bonjour-name",
			"bonjour-tailnet-dns",
			"bonjour-ssh-port",
			"bonjour-cli-path",
		]);
		const port = Number(values.get("port") ?? "0");
		if (!Number.isInteger(port) || port < 0 || port > 65_535)
			throw new Error("--port must be an integer from 0 through 65535.");
		const tlsKey = values.get("tls-key");
		const tlsCert = values.get("tls-cert");
		if (Boolean(tlsKey) !== Boolean(tlsCert))
			throw new Error("--tls-key and --tls-cert must be supplied together.");
		const allowedOrigins = (values.get("allowed-origins") ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		for (const value of allowedOrigins) {
			let parsed: URL;
			try {
				parsed = new URL(value);
			} catch {
				throw new Error(
					"--allowed-origins must contain exact HTTP(S) origins.",
				);
			}
			if (
				parsed.origin !== value ||
				!["https:", "http:"].includes(parsed.protocol)
			)
				throw new Error(
					"--allowed-origins must contain exact HTTP(S) origins.",
				);
		}
		const trustedProxyConfig = values.get("trusted-proxy-config");
		const proxyTerminatedTls = values.get("proxy-terminated-tls") ?? "no";
		if (proxyTerminatedTls !== "yes" && proxyTerminatedTls !== "no")
			throw new Error("--proxy-terminated-tls must be yes or no.");
		if (proxyTerminatedTls === "yes" && !trustedProxyConfig)
			throw new Error(
				"--proxy-terminated-tls yes requires --trusted-proxy-config.",
			);
		const tailscaleMode = values.get("tailscale") ?? "off";
		if (!["off", "serve", "funnel"].includes(tailscaleMode))
			throw new Error("--tailscale must be off, serve, or funnel.");
		const tailscaleService = values.get("tailscale-service");
		if (tailscaleService && tailscaleMode !== "serve")
			throw new Error("--tailscale-service requires --tailscale serve.");
		const tailscaleResetOnExit = values.get("tailscale-reset-on-exit") ?? "yes";
		if (tailscaleResetOnExit !== "yes" && tailscaleResetOnExit !== "no")
			throw new Error("--tailscale-reset-on-exit must be yes or no.");
		const tailscalePublicApproved =
			values.get("tailscale-public-ack") === "public";
		if (tailscaleMode === "funnel" && !tailscalePublicApproved)
			throw new Error(
				"--tailscale funnel requires --tailscale-public-ack public.",
			);
		const host = values.get("host") ?? "127.0.0.1";
		if (
			tailscaleMode !== "off" &&
			!["127.0.0.1", "::1", "localhost"].includes(host)
		)
			throw new Error("Tailscale Serve/Funnel requires a loopback --host.");
		const bonjourMode = values.get("bonjour") ?? "off";
		if (!["off", "minimal", "full"].includes(bonjourMode))
			throw new Error("--bonjour must be off, minimal, or full.");
		const bonjourName = values.get("bonjour-name") ?? "Kestrel";
		const bonjourTailnetDns = values.get("bonjour-tailnet-dns");
		const bonjourCliPath = values.get("bonjour-cli-path");
		const bonjourSshPortValue = values.get("bonjour-ssh-port");
		const bonjourSshPort = bonjourSshPortValue
			? Number(bonjourSshPortValue)
			: undefined;
		if (
			bonjourSshPort !== undefined &&
			(!Number.isInteger(bonjourSshPort) ||
				bonjourSshPort < 1 ||
				bonjourSshPort > 65_535)
		)
			throw new Error("--bonjour-ssh-port is invalid.");
		if (
			bonjourMode !== "full" &&
			(bonjourTailnetDns || bonjourCliPath || bonjourSshPort)
		)
			throw new Error("Full Bonjour hints require --bonjour full.");
		return {
			name: "remote-serve",
			host,
			port,
			allowedOrigins,
			proxyTerminatedTls: proxyTerminatedTls === "yes",
			tailscaleMode: tailscaleMode as "off" | "serve" | "funnel",
			tailscaleResetOnExit: tailscaleResetOnExit === "yes",
			tailscalePublicApproved,
			bonjourMode: bonjourMode as "off" | "minimal" | "full",
			bonjourName,
			...(bonjourTailnetDns ? { bonjourTailnetDns } : {}),
			...(bonjourSshPort ? { bonjourSshPort } : {}),
			...(bonjourCliPath ? { bonjourCliPath } : {}),
			...(tailscaleService ? { tailscaleService } : {}),
			...(trustedProxyConfig ? { trustedProxyConfig } : {}),
			...(tlsKey && tlsCert ? { tlsKey, tlsCert } : {}),
		};
	}
	throw new Error("Unknown remote command.");
}

function parseMemoryCommand(args: string[]): CliCommand {
	const action = args[1];
	if (action === "list") {
		options(args.slice(2), []);
		return { name: "memory-list" };
	}
	if (action === "search") {
		const values = options(args.slice(2), ["query"]);
		return { name: "memory-search", query: required(values, "query") };
	}
	if (action === "forget") {
		const values = options(args.slice(2), ["memory"]);
		return { name: "memory-forget", memoryId: required(values, "memory") };
	}
	throw new Error("Unknown memory command.");
}

export function parseCliArguments(input: string[]): CliCommand {
	let args = input;
	if (args[0] === "--") args = args.slice(1);
	if (
		args.length === 0 ||
		args[0] === "help" ||
		args[0] === "--help" ||
		args[0] === "-h"
	)
		return { name: "help" };
	if (args[0] === "session") {
		return parseSessionCommand(args);
	}
	if (args[0] === "memory") {
		return parseMemoryCommand(args);
	}
	if (args[0] === "tools") {
		const values = options(args.slice(1), ["session", "query"]);
		const query = values.get("query");
		return {
			name: "tools",
			sessionId: required(values, "session"),
			...(query ? { query } : {}),
		};
	}
	if (args[0] === "run") {
		const values = options(args.slice(1), [
			"session",
			"prompt",
			"model",
			"providers",
		]);
		return {
			name: "run",
			sessionId: required(values, "session"),
			prompt: required(values, "prompt"),
			model: required(values, "model"),
			providers: required(values, "providers")
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		};
	}
	if (args[0] === "retry") {
		const values = options(args.slice(1), ["session", "model", "providers"]);
		return {
			name: "retry",
			sessionId: required(values, "session"),
			model: required(values, "model"),
			providers: required(values, "providers")
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		};
	}
	if (args[0] === "resume") {
		const values = options(args.slice(1), ["run", "decision"]);
		const decision = required(values, "decision");
		if (decision !== "approved" && decision !== "rejected")
			throw new Error("--decision must be approved or rejected.");
		return { name: "resume", runId: required(values, "run"), decision };
	}
	if (args[0] === "jobs") {
		options(args.slice(1), []);
		return { name: "jobs" };
	}
	if (args[0] === "automation") {
		return parseAutomationCommand(args);
	}
	if (args[0] === "migration") {
		return parseMigrationCommand(args);
	}
	if (args[0] === "skin") {
		return parseSkinCommand(args);
	}
	if (args[0] === "pets" || args[0] === "pet") {
		return parsePetCommand(args);
	}
	if (args[0] === "remote") {
		return parseRemoteCommand(args);
	}
	if (args[0] === "tui" || args[0] === "acp") {
		const values = options(args.slice(1), ["model", "providers", "workspace"]);
		return { name: args[0], ...modelOptions(values) };
	}
	throw new Error("Unknown command. Run `kestrel help`.");
}
