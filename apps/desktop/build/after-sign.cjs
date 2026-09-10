const { join } = require("node:path");
const { verifyAgentCoreSidecar } = require("./agent-core-sidecar.cjs");

exports.default = async function verifySignedAgentCoreSidecar(context) {
	if (process.platform !== "darwin") return;
	const appPath = join(
		context.appOutDir,
		`${context.packager.appInfo.productFilename}.app`,
	);
	// The app-level signature is not enough evidence for a runtime that executes
	// from Resources. Verify the standalone Node executable itself after the
	// final signer has processed the bundle.
	verifyAgentCoreSidecar(appPath, { verifySignature: true });
};
