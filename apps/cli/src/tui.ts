import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AgentLoopResult, PetHatchDraft } from "@kestrel/agent-core";
import { textContent } from "@kestrel/agent-core";
import sharp from "sharp";
import { openKestrel, resolveModelConfig } from "./state";

export interface TuiOptions {
	model?: string;
	providers?: string[];
	workspace?: string;
}

async function renderHatchDraft(
	draft: PetHatchDraft,
	mode: "kitty" | "iterm" | "sixel" | "unicode" | "off",
): Promise<string> {
	if (mode === "off") return "";
	const source = Buffer.from(draft.dataBase64, "base64");
	if (mode === "kitty" || mode === "iterm") {
		const png = await sharp(source)
			.resize(18 * 2, 18 * 2, { fit: "contain", kernel: "nearest" })
			.png()
			.toBuffer();
		const encoded = png.toString("base64");
		if (mode === "iterm")
			return `\x1b]1337;File=inline=1;width=18;preserveAspectRatio=1:${encoded}\x07\n`;
		const chunks = encoded.match(/.{1,4096}/g) ?? [];
		return `${chunks.map((chunk, index) => `\x1b_Gf=100,a=T,q=2,c=18,m=${index < chunks.length - 1 ? 1 : 0};${chunk}\x1b\\`).join("")}\n`;
	}
	const { data, info } = await sharp(source)
		.resize(18, 18, {
			fit: "contain",
			kernel: "nearest",
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		})
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const lines: string[] = [];
	for (let y = 0; y < info.height; y += 2) {
		let line = "";
		for (let x = 0; x < info.width; x += 1) {
			const top = (y * info.width + x) * 4;
			const bottom = (Math.min(y + 1, info.height - 1) * info.width + x) * 4;
			const topVisible = data[top + 3]! >= 32;
			const bottomVisible = data[bottom + 3]! >= 32;
			if (!topVisible && !bottomVisible) line += "\x1b[0m ";
			else if (topVisible && bottomVisible)
				line += `\x1b[38;2;${data[top]};${data[top + 1]};${data[top + 2]}m\x1b[48;2;${data[bottom]};${data[bottom + 1]};${data[bottom + 2]}m▀`;
			else if (topVisible)
				line += `\x1b[0m\x1b[38;2;${data[top]};${data[top + 1]};${data[top + 2]}m▀`;
			else
				line += `\x1b[0m\x1b[38;2;${data[bottom]};${data[bottom + 1]};${data[bottom + 2]}m▄`;
		}
		lines.push(`${line}\x1b[0m`);
	}
	return `${lines.join("\n")}\n`;
}

export async function runTui(options: TuiOptions): Promise<void> {
	const config = resolveModelConfig(options);
	const core = openKestrel(options.workspace ? [options.workspace] : []);
	let session = options.workspace
		? core.runtime.createSession({
				title: "Terminal session",
				workspaceRoot: realpathSync(options.workspace),
			})
		: core.runtime.ensureMainSession();
	let pendingRunId: string | undefined;
	let active: AbortController | undefined;
	let activeRun: Promise<void> | undefined;
	const steering: string[] = [];
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	let skin = core.skins.selected();
	let hatchDrafts: PetHatchDraft[] = [];
	const commands = [
		"/help",
		"/skin",
		"/pet",
		"/hatch",
		"/generate-pet",
		"/new",
		"/sessions",
		"/use",
		"/messages",
		"/tools",
		"/diff",
		"/approve",
		"/reject",
		"/cancel",
		"/clear",
		"/quit",
	];
	const completer = (line: string): [string[], string] => {
		const candidates = line.startsWith("/use ")
			? core.runtime.listSessions().map((item) => `/use ${item.id}`)
			: line.startsWith("/tools ")
				? core.runtime
						.discoverTools(session.id)
						.map((tool) => `/tools ${tool.name}`)
				: line.startsWith("/skin ")
					? core.skins.status().skins.map((item) => `/skin ${item.id}`)
					: line.startsWith("/pet ")
						? [
								...core
									.pets!.status()
									.installed.map((item) => `/pet ${item.slug}`),
								"/pet list",
								"/pet show",
								"/pet off",
								"/pet scale ",
							]
						: line.startsWith("/hatch ") || line.startsWith("/generate-pet ")
							? ["/hatch choose ", "/hatch "]
							: commands;
		const hits = candidates.filter((candidate) => candidate.startsWith(line));
		return [hits.length ? hits : candidates, line];
	};
	if (interactive) process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
	const terminal = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: interactive,
		historySize: 200,
		completer,
	});
	const write = (value: string) => process.stdout.write(value);
	const color = (index: number, value: string) =>
		interactive ? `\x1b[38;5;${index}m${value}\x1b[0m` : value;
	const petMode = () => {
		const configured = core.pets!.status().configuration.renderMode;
		if (configured !== "auto") return configured;
		if (process.env.KITTY_WINDOW_ID || process.env.TERM?.includes("kitty"))
			return "kitty" as const;
		if (process.env.TERM_PROGRAM === "iTerm.app") return "iterm" as const;
		if (process.env.TERM?.includes("sixel")) return "sixel" as const;
		return "unicode" as const;
	};
	const renderPet = async (
		state: "idle" | "wave" | "run" | "failed" | "review" | "jump" | "waiting",
	) => {
		if (!interactive) return;
		const status = core.pets!.status();
		const slug = status.configuration.selectedSlug;
		const mode = petMode();
		if (!status.configuration.enabled || !slug || mode === "off") return;
		const columns = Math.max(
			8,
			Math.min(80, Math.round(24 * (status.configuration.scale / 0.33))),
		);
		write(await core.pets!.terminalFrame(slug, state, mode, columns));
	};
	const prompt = () => {
		if (interactive) {
			terminal.setPrompt(
				`${color(skin.terminal.accent, skin.terminal.responseLabel)}:${session.id.slice(-8)}${active ? " · running" : pendingRunId ? " · approval" : ""}${skin.terminal.promptSymbol} `,
			);
			terminal.prompt();
		}
	};
	const header = () =>
		write(
			interactive
				? `\x1b[1m${skin.terminal.responseLabel} terminal\x1b[0m · ${skin.name} skin · session ${session.id}\n\x1b[2mTab completes commands · /skin and /pet personalize · sensitive tools pause for approval\x1b[0m\n${color(skin.terminal.muted, "─".repeat(Math.max(24, Math.min(100, process.stdout.columns ?? 80))))}\n`
				: `Kestrel terminal · session ${session.id}\nType /help for commands. Sensitive tools always pause for approval.\n`,
		);
	const renderDiff = (diff: string) =>
		diff
			.split("\n")
			.map((line) =>
				line.startsWith("+") && !line.startsWith("+++")
					? color(skin.terminal.success, line)
					: line.startsWith("-") && !line.startsWith("---")
						? color(skin.terminal.error, line)
						: line.startsWith("@@")
							? color(skin.terminal.accent, line)
							: line,
			)
			.join("\n");
	const showResult = (result: AgentLoopResult) => {
		if (result.run.status === "waiting_approval" && result.pendingExecution) {
			pendingRunId = result.run.id;
			void renderPet("waiting");
			write(
				`\nApproval required: ${result.pendingExecution.toolName} [${result.pendingExecution.riskLevel}]\n${JSON.stringify(result.pendingExecution.input, null, 2)}\nUse /approve or /reject.\n`,
			);
		} else pendingRunId = undefined;
	};
	const resume = (approvalDecision: "approved" | "rejected") => {
		if (!pendingRunId) {
			write("No run is waiting for approval.\n");
			return;
		}
		active = new AbortController();
		const controller = active;
		activeRun = core.agentLoop
			.resume({
				runId: pendingRunId,
				approvalDecision,
				signal: controller.signal,
				onTextDelta: write,
				takeSteering: () => steering.splice(0),
			})
			.then(async (result) => {
				write("\n");
				showResult(result);
				await renderPet(result.run.status === "failed" ? "failed" : "wave");
			})
			.catch((error) => {
				write(
					`\nError: ${error instanceof Error ? error.message : "unknown error"}\n`,
				);
			})
			.finally(() => {
				if (active === controller) active = undefined;
				activeRun = undefined;
				prompt();
			});
	};

	await renderPet("idle");
	header();
	terminal.on("SIGINT", () => {
		if (active) {
			active.abort(new Error("Cancelled from terminal."));
			write("\nCancelling…\n");
		} else terminal.close();
	});
	prompt();
	try {
		for await (const raw of terminal) {
			const line = raw.trim();
			try {
				if (!line) {
					prompt();
					continue;
				}
				if (line === "/quit" || line === "/exit") break;
				if (line === "/help")
					write(
						"/skin [id] · /pet [list|show|off|scale <factor>|slug] · /hatch <description> · /hatch choose <number> <slug> <name> · /new [title] · /sessions · /use <id> · /messages · /tools [query] · /diff [--staged] · /approve · /reject · /cancel · /clear · /quit\n",
					);
				else if (line === "/skin")
					write(
						`${core.skins
							.status()
							.skins.map(
								(item) =>
									`${item.id === skin.id ? "●" : "○"} ${item.id} — ${item.description}`,
							)
							.join("\n")}\n`,
					);
				else if (line.startsWith("/skin ")) {
					core.skins.select(line.slice(6).trim());
					skin = core.skins.selected();
					if (interactive) {
						write("\x1b[2J\x1b[H");
						header();
					} else write(`Selected ${skin.name}.\n`);
				} else if (/^\/(?:hatch|generate-pet) choose\b/.test(line)) {
					const match =
						/^\/(?:hatch|generate-pet) choose\s+(\d+)\s+([a-z0-9][a-z0-9-]{0,79})\s+(.+)$/.exec(
							line,
						);
					if (!match)
						throw new Error(
							"Use /hatch choose <number> <slug> <display name>.",
						);
					const draft = hatchDrafts[Number(match[1]) - 1];
					if (!draft)
						throw new Error(
							"That draft number is unavailable. Generate a round with /hatch <description> first.",
						);
					if (!core.petHatch)
						throw new Error("Pet hatch storage is unavailable.");
					write(
						`Hatching ${match[3]} from draft ${match[1]} · generating eight reference-grounded rows…\n`,
					);
					const result = await core.petHatch.hatch(
						{
							draftId: draft.id,
							slug: match[2]!,
							displayName: match[3]!.trim(),
							description: draft.concept,
						},
						AbortSignal.timeout(420_000),
					);
					write(
						`Hatched ${result.displayName} · ${result.states.length} verified rows · SHA-256 ${result.sha256}\n`,
					);
					await renderPet("jump");
				} else if (line === "/hatch" || line === "/generate-pet") {
					write(
						"Use /hatch <description>, then /hatch choose <number> <slug> <display name>.\n",
					);
				} else if (
					line.startsWith("/hatch ") ||
					line.startsWith("/generate-pet ")
				) {
					if (!core.petHatch)
						throw new Error("Pet hatch storage is unavailable.");
					const description = line
						.replace(/^\/(?:hatch|generate-pet)\s+/, "")
						.trim();
					if (!description)
						throw new Error("Describe the original pet you want to hatch.");
					const capability = core.petHatch.capability();
					if (!capability.available) throw new Error(capability.reason);
					write(
						`Drawing four low-cost base looks with ${capability.providerId}${capability.model ? ` · ${capability.model}` : ""}…\n`,
					);
					hatchDrafts = await core.petHatch.generateDrafts(
						{ concept: description, count: 4 },
						AbortSignal.timeout(180_000),
					);
					for (const [index, draft] of hatchDrafts.entries()) {
						write(`\nDraft ${index + 1} · ${draft.model}\n`);
						if (interactive) write(await renderHatchDraft(draft, petMode()));
					}
					write(
						"\nChoose one with /hatch choose <number> <slug> <display name>. The hatch uses eight reference-grounded image calls and can take several minutes.\n",
					);
				} else if (line === "/pet") {
					const status = core.pets!.status();
					if (status.configuration.enabled) {
						core.pets!.configure({ enabled: false });
						write("Pet tucked away.\n");
					} else {
						const slug =
							status.configuration.selectedSlug ?? status.installed[0]?.slug;
						if (!slug)
							write("No pet is installed. Use /pet list, then /pet <slug>.\n");
						else {
							core.pets!.select(slug);
							write(`Adopted ${slug}.\n`);
							await renderPet("wave");
						}
					}
				} else if (line === "/pet list") {
					const gallery = await core.pets!.gallery("", 24);
					write(
						`${gallery.map((item) => `${core.pets!.status().installed.some((pet) => pet.slug === item.slug) ? "●" : "○"} ${item.slug} — ${item.displayName} · ${item.kind} · ${item.submittedBy}`).join("\n")}\n`,
					);
				} else if (line === "/pet show") await renderPet("idle");
				else if (line === "/pet off") {
					core.pets!.configure({ enabled: false });
					write("Pet tucked away.\n");
				} else if (line.startsWith("/pet scale ")) {
					const scale = Number(line.slice(11).trim());
					if (!Number.isFinite(scale) || scale < 0.1 || scale > 3)
						throw new Error("Pet scale must be from 0.1 through 3.");
					core.pets!.configure({ scale });
					write(`Pet scale set to ${scale}.\n`);
					await renderPet("idle");
				} else if (line.startsWith("/pet ")) {
					const slug = line.slice(5).trim();
					const installed = core
						.pets!.status()
						.installed.some((pet) => pet.slug === slug);
					if (installed) core.pets!.select(slug);
					else await core.pets!.install(slug, true);
					write(`Adopted ${slug}.\n`);
					await renderPet("wave");
				} else if (line === "/sessions")
					write(`${JSON.stringify(core.runtime.listSessions(), null, 2)}\n`);
				else if (line.startsWith("/new")) {
					const title = line.slice(4).trim() || "Terminal session";
					session = core.runtime.createSession({
						title,
						...(options.workspace
							? { workspaceRoot: realpathSync(options.workspace) }
							: {}),
					});
					pendingRunId = undefined;
					write(`Using ${session.id}.\n`);
				} else if (line.startsWith("/use ")) {
					session = core.runtime.getSession(line.slice(5).trim());
					pendingRunId = undefined;
					write(`Using ${session.id}.\n`);
				} else if (line === "/messages")
					write(
						`${JSON.stringify(core.runtime.listMessages(session.id), null, 2)}\n`,
					);
				else if (line === "/tools" || line.startsWith("/tools "))
					write(
						`${JSON.stringify(core.runtime.discoverTools(session.id, line.slice(6).trim() || undefined), null, 2)}\n`,
					);
				else if (line === "/diff" || line === "/diff --staged") {
					const result = await core.runtime.callTool(session.id, "git.diff", {
						staged: line.endsWith("--staged"),
						pathspec: [],
					});
					if (result.status !== "verified")
						throw new Error(result.error ?? "Git diff failed.");
					write(`${renderDiff(String(result.output?.diff ?? ""))}\n`);
				} else if (line === "/clear") {
					if (interactive) {
						write("\x1b[2J\x1b[H");
						header();
					}
				} else if (line === "/approve") resume("approved");
				else if (line === "/reject") resume("rejected");
				else if (line === "/cancel") {
					if (active) active.abort(new Error("Cancelled from terminal."));
					else write("No active model or tool call.\n");
				} else if (line.startsWith("/"))
					write("Unknown command. Type /help.\n");
				else {
					if (active) {
						if (steering.length >= 20)
							write(
								"Steering queue is full. Wait for the agent to consume an update.\n",
							);
						else {
							steering.push(line);
							write("Queued update for the active run.\n");
						}
						prompt();
						continue;
					}
					if (pendingRunId) {
						write(
							"Resolve the pending approval with /approve or /reject first.\n",
						);
						prompt();
						continue;
					}
					active = new AbortController();
					const controller = active;
					await renderPet("review");
					activeRun = core.agentLoop
						.run({
							sessionId: session.id,
							model: config.model,
							providerIds: config.providers,
							userContent: textContent(line),
							signal: controller.signal,
							onTextDelta: write,
							takeSteering: () => steering.splice(0),
						})
						.then(async (result) => {
							write("\n");
							showResult(result);
							await renderPet(
								result.run.status === "failed" ? "failed" : "wave",
							);
						})
						.catch((error) => {
							write(
								`\nError: ${error instanceof Error ? error.message : "unknown error"}\n`,
							);
						})
						.finally(() => {
							if (active === controller) active = undefined;
							activeRun = undefined;
							prompt();
						});
				}
			} catch (error) {
				write(
					`Error: ${error instanceof Error ? error.message : "unknown error"}\n`,
				);
			}
			prompt();
		}
	} finally {
		terminal.close();
		active?.abort(new Error("Terminal closed."));
		await activeRun;
		await core.close();
		if (interactive) process.stdout.write("\x1b[?1049l");
	}
}
