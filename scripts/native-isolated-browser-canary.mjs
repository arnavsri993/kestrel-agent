import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function createIsolationFixtures() {
	const visits = [], storage = [], actions = [], pulses = [], uploads = [];
	return { visits, storage, actions, pulses, uploads, handle(request, response) {
		const url = new URL(request.url, "http://127.0.0.1");
		if (!url.pathname.startsWith("/isolation-")) return false;
		const role = url.searchParams.get("role") || "unknown";
		if (url.pathname === "/isolation-uploaded") {
			let body = "";
			request.on("data", chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
			request.on("end", () => { uploads.push(body); response.writeHead(204); response.end(); }); return true;
		}
		else if (url.pathname === "/isolation-upload") {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<!doctype html><title>Owned workspace upload fixture</title><h1>Workspace upload fixture</h1><label>Fixture file<input id='fixture-upload' type='file'></label><script>document.querySelector('input').addEventListener('change',async event=>{const file=event.target.files[0];if(file)await fetch('/isolation-uploaded',{method:'POST',body:await file.text()})});</script>"); return true;
		}
		else if (url.pathname === "/isolation-pulse") pulses.push(role);
		else if (url.pathname === "/isolation-alive") {
			response.writeHead(200, { "content-type": "text/html" });
			response.end(`<!doctype html><title>Owned isolated recovery fixture</title><h1>Owned recovery fixture</h1><script>const pulse=()=>fetch('/isolation-pulse?role='+${JSON.stringify(encodeURIComponent(role))});pulse();setInterval(pulse,150);</script>`); return true;
		}
		else if (url.pathname === "/isolation-probe") storage.push({ role, previous: url.searchParams.get("previous") });
		else if (url.pathname === "/isolation-act") actions.push({ role, kind: url.searchParams.get("kind"), trusted: url.searchParams.get("trusted"), value: url.searchParams.get("value") });
		else if (url.pathname === "/isolation-page") {
			visits.push({ role, cookie: request.headers.cookie || "" });
			response.writeHead(200, { "content-type": "text/html", "set-cookie": `native_isolation=${encodeURIComponent(role)}; Path=/; SameSite=Lax` });
			response.end(`<!doctype html><title>Isolated browser ${role}</title><style>body{min-height:2400px;font:20px system-ui;padding:20px}input,button{font:inherit;padding:10px}</style>
			<h1>Isolated browser fixture</h1><label>Public query <input id="query" autocomplete="off"></label><button id="act">Act once</button>
			<script>const role=${JSON.stringify(role)};fetch('/isolation-probe?role='+encodeURIComponent(role)+'&previous='+encodeURIComponent(localStorage.getItem('native_isolation')||''));localStorage.setItem('native_isolation',role);
			const emit=(kind,event,value='')=>fetch('/isolation-act?role='+encodeURIComponent(role)+'&kind='+kind+'&trusted='+event.isTrusted+'&value='+encodeURIComponent(value));
			document.querySelector('#query').addEventListener('input',event=>emit('input',event,event.target.value));document.querySelector('#act').addEventListener('click',event=>emit('click',event));</script>`);
			return true;
		} else if (url.pathname === "/isolation-visual") {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<!doctype html><title>Isolated screenshot</title><h1>Isolated screenshot fixture</h1><p>Public static background content.</p>"); return true;
		} else { response.writeHead(404); response.end(); return true; }
		response.writeHead(204); response.end(); return true;
	} };
}

export async function prepareIsolatedCoreResetCanary({ coreTool, origin, fixtures }) {
	const created = await coreTool("browser.create", { allowedOrigins: [origin] });
	assert.equal(created.status, "verified", JSON.stringify(created));
	const browserSessionId = created.output?.browserSessionId; assert(browserSessionId);
	const navigated = await coreTool("browser.navigate", { browserSessionId, url: `${origin}/isolation-alive?role=orphan` });
	assert(!["failed", "blocked"].includes(navigated.status), JSON.stringify(navigated));
	for (const end = Date.now() + 10_000; Date.now() < end;) {
		if (fixtures.pulses.filter(role => role === "orphan").length >= 2) return;
		await delay(50);
	}
	assert.fail("The owned isolated renderer must be actively running before Core interruption.");
}

export async function finishIsolatedCoreResetCanary({ coreTool, origin, fixtures, receipt }) {
	// Drain an already-dispatched request, then require the actual old page to
	// stop running. A new Core's empty session map alone would not prove cleanup.
	await delay(500);
	const stoppedAt = fixtures.pulses.filter(role => role === "orphan").length;
	await delay(800);
	assert.equal(fixtures.pulses.filter(role => role === "orphan").length, stoppedAt, "Core recovery must close the orphaned native renderer.");
	const created = await coreTool("browser.create", { allowedOrigins: [origin] });
	assert.equal(created.status, "verified", JSON.stringify(created));
	const browserSessionId = created.output?.browserSessionId; assert(browserSessionId);
	try {
		const navigated = await coreTool("browser.navigate", { browserSessionId, url: `${origin}/isolation-alive?role=recovered` });
		assert(!["failed", "blocked"].includes(navigated.status), JSON.stringify(navigated));
		for (const end = Date.now() + 10_000; Date.now() < end && !fixtures.pulses.includes("recovered");) await delay(50);
		assert(fixtures.pulses.includes("recovered"), "A new isolated context must work after cleanup acknowledgment.");
	} finally { await coreTool("browser.close", { browserSessionId }); }
	receipt.phases.push({ phase: "native-active-isolated-renderer-cleanup-and-recreation-after-Core-crash", passed: true, stoppedPagePulses: stoppedAt });
}

export async function nativeIsolatedBrowserCanary({ coreTool, origin, fixtures, createdPage, getHome, evidence, receipt }) {
	const sessions = [];
	let userTab;
	async function call(tool, input) {
		const result = await coreTool(tool, input);
		assert(!["failed", "blocked", "cancelled"].includes(result.status), JSON.stringify(result));
		return result.output;
	}
	async function wait(check, label) {
		for (const end = Date.now() + 10_000; Date.now() < end;) { if (check()) return; await delay(50); }
		assert.fail(label);
	}
	async function open(role) {
		const created = await call("browser.create", { allowedOrigins: [origin] });
		assert(created.browserSessionId); sessions.push(created.browserSessionId);
		await call("browser.navigate", { browserSessionId: created.browserSessionId, url: `${origin}/isolation-page?role=${role}` });
		await wait(() => fixtures.storage.some(item => item.role === role), `Isolated ${role} must execute its real page.`);
		return created.browserSessionId;
	}
	try {
		userTab = await call("browser.open-tab", { input: `${origin}/isolation-page?role=user` });
		assert(userTab.tabId);
		await createdPage(url => url === `${origin}/isolation-page?role=user`);
		await wait(() => fixtures.storage.some(item => item.role === "user"), "The user tab fixture must load first.");
		const before = await call("browser.tabs", {});
		const first = await open("first"), second = await open("second");
		for (const role of ["user", "first", "second"]) {
			assert.equal(fixtures.storage.find(item => item.role === role)?.previous, "", `${role} must start without another context's localStorage.`);
			assert.equal(fixtures.visits.find(item => item.role === role)?.cookie, "", `${role} must start without another context's cookie.`);
		}
		const after = await call("browser.tabs", {});
		assert.deepEqual(after.tabs.map(item => item.id).sort(), before.tabs.map(item => item.id).sort(), "Background automation must not create stock visible tabs or windows.");
		await call("browser.viewport", { browserSessionId: first, viewport: { name: "canary", width: 1000, height: 700, deviceScaleFactor: 1 } });
		let snapshot = await call("browser.snapshot", { browserSessionId: first });
		const query = snapshot.interactive?.find(item => item.name === "Public query");
		assert(query, JSON.stringify(snapshot));
		await call("browser.act", { browserSessionId: first, action: { type: "type", target: query.ref, text: "isolated-native-input" } });
		await wait(() => fixtures.actions.some(item => item.role === "first" && item.kind === "input" && item.trusted === "true" && item.value === "isolated-native-input"), "Isolated typing must produce a trusted Chromium input event.");
		snapshot = await call("browser.snapshot", { browserSessionId: first });
		const button = snapshot.interactive?.find(item => item.name === "Act once"); assert(button);
		await call("browser.act", { browserSessionId: first, action: { type: "click", target: button.ref } });
		await wait(() => fixtures.actions.some(item => item.role === "first" && item.kind === "click" && item.trusted === "true"), "Isolated clicking must produce a trusted Chromium event.");
		const stale = await coreTool("browser.act", { browserSessionId: first, action: { type: "click", target: button.ref } });
		assert(["failed", "blocked"].includes(stale.status), "A consumed ref must not act again.");
		assert.equal(fixtures.actions.filter(item => item.role === "first" && item.kind === "click").length, 1);
		const outside = await coreTool("browser.navigate", { browserSessionId: second, url: "https://example.invalid/" });
		assert(["failed", "blocked"].includes(outside.status), "An isolated session may not leave its origin allowlist.");
		receipt.phases.push({ phase: "native-Chrome-owner-isolated-cookie-storage-and-trusted-input", passed: true });
		await call("browser.navigate", { browserSessionId: first, url: `${origin}/isolation-visual` });
		const frame = await call("browser.screenshot", { browserSessionId: first });
		const png = Buffer.from(frame.pngBase64, "base64");
		assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); assert(frame.width > 0 && frame.height > 0);
		await writeFile(join(evidence, "native-isolated-Core-screenshot.png"), png);
		receipt.phases.push({ phase: "native-Chrome-owner-isolated-viewport-snapshot-and-Core-screenshot", passed: true, width: frame.width, height: frame.height, pngBytes: png.length });
	} finally {
		for (const browserSessionId of sessions) await coreTool("browser.close", { browserSessionId }).catch(() => {});
		if (userTab?.tabId) await coreTool("browser.close-tab", { tabId: userTab.tabId }).catch(() => {});
		await getHome().bringToFront();
	}
}
