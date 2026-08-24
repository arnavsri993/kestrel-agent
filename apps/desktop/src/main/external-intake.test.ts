import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	externalPayloadIdFromDeepLink,
	filePathsFromArgv,
	parseExternalServicePayload,
} from "./external-intake";

describe("external macOS intake payloads", () => {
	it("recognizes only bounded cold-start Ask Kestrel links", () => {
		const id = "00000000-0000-0000-0000-000000000000";
		expect(externalPayloadIdFromDeepLink(`kestrel://ask?payload=${id}`)).toBe(id);
		expect(externalPayloadIdFromDeepLink("kestrel://settings")).toBeUndefined();
		expect(
			externalPayloadIdFromDeepLink(`kestrel://ask/path?payload=${id}`),
		).toBeUndefined();
		expect(
			externalPayloadIdFromDeepLink("kestrel://ask?payload=../../etc/passwd"),
		).toBeUndefined();
	});

	it("accepts text-only Services requests", () => {
		expect(
			parseExternalServicePayload({
				kind: "ask",
				paths: [],
				text: "Explain this selected passage.",
			}),
		).toEqual({
			kind: "ask",
			paths: [],
			text: "Explain this selected passage.",
		});
	});

	it("accepts bounded multi-file requests and rejects empty input", () => {
		expect(
			parseExternalServicePayload({
				kind: "ask",
				paths: ["/tmp/one.pdf", "/tmp/two.png"],
			}),
		).toEqual({
			kind: "ask",
			paths: ["/tmp/one.pdf", "/tmp/two.png"],
		});
		expect(
			parseExternalServicePayload({ kind: "ask", paths: [], text: "  " }),
		).toBeUndefined();
		expect(
			parseExternalServicePayload({
				kind: "ask",
				paths: Array.from({ length: 9 }, (_, index) => `/tmp/${index}`),
			}),
		).toBeUndefined();
	});

	it("bounds selected text before it reaches the renderer", () => {
		const text = "x".repeat(20_001);
		expect(
			parseExternalServicePayload({ kind: "ask", paths: [], text }),
		).toBeUndefined();
	});

	it("does not treat Electron's development entrypoint as a user-opened file", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-intake-argv-"));
		const entrypoint = join(root, "index.js");
		const userFile = join(root, "notes.txt");
		writeFileSync(entrypoint, "export {};\n");
		writeFileSync(userFile, "Review these notes.\n");
		try {
			expect(
				filePathsFromArgv(["/Applications/Electron", entrypoint, userFile], {
					defaultApp: true,
					executablePath: "/Applications/Electron",
				}),
			).toEqual([userFile]);
			expect(
				filePathsFromArgv(["/Applications/Kestrel", userFile], {
					defaultApp: false,
					executablePath: "/Applications/Kestrel",
				}),
			).toEqual([userFile]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
