const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function architectureAudit(context) {
	if (process.platform !== "darwin") return;
	const appPath = join(
		context.appOutDir,
		`${context.packager.appInfo.productFilename}.app`,
	);
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
	walk(join(appPath, "Contents"));
	for (const binary of binaries) {
		try {
			execFileSync("lipo", ["-info", binary], { stdio: "pipe" });
		} catch {
			/* Non-Mach-O executable resources are checked by their own adapter. */
		}
	}

	const lsregister =
		"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	const noindexFile = join(context.outDir, ".metadata_never_index");
	if (!existsSync(noindexFile)) {
		try {
			writeFileSync(noindexFile, "");
		} catch {
			/* Best effort Spotlight indexing exclusion */
		}
	}
	if (existsSync(lsregister)) {
		try {
			execFileSync(lsregister, ["-u", appPath], { stdio: "ignore" });
		} catch {
			/* Best effort LaunchServices unregister */
		}
	}
};
