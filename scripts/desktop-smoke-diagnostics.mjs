import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const phases = new Set([
	"launch", "first-window", "onboarding", "composer", "task-settings",
	"settings", "decoder", "browser-tools", "receipts", "screenshot",
]);
const booleanFields = [
	"bridgeAvailable", "loadingScreen", "errorScreen", "composerPresent",
	"composerHasLayout", "composerDisplayNone", "composerVisibilityHidden",
	"sidebarCollapsed", "documentHidden",
];

function rendererState() {
	const composer = document.querySelector("#runtime-prompt");
	const style = composer ? getComputedStyle(composer) : undefined;
	return {
		readyState: document.readyState,
		bridgeAvailable: typeof window.kestrel === "object" && window.kestrel !== null,
		loadingScreen: Boolean(document.querySelector(".loading-screen")),
		errorScreen: Boolean(document.querySelector(".error-screen")),
		composerPresent: Boolean(composer),
		composerHasLayout: Boolean(composer?.getClientRects().length),
		composerDisplayNone: style?.display === "none",
		composerVisibilityHidden: style?.visibility === "hidden",
		sidebarCollapsed: Boolean(document.querySelector(".agent-sidebar.is-collapsed")),
		documentHidden: document.hidden,
	};
}

async function inspectRenderer(page, timeoutMs) {
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(() => page.evaluate(rendererState)).then((raw) => {
				const state = {};
				for (const field of booleanFields) {
					if (typeof raw?.[field] === "boolean") state[field] = raw[field];
				}
				if (["loading", "interactive", "complete"].includes(raw?.readyState))
					state.readyState = raw.readyState;
				return { status: "captured", state };
			}).catch(() => ({ status: "unavailable" })),
			new Promise((done) => {
				timer = setTimeout(() => done({ status: "timed-out" }), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// Only use with the smoke fixture's own disposable application/page. Never
// inspect the normal profile. The allowlist deliberately excludes page text,
// URLs, console/error strings, screenshots, environment and profile contents.
export function createDesktopSmokeDiagnostics({
	baseDirectory = process.cwd(),
	inspectionTimeoutMs = 750,
} = {}) {
	const events = { pageErrors: 0, consoleErrors: 0, crashes: 0 };
	const observed = new Set();
	const listeners = [];
	const increment = (key) => { events[key] = Math.min(1_000, events[key] + 1); };
	const summary = ({ application, page, phase, error }, capture) => ({
		version: 1,
		capture,
		phase: phases.has(phase) ? phase : "unknown",
		failure: ["TimeoutError", "AssertionError"].includes(error?.name) ? error.name : "Error",
		applicationAvailable: Boolean(application),
		pageAvailable: Boolean(page),
		events: { ...events },
	});
	const writeReceipt = (report) => {
		let directory = resolve(baseDirectory);
		for (const part of [".tmp", "desktop-smoke-diagnostics"]) {
			directory = join(directory, part);
			try { mkdirSync(directory, { mode: 0o700 }); }
			catch (error) { if (error.code !== "EEXIST") throw error; }
			const metadata = lstatSync(directory);
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) return undefined;
		}
		const receipt = join(mkdtempSync(join(directory, "failure-")), "report.json");
		writeFileSync(receipt, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		return receipt;
	};
	return {
		observe(page) {
			if (!page || observed.has(page) || observed.size >= 4) return;
			observed.add(page);
			try {
				for (const [event, callback] of [
					["pageerror", () => increment("pageErrors")],
					["crash", () => increment("crashes")],
					["console", (message) => {
						try { if (message.type() === "error") increment("consoleErrors"); } catch {}
					}],
				]) {
					page.on(event, callback);
					listeners.push([page, event, callback]);
				}
			} catch { /* Diagnostics must not change the smoke outcome. */ }
		},
		async capture({ application, page, phase, error }) {
			try {
				return writeReceipt({
					...summary({ application, page, phase, error }, "caught-failure"),
					renderer: page
						? await inspectRenderer(page, Math.min(2_000, Math.max(1,
							Number.isFinite(inspectionTimeoutMs) ? inspectionTimeoutMs : 750)))
						: { status: "unavailable" },
				});
			} catch { return undefined; }
		},
		// uncaughtExceptionMonitor cannot await a renderer inspection or a promise.
		// A synchronous structural receipt leaves Node's fatal exit unchanged.
		captureCrash({ application, phase, error }) {
			try {
				return writeReceipt({
					...summary({ application, phase, error }, "uncaught-exception"),
					renderer: { status: "unavailable" },
				});
			} catch { return undefined; }
		},
		dispose() {
			for (const [page, event, callback] of listeners.splice(0)) {
				try { page.off(event, callback); } catch {}
			}
			observed.clear();
		},
	};
}
