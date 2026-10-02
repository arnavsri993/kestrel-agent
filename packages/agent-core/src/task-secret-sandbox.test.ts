import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxedCommandRunner } from "./command-runner";

describe("real temporary credential sandbox", () => {
	it.skipIf(process.platform !== "darwin")("delivers only the selected environment and denies descendants without disclosing output", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-secret-sandbox-")));
		const key = "fixture-real-sandbox-sensitive-123456";
		const program = `const fs=require('node:fs'); const crypto=require('node:crypto');
const child=require('node:child_process').spawnSync(process.execPath,['-e','process.exit(0)']);
fs.writeFileSync('proof.json',JSON.stringify({digest:crypto.createHash('sha256').update(process.env.SERVICE_API_KEY).digest('hex'),descendantDenied:!!child.error,childError:child.error?.code}));
console.log(process.env.SERVICE_API_KEY); console.error(Buffer.from(process.env.SERVICE_API_KEY).toString('base64'));`;
		const progress: unknown[] = [];
		try {
			const result = await new SandboxedCommandRunner().run({ command: "node", args: ["-e", program], cwd: root,
				workspaceRoot: root, mode: "workspace_write", timeoutMs: 5_000, environment: { SERVICE_API_KEY: key }, protectSecrets: true },
				{ signal: AbortSignal.timeout(10_000), onProgress: event => progress.push(event) });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
			expect(progress).toEqual([]);
			const proof = JSON.parse(readFileSync(join(root, "proof.json"), "utf8"));
			expect(proof.digest).toBe(createHash("sha256").update(key).digest("hex"));
			expect(proof.descendantDenied).toBe(true);
			expect(["EPERM", "EACCES"]).toContain(proof.childError);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
