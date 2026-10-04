import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

// A headless renderer fixture never opens Electron or reads the Kestrel profile.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const { createServer } = await import(pathToFileURL(desktopRequire.resolve("vite")).href);
const output = join(root, ".tmp/memory-cleanup-review");
mkdirSync(output, { recursive: true });
const fixture = mkdtempSync(join(root, ".tmp/memory-cleanup-renderer-"));
writeFileSync(join(fixture, "index.html"), '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>');
writeFileSync(join(fixture, "fixture.js"), `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryWorkspace } from '/apps/desktop/src/renderer/components/MemoryWorkspace.tsx';
const record = { id: 'owned-fixture', kind: 'memory', title: 'Owned automatic fixture', text: 'Complete owned text with a second line.\\nThis proof must remain readable.', tier: 'mid_term', domainIds: ['personal'], sourceIds: ['synthetic:fixture'], sharing: 'owner_only', confidence: .6, confirmation: 'inferred', sensitivity: 'personal', passages: [], origin: 'legacy', version: 1, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2026-07-22T12:00:00.000Z' };
const taskResult = {...record, id: 'workspace:agent-memory:agent-outcome-owned-task', title: 'agent-outcome-owned-task', text: 'Owned browser task finished\\nFull owned task proof: TASK-42.', sourceIds: ['task:owned-task']};
window.fixture = { calls: [], document: record, taskResult, failNextApply: false, applied: 0, holdApply: false };
window.kestrel = { request: async input => {
 const f = window.fixture; f.calls.push(input);
 if(input.type === 'memory-workspace-read') return {ok:true, memoryWorkspace:{query: input.query, documents: [...(f.document ? [f.document] : []), f.taskResult], domains: [], viewers: [{id:'user', label:'You'}]}};
 if(input.type === 'memory-document-save') { const key=input.document.id===f.taskResult.id?'taskResult':'document'; f[key]={...f[key], ...input.document, version:f[key].version+1}; return {ok:true,memoryDocument:f[key]}; }
 if(input.type === 'memory-fade-plan') return {ok:true,memoryFadePreview:{plan:{version:1,id:'owned-plan',createdAt:'2026-07-22T12:00:00.000Z',agentMemoryCandidates:1,legacyMemoryCandidates:0,timelineCandidates:0,sourceDerivedCandidates:0,applied:false}, candidates:[{kind:'agent',id:record.id,content:record.text}]}};
 if(input.type === 'memory-fade-apply') {
  if(f.failNextApply){f.failNextApply=false;return {ok:false,error:'Memory changed after review. Review a fresh cleanup plan.'};}
  if(f.holdApply) await new Promise(resolve => { f.releaseApply = resolve; });
  f.applied++; f.document=null; return {ok:true,memoryFadeDryRun:{applied:true,backupKey:'owned-fixture-backup'}};
 }
 throw Error('Unexpected fixture request '+input.type);
}};
createRoot(document.getElementById('root')).render(createElement(MemoryWorkspace));
`);
const server = await createServer({ root, configFile: false, logLevel: "error",
	resolve: { alias: [
		{ find: /^react$/, replacement: desktopRequire.resolve("react") },
		{ find: /^react-dom\/client$/, replacement: desktopRequire.resolve("react-dom/client") },
	] },
	esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, strictPort: false }, appType: "mpa" });
let browser;
const report = [];
try {
	await server.listen();
	const address = server.httpServer.address();
	browser = await chromium.launch({ headless: true });
	for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
		const page = await browser.newPage({ viewport }); const errors = [];
		page.on("pageerror", error => errors.push(error.message));
		const response = await page.goto(`http://127.0.0.1:${address.port}/${fixture.slice(root.length + 1)}/index.html`);
		assert.equal(response.status(), 200);
		try { await page.waitForFunction(() => document.querySelector("#root")?.children.length > 0, undefined, { timeout: 10_000 }); }
		catch (error) { throw new Error(`Owned fixture could not render: ${JSON.stringify(errors)}`, { cause: error }); }
		await page.addStyleTag({ content: "body{margin:0;background:#171718;color:#f2f2f0;font:14px system-ui;--border:#38383a;--ink:#f2f2f0;--panel:#242426;--line:#38383a;--radius-control:8px;}*{box-sizing:border-box;}button,input,select{font:inherit;}" });
		await page.getByRole("button", { name: "Notes", exact: true }).click();
		await page.getByRole("heading", { name: "Owned automatic fixture" }).waitFor();
		const taskResults = page.locator(".memory-task-results");
		assert.equal(await taskResults.evaluate(element => element.open), false);
		const search = page.getByRole("searchbox");
		await search.fill("TASK-42");
		assert.equal(await taskResults.evaluate(element => element.open), true);
		await taskResults.getByRole("button").click();
		await page.getByRole("heading", { name: "Owned browser task finished", exact: true }).waitFor();
		assert.match(await page.locator(".memory-reader").innerText(), /Full owned task proof: TASK-42/);
		await search.fill("");
		assert.equal(await taskResults.evaluate(element => element.open), false);
		await page.getByRole("button", { name: "Edit note", exact: true }).click();
		await page.getByLabel("Title (optional)").fill("My browser comparison");
		await page.getByLabel("What Kestrel should know").fill("My corrected comparison.\nKeep the source proof: TASK-42.");
		await page.locator(".memory-editor").getByRole("button", { name: "Save", exact: true }).click();
		await page.getByRole("heading", { name: "My browser comparison", exact: true }).waitFor();
		assert.equal(await page.locator(".memory-task-results").count(), 0);
		assert.equal(await page.locator(".memory-kicker").count(), 0);
		const editedTask = await page.evaluate(() => window.fixture.taskResult);
		assert.equal(editedTask.origin, "manual");
		assert.equal(editedTask.title, "My browser comparison");
		assert.deepEqual(editedTask.sourceIds, ["task:owned-task"]);
		assert.equal(editedTask.confidence, .6);
		assert.equal(editedTask.confirmation, "inferred");
		await page.locator(".memory-library aside").getByRole("button").filter({ hasText: "My browser comparison" }).waitFor();
		await page.locator(".memory-library aside").getByRole("button").filter({ hasText: "Owned automatic fixture" }).click();
		await page.getByRole("button", { name: "Edit note", exact: true }).click();
		await page.getByLabel("What Kestrel should know").fill("Unsaved owned draft");
		await page.getByText("Note filters", { exact: true }).click();
		page.once("dialog", dialog => dialog.dismiss());
		await page.getByLabel("Note retention").selectOption("kept");
		assert.equal(await page.getByLabel("Note retention").inputValue(), "all");
		assert.equal(await page.getByLabel("What Kestrel should know").inputValue(), "Unsaved owned draft");
		await page.getByText("Review old automatic notes", { exact: true }).focus(); await page.keyboard.press("Enter");
		assert(await page.getByRole("button", { name: "Review cleanup", exact: true }).isDisabled());
		page.once("dialog", dialog => dialog.accept());
		await page.locator(".memory-editor").getByRole("button", { name: "Cancel", exact: true }).click();
		await page.getByRole("button", { name: "Review cleanup", exact: true }).waitFor({ state: "visible" });
		await page.getByRole("button", { name: "Review cleanup", exact: true }).click();
		const remove = page.getByRole("button", { name: "Remove reviewed notes", exact: true });
		await remove.waitFor(); assert(await remove.isDisabled());
		assert.equal(await page.evaluate(() => window.fixture.applied), 0);
		assert.match(await page.locator(".memory-cleanup-candidates").innerText(), /second line\.\nThis proof must remain readable/);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		assert.equal(await page.evaluate(() => window.fixture.applied), 0);
		await page.getByRole("button", { name: "Review cleanup", exact: true }).click();
		await page.getByRole("checkbox").check(); await page.evaluate(() => { window.fixture.failNextApply = true; });
		await remove.click(); await page.getByRole("alert").filter({ hasText: "changed after review" }).waitFor();
		assert.equal(await page.evaluate(() => window.fixture.applied), 0);
		await page.getByRole("button", { name: "Review cleanup", exact: true }).click();
		assert(await remove.isDisabled()); await page.getByRole("checkbox").check();
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
		await page.screenshot({ path: join(output, `review-${viewport.width}.png`), fullPage: true });
		await page.evaluate(() => { window.fixture.holdApply = true; });
		await remove.click();
		await page.waitForFunction(() => typeof window.fixture.releaseApply === "function");
		await page.waitForFunction(() => document.querySelector(".memory-lane-actions button")?.disabled);
		assert(await page.getByRole("button", { name: "Edit note", exact: true }).isDisabled());
		assert(await page.getByLabel("Note retention").isDisabled());
		await page.getByRole("button", { name: "Recent activity", exact: true }).click();
		assert.equal(await page.locator(".memory-editor").count(), 0);
		assert.equal(await page.locator(".memory-timeline").count(), 0);
		await page.evaluate(() => window.fixture.releaseApply());
		await page.getByRole("status").filter({ hasText: "owned-fixture-backup" }).waitFor();
		const calls = await page.evaluate(() => window.fixture.calls.filter(call => call.type === "memory-fade-apply"));
		assert.deepEqual(calls, [{ type: "memory-fade-apply", planId: "owned-plan", approved: true }, { type: "memory-fade-apply", planId: "owned-plan", approved: true }]);
		assert.equal(await page.evaluate(() => window.fixture.applied), 1);
		assert.deepEqual(errors, []);
		// Keep retains an inference without claiming it became a confirmed fact.
		await page.reload(); await page.getByRole("button", { name: "Notes", exact: true }).click();
		await page.getByRole("button", { name: "Keep", exact: true }).click();
		await page.getByText("Note filters", { exact: true }).click();
		await page.getByLabel("Note retention").selectOption("kept");
		await page.getByRole("heading", { name: "Owned automatic fixture" }).waitFor();
		assert.equal(await page.evaluate(() => window.fixture.document.confirmation), "inferred");
		assert.equal(await page.evaluate(() => window.fixture.document.confidence), .6);
		assert.equal(await page.evaluate(() => window.fixture.document.tier), "long_term");
		report.push({ viewport, approvalOrder: "pass", staleApproval: "pass", cancel: "pass", draftProtection: "pass", busyProtection: "pass", taskResultSearch: "pass", taskResultEdit: "pass", keepInference: "pass", rendererErrors: errors });
		await page.close();
	}
	writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
	console.log(`Memory cleanup review passed at ${report.length} viewports.`);
} finally {
	await browser?.close(); await server.close(); rmSync(fixture, { recursive: true, force: true });
}
