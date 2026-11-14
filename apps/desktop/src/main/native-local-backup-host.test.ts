import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RendererResponse } from "@kestrel/shared-types";
import { NativeLocalBackupHost, NATIVE_LOCAL_BACKUP_REQUEST_TYPES, type NativeLocalBackupHostOptions } from "./native-local-backup-host";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

const roots: string[] = [];
const hosts: NativeLocalBackupHost[] = [];
async function fixture(overrides: Partial<NativeLocalBackupHostOptions> = {}) {
	const base = await mkdtemp(join(tmpdir(), "native-local-backup-host-"));
	roots.push(base);
	const root = join(base, "core-data");
	const destination = join(base, "backups");
	const browserProfile = join(base, "browser-profile");
	await mkdir(root, { mode: 0o700 });
	await mkdir(destination, { mode: 0o700 });
	await mkdir(browserProfile, { mode: 0o700 });
	await mkdir(join(root, "database"), { mode: 0o700 });
	await writeFile(join(root, "database", "kestrel.sqlite"), "fixture-database", { mode: 0o600 });
	await mkdir(join(root, "secure"), { mode: 0o755 });
	await mkdir(join(root, "secure", "credentials"), { mode: 0o700 });
	await writeFile(join(root, "secure", "credentials", "fixture.bin"), "fixture-secure-data", { mode: 0o600 });
	await writeFile(join(root, "secure", "database-key.bin"), "excluded-database-key", { mode: 0o600 });
	await writeFile(join(root, "secure", "credentials.master"), "excluded-master-key", { mode: 0o600 });
	await mkdir(join(root, "vendor-cache"), { mode: 0o700 });
	await writeFile(join(root, "vendor-cache", "model.bin"), "excluded-model", { mode: 0o600 });
	await mkdir(join(root, "browser"), { mode: 0o700 });
	await writeFile(join(root, "browser", "cookies.sqlite"), "excluded-cookies", { mode: 0o600 });
	await mkdir(join(root, "projects"), { mode: 0o700 });
	await writeFile(join(root, "projects", "workspace.txt"), "excluded-workspace", { mode: 0o600 });
	const keyBase64 = randomBytes(32).toString("base64");
	const selectDestination = vi.fn(async (_signal: AbortSignal): Promise<string | null> => destination);
	const publishDirectory: NativeLocalBackupHostOptions["publishDirectory"] = async (stage, final, identity) => {
		const [parent, staged] = await Promise.all([lstat(destination, { bigint: true }), lstat(stage, { bigint: true })]);
		expect(parent.dev.toString()).toBe(identity.parentDev);
		expect(parent.ino.toString()).toBe(identity.parentIno);
		expect(staged.dev.toString()).toBe(identity.stagingDev);
		expect(staged.ino.toString()).toBe(identity.stagingIno);
		await rename(stage, final);
	};
	const revealDirectory = vi.fn(async (_path: string, _signal: AbortSignal) => {});
	const withStoppedCore = vi.fn(async (operation: () => Promise<unknown>) => ({
		completed: true,
		value: await operation(),
		coreStatus: "ready",
	})) as unknown as NativeLocalBackupHostOptions["withStoppedCore"];
	const options: NativeLocalBackupHostOptions = {
		root,
		forbiddenDestinationRoots: [browserProfile],
		appVersion: "1.2.3-host-test",
		encryptionKeyBase64: keyBase64,
		selectDestination,
		publishDirectory,
		revealDirectory,
		withStoppedCore,
		...overrides,
	};
	const host = new NativeLocalBackupHost(options);
	hosts.push(host);
	return { base, root, destination, browserProfile, keyBase64, options, selectDestination: options.selectDestination, publishDirectory: options.publishDirectory, revealDirectory, withStoppedCore, host };
}

const create = { type: "create-local-backup" } as const;
afterEach(async () => {
	await Promise.all(hosts.splice(0).map(host => host.close()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("NativeLocalBackupHost", () => {
	it("creates only the selected Core data snapshot and returns metadata without paths or keys", async () => {
		const f = await fixture();
		expect(await f.host.status()).toEqual({ verified: false });
		expect([...NATIVE_LOCAL_BACKUP_REQUEST_TYPES].sort()).toEqual(["create-local-backup", "reveal-created-local-backup"]);
		const response = await f.host.handle(create);
		expect(response.ok).toBe(true);
		if (!response.ok || !("localBackupCreated" in response)) throw new Error("missing local backup result");
		const result = response.localBackupCreated;
		expect(result).toMatchObject({ files: 2, verified: true, scope: "native-core-data", coreStatus: "ready" });
		expect(result.backupId).toMatch(/^[0-9a-f-]{36}$/i);
		const backupPath = join(f.destination, (await readdir(f.destination))[0]!);
		expect(await readFile(join(backupPath, "database", "kestrel.sqlite"), "utf8")).toBe("fixture-database");
		expect(await readFile(join(backupPath, "secure", "credentials", "fixture.bin"), "utf8")).toBe("fixture-secure-data");
		expect(await readdir(join(backupPath, "secure"))).toEqual(["credentials"]);
		expect(await readdir(backupPath)).toEqual(["database", "kestrel-native-core-backup.json", "secure"]);
		const rendererJson = JSON.stringify(response);
		expect(rendererJson).not.toContain(f.root);
		expect(rendererJson).not.toContain(f.destination);
		expect(rendererJson).not.toContain(f.keyBase64);
		expect(rendererJson).not.toContain("fixture-database");
		const receiptText = await readFile(join(f.root, ".native-backup-receipts", `${result.backupId}.json`), "utf8");
		expect(receiptText).not.toContain(f.destination);
		expect(receiptText).not.toContain(f.keyBase64);
		expect(receiptText).not.toContain("fixture-database");
		expect(f.withStoppedCore).toHaveBeenCalledTimes(1);
		expect(await f.host.status()).toMatchObject({ verified: true, createdAt: result.createdAt });
		await rename(backupPath, `${backupPath}-moved`);
		expect(await f.host.status()).toEqual({ verified: false });
	});

	it("reserves admission before injected callbacks and returns static busy, duplicate, and closed results", async () => {
		const gate = deferred<string | null>();
		const f = await fixture({ selectDestination: vi.fn(() => gate.promise) });
		const active = f.host.handle(create);
		expect(await f.host.handle(create)).toEqual({ ok: false, error: "Another native local backup operation is already in progress." });
		expect(f.withStoppedCore).not.toHaveBeenCalled();
		gate.resolve(null);
		expect(await active).toEqual({ ok: true, cancelled: true });

		const busy = await fixture({ isBusy: () => true });
		expect(await busy.host.handle(create)).toEqual({ ok: false, error: "Core is busy. Try again when its current operation is complete." });
		expect(busy.selectDestination).not.toHaveBeenCalled();

		await f.host.close();
		expect(await f.host.handle(create)).toEqual({ ok: false, error: "Native local backup is closed." });
		expect(await f.host.status()).toEqual({ verified: false });
		expect((f.host as unknown as { key: Buffer }).key.every(value => value === 0)).toBe(true);
	});

	it("strictly validates request shape and treats destination cancellation without stopping Core", async () => {
		const f = await fixture({ selectDestination: vi.fn(async () => null) });
		for (const raw of [null, {}, { ...create, path: "/tmp/injected" }, { type: "reveal-created-local-backup", backupId: "../path" }, { type: "reveal-local-backup", path: "/tmp/user-path" }]) {
			expect(await f.host.handle(raw)).toEqual({ ok: false, error: "Invalid native local backup request." });
		}
		expect(f.selectDestination).not.toHaveBeenCalled();
		expect(await f.host.handle(create)).toEqual({ ok: true, cancelled: true });
		expect(f.withStoppedCore).not.toHaveBeenCalled();
	});

	it("does not start backup if Core stop fails and sanitizes its error", async () => {
		const f = await fixture({
			withStoppedCore: vi.fn(async () => ({ completed: false as const, error: `/private/secret ${fKeyPlaceholder}`, coreStatus: "restart-required" as const })),
		});
		const response = await f.host.handle(create);
		expect(response).toEqual({ ok: false, error: "Core restart is required. No backup was created." });
		expect(JSON.stringify(response)).not.toContain(f.keyBase64);
		expect(await readdir(f.destination)).toEqual([]);
	});

	it("reports a committed backup even if restart fails or cancellation arrives late", async () => {
		const controller = new AbortController();
		const f = await fixture({
			publishDirectory: async (stage, final) => { await rename(stage, final); controller.abort(); },
			withStoppedCore: vi.fn(async <T>(operation: () => Promise<T>, { signal }: { signal: AbortSignal }) => {
				const value = await operation();
				return signal.aborted
					? { completed: false as const, error: "restart failed", coreStatus: "restart-required" as const }
					: { completed: true as const, value, coreStatus: "ready" as const };
			}) as unknown as NativeLocalBackupHostOptions["withStoppedCore"],
		});
		const response = await f.host.handle(create, controller.signal);
		expect(response.ok).toBe(true);
		if (!response.ok || !("localBackupCreated" in response)) throw new Error("committed backup completion was lost");
		expect(response.localBackupCreated.coreStatus).toBe("restart-required");
		expect(await f.host.handle({ type: "reveal-created-local-backup", backupId: response.localBackupCreated.backupId })).toEqual({ ok: true });
	});

	it("opens persisted receipts after restart and rejects forged or replaced backup locations", async () => {
		const f = await fixture();
		const created = await f.host.handle(create);
		if (!created.ok || !("localBackupCreated" in created)) throw new Error("missing local backup result");
		const backupId = created.localBackupCreated.backupId;
		await f.host.close();
		const reopened = new NativeLocalBackupHost(f.options);
		hosts.push(reopened);
		expect(await reopened.handle({ type: "reveal-created-local-backup", backupId })).toEqual({ ok: true });
		expect(f.revealDirectory).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Kestrel-Native-Core-"), expect.any(AbortSignal));
		expect(await reopened.handle({ type: "reveal-created-local-backup", backupId: randomUUID() })).toEqual({ ok: false, error: "The backup receipt is unavailable or no longer matches the saved backup." });
		const revealCount = f.revealDirectory.mock.calls.length;
		const final = f.revealDirectory.mock.calls[0]?.[0];
		if (!final) throw new Error("missing reveal path fixture");
		const displaced = `${final}.saved-fixture`;
		await rename(final, displaced);
		await symlink(displaced, final);
		expect(await reopened.handle({ type: "reveal-created-local-backup", backupId })).toEqual({ ok: false, error: "The backup receipt is unavailable or no longer matches the saved backup." });
		expect(f.revealDirectory).toHaveBeenCalledTimes(revealCount);
	});

	it("keeps the in-memory receipt usable when optional persistence is unavailable", async () => {
		const f = await fixture();
		await writeFile(join(f.root, ".native-backup-receipts"), "blocker", { mode: 0o600 });
		const created = await f.host.handle(create);
		if (!created.ok || !("localBackupCreated" in created)) throw new Error("backup completion should survive receipt persistence failure");
		expect(await f.host.handle({ type: "reveal-created-local-backup", backupId: created.localBackupCreated.backupId })).toEqual({ ok: true });
	});

	it("surfaces committed-but-sync-uncertain separately and preserves published files", async () => {
		const f = await fixture({
			publishDirectory: async (stage, final) => {
				await rename(stage, final);
				throw Object.assign(new Error(`/private ${fKeyPlaceholder}`), { code: "KESTREL_BACKUP_COMMITTED_SYNC_UNCERTAIN" });
			},
		});
		const response = await f.host.handle(create);
		expect(response).toEqual({ ok: false, error: "Backup files were published, but disk sync is unconfirmed; the files were preserved." });
		expect(JSON.stringify(response)).not.toContain(f.root);
		expect((await readdir(f.destination)).some(name => name.startsWith("Kestrel-Native-Core-"))).toBe(true);
	});

	it("cancels and awaits an active panel before zeroing its private key", async () => {
		const picker = vi.fn((signal: AbortSignal) => new Promise<string | null>(resolve => signal.addEventListener("abort", () => resolve(null), { once: true })));
		const f = await fixture({
			selectDestination: picker,
		});
		const active = f.host.handle(create);
		await vi.waitFor(() => expect(picker).toHaveBeenCalledOnce());
		const closing = f.host.close();
		const closingAgain = f.host.close();
		expect(closingAgain).toBe(closing);
		await closing;
		expect(await active).toEqual({ ok: true, cancelled: true });
		expect((f.host as unknown as { key: Buffer }).key.every(value => value === 0)).toBe(true);
		expect(await readdir(f.destination)).toEqual([]);
	});

	it("keeps only explicit, bounded native entry names in its backup contract", async () => {
		const f = await fixture();
		const created = await f.host.handle(create);
		expect(created.ok).toBe(true);
		const backupPath = join(f.destination, (await readdir(f.destination))[0]!);
		const manifest = JSON.parse(await readFile(join(backupPath, "kestrel-native-core-backup.json"), "utf8"));
		expect(manifest.files.map((file: { path: string }) => file.path).sort()).toEqual(["database/kestrel.sqlite", "secure/credentials/fixture.bin"]);
	});
});

const fKeyPlaceholder = "never-a-real-key";
