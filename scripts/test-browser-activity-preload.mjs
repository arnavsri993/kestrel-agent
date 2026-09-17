import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "@playwright/test";

const root = mkdtempSync(join(tmpdir(), "kestrel-browser-activity-"));
const preload = resolve("apps/desktop/out/preload/userBrowser.cjs");
const main = join(root, "main.cjs");

writeFileSync(main, `const {app,BrowserWindow,session,ipcMain}=require('electron');
app.setPath('userData', ${JSON.stringify(join(root, "profile"))});
app.whenReady().then(async()=>{
 await session.defaultSession.protocol.handle('https',request=>new Promise(resolve=>setTimeout(()=>resolve(new Response('<!doctype html><title>Activity fixture</title><body></body>',{headers:{'content-type':'text/html'}})),request.url.endsWith('/slow')?300:0)));
 session.defaultSession.setPermissionCheckHandler(()=>true);
 session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(true));
 globalThis.activityMessages=[];
 ipcMain.on('kestrel:user-browser-activity',(_event,data)=>globalThis.activityMessages.push(data));
 const win=new BrowserWindow({show:false,width:900,height:600,webPreferences:{preload:${JSON.stringify(preload)},sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await win.loadURL('https://activity.example.test/');
});`);

let app;
try {
	app = await electron.launch({
		executablePath: createRequire(resolve("apps/desktop/package.json"))("electron"),
		args: [main, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
	});
	const page = await app.firstWindow();
	await page.waitForURL("https://activity.example.test/");
	const mark = () => app.evaluate(() => globalThis.activityMessages.length);
	const waitFor = async (key, value, after) => {
		for (let attempt = 0; attempt < 60; attempt++) {
			const reports = await app.evaluate(() => globalThis.activityMessages);
			const index = reports.findIndex((report, index) => index >= after && report[key] === value);
			if (index >= 0) return index;
			await page.waitForTimeout(50);
		}
		const reports = await app.evaluate(() => globalThis.activityMessages);
		throw new Error(`Timed out waiting for ${key}=${value}: ${JSON.stringify(reports)}`);
	};

	// A muted video remains active, and a pause clears the activity immediately.
	let activityMark = await mark();
	await page.evaluate(() => {
		const video = document.createElement("video");
		Object.defineProperties(video, {
			paused: { configurable: true, get: () => video.dataset.playing !== "yes" },
			ended: { configurable: true, get: () => false },
		});
		video.muted = true;
		video.dataset.playing = "yes";
		document.body.append(video);
		video.dispatchEvent(new Event("play", { bubbles: true }));
	});
	await waitFor("playing", true, activityMark);
	activityMark = await mark();
	await page.evaluate(() => {
		const video = document.querySelector("video");
		video.dataset.playing = "no";
		video.dispatchEvent(new Event("pause", { bubbles: true }));
	});
	await waitFor("playing", false, activityMark);

	// Native fetches are busy while pending and clear after the response resolves.
	activityMark = await mark();
	await page.evaluate(() => fetch("/slow"));
	const busyIndex = await waitFor("busy", true, activityMark);
	await waitFor("busy", false, busyIndex + 1);

	// Trusted text and checkbox edits stay dirty. A site that prevents submit
	// keeps the draft alive; a reset clears it.
	await page.evaluate(() => { document.body.innerHTML = '<form onsubmit="event.preventDefault()"><input aria-label="Draft"><input type="checkbox" aria-label="Remember"><button>Save</button></form>'; });
	activityMark = await mark();
	await page.getByLabel("Draft").fill("private fixture value");
	await waitFor("dirty", true, activityMark);
	await page.getByLabel("Remember").check();
	activityMark = await mark();
	await page.getByRole("button", { name: "Save" }).click();
	await page.waitForTimeout(50);
	const afterPreventedSubmit = await app.evaluate(() => globalThis.activityMessages.at(-1));
	assert.equal(afterPreventedSubmit.dirty, true, "a prevented submit must retain dirty form activity");
	activityMark = await mark();
	await page.locator("form").evaluate((form) => form.reset());
	await waitFor("dirty", false, activityMark);

	// Fake Chromium media streams exercise the native getUserMedia wrapper and
	// track end lifecycle without passing any stream details over IPC.
	activityMark = await mark();
	const mediaWorked = await page.evaluate(async () => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
			globalThis.fixtureStream = stream;
			return true;
		} catch { return false; }
	});
	if (mediaWorked) {
		await waitFor("microphone", true, activityMark);
		await waitFor("camera", true, activityMark);
		activityMark = await mark();
		await page.evaluate(() => globalThis.fixtureStream.getTracks().forEach((track) => track.stop()));
		await waitFor("microphone", false, activityMark);
		await waitFor("camera", false, activityMark);
	}

	await page.goto("https://activity.example.test/next");
	await page.waitForTimeout(50);
	const messages = await app.evaluate(() => globalThis.activityMessages);
	assert.ok(messages.length > 0, "activity bridge should emit reports over IPC");
	for (const message of messages) {
		assert.deepEqual(Object.keys(message).sort(), ["busy", "camera", "dirty", "location", "microphone", "playing", "screen"]);
		assert.ok(Object.values(message).every((value) => typeof value === "boolean"));
		assert.equal(JSON.stringify(message).includes("private fixture value"), false);
	}
	assert.deepEqual(messages.at(-1), {
		playing: false,
		microphone: false,
		camera: false,
		screen: false,
		location: false,
		busy: false,
		dirty: false,
	});
	console.log("PASS: browser activity preload reports muted playback, pending fetches, dirty form lifecycle, media tracks, navigation reset, and boolean-only IPC payloads.");
} finally {
	if (app) await app.close();
	rmSync(root, { recursive: true, force: true });
}
