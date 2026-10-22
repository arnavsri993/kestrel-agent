import {
	existsSync,
	lstatSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserBrowserState } from "@kestrel/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshBrowserState } from "./browser-tab-store";
import { restoreDetachedWindowStates } from "./detached-window-recovery";

const roots: string[] = [];
const fixedNow = () => new Date("2026-10-22T12:00:00.000Z");

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function recoveryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "kestrel-detached-recovery-"));
	roots.push(directory);
	return directory;
}

function stateFileName(hex: string): string {
	return `window-${hex.padStart(8, "0")}.json`;
}

function restorableState(label: string): UserBrowserState {
	const state = freshBrowserState(fixedNow);
	state.tabs[0] = {
		...state.tabs[0]!,
		title: label,
		url: `https://${label}.example/`,
	};
	return state;
}

function writeState(
	directory: string,
	name: string,
	state: UserBrowserState,
): string {
	const path = join(directory, name);
	writeFileSync(path, `${JSON.stringify(state)}\n`, "utf8");
	return path;
}

describe("detached window startup recovery", () => {
	it("does not let skipped candidates crowd a valid window out of the recovery budget", async () => {
		const directory = recoveryDirectory();
		for (let index = 0; index < 11; index += 1) {
			writeFileSync(
				join(directory, stateFileName(index.toString(16))),
				"{invalid json",
				"utf8",
			);
		}
		for (let index = 11; index < 22; index += 1) {
			const state = restorableState(`opted-out-${index}`);
			state.settings.restoreSession = false;
			writeState(directory, stateFileName(index.toString(16)), state);
		}
		const validPath = writeState(
			directory,
			stateFileName("ffffffff"),
			restorableState("valid-tail"),
		);
		const restored: string[] = [];

		const count = await restoreDetachedWindowStates(
			directory,
			(_state, _tab, statePath) => restored.push(statePath),
		);

		expect(count).toBe(1);
		expect(restored).toEqual([validPath]);
		expect(existsSync(validPath)).toBe(true);
	});

	it("restores at most twenty valid windows and preserves every state file", async () => {
		const directory = recoveryDirectory();
		const paths = Array.from({ length: 21 }, (_, index) =>
			writeState(
				directory,
				stateFileName(index.toString(16)),
				restorableState(`valid-${index}`),
			),
		);
		const restored: string[] = [];

		const count = await restoreDetachedWindowStates(
			directory,
			(_state, _tab, statePath) => restored.push(statePath),
		);

		expect(count).toBe(20);
		expect(restored).toHaveLength(20);
		expect(paths.every((path) => existsSync(path))).toBe(true);
	});

	it("skips unsafe, incompatible, opted-out, and empty state without removing it", async () => {
		const directory = recoveryDirectory();
		const malformedPath = join(directory, stateFileName("01"));
		writeFileSync(malformedPath, "{invalid json", "utf8");

		const optedOut = restorableState("opted-out");
		optedOut.settings.restoreSession = false;
		const optedOutPath = writeState(
			directory,
			stateFileName("02"),
			optedOut,
		);

		const homepage = restorableState("homepage");
		homepage.settings.startupBehavior = "homepage";
		const homepagePath = writeState(
			directory,
			stateFileName("03"),
			homepage,
		);

		const empty = restorableState("empty");
		empty.tabs = [];
		empty.activeTabId = null;
		const emptyPath = writeState(directory, stateFileName("04"), empty);

		const oversizedPath = join(directory, stateFileName("05"));
		writeFileSync(oversizedPath, "", "utf8");
		truncateSync(oversizedPath, 5_000_001);

		const symlinkTarget = writeState(
			directory,
			"target.json",
			restorableState("symlink-target"),
		);
		const symlinkPath = join(directory, stateFileName("06"));
		symlinkSync(symlinkTarget, symlinkPath);
		const unmatchedPath = writeState(
			directory,
			"window-NOT-HEX.json",
			restorableState("unmatched-name"),
		);

		const restoreWindow = vi.fn();
		const count = await restoreDetachedWindowStates(directory, restoreWindow);

		expect(count).toBe(0);
		expect(restoreWindow).not.toHaveBeenCalled();
		for (const path of [
			malformedPath,
			optedOutPath,
			homepagePath,
			emptyPath,
			oversizedPath,
			symlinkPath,
			unmatchedPath,
		])
			expect(existsSync(path)).toBe(true);
		expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
	});

	it("does not charge callback failures against the successful restore limit", async () => {
		const directory = recoveryDirectory();
		for (let index = 0; index < 20; index += 1)
			writeState(
				directory,
				stateFileName(index.toString(16)),
				restorableState(`callback-failure-${index}`),
			);
		const fallbackState = restorableState("valid-after-callback-failures");
		fallbackState.activeTabId = null;
		const fallbackTabId = fallbackState.tabs[0]!.id;
		const validPath = writeState(
			directory,
			stateFileName("ffffffff"),
			fallbackState,
		);
		const restored: string[] = [];

		const count = await restoreDetachedWindowStates(
			directory,
			(_state, tab, statePath) => {
				if (tab.title.startsWith("callback-failure"))
					throw new Error("Synthetic window construction failure.");
				expect(tab.id).toBe(fallbackTabId);
				restored.push(statePath);
			},
		);

		expect(count).toBe(1);
		expect(restored).toEqual([validPath]);
	});

	it("bounds candidate inspection independently of the restored-window quota", async () => {
		const directory = recoveryDirectory();
		for (let index = 0; index < 1_000; index += 1)
			writeFileSync(join(directory, stateFileName(index.toString(16))), "bad");
		const validPath = writeState(
			directory,
			stateFileName("ffffffff"),
			restorableState("beyond-scan-budget"),
		);
		const restoreWindow = vi.fn();

		expect(await restoreDetachedWindowStates(directory, restoreWindow)).toBe(0);
		expect(restoreWindow).not.toHaveBeenCalled();
		expect(existsSync(validPath)).toBe(true);
	});

	it("bounds aggregate reads even when each candidate fits the per-file limit", async () => {
		const directory = recoveryDirectory();
		for (let index = 0; index < 20; index += 1) {
			const path = join(directory, stateFileName(index.toString(16)));
			writeFileSync(path, "");
			truncateSync(path, 5_000_000);
		}
		const validPath = writeState(
			directory,
			stateFileName("ffffffff"),
			restorableState("beyond-read-budget"),
		);
		const restoreWindow = vi.fn();

		expect(await restoreDetachedWindowStates(directory, restoreWindow)).toBe(0);
		expect(restoreWindow).not.toHaveBeenCalled();
		expect(existsSync(validPath)).toBe(true);
	});
});
