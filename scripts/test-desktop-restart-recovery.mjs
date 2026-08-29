import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-restart-recovery-smoke-"));
const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
const packagedExecutable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const executablePath = packagedExecutable
	? resolve(packagedExecutable)
	: requireFromDesktop("electron");
const launchArgs = packagedExecutable
	? ["--use-mock-keychain"]
	: [resolve("apps/desktop/out/main/index.js")];
let taskCalls = 0;
let taskStartedResolve;
const taskStarted = new Promise((resolvePromise) => {
	taskStartedResolve = resolvePromise;
});
const hangingResponses = new Set();

function sendCompletion(response, text, id) {
	const event = {
		id,
		model: "fixture-model",
		choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
		usage: { prompt_tokens: 20, completion_tokens: 8 },
	};
	response.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
}

const server = createServer(async (request, response) => {
	if (request.method === "GET" && request.url === "/v1/models") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({ data: [{ id: "fixture-model", object: "model" }] }),
		);
		return;
	}
	if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const serialized = JSON.stringify(body.messages ?? []);
	if (!serialized.includes("Prove restart recovery")) {
		sendCompletion(response, "Welcome back.", "welcome-fixture");
		return;
	}
	taskCalls += 1;
	if (taskCalls === 1) {
		hangingResponses.add(response);
		response.on("close", () => hangingResponses.delete(response));
		taskStartedResolve();
		return;
	}
	sendCompletion(
		response,
		"Completed only after explicit retry.",
		`task-fixture-${taskCalls}`,
	);
});

await new Promise((resolveListen, rejectListen) => {
	server.once("error", rejectListen);
	server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert(address && typeof address === "object");
let application;

function corePid(rootPid) {
	const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.map((line) => {
			const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
			return match
				? {
						pid: Number(match[1]),
						ppid: Number(match[2]),
						command: match[3],
					}
				: null;
		})
		.filter(Boolean);
	const descendants = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
				descendants.add(row.pid);
				changed = true;
			}
		}
	}
	const candidates = rows.filter(
		(row) =>
			descendants.has(row.pid) &&
			(/out\/main\/utility\.js/.test(row.command) ||
				(/--type=utility/.test(row.command) &&
					/--utility-sub-type=node\.mojom\.NodeService/.test(row.command))),
	);
	assert.equal(
		candidates.length,
		1,
		`Expected one Agent Core child: ${JSON.stringify(candidates)}`,
	);
	return candidates[0].pid;
}

async function recoveredRuns(page) {
	return page.evaluate(async () => {
		const sessions = await window.kestrel.request({
			type: "runtime-list-sessions",
		});
		if (!sessions.ok) throw new Error(sessions.error);
		for (const session of sessions.sessions ?? []) {
			const response = await window.kestrel.request({
				type: "runtime-list-runs",
				sessionId: session.id,
			});
			if (!response.ok) throw new Error(response.error);
			if (
				response.runs?.some(
					(run) => run.recovery?.reason === "core_restarted",
				)
			)
				return response.runs;
		}
		return null;
	});
}

try {
	application = await electron.launch({
		executablePath,
		args: launchArgs,
		env: {
			...process.env,
			KESTREL_DISABLE_UPDATES: "1",
			KESTREL_TEST_USER_DATA: join(root, "user-data"),
			KESTREL_REAL_USER_PROFILE: "1",
			...(packagedExecutable
				? {}
				: {
						KESTREL_USE_NODE_CORE: "1",
						KESTREL_NODE_EXEC_PATH: process.execPath,
					}),
			NOUS_API_KEY: "local-test-credential",
			NOUS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			NOUS_MODEL: "fixture-model",
		},
	});
	const page = await application.firstWindow();
	page.setDefaultTimeout(30_000);
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
	});
	await page.reload();
	await page.locator("#runtime-prompt").waitFor();
	await page.getByRole("button", { name: /^Model:/ }).click();
	const menu = page.getByRole("menu", {
		name: "Choose provider, model, and thinking level",
	});
	await menu.getByRole("menuitem", { name: /^Nous/ }).click();
	await menu.getByLabel("Custom model ID").fill("fixture-model");
	await menu.getByLabel("Custom model ID").press("Enter");
	await menu.waitFor({ state: "detached" });
	await page
		.getByRole("textbox", { name: "Message Kestrel" })
		.fill("Prove restart recovery");
	await page
		.locator(".agent-conversation-host")
		.getByRole("button", { name: "Send message", exact: true })
		.click();
	await taskStarted;

	process.kill(corePid(application.process().pid), "SIGKILL");

	await page.getByText("Task interrupted", { exact: true }).waitFor();
	await page
		.getByText(/No model or tool call was resumed automatically/i)
		.waitFor();
	await page.screenshot({ path: join(root, "interrupted.png"), fullPage: true });
	const interrupted = await recoveredRuns(page);
	assert(interrupted);
	assert.deepEqual(
		interrupted.map((run) => ({ status: run.status, recovery: run.recovery })),
		[
			{
				status: "failed",
				recovery: {
					reason: "core_restarted",
					action: "retry_last_turn",
				},
			},
		],
	);
	await new Promise((resolveWait) => setTimeout(resolveWait, 500));
	assert.equal(taskCalls, 1, "The crashed provider request was replayed.");

	await page
		.locator(".runtime-outcome")
		.getByRole("button", { name: "Retry last turn", exact: true })
		.click();
	await page.getByText("Task complete", { exact: true }).waitFor();
	assert.equal(taskCalls, 2);
	const retried = await recoveredRuns(page);
	assert(retried);
	assert.deepEqual(
		retried.map((run) => run.status),
		["failed", "completed"],
	);
	process.stdout.write(
		"Restart recovery UI, no-replay boundary, and explicit retry passed.\n",
	);
} finally {
	for (const response of hangingResponses) response.destroy();
	await application?.close();
	await new Promise((resolveClose) => server.close(resolveClose));
	rmSync(root, { recursive: true, force: true });
}
