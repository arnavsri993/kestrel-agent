import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const bytes = Buffer.from("Native isolated Chromium controlled download fixture.\n");
const digest = createHash("sha256").update(bytes).digest("hex");
const prefix = "kestrel-background-downloads.";

export function createIsolatedDownloadFixtures() {
	const transfers = [];
	return { transfers, handle(request, response) {
		const url = new URL(request.url, "http://127.0.0.1");
		if (url.pathname === "/controlled-downloads") {
			response.writeHead(200, { "content-type": "text/html" });
			response.end('<!doctype html><title>Controlled download fixture</title><h1>Controlled download fixture</h1><a href="/controlled-download?kind=small">Download fixture</a><br><a href="/controlled-download?kind=oversized">Oversized fixture</a><br><a href="/controlled-download?kind=slow">Slow fixture</a>');
			return true;
		}
		if (url.pathname !== "/controlled-download") return false;
		const kind = url.searchParams.get("kind"), transfer = { kind, closed: false, sent: 0 };
		transfers.push(transfer);
		response.on("close", () => { transfer.closed = true; });
		response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="../../canary_download_token_secret.txt"', "content-length": kind === "oversized" ? "100000001" : kind === "slow" ? "1048576" : String(bytes.length) });
		if (kind === "small") { transfer.sent = bytes.length; response.end(bytes); }
		else if (kind === "oversized") {
			// Chromium may sniff an initial body block before starting a download.
			// Advertise the oversized length without transferring that payload.
			transfer.sent = 4096; response.write(Buffer.alloc(4096));
			const timeout = setTimeout(() => response.end(), 15_000);
			response.once("close", () => clearTimeout(timeout));
		} else {
			const send = () => { if (!response.destroyed) { const chunk = Buffer.alloc(1024, 65); transfer.sent += chunk.length; response.write(chunk); if (transfer.sent >= 1048576) response.end(); } };
			send(); const timer = setInterval(send, 100);
			response.once("close", () => clearInterval(timer));
		}
		return true;
	} };
}

async function wait(check, label, timeout = 10_000) {
	for (const end = Date.now() + timeout; Date.now() < end;) { if (await check()) return; await delay(50); }
	assert.fail(label);
}

export async function nativeIsolatedDownloadsCanary({ coreTool, origin, fixtures, receipt }) {
	const existing = new Set((await readdir(tmpdir())).filter(name => name.startsWith(prefix)));
	const sessions = [];
	async function call(tool, input) { const result = await coreTool(tool, input); assert.equal(result.status, "verified", JSON.stringify(result)); return result.output; }
	async function open() {
		const { browserSessionId } = await call("browser.create", { allowedOrigins: [origin] }); assert(browserSessionId); sessions.push(browserSessionId);
		await call("browser.navigate", { browserSessionId, url: `${origin}/controlled-downloads` }); return browserSessionId;
	}
	async function click(browserSessionId, name) {
		const snapshot = await call("browser.snapshot", { browserSessionId });
		const target = snapshot.interactive.find(item => item.name === name); assert(target, JSON.stringify(snapshot));
		const result = await coreTool("browser.act", { browserSessionId, action: { type: "click", target: target.ref } });
		assert(result.status === "verified" || result.status === "failed" && /(?:download|navigated) during input|document changed/.test(result.error ?? ""), JSON.stringify(result));
	}
	try {
		const browserSessionId = await open();
		await click(browserSessionId, "Download fixture");
		let completed;
		await wait(async () => { const result = await call("browser.downloads", { browserSessionId }); completed = result.downloads.find(item => item.status === "completed"); return completed; }, "The controlled download must finish and hash its exact bytes.");
		assert.equal(completed.bytes, bytes.length); assert.equal(completed.sha256, digest);
		assert(!JSON.stringify(completed).includes("canary_download_token_secret"));
		assert.match(completed.filename, /^download-[a-f0-9]{32}\.bin$/);
		let actual;
		for (const directory of (await readdir(tmpdir())).filter(name => name.startsWith(prefix) && !existing.has(name))) {
			for (const child of await readdir(join(tmpdir(), directory))) {
				if (!child.startsWith("item-")) continue;
				try { actual = await readFile(join(tmpdir(), directory, child, completed.filename)); } catch (error) { if (error.code !== "ENOENT") throw error; }
			}
		}
		assert.deepEqual(actual, bytes, "The private session artifact must contain the independently verified fixture bytes.");
		await click(browserSessionId, "Oversized fixture");
		let oversizedState;
		await wait(async () => { oversizedState = await call("browser.downloads", { browserSessionId }); return oversizedState.downloads.some(item => ["failed", "cancelled"].includes(item.status)); }, "Known oversized responses must be refused.")
			.catch(error => { throw new Error(error.message + " " + JSON.stringify({ downloads: oversizedState?.downloads, transfers: fixtures.transfers })); });
		assert.equal(fixtures.transfers.find(item => item.kind === "oversized")?.sent, 4096);
		const slow = await open();
		for (let index = 0; index < 4; ++index) {
			await click(slow, "Slow fixture");
			await wait(() => fixtures.transfers.filter(item => item.kind === "slow").length === index + 1, "Each intended accepted click must produce exactly one real transfer.");
			await wait(async () => (await call("browser.downloads", { browserSessionId: slow })).downloads.filter(item => item.status === "progressing" && item.bytes > 0).length === index + 1, "Wait for each accepted transfer before the next independent click.");
		}
		let activeState;
		await wait(async () => { activeState = await call("browser.downloads", { browserSessionId: slow }); return activeState.downloads.filter(item => item.status === "progressing" && item.bytes > 0).length === 4; }, "Four bounded transfers must be active before the refusal check.")
			.catch(error => { throw new Error(error.message + " " + JSON.stringify({ downloads: activeState?.downloads, transfers: fixtures.transfers })); });
		await click(slow, "Slow fixture");
		await wait(() => fixtures.transfers.filter(item => item.kind === "slow").length === 5 && fixtures.transfers.filter(item => item.kind === "slow")[4].closed, "The fifth active transfer must be refused without a hanging navigation.");
		const bounded = await call("browser.downloads", { browserSessionId: slow });
		assert.equal(bounded.downloads.length, 4, "A refused fifth transfer must not exceed the session's live-download bound.");
		await call("browser.close", { browserSessionId: slow }); sessions.splice(sessions.indexOf(slow), 1);
		await wait(() => fixtures.transfers.filter(item => item.kind === "slow").every(item => item.closed), "Closing the session must stop all its active transfers.");
		receipt.phases.push({ phase: "native-isolated-controlled-download-bytes-hash-oversize-active-limit-and-owner-cancellation", passed: true, bytes: bytes.length, sha256: digest, activeLimit: 4 });
	} finally {
		for (const browserSessionId of sessions) await coreTool("browser.close", { browserSessionId }).catch(() => {});
		await wait(async () => !(await readdir(tmpdir())).some(name => name.startsWith(prefix) && !existing.has(name)), "Closing owned isolated sessions must remove their private download directories.");
	}
}
