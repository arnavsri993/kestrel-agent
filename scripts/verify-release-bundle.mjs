import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { resolveReleaseVersion } from "./create-release-manifest.mjs";
import { verifyLocalReleaseBundle } from "./release-distribution-verifier.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const desktopPackage = JSON.parse(
	await readFile(
		resolve(repositoryRoot, "apps", "desktop", "package.json"),
		"utf8",
	),
);
const version = resolveReleaseVersion(
	desktopPackage.version,
	process.env.GITHUB_REF_NAME,
);
const releaseDirectory = resolve(process.argv[2] ?? "release");

const result = await verifyLocalReleaseBundle({
	releaseDirectory,
	version,
	expectedCommit: process.env.GITHUB_SHA ?? "",
	metadataName: process.env.KESTREL_UPDATE_METADATA ?? "latest-mac.yml",
});
console.log(
	`Verified ${result.artifacts.length} Kestrel ${result.version} artifacts from ${result.commit}.`,
);
