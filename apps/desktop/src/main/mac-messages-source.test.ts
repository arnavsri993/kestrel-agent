import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MacMessagesSource } from "./mac-messages-source";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Mac Messages source", () => {
	it("reports that the local source is macOS-only", () => {
		const source = new MacMessagesSource({
			platform: "linux",
			databasePath: "/tmp/not-used/chat.db",
		});
		expect(source.status()).toMatchObject({
			id: "mac-messages",
			state: "unavailable",
		});
	});

	it("scans recent message rows and returns only code candidates", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-messages-"));
		roots.push(root);
		const databasePath = join(root, "chat.db");
		writeFileSync(databasePath, "fixture");
		const source = new MacMessagesSource({
			platform: "darwin",
			databasePath,
			now: () => new Date("2026-08-17T12:00:00.000Z"),
			runQuery: async (_file, args) => {
				expect(args).toContain("-readonly");
				expect(args).toContain(databasePath);
				return {
					stdout: JSON.stringify([
						{
							text: "Your verification code is 481902. Do not share it.",
							subject: "Sign in",
							sender: "+15551234567",
							date: (Date.parse("2026-08-17T11:59:00.000Z") - 978_307_200_000) * 1_000_000,
						},
					]),
					stderr: "",
				};
			},
		});

		const result = await source.searchLoginCodes();
		expect(result.status.state).toBe("connected");
		expect(result.matches).toMatchObject([
			{
				sourceId: "mac-messages",
				code: "481902",
				sender: "+15551234567",
				subject: "Sign in",
			},
		]);
		expect(JSON.stringify(result.matches)).not.toContain("Do not share it");
	});
	it.skipIf(process.platform !== "darwin")("queries a real generated SQLite fixture with an Apple-epoch recent window", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-messages-sqlite-")); roots.push(root);
		const databasePath = join(root, "generated-chat.db");
		const now = new Date("2026-08-17T12:00:00.000Z");
		const apple = (value: number) => (BigInt(value - 978_307_200_000) * 1_000_000n).toString();
		const recent = apple(now.getTime() - 60_000), old = apple(now.getTime() - 31 * 60_000), future = apple(now.getTime() + 60_000);
		execFileSync("/usr/bin/sqlite3", [databasePath, `
			CREATE TABLE handle(id TEXT); INSERT INTO handle(rowid,id) VALUES(1,'generated-sender');
			CREATE TABLE message(text TEXT, subject TEXT, handle_id INTEGER, date INTEGER, attributedBody BLOB);
			INSERT INTO message VALUES('Your login code is 481902','Generated login',1,${recent},NULL);
			INSERT INTO message VALUES('Your login code is 999991',NULL,1,${old},NULL);
			INSERT INTO message VALUES('Your login code is 999992',NULL,1,${future},NULL);
			INSERT INTO message VALUES('Your login code is 999993',NULL,1,'malformed',NULL);
			INSERT INTO message VALUES(NULL,NULL,1,${recent},x'010203');
		`], { timeout: 5_000, stdio: "pipe" });
		const source = new MacMessagesSource({ platform: "darwin", databasePath, now: () => now });
		expect(source.status().detail).toMatch(/appears readable/i);
		const result = await source.searchLoginCodes();
		expect(result.status).toMatchObject({ state: "connected", detail: expect.stringMatching(/attributed-body-only.*not supported/i) });
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]).toMatchObject({ code: "481902", sender: "generated-sender", receivedAt: "2026-08-17T11:59:00.000Z" });
	});

	 it.skipIf(process.platform !== "darwin")("bounds real SQLite rows and returned candidates", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-messages-cap-")); roots.push(root);
		const databasePath = join(root, "generated-chat.db"), now = new Date("2026-08-17T12:00:00.000Z");
		const date = (BigInt(now.getTime() - 60_000 - 978_307_200_000) * 1_000_000n).toString();
		execFileSync("/usr/bin/sqlite3", [databasePath, `CREATE TABLE handle(id TEXT); CREATE TABLE message(text TEXT,subject TEXT,handle_id INTEGER,date INTEGER);
			WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<120)
			INSERT INTO message SELECT 'Your login code is 481902', NULL, NULL, ${date} FROM n;`], { timeout: 5_000, stdio: "pipe" });
		let rowCount = 0;
		const source = new MacMessagesSource({ platform: "darwin", databasePath, now: () => now, runQuery: async (file, args) => {
			expect(args).toContain("-readonly");
			const stdout = execFileSync(file, [...args], { encoding: "utf8", timeout: 5_000, maxBuffer: 2_000_000 });
			rowCount = JSON.parse(stdout).length; return { stdout, stderr: "" };
		} });
		const result = await source.searchLoginCodes();
		expect(rowCount).toBe(100); expect(result.matches).toHaveLength(5);
	 });

	it("rejects future and stale rows even when a query provider returns them", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-messages-bounds-")); roots.push(root);
		const databasePath = join(root, "chat.db"); writeFileSync(databasePath, "fixture");
		const now = new Date("2026-08-17T12:00:00.000Z");
		const apple = (offset: number) => (now.getTime() + offset - 978_307_200_000) * 1_000_000;
		const source = new MacMessagesSource({ platform: "darwin", databasePath, now: () => now, runQuery: async () => ({
			stdout: JSON.stringify([{ text: "Your login code is 999991", date: apple(60_000) },
				{ text: "Your login code is 999992", date: apple(-31 * 60_000) },
				{ text: "Your login code is 481902", date: apple(-60_000) }]), stderr: "" }),
		});
		expect((await source.searchLoginCodes()).matches.map(match => match.code)).toEqual(["481902"]);
	});

	it("returns a truthful empty result and static errors without exposing helper output", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-messages-errors-")); roots.push(root);
		const databasePath = join(root, "chat.db"); writeFileSync(databasePath, "fixture");
		const now = () => new Date("2026-08-17T12:00:00.000Z");
		const empty = new MacMessagesSource({ platform: "darwin", databasePath, now, runQuery: async () => ({ stdout: "", stderr: "" }) });
		expect(await empty.searchLoginCodes()).toMatchObject({ matches: [], status: { state: "connected" } });
		for (const runQuery of [async () => { throw new Error("operation not permitted sensitive generated code 481902"); },
			async () => ({ stdout: "x".repeat(2_000_001), stderr: "generated secret" })]) {
			const source = new MacMessagesSource({ platform: "darwin", databasePath, now, runQuery });
			const result = await source.searchLoginCodes();
			expect(result.matches).toEqual([]);
			expect(["needs_permission", "unavailable"]).toContain(result.status.state);
			expect(JSON.stringify(result)).not.toMatch(/481902|generated secret/);
		}
	});

	it.skipIf(process.platform !== "darwin")("cancels an actual sqlite3 lookup on a generated database", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-messages-cancel-")); roots.push(root);
		const databasePath = join(root, "generated-chat.db");
		execFileSync("/usr/bin/sqlite3", [databasePath, "CREATE TABLE handle(id TEXT); CREATE TABLE message(text TEXT,subject TEXT,handle_id INTEGER,date INTEGER);"], { timeout: 5_000, stdio: "pipe" });
		const source = new MacMessagesSource({ platform: "darwin", databasePath, now: () => new Date("2026-08-17T12:00:00.000Z") });
		const controller = new AbortController(); const pending = source.searchLoginCodes(controller.signal); controller.abort();
		expect(await pending).toMatchObject({ matches: [], status: { state: "unavailable", detail: "Messages lookup was cancelled." } });
	});
	it("propagates cancellation and drops results from a late query", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-messages-cancel-late-")); roots.push(root);
		const databasePath = join(root, "generated-chat.db"); writeFileSync(databasePath, "fixture");
		let finish!: (result: { stdout: string; stderr: string }) => void;
		const controller = new AbortController();
		const source = new MacMessagesSource({ platform: "darwin", databasePath, now: () => new Date("2026-08-17T12:00:00.000Z"),
			runQuery: async (_file, _args, signal) => { expect(signal).toBe(controller.signal); return new Promise(resolve => { finish = resolve; }); } });
		const pending = source.searchLoginCodes(controller.signal); controller.abort();
		finish({ stdout: JSON.stringify([{ text: "Your login code is 481902", date: (Date.parse("2026-08-17T11:59:00.000Z") - 978_307_200_000) * 1_000_000 }]), stderr: "" });
		expect(await pending).toMatchObject({ matches: [], status: { state: "unavailable", detail: "Messages lookup was cancelled." } });
	});

});
