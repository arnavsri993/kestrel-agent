import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	writeFileSync,
	utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	cleanupDuplicateKestrelApps,
	markDirectoryUnindexed,
	preventSpotlightIndexing,
	removeStaleInstallStagingDirectories,
	repositoryReleaseBundle,
	staleInstallStageCandidates,
	worktreeReleaseCandidates,
} from "./kestrel-macos-app-hygiene.mjs";

function createBundle(root, name, identifier = "com.kestrel.desktop.dev") {
	const bundle = join(root, name);
	mkdirSync(join(bundle, "Contents"), { recursive: true });
	writeFileSync(
		join(bundle, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>Kestrel</string>
<key>CFBundleDisplayName</key><string>Kestrel</string>
</dict></plist>
`,
	);
	return bundle;
}

const testSuite = process.platform === "darwin" ? describe : describe.skip;

testSuite("kestrel macOS app hygiene", () => {
	it("finds Agent worktree release bundles under Documents", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-hygiene-worktree-"));
		const documentsRoot = join(root, "Documents");
		const bundleRoot = join(
			documentsRoot,
			"Agent-browser-recovery",
			"release",
			"mac-arm64",
		);
		mkdirSync(bundleRoot, { recursive: true });
		const bundle = createBundle(bundleRoot, "Kestrel.app");

		expect(worktreeReleaseCandidates(documentsRoot)).toEqual([bundle]);
	});

	it("marks release trees unindexed across Agent worktrees", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-hygiene-index-"));
		const documentsRoot = join(root, "Documents");
		const repoRoot = join(documentsRoot, "Agent");
		const releaseDir = join(repoRoot, "release");
		mkdirSync(releaseDir, { recursive: true });

		const marked = preventSpotlightIndexing(repoRoot);

		expect(marked).toContain(releaseDir);
		expect(existsSync(join(releaseDir, ".metadata_never_index"))).toBe(true);
		expect(markDirectoryUnindexed(releaseDir)).toBe(false);
	});

	it("trashes duplicate worktree bundles while keeping excluded paths", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-hygiene-trash-"));
		const documentsRoot = join(root, "Documents");
		const installRoot = join(root, "Applications");
		const trashRoot = join(root, "Trash");
		mkdirSync(installRoot);
		const canonical = createBundle(installRoot, "Kestrel.app");
		const staleRoot = join(
			documentsRoot,
			"Agent-action-receipts",
			"release",
			"mac-arm64",
		);
		mkdirSync(staleRoot, { recursive: true });
		const stale = createBundle(staleRoot, "Kestrel.app");

		const result = cleanupDuplicateKestrelApps({
			installRoot,
			trashRoot,
			searchRoots: [installRoot],
			repositoryRoot: join(documentsRoot, "Agent"),
			documentsRoot,
			excludedPaths: [canonical],
			skipSpotlight: true,
		});

		expect(existsSync(canonical)).toBe(true);
		expect(existsSync(stale)).toBe(false);
		expect(readdirSync(trashRoot)).toHaveLength(1);
		expect(result.moved).toHaveLength(1);
	});

	it("keeps the current repository release bundle for packaged smoke tests", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-hygiene-release-"));
		const documentsRoot = join(root, "Documents");
		const installRoot = join(root, "Applications");
		const trashRoot = join(root, "Trash");
		const repositoryRoot = join(documentsRoot, "Agent");
		mkdirSync(installRoot);
		const canonical = createBundle(installRoot, "Kestrel.app");
		const releaseRoot = join(repositoryRoot, "release", "mac-arm64");
		mkdirSync(releaseRoot, { recursive: true });
		const currentRelease = createBundle(releaseRoot, "Kestrel.app");
		const staleRoot = join(
			documentsRoot,
			"Agent-browser-recovery",
			"release",
			"mac-arm64",
		);
		mkdirSync(staleRoot, { recursive: true });
		const stale = createBundle(staleRoot, "Kestrel.app");

		const result = cleanupDuplicateKestrelApps({
			installRoot,
			trashRoot,
			searchRoots: [installRoot],
			repositoryRoot,
			documentsRoot,
			skipSpotlight: true,
		});

		expect(repositoryReleaseBundle(repositoryRoot)).toBe(currentRelease);
		expect(existsSync(canonical)).toBe(true);
		expect(existsSync(currentRelease)).toBe(true);
		expect(existsSync(stale)).toBe(false);
		expect(readdirSync(trashRoot)).toHaveLength(1);
		expect(result.moved).toHaveLength(1);
	});

	it("removes abandoned install staging directories without touching the canonical app", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-hygiene-staging-"));
		const installRoot = join(root, "Applications");
		mkdirSync(installRoot);
		const canonical = createBundle(installRoot, "Kestrel.app");
		const staleRoot = join(installRoot, ".Kestrel-install-stale");
		const activeRoot = join(installRoot, ".Kestrel-install-active");
		mkdirSync(join(staleRoot, "Kestrel.app", "Contents"), { recursive: true });
		mkdirSync(activeRoot);
		const now = 1_000_000;
		// Directory mtimes are the install heartbeat: an actively copying stage
		// remains recent and must not be removed by another installer.
		utimesSync(staleRoot, new Date(0), new Date(0));
		utimesSync(activeRoot, new Date(now), new Date(now));

		expect(
			staleInstallStageCandidates(installRoot, {
				now,
				maxAgeMs: 1,
			}),
		).toEqual([staleRoot]);
		expect(
			removeStaleInstallStagingDirectories(installRoot, {
				now,
				maxAgeMs: 1,
			}),
		).toEqual([staleRoot]);
		expect(existsSync(canonical)).toBe(true);
		expect(existsSync(staleRoot)).toBe(false);
		expect(existsSync(activeRoot)).toBe(true);
	});
});
