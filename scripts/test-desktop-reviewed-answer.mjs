import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { AgentCore } from "../packages/agent-core/src/index.ts";
import { KestrelDatabase } from "../packages/database/src/index.ts";
import { CredentialBroker, PlaintextSecretProtection } from "../apps/desktop/src/main/credential-broker.ts";

// This is a synthetic review/correction and disposable encrypted profile, never
// a provider task or the person's profile. No preload response stubbing is used.
const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-reviewed-answer-")));
for (const name of ["profile", "home", "codex", "tmp"]) mkdirSync(join(root, name));
const evidence = process.env.KESTREL_REVIEWED_ANSWER_EVIDENCE_DIR;
const executable = process.env.KESTREL_DESKTOP_EXECUTABLE;
const allowedEnvironment = Object.fromEntries(["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "CI"].flatMap(key =>
	process.env[key] === undefined ? [] : [[key, process.env[key]]]));
// Keep constructor discovery, credentials and subscriptions inside this fixture.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, allowedEnvironment, {
	HOME: join(root, "home"), USER: "review-fixture", LOGNAME: "review-fixture",
	CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"),
	KESTREL_TEST_USER_DATA: join(root, "profile"), KESTREL_REAL_USER_PROFILE: "1",
	KESTREL_TEST_ALLOW_MULTIPLE_INSTANCES: "1", KESTREL_DISABLE_UPDATES: "1",
	KESTREL_DISABLE_LOCAL_MODEL_DISCOVERY: "1", KESTREL_DISABLE_SUBSCRIPTION_CLI_DISCOVERY: "1",
});
if (evidence) mkdirSync(evidence, { recursive: true });
let application;
let page;
let core;
const initialText = ("Initial answer without validation evidence. " +
	"This initial draft contains the proposed conclusion and its source notes for the requested change. ".repeat(16)).trim();
const correctedText = ("Corrected answer: the requested validation evidence is included. " +
	"The source was inspected and the focused validation passed using preserved task context. ".repeat(12)).trim();
const calls = [];
let repairSawInitial = false;
const provider = (id, capabilities) => ({
	id, defaultModel: `${id}-model`,
	capabilities: { streaming: true, tools: true, images: false, audio: false, documents: false, local: false },
	profileHints: { capabilities, features: { reasoningLevels: true } },
	probe: async () => undefined,
	complete: async request => {
		const review = request.messages.some(message => message.content.some(part =>
			part.type === "text" && part.text.startsWith("Review the completed agent result")));
		calls.push({ id, phase: review ? "review" : id === "primary" ? "initial" : "correction" });
		if (!review && id !== "primary") repairSawInitial = request.messages.some(message =>
			message.role === "assistant" && message.content.some(part => part.type === "text" && part.text.includes("Initial answer without validation evidence.")));
		return { providerId: id, model: request.model,
			text: review ? request.messages.some(message => message.content.some(part =>
				part.type === "text" && part.text.includes("Corrected answer: the requested validation evidence is included.")))
				? "VERDICT: PASS\nThe corrected answer now includes the requested evidence."
				: "VERDICT: FAIL\nThe initial answer lacks validation evidence."
				: id === "primary" ? initialText : correctedText,
			toolCalls: [], usage: { inputTokens: 3, outputTokens: 1 }, finishReason: "stop" };
	},
});
async function capture(name) {
	if (!evidence) return;
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
	});
	// Flush the compositor before the native capture; first-frame cache can still
	// contain the startup screen after the DOM is already ready.
	await page.screenshot();
	const png = await application.evaluate(async ({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"));
		return (await window.webContents.capturePage()).toPNG().toString("base64");
	});
	writeFileSync(join(evidence, name), Buffer.from(png, "base64"));
}
try {
	const key = await new CredentialBroker(join(root, "profile"), new PlaintextSecretProtection()).getDatabaseKey();
	const database = new KestrelDatabase(join(root, "profile", "database", "kestrel.sqlite"), key);
	core = new AgentCore({ database, learnedSkillRoot: join(root, "learned-skills"), now: () => "2026-07-22T15:00:00.000Z", modelProviders: [
		provider("primary", { coding: 0.99, backend_architecture: 0.99, complex_reasoning: 0.99, reliability: 0.99 }),
		provider("reviewer", { code_review: 0.99, reliability: 0.99 }),
		provider("repair", { coding: 0.96, backend_architecture: 0.96, complex_reasoning: 0.96, reliability: 0.96 }),
	] });
	const session = core.runtime.createSession({ title: "Reviewed answer fixture", kind: "conversation" });
	const response = await core.handle({ type: "runtime-run-agent", sessionId: session.id,
		message: "Implement this production backend architecture change.", model: "auto", providerIds: ["auto"] });
	assert(response.ok && response.run?.status === "completed");
	assert.deepEqual(calls.map(call => call.phase), ["initial", "review", "correction", "review"]);
	assert.notEqual(calls[0].id, calls[1].id, "Review must be independent of the initial executor");
	assert(repairSawInitial, "Correction must preserve the first answer as internal context");
	const messages = core.runtime.listMessages(session.id);
	const initial = messages.find(message => message.content === initialText);
	const corrected = messages.find(message => message.content === correctedText);
	assert(initial && corrected && corrected.supersedesMessageId === initial.id, "Correction must durably link the preserved draft");
	assert(!messages.some(message => message.content.includes("VERDICT:")), "Review evidence must stay internal");
	await core.close(); core = undefined;
	const requireFromDesktop = createRequire(resolve("apps/desktop/package.json"));
	application = await electron.launch({
		executablePath: executable ? resolve(executable) : requireFromDesktop("electron"),
		args: [...(executable ? [] : [resolve("apps/desktop")]), "--use-mock-keychain"],
		env: { ...process.env }, timeout: 30_000,
	});
	page = await application.firstWindow(); page.setDefaultTimeout(20_000);
	const errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForLoadState("domcontentloaded");
	await page.evaluate(() => {
		localStorage.setItem("kestrel:onboarded", "yes");
		localStorage.setItem("kestrel:default-browser-prompted", "yes");
		localStorage.setItem("kestrel:navigation-sidebar", "expanded");
	});
	await page.reload();
	await application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"));
		window.setMinimumSize(360, 360); window.setSize(1440, 900);
	});
	const openChat = () => page.locator(".kestrel-sidebar").getByRole("button", { name: "Reviewed answer fixture", exact: true }).click();
	await openChat();
	const host = page.locator(".agent-conversation-host");
	const draft = host.locator("details.reviewed-answer-earlier");
	const initialBody = host.locator(`[data-runtime-message-id="${initial.id}"] p`).first();
	const correctedBody = host.locator(`[data-runtime-message-id="${corrected.id}"] p`).first();
	await expect(draft).toHaveCount(1);
	await expect(draft).not.toHaveAttribute("open");
	await expect(initialBody).not.toBeVisible();
	await expect(correctedBody).toBeVisible();
	await draft.locator("summary").focus(); await page.keyboard.press("Enter");
	await expect(initialBody).toBeVisible();
	await expect(initialBody).toHaveText(initialText.trim());
	await capture("reviewed-answer-expanded.png");
	await page.keyboard.press("Space"); await expect(draft).not.toHaveAttribute("open");
	await capture("reviewed-answer-desktop.png");
	// Reload proves the installed reader preserves the encrypted relation.
	await page.reload(); await openChat();
	await expect(draft).not.toHaveAttribute("open");
	const persisted = await page.evaluate(sessionId => window.kestrel.request({ type: "runtime-list-messages", sessionId }), session.id);
	assert(persisted.ok && persisted.messages.find(message => message.id === corrected.id)?.supersedesMessageId === initial.id);
	for (const [width, zoom, name] of [[840, 1, "reviewed-answer-narrow.png"], [1920, 2, "reviewed-answer-zoom.png"]]) {
		await application.evaluate(({ BrowserWindow }, { width, zoom }) => {
			const window = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("petOverlay=1"));
			window.setSize(width, 900); window.webContents.setZoomFactor(zoom);
		}, { width, zoom });
		await expect(draft.locator("summary")).toBeVisible();
		await expect(correctedBody).toBeVisible();
		await draft.locator("summary").click();
		await expect(initialBody).toBeVisible();
		assert(await draft.evaluate(node => node.scrollWidth <= node.clientWidth + 1), "Draft disclosure must fit its pane");
		await draft.locator("summary").click();
		await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
		await capture(name);
	}
	assert.deepEqual(errors, []);
	if (evidence) writeFileSync(join(evidence, "proof.json"), JSON.stringify({
		calls, repairSawInitial, preservedDraft: true, persistedRelation: true,
		sourceWorkflowWithSyntheticProviders: true, realProfileVerified: false,
		executable: executable ?? "source Electron", keyboardAndReload: true,
	}, null, 2));
	console.log("Reviewed answer smoke passed: preserved draft, durable correction, keyboard disclosure, reload, narrow and zoom.");
} catch (error) {
	if (application) await capture("failure.png").catch(() => {});
	throw error;
} finally {
	await application?.close().catch(() => {});
	await core?.close().catch(() => {});
	rmSync(root, { recursive: true, force: true });
}
