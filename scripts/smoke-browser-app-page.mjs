import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const { build } = createRequire(desktopRequire.resolve("vite"))("esbuild");
const component = join(root, "apps/desktop/src/renderer/components/browser/BrowserAppPage.tsx");
const evidence = resolve(process.env.KESTREL_APP_PAGE_EVIDENCE || ".tmp/browser-app-page-evidence");
await mkdir(evidence, { recursive: true, mode: 0o700 });
assert.equal((await readdir(evidence)).length, 0, "Preserve prior evidence; choose a fresh directory.");
const temporary = await mkdtemp(join(tmpdir(), "kestrel-app-page-fixture-"));
const receipt = { kind: "headless-app-page-interaction", startedAt: new Date().toISOString(),
	componentSha256: createHash("sha256").update(await readFile(component)).digest("hex"),
	scope: "Actual shared component in a synthetic headless fixture; not full-app or canonical installation evidence.",
	iterations: 0, pointerClicks: 0, keyboardChecks: 0, exitingChecks: 0, phases: [] };
let browser, page;
const errors = [];
try {
	const bundle = join(temporary, "fixture.js");
	await build({ stdin: { contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AnimatePresence} from 'motion/react';
import {BrowserAppPage} from ${JSON.stringify(component)};
function Fixture() {
 const [route,setRoute]=useState('work'),[reduced,setReduced]=useState(false);
 window.routeTo=setRoute; window.reduceMotion=setReduced; window.clickCount ??=0;
 return <div id="browser-viewport" role="tabpanel" aria-label={route}>
  <AnimatePresence initial={false} mode="sync"><BrowserAppPage key={route} pageId={route} reduced={reduced} className="browser-app-page">
   <h1>{route==='work'?'Work fixture':'Commands fixture'}</h1><button onClick={()=>window.clickCount++}>Move task</button>
  </BrowserAppPage></AnimatePresence>
 </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: join(root, "apps/desktop"), loader: "tsx" },
		outfile: bundle, bundle: true, platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning" });
	const script = await readFile(bundle, "utf8");
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	page.on("pageerror", error => errors.push(error.message));
	async function mount(reduced) {
		await page.setContent(`<style>body{margin:16px;font:16px system-ui}#browser-viewport{position:relative;width:min(900px,100%);height:700px;overflow:hidden}.browser-app-page{position:absolute;inset:0;overflow:auto}button{padding:12px}</style><div id="root"></div>`);
		await page.evaluate(() => { delete window.routeTo; delete window.reduceMotion; window.clickCount = 0; });
		await page.addScriptTag({ content: script });
		await page.waitForFunction(() => typeof window.routeTo === "function" && document.querySelector('[data-app-page="work"] button'));
		await page.evaluate(value => window.reduceMotion(value), reduced);
	}
	for (const reduced of [false, true]) {
		await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
		await mount(reduced);
		for (let index = 0; index < 100; index++) {
			await page.evaluate(() => window.routeTo("commands"));
			if (index % 4 === 0) {
				await page.waitForFunction(() => document.getElementById("browser-viewport")?.getAttribute("aria-label") === "commands" &&
					document.querySelector('[data-app-page="commands"]')?.inert === false);
				const exiting = await page.locator('[data-app-page="work"]').evaluateAll(elements => elements.map(element => ({
					inert: element.inert, hidden: element.getAttribute("aria-hidden"), pointer: getComputedStyle(element).pointerEvents,
				})));
				for (const state of exiting) {
					assert.deepEqual(state, { inert: true, hidden: "true", pointer: "none" }); receipt.exitingChecks++;
				}
			}
			await page.evaluate(() => window.routeTo("work"));
			const active = page.locator('[data-app-page="work"]:not([inert])');
			await active.waitFor();
			const button = active.getByRole("button", { name: "Move task", exact: true });
			const beforeClick = await page.evaluate(() => window.clickCount);
			await button.click(); receipt.pointerClicks++;
			assert.equal(await page.evaluate(() => window.clickCount), beforeClick + 1);
			assert.deepEqual(await active.evaluate(element => ({ inert: element.inert, hidden: element.getAttribute("aria-hidden"), pointer: getComputedStyle(element).pointerEvents })), { inert: false, hidden: null, pointer: "auto" });
			await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
			await page.keyboard.press("Tab");
			assert.equal(await button.evaluate(element => element === document.activeElement), true);
			await page.keyboard.press("Enter");
			assert.equal(await page.evaluate(() => window.clickCount), beforeClick + 2); receipt.keyboardChecks++;
			receipt.iterations++;
			if (index === 49) { await page.reload(); await mount(reduced); }
		}
		receipt.phases.push({ phase: reduced ? "rapid-routes-reduced-motion" : "rapid-routes-normal-motion", passed: true });
	}
	assert(receipt.exitingChecks > 0, "Exercise an actual retained exiting page.");
	assert.equal(await page.evaluate(() => window.clickCount), 100);
	assert.deepEqual(errors, []);
	await page.screenshot({ path: join(evidence, "desktop.png") });
	await page.setViewportSize({ width: 640, height: 860 });
	await page.screenshot({ path: join(evidence, "compact.png") });
	receipt.result = "passed";
} catch (error) {
	receipt.result = "failed"; receipt.error = String(error);
	await page?.screenshot({ path: join(evidence, "failure.png") }).catch(() => undefined);
	throw error;
} finally {
	await browser?.close(); await rm(temporary, { recursive: true, force: true });
	receipt.pageErrors = errors;
	receipt.finishedAt = new Date().toISOString();
	await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify({ result: receipt.result, iterations: receipt.iterations, pointerClicks: receipt.pointerClicks, keyboardChecks: receipt.keyboardChecks, exitingChecks: receipt.exitingChecks }));
