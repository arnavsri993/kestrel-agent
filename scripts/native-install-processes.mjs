import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, sep } from "node:path";

/** Refuse replacement; never quit or signal the person's running application. */
export async function assertNoRunningCanonicalKestrel(target, { readProcesses = () => spawnSync(
	"/bin/ps", ["-ww", "-ax", "-o", "pid=,comm="], { encoding: "utf8" },
) } = {}) {
	const canonical = await realpath(target).catch(error => {
		if (error.code === "ENOENT") return target;
		throw error;
	});
	const result = readProcesses();
	if (result.error || result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.trim())
		throw new Error("Cannot confirm whether the canonical Kestrel app is running. No app was replaced.");
	const running = [];
	for (const line of result.stdout.split("\n").filter(line => line.trim())) {
		const match = line.match(/^\s*([1-9][0-9]*)\s+(.+?)\s*$/);
		if (!match) throw new Error("Cannot parse the process inventory safely. No app was replaced.");
		const executable = match[2];
		const resolved = isAbsolute(executable) ? await realpath(executable).catch(() => executable) : executable;
		if ([target, canonical].some(root => resolved.startsWith(`${root}${sep}`) || executable.startsWith(`${root}${sep}`)) ||
			(!isAbsolute(executable) && /^Kestrel(?: Native Bridge| Helper(?: \(.+\))?)?$/.test(basename(executable))))
			running.push(Number(match[1]));
	}
	if (running.length) throw new Error(`Quit the canonical Kestrel app before replacing it (processes ${running.join(", ")}). No process was stopped.`);
}
