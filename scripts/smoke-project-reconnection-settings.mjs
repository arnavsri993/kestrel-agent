import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const { build } = createRequire(desktopRequire.resolve("vite"))("esbuild");
const typescript = desktopRequire("typescript");
const componentPath = join(root, "apps/desktop/src/renderer/App.tsx");
const rendererEntry = join(root, "apps/desktop/src/renderer/src.tsx"), rendererRoot = dirname(rendererEntry);
const evidence = resolve(process.env.KESTREL_PROJECT_RECONNECTION_SETTINGS_EVIDENCE || ".tmp/project-reconnection-settings-evidence");
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Preserve prior evidence; choose a fresh directory.");
const temporary = await mkdtemp(join(tmpdir(), "kestrel-project-reconnection-settings-"));
const appSource = await readFile(componentPath, "utf8"), rendererSource = await readFile(rendererEntry, "utf8");
const sourceFile = typescript.createSourceFile(componentPath, appSource, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TSX);
let componentNode;
for (const node of sourceFile.statements) if (typescript.isFunctionDeclaration(node) && node.name?.text === "AgentWorkspaceSettings") componentNode = node;
assert(componentNode, "Could not locate the actual AgentWorkspaceSettings function in App.tsx.");
const component = componentNode.getText(sourceFile);
const rendererFile = typescript.createSourceFile(rendererEntry, rendererSource, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TSX);
const stylesheetImports = rendererFile.statements.filter(node => typescript.isImportDeclaration(node) && typescript.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith(".css"))
	.map(node => node.moduleSpecifier.text);
assert(stylesheetImports.length > 0, "Could not locate renderer stylesheet imports in src.tsx.");
const cssOutputRoot = join(temporary, "renderer-css");
const cssBundle = await build({ stdin: { contents: stylesheetImports.map(path => `import ${JSON.stringify(path)};`).join("\n"), resolveDir: rendererRoot,
	sourcefile: "project-reconnection-renderer-styles.tsx", loader: "tsx" }, bundle: true, platform: "browser", outdir: cssOutputRoot,
	entryNames: "renderer", assetNames: "assets/[name]-[hash]", loader: { ".svg": "file", ".jpg": "file", ".jpeg": "file", ".png": "file", ".woff": "file", ".woff2": "file" }, write: false, logLevel: "warning" });
const outputs = new Map(cssBundle.outputFiles.map(output => [output.path.slice(cssOutputRoot.length + 1).replaceAll("\\", "/"), output]));
const cssOutput = outputs.get("renderer.css");
assert(cssOutput, "esbuild did not emit the renderer source stylesheet bundle.");
const css = cssOutput.text;
const receipts = { kind: "headless-project-reconnection-settings", startedAt: new Date().toISOString(),
	componentSha256: createHash("sha256").update(component).digest("hex"), rendererCssSha256: createHash("sha256").update(css).digest("hex"),
	rendererCssInputs: stylesheetImports.map(path => `apps/desktop/src/renderer/${path.replace(/^\.\//, "")}`),
	bridgeMocked: true, scope: "Actual AgentWorkspaceSettings function extracted by TypeScript AST, CSS bundled directly from the current src.tsx stylesheet imports, generated public fixture data, and mocked Kestrel bridge in headless Chromium; not full-app or canonical-install evidence.",
	sourceFunction: "apps/desktop/src/renderer/App.tsx#AgentWorkspaceSettings", phases: [], calls: [], screenshots: [], pageErrors: [] };
let browser, server, page;
const errors = [];

try {
	const bundle = join(temporary, "fixture.js");
	await build({ stdin: { contents: `
import React, {useState,useRef,useCallback,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
${component}
function Fixture(){ return <div className="unified-ui"><main className="settings-content"><AgentWorkspaceSettings/></main></div>; }
createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: join(root, "apps/desktop"), loader: "tsx" },
		outfile: bundle, bundle: true, platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning" });
	const javascript = await readFile(bundle, "utf8");
	server = createServer((request, response) => {
		if (request.url === "/fixture.js") { response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); response.end(javascript); return; }
		const pathname = request.url?.split("?", 1)[0]?.replace(/^\//, "");
		if (pathname && pathname !== "fixture.js" && pathname !== "renderer.css" && !pathname.includes("..")) {
			const asset = outputs.get(pathname);
			if (asset) { const contentType = pathname.endsWith(".svg") ? "image/svg+xml" : /\.(?:jpg|jpeg)$/i.test(pathname) ? "image/jpeg" : pathname.endsWith(".png") ? "image/png" : pathname.endsWith(".woff2") ? "font/woff2" : pathname.endsWith(".woff") ? "font/woff" : "application/octet-stream";
				response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" }); response.end(asset.contents); return; }
		}
		if (request.url === "/renderer.css") { response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" }); response.end(css); return; }
		if (request.url !== "/") { response.writeHead(404); response.end(); return; }
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/renderer.css"><style>html,body,#root{margin:0;min-height:100%;width:100%}.unified-ui{min-height:100vh}.settings-content{min-width:0}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
	});
	await new Promise(resolveListening => server.listen(0, "127.0.0.1", resolveListening));
	const address = server.address(); assert(address && typeof address === "object");
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	page.on("pageerror", error => errors.push(error.message));
	page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
	const idA = "11111111-1111-4111-8111-aaaaaaaaaaaa", idB = "22222222-2222-4222-8222-bbbbbbbbbbbb";
	const projects = [{ id: idA, name: "Étude 🚀" }, { id: idB, name: "Étude 🚀" }];
	await page.addInitScript(({ projects }) => {
		let pending = projects.map(project => ({ ...project })), grants = [], onChanged, deferNext = false, finishDeferred, deferStarted = false, reconnectDeferred, finishReconnect;
		const calls = [];
		const addGrant = () => { grants = [{ path: "/synthetic/reconnected-project", name: "Reconnected synthetic project", available: true }]; pending = pending.filter(project => project.id !== "11111111-1111-4111-8111-aaaaaaaaaaaa"); };
		const handlers = {
			"runtime-list-sessions": async () => ({ ok: true, sessions: [] }),
			"get-workspace-grants": async () => {
				if (deferNext) { deferNext = false; deferStarted = true; return await new Promise(resolve => { finishDeferred = resolve; }); }
				return { ok: true, workspaceGrants: grants, pendingWorkspaceProjects: pending };
			},
			"reconnect-workspace-project": async request => {
				if (request.projectId === "11111111-1111-4111-8111-aaaaaaaaaaaa") return await new Promise(resolve => { reconnectDeferred = true; finishReconnect = success => { if (success) addGrant(); resolve(success ? { ok: true } : { ok: false, error: "Synthetic reconnect failure" }); }; });
				return { ok: false, error: "Synthetic reconnect failure" };
			},
			"remove-pending-workspace-project": async request => { pending = pending.filter(project => project.id !== request.projectId); return { ok: true }; },
		};
		window.__fixture = {
			calls,
			request: async request => { calls.push({ ...request }); const handler = handlers[request.type]; return handler ? handler(request) : { ok: false, error: `Unexpected fixture request: ${request.type}` }; },
			onChanged: callback => { onChanged = callback; },
			emitChanged: next => onChanged?.(next),
			deferNextGrantRequest: () => { deferNext = true; deferStarted = false; },
			grantRequestStarted: () => deferStarted,
			resolveOldGrantError: () => finishDeferred?.({ ok: false, error: "Stale synthetic refresh failure" }),
			setFreshState: () => { grants = [{ path: "/synthetic/fresh-project", name: "Fresh synthetic grant", available: true }]; },
			completeReconnect: success => finishReconnect?.(success), reconnectIsBusy: () => reconnectDeferred,
			state: () => ({ pending, grants }),
		};
		window.kestrel = {
			request: request => window.__fixture.request(request),
			onWorkspaceProjectsChanged: callback => { window.__fixture.onChanged(callback); return () => { onChanged = undefined; }; },
		};
	}, { projects });
	await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
	const sheetState = await page.evaluate(() => ({ count: document.styleSheets.length, rules: Array.from(document.styleSheets).reduce((count, sheet) => { try { return count + sheet.cssRules.length; } catch { return count; } }, 0) }));
	assert(sheetState.count >= 1 && sheetState.rules > 100, "The current renderer source CSS did not load into the fixture.");
	receipts.stylesheet = sheetState;
	const panel = page.getByRole("region", { name: "Workspace and sessions" });
	await panel.getByText("Choose a folder for each project to give it access again.").waitFor();
	const rowA = panel.locator("li").filter({ hasText: "aaaaaaaa" }), rowB = panel.locator("li").filter({ hasText: "bbbbbbbb" });
	const remainingRow = panel.locator("li").filter({ hasText: "Étude 🚀" });
	await rowA.getByRole("button", { name: "Choose folder for Étude 🚀", exact: true }).waitFor();
	assert.equal(await rowB.getByRole("button", { name: "Choose folder for Étude 🚀", exact: true }).count(), 1);
	receipts.phases.push({ phase: "actual-component-rendered-with-identical-unicode-names-and-distinct-native-ids", passed: true });

	await rowA.getByRole("button", { name: "Choose folder for Étude 🚀", exact: true }).click();
	await page.waitForFunction(() => window.__fixture.reconnectIsBusy());
	assert.equal(await rowA.getByRole("button", { name: "Choose folder for Étude 🚀", exact: true }).isDisabled(), true);
	assert.equal(await panel.getByRole("button", { name: "Updating…", exact: true }).isDisabled(), true);
	await page.evaluate(() => window.__fixture.completeReconnect(true));
	await panel.getByText("Reconnected synthetic project", { exact: true }).waitFor();
	await page.waitForFunction(() => document.activeElement?.textContent === "Project folder access");
	assert.equal(await rowA.count(), 0); assert.equal(await remainingRow.count(), 1);
	assert.deepEqual(await page.evaluate(() => window.__fixture.calls.filter(call => call.type === "reconnect-workspace-project").map(call => call.projectId)), [idA]);
	receipts.phases.push({ phase: "choose-folder-busy-disabled-refetches-grant-removes-row-and-restores-heading-focus", passed: true });

	await remainingRow.getByRole("button", { name: "Remove Étude 🚀", exact: true }).click();
	assert.equal(await remainingRow.getByRole("button", { name: "Confirm removing Étude 🚀", exact: true }).count(), 1);
	await remainingRow.getByRole("button", { name: "Cancel", exact: true }).click();
	assert.equal(await remainingRow.count(), 1);
	assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.type === "remove-pending-workspace-project").length), 0);
	receipts.phases.push({ phase: "remove-cancel-keeps-pending-project-and-sends-no-removal-request", passed: true });

	await remainingRow.getByRole("button", { name: "Choose folder for Étude 🚀", exact: true }).click();
	await panel.getByRole("alert").filter({ hasText: "Synthetic reconnect failure" }).waitFor();
	assert.equal(await remainingRow.count(), 1);
	assert.deepEqual(await page.evaluate(() => window.__fixture.calls.filter(call => call.type === "reconnect-workspace-project").map(call => call.projectId)), [idA, idB]);
	assert.deepEqual(await page.evaluate(() => window.__fixture.calls.filter(call => call.type === "reconnect-workspace-project").map(call => typeof call.projectId)), ["string", "string"]);
	receipts.calls = await page.evaluate(() => window.__fixture.calls.map(call => ({ type: call.type, projectId: call.projectId, pathIncluded: "path" in call })));
	assert(receipts.calls.filter(call => call.type === "reconnect-workspace-project").every(call => !call.pathIncluded));
	receipts.phases.push({ phase: "backend-error-retains-row-shows-error-and-uses-only-exact-native-identifiers", passed: true });

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
	await page.screenshot({ path: join(evidence, "desktop.png"), fullPage: true }); receipts.screenshots.push("desktop.png");
	await page.setViewportSize({ width: 375, height: 812 });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
	assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
	await page.screenshot({ path: join(evidence, "compact.png"), fullPage: true }); receipts.screenshots.push("compact.png");
	receipts.phases.push({ phase: "reduced-motion-desktop-and-compact-no-horizontal-overflow", passed: true });

	await remainingRow.getByRole("button", { name: "Remove Étude 🚀", exact: true }).click();
	assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.type === "remove-pending-workspace-project").length), 0);
	await remainingRow.getByRole("button", { name: "Confirm removing Étude 🚀", exact: true }).click();
	await page.waitForFunction(id => window.__fixture.calls.some(call => call.type === "remove-pending-workspace-project" && call.projectId === id), idB);
	await panel.getByText("No agent sessions yet.").waitFor();
	assert.deepEqual(await page.evaluate(() => window.__fixture.calls.filter(call => call.type === "remove-pending-workspace-project").map(call => call.projectId)), [idB]);
	receipts.phases.push({ phase: "remove-only-after-explicit-second-confirmation", passed: true });

	await page.evaluate(() => window.__fixture.deferNextGrantRequest());
	await page.evaluate(() => window.__fixture.emitChanged([]));
	await page.waitForFunction(() => window.__fixture.grantRequestStarted());
	await page.evaluate(() => { window.__fixture.setFreshState(); window.__fixture.emitChanged([{ path: "/synthetic/fresh-project", name: "Fresh synthetic grant", available: true }]); });
	await panel.getByText("Fresh synthetic grant", { exact: true }).waitFor();
	await page.evaluate(() => window.__fixture.resolveOldGrantError());
	await page.waitForTimeout(50);
	assert.equal(await panel.getByText("Fresh synthetic grant", { exact: true }).count(), 1);
	assert.equal(await panel.getByRole("alert").count(), 0);
	receipts.phases.push({ phase: "late-stale-refresh-error-does-not-replace-newer-event-state", passed: true });

	receipts.calls = await page.evaluate(() => window.__fixture.calls.map(call => ({ type: call.type, projectId: call.projectId, pathIncluded: "path" in call })));
	assert.deepEqual(receipts.calls.filter(call => call.type === "remove-pending-workspace-project").map(call => call.projectId), [idB]);
	assert.deepEqual(errors, []);
	receipts.pageErrors = errors;
	receipts.result = "passed";
} catch (error) {
	receipts.result = "failed"; receipts.error = String(error);
	await page?.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => undefined);
	throw error;
} finally {
	await browser?.close();
	if (server) await new Promise(resolveClose => server.close(resolveClose));
	await rm(temporary, { recursive: true, force: true });
	receipts.pageErrors = errors; receipts.finishedAt = new Date().toISOString();
	await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipts, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify({ result: receipts.result, sourceFunction: receipts.sourceFunction, bridgeMocked: receipts.bridgeMocked, phases: receipts.phases.length, screenshots: receipts.screenshots, pageErrors: receipts.pageErrors }));
