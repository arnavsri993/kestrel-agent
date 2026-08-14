import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const supportedExtensions = new Set([".dmg", ".zip", ".pkg"]);
const packageVersionPattern =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const commitPattern = /^[a-f0-9]{40}$/;

export function resolveReleaseVersion(packageVersion, githubRefName) {
	if (
		typeof packageVersion !== "string" ||
		!packageVersionPattern.test(packageVersion)
	) {
		throw new Error(
			`Invalid desktop package version: ${String(packageVersion)}`,
		);
	}
	if (
		githubRefName?.startsWith("v") &&
		githubRefName !== `v${packageVersion}`
	) {
		throw new Error(
			`Release tag ${githubRefName} does not match desktop package version ${packageVersion}.`,
		);
	}
	return packageVersion;
}

export function resolveReleaseCommit(githubSha) {
	if (typeof githubSha !== "string" || !commitPattern.test(githubSha)) {
		throw new Error(
			"GITHUB_SHA must be a full lowercase Git commit SHA for a release manifest.",
		);
	}
	return githubSha;
}

export function createReleaseManifest({
	root = resolve("release"),
	desktopPackagePath = resolve(
		repositoryRoot,
		"apps",
		"desktop",
		"package.json",
	),
	environment = process.env,
} = {}) {
	const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
	const version = resolveReleaseVersion(
		desktopPackage.version,
		environment.GITHUB_REF_NAME,
	);
	const commit = resolveReleaseCommit(environment.GITHUB_SHA);
	const artifacts = readdirSync(root)
		.map((name) => join(root, name))
		.filter(
			(path) =>
				statSync(path).isFile() &&
				supportedExtensions.has(extname(path).toLowerCase()),
		)
		.sort();
	if (artifacts.length === 0)
		throw new Error("No DMG, ZIP, or PKG release artifacts were found.");

	const records = artifacts.map((path) => {
		const filename = basename(path);
		const extension = extname(filename).toLowerCase();
		const expectedFilename = `Kestrel-Apple-Silicon-${version}${extension}`;
		if (filename !== expectedFilename) {
			throw new Error(
				`Release artifact ${filename} does not match desktop package version ${version}.`,
			);
		}
		const artifact = readFileSync(path);
		return {
			filename,
			bytes: artifact.byteLength,
			sha256: createHash("sha256").update(artifact).digest("hex"),
			sha512: createHash("sha512").update(artifact).digest("base64"),
		};
	});
	const expectedFilenames = [...supportedExtensions]
		.map((extension) => `Kestrel-Apple-Silicon-${version}${extension}`)
		.sort();
	if (
		records.length !== expectedFilenames.length ||
		records.some(
			(record, index) => record.filename !== expectedFilenames[index],
		)
	) {
		throw new Error(
			`Release must contain exactly ${expectedFilenames.join(", ")}.`,
		);
	}
	const manifest = {
		schemaVersion: 2,
		product: "Kestrel",
		platform: "darwin",
		architecture: "arm64",
		distribution: "internet",
		version,
		commit,
		artifacts: records,
	};
	writeFileSync(
		join(root, "release-manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		{ mode: 0o644 },
	);
	writeFileSync(
		join(root, "SHA256SUMS"),
		`${records
			.map((record) => `${record.sha256}  ${record.filename}`)
			.join("\n")}\n`,
		{ mode: 0o644 },
	);
	return manifest;
}

function isDirectExecution() {
	const entry = process.argv[1];
	return Boolean(
		entry && pathToFileURL(resolve(entry)).href === import.meta.url,
	);
}

if (isDirectExecution()) {
	createReleaseManifest({ root: resolve(process.argv[2] ?? "release") });
}
