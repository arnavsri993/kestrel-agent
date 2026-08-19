import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listWorkspaceFiles } from "./workspace-file-search";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("listWorkspaceFiles", () => {
	it("returns granted files and skips dependency trees", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-workspace-files-"));
		directories.push(root);
		writeFileSync(join(root, "README.md"), "hello");
		mkdirSync(join(root, "node_modules"));
		writeFileSync(join(root, "node_modules", "secret.js"), "nope");
		const files = await listWorkspaceFiles({
			workspaceRoot: root,
			query: "read",
			mediaTypeForPath: () => "text/markdown",
		});
		expect(files.map((file) => file.name)).toEqual(["README.md"]);
	});
});
