import { describe, beforeAll, afterAll, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

describe.skipIf(process.platform !== "darwin")("native Core data profile selection", () => {
	let temporary, executable;
	beforeAll(() => {
		const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-profile-selection-"))); executable = join(temporary, "selection-fixture");
		const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 5000 }).trim();
		execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-isysroot", sdk,
			"-I", join(repository, "apps/native-chromium-host/src"),
			... ["kestrel_native_core_keychain.mm", "kestrel_legacy_core_key.cc", "kestrel_legacy_keychain.mm"].map(file => join(repository, "apps/native-chromium-host/src", file)),
			join(repository, "apps/native-chromium-host/tests/profile_selection_fixture.mm"), "-framework", "Foundation", "-framework", "AppKit", "-framework", "Security", "-framework", "LocalAuthentication", "-o", executable], { timeout: 30000, stdio: "pipe" });
	// A cold CI SDK/compiler may exceed Vitest's default ten-second hook.
	// Keep the hook outside the bounded SDK and compiler subprocess budgets.
	}, 40000);
	afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
	function profile() {
		const root = join(temporary, randomUUID()); mkdirSync(root, { mode: 0o700 });
		return { root, file: join(root, "native-core-profile.json"),
			select(value) { writeFileSync(join(root, "native-core-profile.json"), JSON.stringify(value), { mode: 0o600 }); },
			child() { const relative = `native-core-profiles/${randomUUID()}`; mkdirSync(join(root, "native-core-profiles"), { mode: 0o700 }); mkdirSync(join(root, relative), { mode: 0o700 }); return relative; },
			save(active, previous = "", expected = "", fault) { const result = spawnSync(executable, [root, active, previous, expected], { encoding: "utf8", env: { ...process.env, ...(fault ? { KESTREL_SELECTION_FIXTURE_FSYNC_FAULT: fault } : {}) } }); expect(result.status).toBe(0); expect(result.stderr).toBe(""); return JSON.parse(result.stdout); },
			resolve() { const result = spawnSync(executable, [root], { encoding: "utf8" }); expect(result.status).toBe(0); expect(result.stderr).toBe(""); return JSON.parse(result.stdout); } };
	}
	function source(value, path = value.root) {
		const result = spawnSync(executable, [path, "--source"], { encoding: "utf8" }); expect(result.status).toBe(0); expect(result.stderr).toBe(""); return JSON.parse(result.stdout);
	}
	function sourceProfile() { const value = profile(); for (const name of ["secure", "database"]) mkdirSync(join(value.root, name), { mode: 0o700 }); return value; }
	function stopWorker(mode) {
		const result = spawnSync(executable, [temporary, `--stop-${mode}`], { encoding: "utf8", timeout: 10000 });
		expect(result.status).toBe(0); expect(result.stderr).toBe(""); return JSON.parse(result.stdout);
	}
	it("confirms a private child has stopped before releasing its task", () => {
		const result = stopWorker("worker"); expect(result).toMatchObject({ stopped: true, identity: true, preservedBeforeFixtureCleanup: false }); expect(result.milliseconds).toBeLessThan(3500);
	});
	it("stops an unresponsive paused private child using its captured process identity", () => {
		const result = stopWorker("paused-worker"); expect(result).toMatchObject({ stopped: true, identity: true, preservedBeforeFixtureCleanup: false, signal: 9 }); expect(result.milliseconds).toBeLessThan(3500);
	});
	it("does not force a signal when the captured child start time no longer matches", () => {
		const result = stopWorker("mismatched-worker"); expect(result).toMatchObject({ stopped: false, identity: true, preservedBeforeFixtureCleanup: true, signal: null }); expect(result.milliseconds).toBeLessThan(3500);
	});
	it("canonicalizes an explicit native source without Cocoa shortening /private/var", () => {
		const root = realpathSync(mkdtempSync("/var/tmp/kestrel-source-alias-")), value = { root };
		try {
			for (const name of ["secure", "database"]) mkdirSync(join(root, name), { mode: 0o700 });
			expect(source(value)).toMatchObject({ ok: true, profile: root });
			expect(root.startsWith("/private/var/")).toBe(true);
			expect(source(value, root.replace(/^\/private\/var\//, "/var/"))).toMatchObject({ ok: true, profile: root });
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("canonicalizes an explicitly selected source folder alias", () => {
		const value = sourceProfile(), alias = join(temporary, randomUUID()); symlinkSync(value.root, alias);
		expect(source(value, alias)).toMatchObject({ ok: true, profile: value.root });
	});
	it("rejects relative or incomplete source profiles", () => {
		const value = profile(); expect(source(value).ok).toBe(false); expect(source(value, "relative/profile").ok).toBe(false);
	});
	it("rejects source data directories readable by other users", () => {
		const value = sourceProfile(); chmodSync(join(value.root, "database"), 0o755); expect(source(value).ok).toBe(false);
	});
	it("rejects linked source data directories", () => {
		const value = profile(), other = profile(); mkdirSync(join(value.root, "secure"), { mode: 0o700 }); symlinkSync(other.root, join(value.root, "database")); expect(source(value).ok).toBe(false);
	});
	it("keeps the current profile when no selection was made", () => { const value = profile(); expect(value.resolve()).toEqual({ ok: true, profile: value.root, error: false }); });
	it("resolves a selected stable child without moving either profile", () => {
		const value = profile(), relative = `native-core-profiles/${randomUUID()}`;
		mkdirSync(join(value.root, "native-core-profiles"), { mode: 0o700 }); mkdirSync(join(value.root, relative), { mode: 0o700 });
		value.select({ version: 1, active: relative, previous: "" }); expect(value.resolve()).toEqual({ ok: true, profile: join(value.root, relative), error: false });
	});
	it.each([
		{ version: 2, active: "", previous: "" }, { version: true, active: "", previous: "" }, { version: 1.1, active: "", previous: "" },
		{ version: 1, active: "../other", previous: "" }, { version: 1, active: "/other", previous: "" },
		{ version: 1, active: "", previous: "", extra: true },
	])("refuses malformed or unsupported selection metadata", selected => { const value = profile(); value.select(selected); expect(value.resolve()).toMatchObject({ ok: false, error: true }); });
	it("refuses linked or readable-by-others selection files", () => {
		const value = profile(); value.select({ version: 1, active: "", previous: "" }); chmodSync(value.file, 0o644); expect(value.resolve().ok).toBe(false);
		const linked = profile(); symlinkSync(value.file, linked.file); expect(linked.resolve().ok).toBe(false);
	});
	it("refuses a linked child profile even when its target is private", () => {
		const value = profile(), other = profile(), relative = `native-core-profiles/${randomUUID()}`;
		mkdirSync(join(value.root, "native-core-profiles"), { mode: 0o700 }); symlinkSync(other.root, join(value.root, relative));
		value.select({ version: 1, active: relative, previous: "" }); expect(value.resolve().ok).toBe(false);
	});
	it("saves an atomic selection and can switch back without moving either profile", () => {
		const value = profile(), child = value.child();
		expect(value.save(child)).toMatchObject({ saved: "selected", profile: join(value.root, child) });
		expect(value.save("", child, child)).toMatchObject({ saved: "selected", profile: value.root });
		expect(existsSync(join(value.root, child))).toBe(true);
	});
	it("does not overwrite a selection changed since review", () => {
		const value = profile(), child = value.child(); value.select({ version: 1, active: child, previous: "" });
		expect(value.save("", child)).toMatchObject({ saved: "unchanged", profile: join(value.root, child) });
	});
	it("refuses unavailable or escaping selection targets without creating metadata", () => {
		const value = profile(); expect(value.save(`native-core-profiles/${randomUUID()}`).saved).toBe("unchanged"); expect(value.save("../other").saved).toBe("unchanged"); expect(existsSync(value.file)).toBe(false);
	});
	it("keeps the original selection and removes the staging file if data sync fails", () => {
		const value = profile(), child = value.child();
		expect(value.save(child, "", "", "file")).toMatchObject({ saved: "unchanged", profile: value.root });
		expect(readdirSync(value.root)).toEqual(["native-core-profiles"]);
	});
	it("reports the committed selection honestly when directory sync fails after rename", () => {
		const value = profile(), child = value.child();
		expect(value.save(child, "", "", "directory")).toMatchObject({ saved: "selected-durability-unconfirmed", profile: join(value.root, child) });
		expect(value.resolve()).toMatchObject({ profile: join(value.root, child) });
	});
});
