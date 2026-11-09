import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
	existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
	rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createDesktopSmokeDiagnostics } from "./desktop-smoke-diagnostics.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "kestrel-smoke-diagnostics-test-"));
	roots.push(root);
	return { root, diagnostics: createDesktopSmokeDiagnostics({ baseDirectory: root, ...options }) };
}
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

describe("disposable desktop smoke failure diagnostics", () => {
	it("retains a private launch-failure receipt without needing an application", async () => {
		const { root, diagnostics } = fixture();
		const error = Object.assign(new Error("secret-token https://private.invalid/?key=secret"), { name: "TimeoutError" });
		const first = await diagnostics.capture({ phase: "launch", error });
		const second = await diagnostics.capture({ phase: "launch", error });
		expect(first).not.toBe(second);
		expect(read(first)).toMatchObject({ phase: "launch", failure: "TimeoutError", applicationAvailable: false, pageAvailable: false, renderer: { status: "unavailable" } });
		expect(statSync(first).mode & 0o777).toBe(0o600);
		expect(readFileSync(first, "utf8")).not.toMatch(/secret|private\.invalid/);
		expect(first.startsWith(join(root, ".tmp", "desktop-smoke-diagnostics"))).toBe(true);
	});

	it("captures structural renderer state without accessing text, values, URLs or storage", async () => {
		const { diagnostics } = fixture();
		const page = new EventEmitter();
		const composer = { getClientRects: () => [] };
		const document = {
			readyState: "complete", hidden: false,
			querySelector: (selector) => ({
				"#runtime-prompt": composer, ".error-screen": {},
				".loading-screen": {}, ".agent-sidebar.is-collapsed": {},
			})[selector],
			get body() { throw new Error("Do not inspect page text"); },
		};
		const window = {
			kestrel: {},
			get localStorage() { throw new Error("Do not inspect profile settings"); },
		};
		page.evaluate = (fn) => Promise.resolve(runInNewContext(`(${fn.toString()})()`, {
			document, window, getComputedStyle: () => ({ display: "none", visibility: "hidden" }),
		}));
		diagnostics.observe(page);
		diagnostics.observe(page);
		page.emit("pageerror", new Error("secret page error"));
		page.emit("console", { type: () => "error", text: () => "secret console text" });
		page.emit("console", { type: () => "log" });
		page.emit("crash");
		const path = await diagnostics.capture({ application: {}, page, phase: "composer", error: new Error() });
		expect(read(path)).toMatchObject({
			events: { pageErrors: 1, consoleErrors: 1, crashes: 1 },
			renderer: { status: "captured", state: {
				readyState: "complete", bridgeAvailable: true, errorScreen: true,
				loadingScreen: true, composerPresent: true, composerHasLayout: false,
				composerDisplayNone: true, composerVisibilityHidden: true, sidebarCollapsed: true,
			} },
		});
		expect(readFileSync(path, "utf8")).not.toContain("secret");
		diagnostics.dispose();
		expect(page.listenerCount("pageerror")).toBe(0);
		expect(page.listenerCount("console")).toBe(0);
	});

	it("filters unexpected renderer fields and arbitrary error/phase strings", async () => {
		const { diagnostics } = fixture();
		const path = await diagnostics.capture({
			page: { evaluate: async () => ({ bridgeAvailable: false, composerPresent: "secret", readyState: "secret", url: "secret", body: "secret", profile: { token: "secret" } }) },
			phase: "secret", error: { name: "secret", message: "secret" },
		});
		expect(read(path)).toMatchObject({ phase: "unknown", failure: "Error", renderer: { state: { bridgeAvailable: false } } });
		expect(readFileSync(path, "utf8")).not.toContain("secret");
	});

	it("bounds a hung renderer observation", async () => {
		const { diagnostics } = fixture({ inspectionTimeoutMs: 10 });
		const path = await diagnostics.capture({ page: { evaluate: () => new Promise(() => {}) }, phase: "composer" });
		expect(read(path).renderer).toEqual({ status: "timed-out" });
	}, 1_000);

	it("still writes a receipt if the page disconnects or evaluation throws", async () => {
		const { diagnostics } = fixture();
		const path = await diagnostics.capture({ page: { evaluate: () => { throw new Error("private disconnect detail"); } }, phase: "composer" });
		expect(read(path).renderer).toEqual({ status: "unavailable" });
		expect(readFileSync(path, "utf8")).not.toContain("private");
	});

	it.each([".tmp", ".tmp/desktop-smoke-diagnostics"])("does not follow an existing receipt-directory symlink at %s", async (relative) => {
		const { root, diagnostics } = fixture();
		const outside = mkdtempSync(join(tmpdir(), "kestrel-smoke-outside-"));
		roots.push(outside);
		writeFileSync(join(outside, "sentinel"), "untouched");
		if (relative.includes("/")) mkdirSync(join(root, ".tmp"));
		symlinkSync(outside, join(root, relative), "dir");
		expect(await diagnostics.capture({ phase: "launch" })).toBeUndefined();
		expect(readdirSync(outside)).toEqual(["sentinel"]);
	});

	it("preserves the original failure when receipt storage is unavailable", async () => {
		const { root, diagnostics } = fixture();
		writeFileSync(join(root, ".tmp"), "not a directory");
		const original = new Error("original smoke failure");
		expect(diagnostics.captureCrash({ phase: "launch", error: original })).toBeUndefined();
		await expect((async () => {
			try { throw original; }
			catch (error) { await diagnostics.capture({ phase: "launch", error }); throw error; }
		})()).rejects.toBe(original);
		expect(readFileSync(join(root, ".tmp"), "utf8")).toBe("not a directory");
	});

	it("does not create artifacts just by observing a successful fixture", () => {
		const { root, diagnostics } = fixture();
		diagnostics.observe(new EventEmitter());
		diagnostics.dispose();
		expect(existsSync(join(root, ".tmp"))).toBe(false);
	});

	it("writes a synchronous fatal-exception receipt without inspecting a renderer", () => {
		const { diagnostics } = fixture();
		const path = diagnostics.captureCrash({ phase: "launch", error: new Error("secret fatal detail") });
		expect(typeof path).toBe("string");
		expect(read(path)).toMatchObject({ capture: "uncaught-exception", phase: "launch", pageAvailable: false, renderer: { status: "unavailable" } });
		expect(readFileSync(path, "utf8")).not.toContain("secret");
	});
});
