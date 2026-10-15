import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseLatestMac } from "./release-distribution-verifier.mjs";
import {
	renderLatestMacYml,
	writeNativeLatestMac,
} from "./write-native-latest-mac.mjs";

const temporaryRoots = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("native latest-mac.yml writer", () => {
	it("renders a feed accepted by the release-distribution verifier", () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-native-latest-mac-"));
		temporaryRoots.push(root);
		const version = "1.2.3";
		const dmgPath = join(root, `Kestrel-Apple-Silicon-${version}.dmg`);
		const zipPath = join(root, `Kestrel-Apple-Silicon-${version}.zip`);
		writeFileSync(dmgPath, "dmg-bytes");
		writeFileSync(zipPath, "zip-bytes-here");
		const releaseDate = "2026-10-15T12:00:00.000Z";
		const body = renderLatestMacYml({
			version,
			dmgPath,
			zipPath,
			releaseDate,
		});
		const parsed = parseLatestMac(body);
		expect(parsed.version).toBe(version);
		expect(parsed.path).toBe(`Kestrel-Apple-Silicon-${version}.zip`);
		expect(parsed.releaseDate).toBe(releaseDate);
		expect(parsed.files).toHaveLength(2);
		expect(parsed.sha512).toBe(
			createHash("sha512").update("zip-bytes-here").digest("base64"),
		);

		const out = writeNativeLatestMac({
			releaseRoot: root,
			version,
			releaseDate,
		});
		expect(out).toBe(join(root, "latest-mac.yml"));
		expect(readFileSync(out, "utf8")).toBe(body);
	});
});
