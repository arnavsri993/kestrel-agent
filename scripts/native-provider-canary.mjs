import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { selectSettingsSection } from "./desktop-browser-test-helpers.mjs";
import { nativePanelProbe } from "./native-panel-probe.mjs";

// A real native Settings -> provider discovery -> Home prompt -> Core ->
// streaming HTTP response flow. No API purchase, account token or user data.
export async function nativeProviderCanary({ settings, home, profile, evidence, receipt, endpoint }) {
	const secret = "native-provider-header-fixture-secret";
	const answer = "Native provider task completed through Chromium and Agent Core.";
	let completions = 0;
	let hold = false;
	let release;
	const rejectedPrompt = "NATIVE_PANEL_BUSY_DRAFT_MUST_STAY_IN_HOME";
	let rejectedPromptDispatched = false;
	const requests = [];
	const server = createServer(async (request, response) => {
		requests.push({ path: request.url, protectedHeader: request.headers["x-kestrel-canary"] === secret });
		if (request.headers["x-kestrel-canary"] !== secret) { response.writeHead(401); response.end(); return; }
		if (request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "native-canary", name: "Native canary model", context_window: 32768 }] })); return; }
		if (request.url !== "/v1/chat/completions") { response.writeHead(404); response.end(); return; }
		let input = ""; for await (const chunk of request) { input += chunk; if (input.length > 2_000_000) { response.destroy(); return; } }
		const body = JSON.parse(input); assert.equal(body.model, "native-canary"); completions++;
		if (input.includes(rejectedPrompt)) rejectedPromptDispatched = true;
		if (hold) await new Promise(resolve => { release = resolve; });
		if (response.destroyed) return;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`data: ${JSON.stringify({ id: "native-canary-response", model: "native-canary", choices: [{ delta: { content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	try {
		await selectSettingsSection(settings, "agent-models", "Models & routing");
		const form = settings.locator(".provider-account-add"); await form.waitFor();
		await form.locator("select").selectOption("compatible");
		await form.getByLabel("Account label", { exact: true }).fill("Native provider canary");
		await form.getByLabel("Provider ID", { exact: true }).fill("native-canary");
		await form.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.address().port}/v1`);
		await form.getByLabel("Fallback model ID (optional)", { exact: true }).fill("native-canary");
		await form.locator("summary").filter({ hasText: "Advanced connection settings" }).click();
		await form.getByLabel("Additional request headers", { exact: true }).fill(`X-Kestrel-Canary: ${secret}`);
		await form.getByRole("button", { name: "Add account", exact: true }).click();
		const card = settings.locator(".provider-account-card").filter({ hasText: "Native provider canary" });
		await card.waitFor(); await card.getByText("Ready", { exact: true }).waitFor();
		const runtime = await home.evaluate(() => window.kestrel.request({ type: "runtime-list-providers" }));
		assert(runtime.ok, runtime.error); const account = runtime.providerAccounts.find(account => account.providerId === "native-canary");
		assert(account?.models.some(model => model.id === "native-canary" && model.availability === "available"));
		assert(!JSON.stringify(runtime).includes(secret));
		assert(!(await readFile(join(profile, "native-core/provider-accounts.json"), "utf8")).includes(secret));
		await settings.screenshot({ path: join(evidence, "native-provider-settings.png") });
		await home.evaluate(id => {
			localStorage.setItem("kestrel:execution-mode", "manual"); localStorage.setItem("kestrel:provider-id", "native-canary");
			localStorage.setItem("kestrel:provider-account-id", id); localStorage.setItem("kestrel:model", "native-canary");
		}, account.id);
		await home.bringToFront(); await home.reload(); await home.locator("#new-tab-chat-input").waitFor();
		await home.locator("#new-tab-chat-input").fill("Complete the native provider canary with one short confirmation.");
		await home.getByRole("button", { name: /^Send message to / }).click();
		let sessionId;
		for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
			const sessions = await home.evaluate(() => window.kestrel.request({ type: "runtime-list-sessions" }));
			for (const session of sessions.sessions ?? []) {
				const messages = await home.evaluate(sessionId => window.kestrel.request({ type: "runtime-list-messages", sessionId }), session.id);
				if (messages.messages?.some(message => message.role === "assistant" && message.content.includes(answer))) { sessionId = session.id; break; }
			}
			if (sessionId) break; await delay(100);
		}
		assert(sessionId, "The visible Home composer must produce a persisted assistant response through the native provider.");
		assert(completions > 0); assert(requests.every(request => request.protectedHeader));
		receipt.phases.push({ phase: "native-provider-settings-discovery-and-Home-agent", passed: true, accountId: account.id, sessionId, completions });

		// Hold one real request at the endpoint; a provider edit must not stop it
		// or persist the requested credential. Releasing it must finish normally.
		hold = true;
		await home.evaluate(({ sessionId, accountId }) => {
			window.__nativeProviderPending = window.kestrel.request({ type: "runtime-run-agent", sessionId, message: "Check busy provider protection.", model: "native-canary", providerIds: [accountId], streamId: "native-provider-busy-canary", maximumTurns: 2 });
		}, { sessionId, accountId: account.id });
		for (const deadline = Date.now() + 15_000; !release && Date.now() < deadline;) await delay(50);
		assert(release, "The real provider task did not reach the fixture.");
		const blocked = await home.evaluate(() => window.kestrel.request({ type: "credential-set", credentialId: "openai", value: "must-not-persist-during-task" }));
		assert.equal(blocked.ok, false, "An active task must reject provider changes.");
		const credentials = await home.evaluate(() => window.kestrel.request({ type: "credential-list" }));
		assert(credentials.ok); assert.equal(credentials.credentials.find(item => item.id === "openai").configured, false);
		release(); release = undefined; hold = false;
		const completed = await home.evaluate(() => window.__nativeProviderPending); assert(completed.ok, completed.error); assert.equal(completed.run?.status, "completed");
		receipt.phases.push({ phase: "native-provider-change-preserves-active-task", passed: true });

		// Opening the marketplace from Settings also opens Chromium's actual
		// companion. A subsequent Home prompt must execute and render there.
		await settings.bringToFront(); await selectSettingsSection(settings, "browser-extensions", "Extensions");
		await settings.getByRole("link", { name: /Browse Chrome Web Store/ }).click();
		await home.bringToFront();
		await home.waitForFunction(() => document.querySelectorAll(".agent-sidebar").length === 0);
		const uiUrl = new URL(home.url());
		const panel = await nativePanelProbe(endpoint, `${uiUrl.protocol}//${uiUrl.host}`);
		try {
			const before = completions;
			await home.locator("#new-tab-chat-input").fill("Complete the native companion canary.");
			await home.getByRole("button", { name: /^Send message to / }).click();
			let rendered = false;
			for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
				if (completions > before && (await panel.text()).includes(answer)) { rendered = true; break; }
				await delay(100);
			}
			assert(rendered, "The Home task must reach and render in Chromium's actual native companion.");
			assert.equal(await home.locator("#new-tab-chat-input").inputValue(), "", "Home clears the prompt only after the native panel accepts it.");
			await writeFile(join(evidence, "native-companion-provider-conversation.png"), await panel.screenshot());
			receipt.phases.push({ phase: "native-Home-task-handoff-to-Chromium-companion", passed: true, targetId: panel.id });
			hold = true;
			await home.locator("#new-tab-chat-input").fill("Hold this native companion task until the test releases it.");
			await home.getByRole("button", { name: /^Send message to / }).click();
			for (const deadline = Date.now() + 15_000; !release && Date.now() < deadline;) await delay(50);
			assert(release, "The companion task did not reach the provider.");
			await home.locator("#new-tab-chat-input").fill(rejectedPrompt);
			await home.getByRole("button", { name: /^Send message to / }).click();
			await home.getByText("The agent did not accept this task. Your message is still here.", { exact: true }).waitFor();
			assert.equal(await home.locator("#new-tab-chat-input").inputValue(), rejectedPrompt);
			assert.equal(rejectedPromptDispatched, false, "A busy companion must not dispatch the rejected draft.");
			release(); release = undefined; hold = false;
			let taskCompleted = false;
			for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
				const sessions = await home.evaluate(() => window.kestrel.request({ type: "runtime-list-sessions" }));
				const task = sessions.sessions?.find(session => session.title.startsWith("Hold this native companion task"));
				if (task) {
					const runs = await home.evaluate(sessionId => window.kestrel.request({ type: "runtime-list-runs", sessionId }), task.id);
					if (runs.runs?.some(run => run.status === "completed")) { taskCompleted = true; break; }
				}
				await delay(100);
			}
			assert(taskCompleted, "The original companion task must finish after rejecting the competing Home draft.");
			receipt.phases.push({ phase: "native-companion-busy-task-and-Home-draft-preservation", passed: true });
		} finally { panel.close(); }
		return { accountId: account.id, sessionId, answer };
	} finally {
		release?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
	}
}

// Explicit opt-in live entitlement check. This uses the official vendor CLI's
// existing login; Kestrel receives account metadata and never copies its tokens.
export async function nativeCodexCanary({ settings, home, evidence, receipt }) {
	await settings.bringToFront(); await selectSettingsSection(settings, "agent-connections", "Accounts & access");
	await settings.locator("summary").filter({ hasText: "Model provider · ChatGPT" }).click();
	const connection = settings.locator(".oauth-connection").filter({ hasText: "ChatGPT" });
	const statuses = await home.evaluate(() => window.kestrel.request({ type: "subscription-cli-status" }));
	assert(statuses.ok); const codex = statuses.subscriptionClis.find(item => item.id === "codex");
	assert(codex?.detected && codex.authenticated, "The live native Codex canary requires an existing official ChatGPT login.");
	if (!codex.enabled) await connection.getByRole("button", { name: "Enable model route", exact: true }).click();
	await connection.getByRole("button", { name: "Disable model route", exact: true }).waitFor({ timeout: 30_000 });
	const refreshed = await home.evaluate(() => window.kestrel.request({ type: "runtime-refresh-provider-models", providerId: "native-cli-codex" }));
	assert(refreshed.ok, refreshed.error);
	const account = refreshed.providerAccounts.find(account => account.id === "native-cli-codex");
	const models = account?.models.filter(model => model.availability === "available");
	assert(models?.length, "The official Codex app-server did not return an available entitled model.");
	const model = models.find(model => model.id === "gpt-5.6-luna") ?? models.find(model => model.id === "gpt-6-luna") ?? models[0];
	await selectSettingsSection(settings, "agent-models", "Models & routing");
	const subscriptionCard = settings.locator(".provider-account-card").filter({ hasText: "ChatGPT plan through Codex" });
	await subscriptionCard.waitFor(); assert.equal(await subscriptionCard.getByRole("button", { name: "Connect", exact: true }).count(), 0);
	await subscriptionCard.getByText("Manage this connection in Accounts and access.", { exact: true }).waitFor();
	await home.evaluate(({ accountId, model }) => {
		localStorage.setItem("kestrel:execution-mode", "manual"); localStorage.setItem("kestrel:provider-id", accountId);
		localStorage.setItem("kestrel:provider-account-id", accountId); localStorage.setItem("kestrel:model", model);
		localStorage.setItem("kestrel:reasoning-effort", "low");
	}, { accountId: account.id, model: model.id });
	await home.bringToFront(); await home.reload(); await home.locator("#new-tab-chat-input").waitFor();
	const marker = `NATIVE_CODEX_OK_${Date.now()}`;
	await home.locator("#new-tab-chat-input").fill(`Reply with only ${marker}. Do not use tools or read files.`);
	await home.getByRole("button", { name: /^Send message to / }).click();
	let sessionId;
	for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
		const sessions = await home.evaluate(() => window.kestrel.request({ type: "runtime-list-sessions" }));
		for (const session of sessions.sessions ?? []) {
			const messages = await home.evaluate(sessionId => window.kestrel.request({ type: "runtime-list-messages", sessionId }), session.id);
			if (messages.messages?.some(message => message.role === "assistant" && message.content.includes(marker))) { sessionId = session.id; break; }
		}
		if (sessionId) break; await delay(250);
	}
	assert(sessionId, "The visible native Home prompt did not receive a real Codex response.");
	await home.screenshot({ path: join(evidence, "native-Codex-conversation.png") });
	receipt.phases.push({ phase: "native-existing-Codex-login-model-discovery-and-Home-agent", passed: true, accountId: account.id, model: model.id, sessionId });
}
