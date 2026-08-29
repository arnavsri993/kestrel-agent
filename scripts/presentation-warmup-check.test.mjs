import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePresentationWarmup } from "./presentation-warmup-check.mjs";

const require = createRequire(
	join(dirname(fileURLToPath(import.meta.url)), "../packages/database/package.json"),
);
const Database = require("better-sqlite3");

const root = mkdtempSync(join(tmpdir(), "kestrel-warmup-check-"));

try {
	mkdirSync(join(root, "browser"), { recursive: true });
	mkdirSync(join(root, "database"), { recursive: true });

	writeFileSync(
		join(root, "browser", "state.json"),
		JSON.stringify({
			history: [
				{ url: "https://example.com/a" },
				{ url: "https://docs.example.org/b" },
				{ url: "https://reference.example.net/c" },
			],
		}),
	);
	writeFileSync(
		join(root, "workspace-grants.json"),
		JSON.stringify([{ path: "/tmp/demo" }]),
	);

	const databasePath = join(root, "database", "kestrel.sqlite");
	const db = new Database(databasePath);
	db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      user_confirmed INTEGER NOT NULL
    );
    CREATE TABLE runtime_sessions (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE runtime_messages (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `);
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO memories (id, status, user_confirmed) VALUES (?, ?, ?)",
	).run("m1", "active", 1);
	db.prepare("INSERT INTO runtime_sessions (id, updated_at) VALUES (?, ?)").run(
		"s1",
		now,
	);
	db.prepare("INSERT INTO runtime_messages (id, created_at) VALUES (?, ?)").run(
		"msg1",
		now,
	);
	db.close();

	const evaluation = evaluatePresentationWarmup({
		profileDir: root,
		now: Date.now(),
	});
	assert.equal(evaluation.pass, true);
	assert.equal(
		evaluation.results.filter((result) => result.ok).length,
		evaluation.results.length,
	);
	console.log("presentation-warmup-check.test.mjs ok");
} finally {
	rmSync(root, { recursive: true, force: true });
}
