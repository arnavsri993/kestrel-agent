import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
							date: 800000000000000000,
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
});
