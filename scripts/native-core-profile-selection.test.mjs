import { compileNativeLocalVaultCrypto, nativeLocalVaultLinkFlags } from "./build-native-local-vault.mjs";
import { describe, beforeAll, afterAll, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

describe.skipIf(process.platform !== "darwin")("native Core data profile selection", () => {
	let temporary, executable;
	beforeAll(() => {
		const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		temporary = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-profile-selection-")));
		const bundle = join(temporary, "Fixture.app", "Contents");
		const resources = join(bundle, "Resources"), nodeDirectory = join(resources, "agent-core/node/bin");
		mkdirSync(join(bundle, "MacOS"), { recursive: true }); mkdirSync(nodeDirectory, { recursive: true });
		executable = join(bundle, "MacOS/selection-fixture");
		writeFileSync(join(bundle, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>selection-fixture</string><key>CFBundleIdentifier</key><string>com.kestrel.native-profile-selection-fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
		const fakeNode = join(nodeDirectory, "node");
		writeFileSync(fakeNode, "#!/bin/sh\nparent=$PPID\nsleeper=\ntrap 'if [ -n \"$sleeper\" ]; then kill \"$sleeper\" 2>/dev/null; wait \"$sleeper\" 2>/dev/null; fi; exit 0' TERM INT HUP\ni=0\nwhile [ \"$i\" -lt 80 ] && kill -0 \"$parent\" 2>/dev/null; do\n  /bin/sleep 0.1 & sleeper=$!\n  wait \"$sleeper\"\n  sleeper=\n  i=$((i+1))\ndone\nexit 0\n", { mode: 0o700 }); chmodSync(fakeNode, 0o700);
		const crypto = compileNativeLocalVaultCrypto(join(temporary, "vault.o"));
		const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 5000 }).trim();
		execFileSync("/usr/bin/xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0", "-isysroot", sdk,
			"-I", join(repository, "apps/native-chromium-host/src"),
			crypto, ...nativeLocalVaultLinkFlags(),
			... ["kestrel_local_vault.mm", "kestrel_local_vault_crypto_process.mm"].map(file => join(repository, "apps/native-chromium-host/src", file)),
				... ["kestrel_native_core_keychain.mm", "kestrel_native_prepared_profiles.mm", "kestrel_profile_reservation.cc", "kestrel_legacy_core_key.cc", "kestrel_legacy_keychain.mm"].map(file => join(repository, "apps/native-chromium-host/src", file)),
			join(repository, "apps/native-chromium-host/tests/profile_selection_fixture.mm"), "-framework", "Foundation", "-framework", "AppKit", "-framework", "Security", "-framework", "LocalAuthentication", "-o", executable], { timeout: 30000, stdio: "pipe" });
	// Allow the complete bounded cold build: Swift (60s), target info (10s),
	// SDK lookup (5s), and C++/link (30s), plus fixture setup. Individual
	// subprocess deadlines still fail a hung compiler before this hook expires.
	}, 120000);
	afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
	function profile() {
		const root = join(temporary, randomUUID()); mkdirSync(root, { mode: 0o700 });
		return { root, file: join(root, "native-core-profile.json"),
			select(value) { writeFileSync(join(root, "native-core-profile.json"), JSON.stringify(value), { mode: 0o600 }); },
			child() { const relative = `native-core-profiles/${randomUUID()}`; mkdirSync(join(root, "native-core-profiles"), { mode: 0o700, recursive: true }); mkdirSync(join(root, relative), { mode: 0o700 }); return relative; },
			save(active, previous = "", expected = "", fault) { const result = spawnSync(executable, [root, active, previous, expected], { encoding: "utf8", env: { ...process.env, ...(fault ? { KESTREL_SELECTION_FIXTURE_FSYNC_FAULT: fault } : {}) } }); expect(result.status).toBe(0); expect(result.stderr).toBe(""); return JSON.parse(result.stdout); },
			resolve() { const result = spawnSync(executable, [root], { encoding: "utf8" }); expect(result.status).toBe(0); expect(result.stderr).toBe(""); return JSON.parse(result.stdout); } };
	}
	function source(value, path = value.root) {
		const result = spawnSync(executable, [path, "--source"], { encoding: "utf8" }); expect(result.status).toBe(0); expect(result.stderr).toBe(""); return JSON.parse(result.stdout);
	}
	function sourceProfile() { const value = profile(); for (const name of ["secure", "database"]) mkdirSync(join(value.root, name), { mode: 0o700 }); return value; }
		// These use an injected in-memory existing-key backend. They do not unlock
		// a production vault or establish Secure Enclave/runtime acceptance.
		function nativeSource(active = false) {
			const value = profile();
			writeFileSync(join(value.root, ".kestrel-desktop.lock"), "", { mode: 0o600 });
			function core(root) {
				mkdirSync(join(root, "native-core/database"), { mode: 0o700, recursive: true });
				writeFileSync(join(root, "native-core/database/kestrel.sqlite"), "generated inert database fixture", { mode: 0o600 });
				writeFileSync(join(root, ".kestrel-local-vault-v1"), Buffer.from([0x4b,0x53,0x54,0x56,0x4c,0x54,1,0,1,2,3]), { mode: 0o600 });
			}
			core(value.root);
			let selected = value.root;
			if (active) {
				const relative = value.child(); selected = join(value.root, relative); core(selected);
				value.select({ version: 2, active: relative, previous: "", handoffs: { "": null, [relative]: randomUUID() } });
			}
			return { ...value, selected };
		}
	function stopWorker(mode) {
		const result = spawnSync(executable, [temporary, `--stop-${mode}`], { encoding: "utf8", timeout: 10000 });
		expect(result.status).toBe(0); expect(result.stderr).toBe(""); return JSON.parse(result.stdout);
	}
	function fixture(...args) {
		const result = spawnSync(executable, args, { encoding: "utf8", timeout: 2000 });
		expect(result.status).toBe(0); expect(result.stderr).toBe(""); return JSON.parse(result.stdout);
	}
	function registry(value, op, first, second, expected, fault) {
		const args = [value.root, "--registry", ...(op ? [op, first, second, JSON.stringify(expected)] : [])];
		const result = spawnSync(executable, args, { encoding: "utf8", env: { ...process.env, ...(fault ? { KESTREL_SELECTION_FIXTURE_FSYNC_FAULT: fault } : {}) } });
		expect(result.status).toBe(0); expect(result.stderr).toBe(""); return JSON.parse(result.stdout);
	}
	it("normalizes v1 without writing and resolves its explicit legacy identity", () => {
		const value = profile(), child = value.child(); value.select({ version: 1, active: child, previous: "" });
		const before = readFileSync(value.file, "utf8"), result = registry(value);
		expect(result.selection).toEqual({ version: 2, active: child, previous: "", handoffs: { [child]: null, "": null } });
		expect(result.resolved).toEqual({ profilePath: join(value.root, child), relativeProfile: child, handoffId: null });
		expect(readFileSync(value.file, "utf8")).toBe(before);
	});
	it("registers, selects and swaps while preserving all handoff identities", () => {
		const value = profile(), child = value.child(), id = randomUUID(), initial = registry(value).selection;
		let result = registry(value, "register", child, id, initial); expect(result.saved).toBe("selected");
		expect(result.selection.handoffs[child]).toBe(id);
		result = registry(value, "save", child, "", result.selection); expect(result.saved).toBe("selected");
		expect(result.resolved).toEqual({ profilePath: join(value.root, child), relativeProfile: child, handoffId: id });
		result = registry(value, "save", "", child, result.selection); expect(result.saved).toBe("selected");
		expect(result.selection.handoffs[child]).toBe(id); expect(result.resolved.handoffId).toBe(null);
		expect(value.save(child, "", "").saved).toBe("selected"); expect(registry(value).resolved.handoffId).toBe(id);
	});
	it("requires a full reviewed snapshot and never overwrites legacy or registered identities", () => {
		const value = profile(), a = value.child(), b = value.child(), id = randomUUID(), initial = registry(value).selection;
		const registered = registry(value, "register", a, id, initial); expect(registered.saved).toBe("selected");
		expect(registry(value, "register", b, randomUUID(), initial).saved).toBe("unchanged");
		expect(registry(value, "save", a, "", initial).saved).toBe("unchanged");
		expect(registry(value, "register", a, randomUUID(), registered.selection).saved).toBe("unchanged");
		expect(registry(value, "save", b, "", registered.selection).saved).toBe("unchanged");
		expect(registry(value, "register", a, id, registered.selection).saved).toBe("selected");
	});
	it("upgrades a legacy null handoff only for an unselected prepared profile", () => {
		const value = profile(), active = value.child(), previous = value.child(), prepared = value.child();
		const id = "123e4567-e89b-42d3-a456-426614174000";
		const initial = { version: 2, active, previous, handoffs: { "": null, [active]: null, [previous]: null, [prepared]: null } };
		value.select(initial);
		const registered = registry(value, "register", prepared, id, initial);
		expect(registered.saved).toBe("selected");
		expect(registered.selection.handoffs).toEqual({ "": null, [active]: null, [previous]: null, [prepared]: id });
		expect(registry(value, "register", active, id, registered.selection).saved).toBe("unchanged");
		expect(registry(value, "register", previous, id, registered.selection).saved).toBe("unchanged");
		expect(registry(value).selection).toEqual(registered.selection);
	});
	it("accepts only canonical lowercase RFC 4122 UUIDv4 handoff IDs", () => {
		const value = profile(), prepared = value.child();
		const initial = { version: 2, active: "", previous: "", handoffs: { "": null, [prepared]: null } };
		value.select(initial);
		for (const id of [
			"123E4567-E89B-42D3-A456-426614174000",
			"123e4567-e89b-12d3-a456-426614174000",
			"123e4567-e89b-42d3-7456-426614174000",
			"123e4567e89b42d3a456426614174000",
		]) {
			expect(registry(value, "register", prepared, id, initial).saved).toBe("unchanged");
			expect(registry(value).selection).toEqual(initial);
		}
	});
	it.each([false, true])("looks up only the selected native source's existing key (active child %s)", active => {
		const value = nativeSource(active), vault = join(value.selected, ".kestrel-local-vault-v1"), db = join(value.selected, "native-core/database/kestrel.sqlite");
		const before = [readFileSync(vault), readFileSync(db)];
		expect(fixture(value.root, "--native-source", "lookup")).toMatchObject({ valid: true, profile: value.selected, lease: true, current: true,
			opened: true, reads: 1, creates: 0, legacyReaders: 0, sourceUnchanged: true, reservationsBlock: true, preparedReadable: true });
		expect([readFileSync(vault), readFileSync(db)]).toEqual(before);
	});
	it("does not generate or use a legacy reader when the existing native key is unavailable", () => {
		const value = nativeSource();
		expect(fixture(value.root, "--native-source", "lookup-missing")).toMatchObject({ valid: true, lease: true, opened: false,
			reads: 1, creates: 0, legacyReaders: 0, sourceUnchanged: true });
	});
	it.each(["transfer", "recovery"])("releases a stopped worker's source before retrying %s", operation => {
		const value = nativeSource(true);
		expect(fixture(value.root, "--native-source", `retry-${operation}-confirmed`)).toEqual({
			stopCalled: true, reentered: true, pipeRetained: false, leaseRetained: false,
		});
	});
	it.each(["transfer", "recovery"])("keeps the source reserved when the previous %s worker stop is uncertain", operation => {
		const value = nativeSource(true);
		expect(fixture(value.root, "--native-source", `retry-${operation}-uncertain`)).toEqual({
			stopCalled: true, reentered: false, pipeRetained: true, leaseRetained: true,
		});
	});
	it.each([true, false])("waits for transfer shutdown once and preserves an uncertain source reservation (confirmed %s)", confirmed => {
		const value = nativeSource(true);
		expect(fixture(value.root, "--native-source", `shutdown-${confirmed ? "confirmed" : "uncertain"}`)).toEqual({
			stopped: true, waitPassed: confirmed, stopCount: 1, pipeRetained: !confirmed, leaseRetained: !confirmed, lockAvailable: confirmed,
		});
	});
	it("bounds shutdown waiting and permits a later completion check", () => {
		const value = nativeSource(true);
		expect(fixture(value.root, "--native-source", "shutdown-timeout")).toEqual({
			firstWaitPassed: false, secondWaitPassed: true, stopCount: 1, pipeRetained: false, leaseRetained: false, lockAvailable: true,
		});
	});
	it.each(["read", "write"])("cancels a blocked production-pipe %s and reaps only its owned child", mode => {
		const result = spawnSync(executable, [`--pipe-cancel-${mode}`], { encoding: "utf8", timeout: 10_000 });
		expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({ stopped: true, requestCancelled: true, blockedWrite: mode === "write", childAbsent: true, pipeRetained: false });
		expect(JSON.parse(result.stdout).elapsedMs).toBeLessThan(2_000);
	});
	it("keeps a verified source lease until final choice or shutdown", () => {
		const value = nativeSource(true);
		expect(fixture(value.root, "--native-source", "lease-stop-retain")).toEqual({
			stoppedWorker: true, leaseBlocksSecondOwner: true, mutationDetected: true, sourceRestored: true, shutdownConfirmed: true,
			leaseReleasedAtShutdown: true, invalidateIdempotent: true,
		});
	});
	it.each(["busy-source", "busy-reservation", "busy-active-reservation"])("refuses native source in use through %s before key access", action => {
		const value = nativeSource(true);
		expect(fixture(value.root, "--native-source", action)).toMatchObject({ valid: true, lease: false, opened: false,
			reads: 0, creates: 0, legacyReaders: 0, sourceUnchanged: true });
	});
	it.each(["mutate-vault", "replace-vault", "move-owner", "mutate-selection", "switch-selection", "replace-core"])("invalidates reviewed source after %s without accessing a key", action => {
		const value = nativeSource(true);
		expect(fixture(value.root, "--native-source", action)).toMatchObject({ valid: true, lease: true, current: false, opened: false,
			reads: 0, creates: 0, legacyReaders: 0 });
	});
	it("clears a looked-up key if the native source changes during lookup", () => {
		const value = nativeSource(true);
		expect(fixture(value.root, "--native-source", "changed-during-lookup")).toMatchObject({ valid: true, opened: false, current: false,
			reads: 1, creates: 0, legacyReaders: 0, failureCleared: true });
	});
	it.each([false, true])("accepts ctime-only owner metadata activity while retaining source identities and bytes (active child %s)", active => {
		const value = nativeSource(active);
		expect(fixture(value.root, "--native-source", "root-metadata-only")).toMatchObject({ valid: true, lease: true,
			current: true, opened: true, reads: 1, creates: 0, legacyReaders: 0, sourceUnchanged: true });
	});
	it.each(["active-profile-metadata-only", "core-metadata-only", "database-metadata-only"])("keeps the nested directory ctime guard after %s", action => {
		const value = nativeSource(true);
		expect(fixture(value.root, "--native-source", action)).toMatchObject({ valid: true, lease: true,
			current: false, opened: false, reads: 0, creates: 0, legacyReaders: 0, sourceUnchanged: true });
	});
	it("rejects an owner ACL change even when directory identity and POSIX permissions stay private", () => {
		const value = nativeSource(true);
		expect(fixture(value.root, "--native-source", "root-acl-change")).toMatchObject({ valid: true, lease: true,
			current: false, opened: false, reads: 0, creates: 0, legacyReaders: 0, sourceUnchanged: true });
	});
	it("rejects an owner group change even when permissions, ACL and data stay unchanged", context => {
		const value = nativeSource(true);
		if (!process.getgroups().some(group => group !== lstatSync(value.root).gid)) { context.skip(); return; }
		expect(fixture(value.root, "--native-source", "root-group-change")).toMatchObject({ valid: true, lease: true,
			current: false, opened: false, reads: 0, creates: 0, legacyReaders: 0, sourceUnchanged: true });
	});
	it.each(["missing-vault", "corrupt-vault", "linked-vault", "unsafe-vault", "missing-active", "missing-database", "unsettled-journal", "malformed-selection", "ambiguous-layout", "test-key", "owner-test-marker", "owner-test-key", "owner-file-key", "missing-lock"])("refuses %s without fallback or source key creation", action => {
		const value = nativeSource(true), vault = join(value.selected, ".kestrel-local-vault-v1");
		if (action === "missing-vault") rmSync(vault);
		if (action === "corrupt-vault") writeFileSync(vault, "not a vault");
		if (action === "linked-vault") { rmSync(vault); symlinkSync(join(value.root, ".kestrel-local-vault-v1"), vault); }
		if (action === "unsafe-vault") chmodSync(vault, 0o644);
		if (action === "missing-active") value.select({ version: 1, active: `native-core-profiles/${randomUUID()}`, previous: "" });
		if (action === "missing-database") rmSync(join(value.selected, "native-core/database/kestrel.sqlite"));
		if (action === "unsettled-journal") writeFileSync(join(value.selected, "native-core/database/kestrel.sqlite-journal"), "generated unsettled fixture", { mode: 0o600 });
		if (action === "malformed-selection") writeFileSync(value.file, '{"version":2,"active":""}');
		if (action === "ambiguous-layout") mkdirSync(join(value.root, "database"), { mode: 0o700 });
		if (action === "test-key") writeFileSync(join(value.selected, ".kestrel-native-test-core-key-v1"), Buffer.alloc(32), { mode: 0o600 });
		if (action === "owner-test-marker") writeFileSync(join(value.root, ".kestrel-native-test-profile-v1"), "native-test-profile-v1\n", { mode: 0o600 });
		if (action === "owner-test-key") writeFileSync(join(value.root, ".kestrel-native-test-core-key-v1"), Buffer.alloc(32), { mode: 0o600 });
		if (action === "owner-file-key") writeFileSync(join(value.root, "native-core/database.key"), Buffer.alloc(32), { mode: 0o600 });
		if (action === "missing-lock") rmSync(join(value.root, ".kestrel-desktop.lock"));
		const result = fixture(value.root, "--native-source", "lookup");
		expect(result).toMatchObject({ opened: false, reads: 0, creates: 0, legacyReaders: 0 });
		if (action !== "missing-lock") expect(result.valid).toBe(false);
		else expect(result.lease).toBe(false);
	});
	it.each([false, true])("authenticates the explicit owner and selection for recovery (active child %s)", active => {
		const value = nativeSource(active), destination = profile();
		mkdirSync(join(destination.root, "native-core/database"), { mode: 0o700, recursive: true });
		writeFileSync(join(destination.root, "native-core/database/kestrel.sqlite.kestrel-transfer-journal"), "generated journal fixture", { mode: 0o600 });
		expect(fixture(value.root, "--native-source", "binding", destination.root)).toMatchObject({ opened: true, bindingValid: true,
			wrongKeyRejected: true, bindingNoKeys: true, bindingWitness: true, sourceUnchanged: true, creates: 0, legacyReaders: 0 });
	});
	it("rejects an altered source binding with matching source paths", () => {
		const value = nativeSource(true), destination = profile();
		expect(fixture(value.root, "--native-source", "tamper-binding", destination.root)).toMatchObject({ bindingValid: false,
			wrongKeyRejected: true, bindingNoKeys: true, sourceUnchanged: true });
	});
	it("rejects recovery when the same vault bytes are replaced after the binding is recorded", () => {
		const value = nativeSource(true), destination = profile();
		mkdirSync(join(destination.root, "native-core/database"), { mode: 0o700, recursive: true });
		writeFileSync(join(destination.root, "native-core/database/kestrel.sqlite.kestrel-transfer-journal"), "generated journal fixture", { mode: 0o600 });
		expect(fixture(value.root, "--native-source", "stale-binding", destination.root)).toMatchObject({ bindingValid: false, bindingWitness: false, sourceUnchanged: true });
	});
	it("rejects corrupt v2 maps, unknown fields, invalid UUIDs and booleans", () => {
		const value = profile(), child = value.child();
		for (const selected of [
			{ version: 2, active: child, previous: "", handoffs: { "": null } },
			{ version: 2, active: "", previous: "", handoffs: { "": true } },
			{ version: 2, active: "", previous: "", handoffs: { "": "not-a-uuid" } },
			{ version: 2, active: "", previous: "", handoffs: { "": null }, extra: 1 },
			{ version: true, active: "", previous: "", handoffs: { "": null } },
			{ version: 2, active: "", previous: "", handoffs: { "": null, "native-core-profiles/not-uuid": null } },
		]) { value.select(selected); expect(registry(value)).toMatchObject({ selection: null, resolved: null, error: true }); }
	});
	it("enforces the registry bound before mutation", () => {
		const value = profile(), child = value.child(), handoffs = { "": null };
		for (let i = 0; i < 128; i++) handoffs[`native-core-profiles/${randomUUID()}`] = randomUUID();
		value.select({ version: 2, active: "", previous: "", handoffs }); const initial = registry(value).selection;
		expect(registry(value, "register", child, randomUUID(), initial).saved).toBe("unchanged"); expect(registry(value).selection).toEqual(initial);
	});
	it.each([["file", "unchanged"], ["directory", "selected-durability-unconfirmed"]])("reports %s sync faults during registration", (fault, saved) => {
		const value = profile(), child = value.child(), initial = registry(value).selection;
		expect(registry(value, "register", child, randomUUID(), initial, fault).saved).toBe(saved);
	});
	it("refuses a FIFO key envelope without blocking", () => {
		const path = join(temporary, randomUUID());
		execFileSync("/usr/bin/mkfifo", [path]);
		expect(fixture(path, "--read-private")).toMatchObject({ ok: false });
	});
	it("rejects malformed interrupted review data", () => {
		expect(fixture(temporary, "--review-validation")).toEqual({ valid: true, badCount: true, badPath: true, badDigest: true });
	});
	it("bounds the optional legacy preservation review counts", () => {
		expect(fixture(temporary, "--legacy-review-validation")).toEqual({ valid: true, badBool: true, badLimit: true, badVersion: true, badFields: true });
	});
	it("discloses paused conflict preservation and validates both optional counts", () => {
		expect(fixture(temporary, "--conflict-review-validation")).toEqual({ valid: true, disclosed: true, badBool: true, badPair: true, badZero: true, badMissing: true, partialPurge: true, completePurge: true, purgeDisclosed: true, badPurgeCount: true });
	});
	it("validates exact fresh and recovery project handoff preview counts", () => {
		expect(fixture(temporary, "--project-handoff-validation")).toEqual({
			validFresh: true, validRecovery: true,
			badFreshExtra: true, badFreshMissing: true, badFreshType: true, badFreshRange: true, badFreshID: true,
			badRecoveryExtra: true, badRecoveryMissing: true, badRecoveryType: true, badRecoveryRange: true, badRecoveryID: true,
		});
	});
	it("adds only the shared empty active-child fence while preserving existing source data, vault and selection bytes", () => {
		const value = nativeSource(true), parent = join(value.root, "native-core-profiles");
		const files = [join(value.root, ".kestrel-local-vault-v1"), value.file, join(value.selected, ".kestrel-local-vault-v1"), join(value.selected, "native-core/database/kestrel.sqlite")];
		const bytes = files.map(path => readFileSync(path)), before = readdirSync(parent);
		expect(fixture(value.root, "--native-source", "lookup").sourceUnchanged).toBe(true);
		const added = readdirSync(parent).filter(name => !before.includes(name));
		expect(added).toEqual([`.kestrel-profile-${createHash("sha256").update(value.selected).digest("hex")}.lock`]);
		const fence = join(parent, added[0]), info = lstatSync(fence);
		expect(info.isFile() && info.size === 0 && info.nlink === 1 && info.uid === process.getuid() && (info.mode & 0o7777) === 0o600).toBe(true);
		expect(files.map(path => readFileSync(path))).toEqual(bytes);
	});
	it("keeps 128 prepared profiles inspectable alongside 128 strictly validated reservation files", () => {
		const value = nativeSource(true), parent = join(value.root, "native-core-profiles");
		for (let index = 0; index < 127; index++) {
			value.child();
			writeFileSync(join(parent, `.kestrel-profile-${index.toString(16).padStart(64, "0")}.lock`), "", { mode: 0o600 });
		}
		expect(fixture(value.root, "--native-source", "lookup").preparedReadable).toBe(true);
	});
	it.each(["unsafe", "nonempty", "linked", "excessive"])("refuses %s reservation metadata during prepared-profile enumeration", kind => {
		const value = nativeSource(true), parent = join(value.root, "native-core-profiles"), guard = join(parent, `.kestrel-profile-${"0".repeat(64)}.lock`);
		if (kind === "linked") symlinkSync(value.file, guard);
		else writeFileSync(guard, kind === "nonempty" ? "x" : "", { mode: kind === "unsafe" ? 0o644 : 0o600 });
		if (kind === "excessive") for (let index = 1; index < 128; index++) writeFileSync(join(parent, `.kestrel-profile-${index.toString(16).padStart(64, "0")}.lock`), "", { mode: 0o600 });
		expect(fixture(value.root, "--native-source", "lookup").preparedReadable).toBe(false);
	});
	it.each(["source", "destination", "key", "journal", "sidecar"])("invalidates a recovery witness when %s changes", target => {
		const sourceRoot = sourceProfile().root, destinationRoot = sourceProfile().root;
		const sourceDb = join(sourceRoot, "database/kestrel.sqlite"), destinationDb = join(destinationRoot, "database/kestrel.sqlite");
		const paths = { source: sourceDb, destination: destinationDb, key: join(sourceRoot, "secure/database-key.bin"), journal: `${destinationDb}.kestrel-transfer-journal`, sidecar: `${sourceDb}-wal` };
		for (const path of [paths.source, paths.destination, paths.key, paths.journal]) writeFileSync(path, "fixture", { mode: 0o600 });
		expect(fixture(sourceDb, "--witness", destinationDb, paths[target])).toEqual({ before: true, after: true, same: false });
	});
	it.each(["source", "destination", "key", "journal"])("invalidates a recovery witness when %s is replaced", target => {
		const sourceRoot = sourceProfile().root, destinationRoot = sourceProfile().root;
		const sourceDb = join(sourceRoot, "database/kestrel.sqlite"), destinationDb = join(destinationRoot, "database/kestrel.sqlite");
		const paths = { source: sourceDb, destination: destinationDb, key: join(sourceRoot, "secure/database-key.bin"), journal: `${destinationDb}.kestrel-transfer-journal` };
		for (const path of Object.values(paths)) writeFileSync(path, "fixture", { mode: 0o600 });
		expect(fixture(sourceDb, "--witness", destinationDb, paths[target], "replace")).toEqual({ before: true, after: true, same: false });
	});
	it("rejects missing required and linked recovery witness files", () => {
		const sourceRoot = sourceProfile().root, destinationRoot = sourceProfile().root;
		const sourceDb = join(sourceRoot, "database/kestrel.sqlite"), destinationDb = join(destinationRoot, "database/kestrel.sqlite");
		for (const path of [sourceDb, destinationDb, join(sourceRoot, "secure/database-key.bin")]) writeFileSync(path, "fixture", { mode: 0o600 });
		expect(fixture(sourceDb, "--witness", destinationDb, "").before).toBe(false);
		symlinkSync(sourceDb, `${destinationDb}.kestrel-transfer-journal`);
		expect(fixture(sourceDb, "--witness", destinationDb, "").before).toBe(false);
	});
	it("binds source inputs before recovery publishes a staged destination", () => {
		const sourceRoot = sourceProfile().root, destinationRoot = sourceProfile().root;
		const sourceDb = join(sourceRoot, "database/kestrel.sqlite"), destinationDb = join(destinationRoot, "database/kestrel.sqlite"), key = join(sourceRoot, "secure/database-key.bin");
		for (const path of [sourceDb, key, `${destinationDb}.kestrel-transfer-journal`]) writeFileSync(path, "fixture", { mode: 0o600 });
		expect(fixture(sourceDb, "--input-witness", destinationDb, "")).toEqual({ before: true, after: true, same: true });
		expect(fixture(sourceDb, "--input-witness", destinationDb, key)).toEqual({ before: true, after: true, same: false });
		expect(existsSync(destinationDb)).toBe(false);
	});
	it("does not overwrite a changed previous selection", () => {
		const value = profile(), child = value.child();
		value.select({ version: 1, active: child, previous: "" });
		const result = fixture(value.root, "", child, child, child);
		expect(result).toMatchObject({ saved: "unchanged", profile: join(value.root, child) });
	});
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
