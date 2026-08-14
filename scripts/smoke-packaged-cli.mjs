import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	client,
	ndJsonStream,
	PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const root = mkdtempSync(join(tmpdir(), "kestrel-packaged-cli-"));
const data = join(root, "data");
const workspace = join(root, "workspace");
mkdirSync(workspace);
const cli = resolve("apps/cli/dist/kestrel.mjs");
const acpBinary = resolve("apps/cli/dist/kestrel-acp.mjs");
const environment = { ...process.env, KESTREL_DATA_DIR: data };

function command(binary, args) {
	const result = spawnSync(process.execPath, [binary, ...args], {
		encoding: "utf8",
		env: environment,
		timeout: 10_000,
	});
	assert.equal(
		result.status,
		0,
		result.stderr || `Command failed: ${args.join(" ")}`,
	);
	return result.stdout;
}

function firstLine(stream) {
	return new Promise((resolveLine, rejectLine) => {
		let buffered = "";
		const timeout = setTimeout(
			() =>
				rejectLine(new Error("Timed out waiting for packaged process output.")),
			10_000,
		);
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			buffered += chunk;
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timeout);
			resolveLine(buffered.slice(0, newline));
		});
		stream.once("error", (error) => {
			clearTimeout(timeout);
			rejectLine(error);
		});
	});
}

try {
	assert.match(command(cli, ["help"]), /kestrel acp/);
	const created = JSON.parse(
		command(cli, [
			"session",
			"create",
			"--title",
			"Packaged smoke",
			"--workspace",
			workspace,
		]),
	);
	assert.equal(created.title, "Packaged smoke");
	assert.ok(
		JSON.parse(command(cli, ["session", "list"])).some(
			(session) => session.id === created.id,
		),
	);
	const checkpointed = JSON.parse(
		command(cli, [
			"session",
			"checkpoint",
			"--session",
			created.id,
			"--summary",
			"Packaged safe point",
		]),
	);
	const restored = JSON.parse(
		command(cli, [
			"session",
			"restore",
			"--session",
			created.id,
			"--checkpoint",
			checkpointed.checkpoints[0].id,
		]),
	);
	assert.equal(restored.id, created.id);
	const forked = JSON.parse(
		command(cli, [
			"session",
			"fork",
			"--session",
			created.id,
			"--title",
			"Packaged branch",
		]),
	);
	assert.equal(forked.parentSessionId, created.id);
	const scheduled = JSON.parse(
		command(cli, [
			"automation",
			"schedule",
			"--session",
			created.id,
			"--title",
			"Future smoke",
			"--prompt",
			"Do this later",
			"--model",
			"fixture",
			"--providers",
			"fixture",
			"--at",
			"2099-01-01T00:00:00.000Z",
		]),
	);
	assert.equal(scheduled.status, "pending");
	const automation = spawn(
		process.execPath,
		[cli, "automation", "serve", "--poll-ms", "250"],
		{ env: environment, stdio: ["ignore", "pipe", "pipe"] },
	);
	assert.match(await firstLine(automation.stdout), /"automation":"ready"/);
	automation.kill("SIGTERM");
	const automationExit = await new Promise((resolveExit) =>
		automation.once("exit", resolveExit),
	);
	assert.equal(automationExit, 0);
	assert.equal(
		JSON.parse(command(cli, ["automation", "cancel", "--job", scheduled.id]))
			.status,
		"cancelled",
	);
	const migrationSource = join(root, "migration-source");
	const migrationTarget = join(root, "migration-target");
	mkdirSync(migrationSource);
	writeFileSync(
		join(migrationSource, "AGENTS.md"),
		"Inspect before editing.\n",
	);
	const migrationPlan = command(cli, [
		"migration",
		"plan",
		"--product",
		"codex",
		"--source",
		migrationSource,
		"--target",
		migrationTarget,
	]);
	const migrationPlanPath = join(root, "migration-plan.json");
	writeFileSync(migrationPlanPath, migrationPlan, { mode: 0o600 });
	assert.equal(
		JSON.parse(
			command(cli, [
				"migration",
				"apply",
				"--plan",
				migrationPlanPath,
				"--approve",
				"yes",
			]),
		).imported.length,
		1,
	);
	const tui = spawnSync(
		process.execPath,
		[
			cli,
			"tui",
			"--model",
			"fixture",
			"--providers",
			"fixture",
			"--workspace",
			workspace,
		],
		{
			encoding: "utf8",
			env: { ...environment, KESTREL_DATA_DIR: join(root, "tui-data") },
			input: "/sessions\n/quit\n",
			timeout: 10_000,
		},
	);
	assert.equal(tui.status, 0, tui.stderr || "Packaged TUI failed.");
	assert.match(tui.stdout, /Kestrel terminal/);
	assert.match(tui.stdout, /Terminal session/);

	const pairing = JSON.parse(
		command(cli, [
			"remote",
			"pair",
			"--label",
			"Packaged smoke remote",
			"--scopes",
			"read,tasks,approve",
		]),
	);
	const channelSecret = Buffer.alloc(32, 9);
	const channelConfig = join(root, "channels.json");
	writeFileSync(
		channelConfig,
		JSON.stringify({
			version: 1,
			channels: [
				{
					id: "smoke-chat",
					inboundSecretBase64: channelSecret.toString("base64"),
					sessionId: created.id,
				},
			],
		}),
		{ mode: 0o600 },
	);
	const remoteEnvironment = {
		...environment,
		KESTREL_CHANNEL_CONFIG: channelConfig,
	};
	const remote = spawn(
		process.execPath,
		[cli, "remote", "serve", "--host", "127.0.0.1", "--port", "0"],
		{ env: remoteEnvironment, stdio: ["ignore", "pipe", "pipe"] },
	);
	let remoteStderr = "";
	remote.stderr.setEncoding("utf8");
	remote.stderr.on("data", (chunk) => {
		remoteStderr += chunk;
	});
	const remoteAddress = JSON.parse(await firstLine(remote.stdout));
	const remoteApp = await fetch(`${remoteAddress.origin}/app/`);
	assert.equal(remoteApp.status, 200);
	assert.match(await remoteApp.text(), /Pair this device/);
	const pairedResponse = await fetch(
		`${remoteAddress.origin}/v1/pairings/complete`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				pairingId: pairing.pairingId,
				code: pairing.code,
			}),
		},
	);
	assert.equal(pairedResponse.status, 200);
	const device = await pairedResponse.json();
	const sessionsResponse = await fetch(`${remoteAddress.origin}/v1/sessions`, {
		headers: { authorization: `Bearer ${device.token}` },
	});
	assert.equal(sessionsResponse.status, 200);
	assert.ok(
		(await sessionsResponse.json()).sessions.some(
			(session) => session.id === created.id,
		),
	);
	const envelope = {
		channelId: "smoke-chat",
		externalId: "incoming-1",
		conversationId: "room-1",
		senderId: "person-1",
		text: "Packaged channel delivery",
		receivedAt: new Date().toISOString(),
	};
	const signature = createHmac("sha256", channelSecret)
		.update(JSON.stringify(envelope))
		.digest("hex");
	const channelResponse = await fetch(
		`${remoteAddress.origin}/v1/channels/inbound`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-kestrel-signature": signature,
			},
			body: JSON.stringify({ envelope }),
		},
	);
	assert.equal(channelResponse.status, 202);
	const eventsAbort = new AbortController();
	const eventsResponse = await fetch(`${remoteAddress.origin}/v1/events`, {
		headers: { authorization: `Bearer ${device.token}` },
		signal: eventsAbort.signal,
	});
	assert.equal(eventsResponse.status, 200);
	const eventsChunk = await eventsResponse.body.getReader().read();
	assert.match(Buffer.from(eventsChunk.value).toString("utf8"), /connected/);
	eventsAbort.abort();
	assert.equal(
		JSON.parse(command(cli, ["remote", "revoke", "--device", device.deviceId]))
			.revoked,
		device.deviceId,
	);
	const revokedResponse = await fetch(`${remoteAddress.origin}/v1/sessions`, {
		headers: { authorization: `Bearer ${device.token}` },
	});
	assert.equal(revokedResponse.status, 401);
	remote.kill("SIGTERM");
	const remoteExit = await new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => {
			remote.kill("SIGKILL");
			rejectExit(new Error("Packaged remote host did not stop."));
		}, 5_000);
		remote.once("exit", (code) => {
			clearTimeout(timeout);
			resolveExit(code);
		});
	});
	assert.equal(
		remoteExit,
		0,
		remoteStderr || "Packaged remote host exited unsuccessfully.",
	);
	assert.match(
		JSON.stringify(
			JSON.parse(
				command(cli, ["session", "messages", "--session", created.id]),
			),
		),
		/Packaged channel delivery/,
	);

	const child = spawn(
		process.execPath,
		[
			acpBinary,
			"--model",
			"fixture",
			"--providers",
			"fixture",
			"--workspace",
			workspace,
		],
		{
			env: { ...environment, KESTREL_DATA_DIR: join(root, "acp-data") },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const stream = ndJsonStream(
		Writable.toWeb(child.stdin),
		Readable.toWeb(child.stdout),
	);
	const editor = client({ name: "Packaged smoke editor" });
	await editor.connectWith(stream, async (agent) => {
		const initialized = await agent.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientInfo: { name: "Packaged smoke editor", version: "1" },
		});
		assert.equal(initialized.protocolVersion, PROTOCOL_VERSION);
		const session = await agent.request("session/new", {
			cwd: workspace,
			mcpServers: [],
		});
		const listed = await agent.request("session/list", { cwd: workspace });
		assert.ok(
			listed.sessions.some((item) => item.sessionId === session.sessionId),
		);
		await agent.request("session/close", { sessionId: session.sessionId });
	});
	child.stdin.end();
	const exitCode = await new Promise((resolveExit, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Packaged ACP host did not exit after stdin closed."));
		}, 5_000);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			resolveExit(code);
		});
	});
	assert.equal(
		exitCode,
		0,
		stderr || "Packaged ACP host exited unsuccessfully.",
	);
	process.stdout.write(
		"Packaged CLI, authenticated remote HTTP/SSE, signed channels, and ACP stdio smoke test passed.\n",
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
