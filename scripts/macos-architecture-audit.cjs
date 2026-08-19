const { execFileSync } = require("node:child_process");
const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const ALLOWED_ARCHITECTURE = "arm64";
const MAXIMUM_MINOS = [13, 0, 0];

function parseLipoArchitectures(output) {
	const fat = output.match(/are:\s*(.+)\s*$/m);
	const thin = output.match(/architecture:\s+(\S+)/);
	const listed = (fat ? fat[1] : thin ? thin[1] : "").trim();
	return listed.split(/\s+/).filter(Boolean);
}

function parseMinos(output) {
	const match = output.match(/\bminos\s+(\d+(?:\.\d+)*)/);
	if (!match) return null;
	return match[1].split(".").map((part) => Number(part));
}

function minosExceedsLimit(minos, limit = MAXIMUM_MINOS) {
	for (let index = 0; index < Math.max(minos.length, limit.length); index += 1) {
		const actual = minos[index] ?? 0;
		const allowed = limit[index] ?? 0;
		if (actual > allowed) return true;
		if (actual < allowed) return false;
	}
	return false;
}

function collectPackagedBinaries(root) {
	const binaries = [];
	function walk(path) {
		for (const name of readdirSync(path)) {
			const item = join(path, name);
			const stat = statSync(item);
			if (stat.isDirectory()) walk(item);
			else if (
				stat.mode & 0o111 ||
				item.endsWith(".node") ||
				item.endsWith(".dylib")
			)
				binaries.push(item);
		}
	}
	walk(root);
	return binaries;
}

function inspectMachO(binary) {
	let lipoOutput;
	try {
		lipoOutput = execFileSync("lipo", ["-info", binary], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return null;
	}
	const architectures = parseLipoArchitectures(lipoOutput);
	let minos = null;
	try {
		const vtoolOutput = execFileSync("vtool", ["-show-build", binary], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		minos = parseMinos(vtoolOutput);
	} catch {
		minos = null;
	}
	return { architectures, minos };
}

function auditPackagedMacApp(appPath) {
	const binaries = collectPackagedBinaries(join(appPath, "Contents"));
	for (const binary of binaries) {
		const inspected = inspectMachO(binary);
		if (!inspected) continue;
		const { architectures, minos } = inspected;
		if (
			architectures.length !== 1 ||
			architectures[0] !== ALLOWED_ARCHITECTURE
		) {
			throw new Error(
				`${binary} must be ${ALLOWED_ARCHITECTURE}-only; lipo reported ${architectures.join(", ") || "(none)"}.`,
			);
		}
		if (minos && minosExceedsLimit(minos)) {
			throw new Error(
				`${binary} requires macOS ${minos.join(".")}; packaged binaries must run on macOS ${MAXIMUM_MINOS.join(".")} Apple Silicon.`,
			);
		}
	}
}

module.exports = {
	ALLOWED_ARCHITECTURE,
	MAXIMUM_MINOS,
	parseLipoArchitectures,
	parseMinos,
	minosExceedsLimit,
	auditPackagedMacApp,
};
