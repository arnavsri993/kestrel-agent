import { describe, expect, it } from "vitest";
import { runNotaryCommand } from "./native-notary-command.mjs";

const password = "fake-app-password-123";
const args = ["notarytool", "submit", "archive.zip", "--wait", "--apple-id", "example@example.test", "--password", password, "--team-id", "TEAM"];

function exercise(result) {
	let output = "";
	let received;
	const stream = { write: text => { output += text; } };
	let value;
	let error;
	try {
		value = runNotaryCommand("/usr/bin/xcrun", args, {
			secrets: [password], stdout: stream, stderr: stream,
			spawn: (command, actualArgs, options) => {
				received = { command, args: actualArgs, options };
				return result;
			},
		});
	} catch (caught) { error = caught; }
	return { output, value, error, received };
}

describe("notary submission diagnostics", () => {
	it("redacts the password in the failed command, output, and spawn error", () => {
		const { output, error, received } = exercise({ status: null, stdout: `request ${password}\n`, stderr: `failure ${password}\n`, error: new Error(`spawn ${password}`) });
		expect(received.args).toContain(password);
		expect(received.options.stdio).toBe("pipe");
		expect(`${output}\n${error.stack}`).not.toContain(password);
		expect(error.message).toContain("Notary submission failed");
		expect(output).toContain("failure [REDACTED]");
	});

	it("redacts a nonzero submission response while preserving its diagnostic", () => {
		const { output, error } = exercise({ status: 1, stdout: "", stderr: `Rejected: invalid credential ${password}\n` });
		expect(`${output}\n${error.stack}`).not.toContain(password);
		expect(output).toContain("Rejected: invalid credential [REDACTED]");
		expect(error.message).toContain("Notary submission failed");
	});

	it("sanitizes synchronous runner exceptions", () => {
		let error;
		try {
			runNotaryCommand("/usr/bin/xcrun", args, {
				secrets: [password],
				spawn: () => { throw new Error(`runner failed with ${password}`); },
			});
		} catch (caught) { error = caught; }
		expect(error.message).toContain("runner failed with [REDACTED]");
		expect(error.stack).not.toContain(password);
	});

	it("retains useful successful diagnostics while redacting echoed credentials", () => {
		const { output, value, error } = exercise({ status: 0, stdout: `Accepted ${password}\n`, stderr: "warning: retry succeeded\n", output: [null, `Accepted ${password}\n`, "warning: retry succeeded\n"] });
		expect(error).toBeUndefined();
		expect(output).toContain("Accepted [REDACTED]");
		expect(output).toContain("warning: retry succeeded");
		expect(JSON.stringify(value)).not.toContain(password);
	});
});
