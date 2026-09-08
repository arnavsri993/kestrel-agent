import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditSettingsParity } from "./audit-settings-parity.mjs";

const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function temporaryMatrix() {
	const directory = mkdtempSync(join(tmpdir(), "kestrel-settings-audit-"));
	temporaryDirectories.push(directory);
	return join(directory, "matrix.json");
}

function readMatrix() {
	return JSON.parse(
		readFileSync(new URL("../docs/settings-parity-matrix.json", import.meta.url), "utf8"),
	);
}

describe("settings parity audit", () => {
	it("accepts the checked-in catalog and complete ledger", () => {
		const result = auditSettingsParity();
		expect(result.errors).toEqual([]);
		expect(result.entries).toBeGreaterThanOrEqual(120);
		expect(result.catalogSettings).toBe(46);
	});

	it("rejects duplicate and unmapped ledger entries", () => {
		const matrix = readMatrix();
		matrix.entries.push({ ...matrix.entries[0] });
		delete matrix.entries[1].catalogEntryId;
		const path = temporaryMatrix();
		writeFileSync(path, `${JSON.stringify(matrix)}\n`);

		const result = auditSettingsParity({ matrixPath: path });
		expect(result.errors).toEqual(
			expect.arrayContaining([
				`duplicate entry id: ${matrix.entries[0].id}`,
				`duplicate product/reference pair: ${matrix.entries[0].product}:${matrix.entries[0].referenceId}`,
				`${matrix.entries[1].id} is unmapped: catalogEntryId is missing or unknown`,
			]),
		);
		expect(result.errors.join("\n")).toMatch(/unknown|unmapped/);
	});
});
