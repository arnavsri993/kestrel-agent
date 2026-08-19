const { execFileSync } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { auditPackagedMacApp } = require("../../../scripts/macos-architecture-audit.cjs");

exports.default = async function architectureAudit(context) {
	if (process.platform !== "darwin") return;
	const appPath = join(
		context.appOutDir,
		`${context.packager.appInfo.productFilename}.app`,
	);
	auditPackagedMacApp(appPath);

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
