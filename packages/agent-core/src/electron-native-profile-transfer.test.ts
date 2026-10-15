import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ElectronNativeProfileTransfer,
	isElectronNativeTransferPlan,
} from "./electron-native-profile-transfer";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

describe("Electron → native Chromium profile transfer", () => {
	it("plans a bounded dry-run and applies only after approval", () => {
		const source = tempDir("kestrel-electron-source-");
		const target = tempDir("kestrel-native-target-");
		mkdirSync(join(source, "browser"), { recursive: true });
		mkdirSync(join(source, "learned-skills", "review"), { recursive: true });
		mkdirSync(join(source, "database"), { recursive: true });
		mkdirSync(join(source, "secure"), { recursive: true });
		writeFileSync(join(source, "AGENTS.md"), "Keep approvals local.\n");
		writeFileSync(
			join(source, "learned-skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review diffs.\n---\n",
		);
		writeFileSync(
			join(source, "runtime-preferences.json"),
			JSON.stringify({
				theme: "graphite",
				preferredModel: "gpt-test",
				apiKey: "must-not-appear",
				telemetryEnabled: false,
			}),
		);
		writeFileSync(join(source, "provider-accounts.json"), '{"secret":true}');
		writeFileSync(join(source, "database", "kestrel.sqlite"), "encrypted");
		const bookmarkId = `bookmark-${randomUUID()}`;
		const folderId = `bookmark-folder-${randomUUID()}`;
		const visitId = `visit-${randomUUID()}`;
		const tabId = `tab-${randomUUID()}`;
		const downloadId = `download-${randomUUID()}`;
		writeFileSync(
			join(source, "browser", "state.json"),
			JSON.stringify({
				bookmarks: [
					{
						id: bookmarkId,
						url: "https://docs.example/path",
						title: "Docs",
						folderId,
						createdAt: "2026-10-15T00:00:00.000Z",
						faviconDataUrl:
							"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
					},
				],
				bookmarkFolders: [
					{
						id: folderId,
						name: "Reading",
						createdAt: "2026-10-15T00:00:00.000Z",
					},
				],
				history: [
					{
						id: visitId,
						tabId,
						url: "https://docs.example/path",
						title: "Docs",
						visitedAt: "2026-10-15T00:01:00.000Z",
					},
				],
				downloads: [
					{
						id: downloadId,
						tabId,
						filename: "notes.txt",
						sourceUrl: "https://docs.example/notes.txt",
						receivedBytes: 12,
						totalBytes: 12,
						status: "completed",
						startedAt: "2026-10-15T00:02:00.000Z",
						completedAt: "2026-10-15T00:02:01.000Z",
						canReveal: true,
					},
				],
				sitePermissions: [
					{
						origin: "https://docs.example",
						permission: "notifications",
						decision: "deny",
						updatedAt: "2026-10-15T00:03:00.000Z",
					},
				],
			}),
		);

		const manager = new ElectronNativeProfileTransfer(
			() => new Date("2026-10-15T12:00:00.000Z"),
		);
		const plan = manager.plan(source, target);
		expect(isElectronNativeTransferPlan(plan)).toBe(true);
		expect(plan.items.map((item) => item.category).sort()).toEqual([
			"browser-library",
			"instructions",
			"settings-signal",
			"skill",
		]);
		expect(plan.rejected.map((item) => item.path)).toEqual(
			expect.arrayContaining(["database/", "provider-accounts.json", "secure/"]),
		);
		expect(JSON.stringify(plan)).not.toContain("must-not-appear");
		expect(JSON.stringify(plan)).not.toContain("faviconDataUrl");
		expect(() => manager.apply(plan, { approved: false })).toThrow(
			"explicit approval",
		);

		const applied = manager.apply(plan, { approved: true });
		expect(applied.imported.sort()).toEqual([
			"AGENTS.md",
			"browser-library.json",
			"imports/kestrel-electron/.translated/runtime-preferences.json",
			"learned-skills/review/SKILL.md",
		]);
		expect(existsSync(join(target, "database"))).toBe(false);
		expect(existsSync(join(target, "provider-accounts.json"))).toBe(false);
		expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toContain(
			"Keep approvals local",
		);
		const library = JSON.parse(
			readFileSync(join(target, "browser-library.json"), "utf8"),
		) as {
			version: number;
			bookmarks: Array<{ id: string; url: string }>;
			downloads: Array<{ canReveal: boolean }>;
		};
		expect(library.version).toBe(1);
		expect(library.bookmarks[0]).toMatchObject({
			id: bookmarkId,
			url: "https://docs.example/path",
		});
		expect(library.downloads[0]?.canReveal).toBe(false);
		const translated = JSON.parse(
			readFileSync(
				join(
					target,
					"imports/kestrel-electron/.translated/runtime-preferences.json",
				),
				"utf8",
			),
		) as { values: Record<string, boolean> };
		expect(translated.values).toMatchObject({
			hasAppearancePreference: true,
			hasPreferredModel: true,
			hasTelemetryPreference: true,
		});
		expect(JSON.stringify(translated)).not.toContain("must-not-appear");

		const second = manager.apply(plan, { approved: true });
		expect(second.skipped).toHaveLength(4);
		expect(second.imported).toHaveLength(0);
	});

	it("backs up conflicting target files before overwrite", () => {
		const source = tempDir("kestrel-electron-overwrite-source-");
		const target = tempDir("kestrel-electron-overwrite-target-");
		writeFileSync(join(source, "AGENTS.md"), "From Electron.\n");
		writeFileSync(join(target, "AGENTS.md"), "Existing native.\n");
		const manager = new ElectronNativeProfileTransfer(
			() => new Date("2026-10-15T13:00:00.000Z"),
		);
		const plan = manager.plan(source, target);
		expect(plan.items[0]?.status).toBe("conflict");
		const applied = manager.apply(plan, { approved: true, overwrite: true });
		expect(applied.imported).toEqual(["AGENTS.md"]);
		expect(applied.backupRoot).toBeTruthy();
		expect(
			readFileSync(join(applied.backupRoot!, "AGENTS.md"), "utf8"),
		).toContain("Existing native");
		expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toContain(
			"From Electron",
		);
	});

	it("aborts apply when the Electron source changes after planning", () => {
		const source = tempDir("kestrel-electron-changed-source-");
		const target = tempDir("kestrel-electron-changed-target-");
		writeFileSync(join(source, "AGENTS.md"), "Original.\n");
		const manager = new ElectronNativeProfileTransfer();
		const plan = manager.plan(source, target);
		writeFileSync(join(source, "AGENTS.md"), "Changed after plan.\n");
		expect(() => manager.apply(plan, { approved: true })).toThrow(
			"changed after planning",
		);
		expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
		expect(createHash("sha256").update("Original.\n").digest("hex")).toBe(
			plan.items[0]?.sha256,
		);
	});
});
