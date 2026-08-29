#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const require = createRequire(
	join(dirname(fileURLToPath(import.meta.url)), "../packages/database/package.json"),
);
const Database = require("better-sqlite3");

const MIN_BROWSER_ORIGINS = 3;
const MIN_CONFIRMED_MEMORIES = 1;
const MIN_RUNTIME_SESSIONS = 1;
const MODEL_WARM_WINDOW_MS = 10 * 60 * 1000;

function resolveProfileDir() {
	const fromEnv = process.env.KESTREL_PROFILE_DIR ?? process.env.KESTREL_DATA_DIR;
	if (fromEnv) return resolve(fromEnv);
	return join(homedir(), "Library", "Application Support", "Kestrel");
}

function check(label, ok, detail) {
	return { label, ok, detail };
}

function formatResult(result) {
	const mark = result.ok ? "PASS" : "FAIL";
	return `${mark}  ${result.label}${result.detail ? ` — ${result.detail}` : ""}`;
}

function countDistinctBrowserOrigins(browserStatePath) {
	if (!existsSync(browserStatePath)) {
		return { origins: 0, historyEntries: 0, error: "browser/state.json missing" };
	}
	let state;
	try {
		state = JSON.parse(readFileSync(browserStatePath, "utf8"));
	} catch {
		return { origins: 0, historyEntries: 0, error: "browser/state.json unreadable" };
	}
	const history = Array.isArray(state.history) ? state.history : [];
	const origins = new Set();
	for (const entry of history) {
		const url = typeof entry?.url === "string" ? entry.url : "";
		if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
		try {
			const hostname = new URL(url).hostname;
			if (hostname && !hostname.endsWith(".kestrel.local")) origins.add(hostname);
		} catch {
			// Skip malformed URLs.
		}
	}
	return { origins: origins.size, historyEntries: history.length };
}

function openReadonlyDatabase(databasePath) {
	return new Database(databasePath, { readonly: true, fileMustExist: true });
}

function queryProfileCounts(databasePath) {
	if (!existsSync(databasePath)) {
		return { error: "database/kestrel.sqlite missing" };
	}
	let db;
	try {
		db = openReadonlyDatabase(databasePath);
		const memoryRow = db
			.prepare(
				"SELECT COUNT(*) AS count FROM memories WHERE status != 'deleted'",
			)
			.get();
		const confirmedRow = db
			.prepare(
				"SELECT COUNT(*) AS count FROM memories WHERE status != 'deleted' AND user_confirmed = 1",
			)
			.get();
		const sessionRow = db
			.prepare("SELECT COUNT(*) AS count FROM runtime_sessions")
			.get();
		const recentSessionRow = db
			.prepare(
				`SELECT MAX(updated_at) AS latest FROM runtime_sessions`,
			)
			.get();
		const recentMessageRow = db
			.prepare(`SELECT MAX(created_at) AS latest FROM runtime_messages`)
			.get();
		return {
			memories: Number(memoryRow?.count ?? 0),
			confirmedMemories: Number(confirmedRow?.count ?? 0),
			sessions: Number(sessionRow?.count ?? 0),
			latestSessionAt: recentSessionRow?.latest ?? null,
			latestMessageAt: recentMessageRow?.latest ?? null,
		};
	} catch (error) {
		return {
			error:
				error instanceof Error ? error.message : "database could not be opened",
		};
	} finally {
		db?.close();
	}
}

function isRecent(isoTimestamp, windowMs) {
	if (!isoTimestamp || typeof isoTimestamp !== "string") return false;
	const ms = Date.parse(isoTimestamp);
	if (!Number.isFinite(ms)) return false;
	return Date.now() - ms <= windowMs;
}

function countWorkspaceGrants(grantsPath) {
	if (!existsSync(grantsPath)) return 0;
	try {
		const grants = JSON.parse(readFileSync(grantsPath, "utf8"));
		return Array.isArray(grants) ? grants.length : 0;
	} catch {
		return 0;
	}
}

export function evaluatePresentationWarmup({
	profileDir,
	now = Date.now(),
	warmWindowMs = MODEL_WARM_WINDOW_MS,
} = {}) {
	const root = profileDir ?? resolveProfileDir();
	const browser = countDistinctBrowserOrigins(join(root, "browser", "state.json"));
	const database = queryProfileCounts(join(root, "database", "kestrel.sqlite"));
	const workspaceGrants = countWorkspaceGrants(join(root, "workspace-grants.json"));

	const latestActivity = [database.latestSessionAt, database.latestMessageAt]
		.filter(Boolean)
		.sort()
		.at(-1);

	const results = [
		check(
			"Profile directory exists",
			existsSync(root),
			root,
		),
		check(
			`Browser history (${MIN_BROWSER_ORIGINS}+ distinct origins for Frequent tabs)`,
			browser.origins >= MIN_BROWSER_ORIGINS,
			browser.error ??
				`${browser.origins} origins, ${browser.historyEntries} history entries`,
		),
		check(
			"Disposable project granted",
			workspaceGrants >= 1,
			`${workspaceGrants} workspace grant(s)`,
		),
		check(
			`Agent sessions (${MIN_RUNTIME_SESSIONS}+ for Recent work / suggestions)`,
			!database.error && database.sessions >= MIN_RUNTIME_SESSIONS,
			database.error ?? `${database.sessions} session(s)`,
		),
		check(
			`Confirmed memories (${MIN_CONFIRMED_MEMORIES}+ for memory badge / widget)`,
			!database.error && database.confirmedMemories >= MIN_CONFIRMED_MEMORIES,
			database.error ??
				`${database.confirmedMemories} confirmed, ${database.memories} active total`,
		),
		check(
			"Recent model activity (within warm-up window; optional before T−10)",
			!database.error && isRecent(latestActivity, warmWindowMs),
			database.error ??
				(latestActivity
					? `latest activity ${latestActivity}`
					: "no runtime messages yet"),
		),
	];

	return {
		profileDir: root,
		results,
		pass: results.every((result) => result.ok),
	};
}

function main() {
	const evaluation = evaluatePresentationWarmup();
	console.log(`Kestrel presentation warm-up probe`);
	console.log(`Profile: ${evaluation.profileDir}\n`);
	for (const result of evaluation.results) {
		console.log(formatResult(result));
	}
	console.log(
		`\nOverall: ${evaluation.pass ? "PASS" : "FAIL"} — ${evaluation.pass ? "profile looks stage-ready; still verify New Tab visually" : "repeat docs/presentation-day-warmup.md steps marked FAIL"}`,
	);
	process.exitCode = evaluation.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
