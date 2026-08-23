import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	relativeRequireSpecifiers,
	verifyStandalonePreloadBundles,
} from "./verify-desktop-preload-bundles.mjs";

const temporaryDirectories = [];

async function preloadDirectory(entries) {
	const directory = await mkdtemp(join(tmpdir(), "kestrel-preloads-"));
	temporaryDirectories.push(directory);
	await Promise.all(
		Object.entries(entries).map(([name, source]) =>
			writeFile(join(directory, name), source, "utf8"),
		),
	);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe("desktop preload bundle verification", () => {
	it("accepts standalone preload entries", async () => {
		const directory = await preloadDirectory({
			"index.cjs": 'const electron = require("electron");',
			"userBrowser.cjs": "module.exports = {};",
		});

		await expect(verifyStandalonePreloadBundles(directory)).resolves.toBe(
			undefined,
		);
	});

	it("rejects relative shared chunks in a sandboxed preload", async () => {
		const directory = await preloadDirectory({
			"index.cjs": 'require("./chunks/file-drag-abc.cjs");',
			"userBrowser.cjs": "module.exports = {};",
		});

		await expect(verifyStandalonePreloadBundles(directory)).rejects.toThrow(
			'index.cjs: require("./chunks/file-drag-abc.cjs")',
		);
	});

	it("finds parent and sibling relative requires with either quote style", () => {
		expect(
			relativeRequireSpecifiers(
				`require('../shared.cjs'); require("./chunks/entry.cjs"); require("electron");`,
			),
		).toEqual(["../shared.cjs", "./chunks/entry.cjs"]);
	});
});
