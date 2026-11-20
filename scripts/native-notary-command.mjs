import { spawnSync } from "node:child_process";

// Capture sensitive commands so even a tool that echoes its arguments cannot
// write a credential directly to the terminal.
export function runNotaryCommand(command, args, {
	spawn = spawnSync,
	secrets = [],
	stdout = process.stdout,
	stderr = process.stderr,
} = {}) {
	const redact = value => secrets.filter(Boolean).reduce(
		(text, secret) => text.split(secret).join("[REDACTED]"),
		String(value ?? ""),
	);
	let result;
	try {
		result = spawn(command, args, { stdio: "pipe", encoding: "utf8", env: process.env });
	} catch (error) {
		throw new Error(`Notary submission failed: ${redact(error?.message ?? error)}.`);
	}
	const safeStdout = redact(result.stdout);
	const safeStderr = redact(result.stderr);
	if (safeStdout) stdout.write(safeStdout);
	if (safeStderr) stderr.write(safeStderr);
	if (result.status !== 0) {
		const reason = result.error ? `: ${redact(result.error.message)}` : result.signal ? ` (signal ${redact(result.signal)})` : "";
		throw new Error(`Notary submission failed${reason}.`);
	}
	return { pid: result.pid, status: result.status, signal: result.signal, stdout: safeStdout, stderr: safeStderr };
}
