#!/usr/bin/env node

/**
 * Linux-safe CLI dry-run/apply smoke for kestrel-electron → native transfer.
 * Uses an isolated synthetic Electron profile; never touches real user data.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "kestrel-electron-native-cli-"));
const source = join(work, "electron-profile");
const target = join(work, "native-profile");
const planPath = join(work, "transfer-plan.json");
const bookmarkId = `bookmark-${randomUUID()}`;

try {
	mkdirSync(join(source, "browser"), { recursive: true });
	mkdirSync(join(source, "database"), { recursive: true });
	mkdirSync(join(source, "secure"), { recursive: true });
	writeFileSync(join(source, "AGENTS.md"), "CLI transfer keeps approvals local.\n");
	writeFileSync(
		join(source, "runtime-preferences.json"),
		JSON.stringify({
			theme: "graphite",
			preferredModel: "gpt-test",
			telemetryEnabled: false,
			apiKey: "must-not-transfer",
		}),
	);
	writeFileSync(join(source, "provider-accounts.json"), '{"secret":true}');
	writeFileSync(join(source, "database", "kestrel.sqlite"), "encrypted-db");
	writeFileSync(
		join(source, "browser", "state.json"),
		JSON.stringify({
			bookmarks: [
				{
					id: bookmarkId,
					url: "https://example.test/docs",
					title: "Docs",
					createdAt: "2026-10-15T00:00:00.000Z",
				},
			],
			bookmarkFolders: [],
			history: [],
			downloads: [],
			sitePermissions: [],
		}),
	);
	mkdirSync(target, { recursive: true, mode: 0o700 });

	const plan = spawnSync(
		"corepack",
		[
			"pnpm",
			"cli",
			"--",
			"migration",
			"plan",
			"--product",
			"kestrel-electron",
			"--source",
			source,
			"--target",
			target,
		],
		{ cwd: root, encoding: "utf8", env: process.env },
	);
	assert.equal(plan.status, 0, plan.stderr || plan.stdout);
	writeFileSync(planPath, plan.stdout);
	const parsed = JSON.parse(plan.stdout);
	assert.equal(parsed.kind, "electron-native-transfer");
	assert.equal(
		JSON.stringify(parsed).includes("must-not-transfer"),
		false,
		"plan must not embed secrets from runtime-preferences",
	);
	assert.ok(
		parsed.rejected.some(
			(item) =>
				item.path === "provider-accounts.json" ||
				item.path === "database/" ||
				item.path === "secure/",
		),
		"credentials and encrypted database must be rejected",
	);

	const apply = spawnSync(
		"corepack",
		[
			"pnpm",
			"cli",
			"--",
			"migration",
			"apply",
			"--plan",
			planPath,
			"--approve",
			"yes",
			"--overwrite",
			"no",
		],
		{ cwd: root, encoding: "utf8", env: process.env },
	);
	assert.equal(apply.status, 0, apply.stderr || apply.stdout);
	const applied = JSON.parse(apply.stdout);
	assert.ok(applied.imported.includes("AGENTS.md"));
	assert.ok(applied.imported.includes("browser-library.json"));
	assert.equal(existsSync(join(target, "provider-accounts.json")), false);
	assert.equal(existsSync(join(target, "database")), false);
	assert.match(
		readFileSync(join(target, "AGENTS.md"), "utf8"),
		/CLI transfer keeps approvals local/,
	);
	const library = JSON.parse(
		readFileSync(join(target, "browser-library.json"), "utf8"),
	);
	assert.equal(library.bookmarks[0]?.url, "https://example.test/docs");

	console.log(
		"Electron→native CLI transfer smoke ok — dry-run rejected secrets; apply imported non-secret items only.",
	);
} finally {
	rmSync(work, { recursive: true, force: true });
}
