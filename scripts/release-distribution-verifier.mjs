import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const releaseVersionPattern =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const maximumMetadataBytes = 1024 * 1024;
const maximumArtifactBytes = 2 * 1024 * 1024 * 1024;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function parseYamlScalar(value, label) {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} is empty.`);
	if (trimmed.startsWith("'") || trimmed.startsWith('"')) {
		const quote = trimmed[0];
		if (!trimmed.endsWith(quote))
			throw new Error(`${label} has an unterminated quoted value.`);
		if (quote === "'") return trimmed.slice(1, -1).replaceAll("''", "'");
		try {
			return JSON.parse(trimmed);
		} catch {
			throw new Error(`${label} has an invalid quoted value.`);
		}
	}
	return trimmed;
}

function parseSha512(value, label) {
	const encoded = value.trim();
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
		throw new Error(`${label} is not valid base64.`);
	const decoded = Buffer.from(encoded, "base64");
	if (decoded.byteLength !== 64 || decoded.toString("base64") !== encoded)
		throw new Error(`${label} is not a SHA-512 digest.`);
	return encoded;
}

function parsePositiveBytes(value, label) {
	const bytes = Number(value);
	if (
		!Number.isSafeInteger(bytes) ||
		bytes <= 0 ||
		bytes > maximumArtifactBytes
	)
		throw new Error(`${label} must be a positive bounded byte count.`);
	return bytes;
}

function expectedArtifactNames(version) {
	return ["dmg", "pkg", "zip"].map(
		(extension) => `Kestrel-Apple-Silicon-${version}.${extension}`,
	);
}

export function validateReleaseManifest(value, version) {
	if (!releaseVersionPattern.test(version))
		throw new Error(`Invalid public release version: ${version}.`);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Release manifest must be a JSON object.");
	if (value.schemaVersion !== 2)
		throw new Error("Release manifest must use schema version 2.");
	for (const [key, expected] of [
		["product", "Kestrel"],
		["platform", "darwin"],
		["architecture", "arm64"],
		["distribution", "internet"],
		["version", version],
	]) {
		if (value[key] !== expected)
			throw new Error(
				`Release manifest ${key} is ${String(value[key])}; expected ${expected}.`,
			);
	}
	if (typeof value.commit !== "string" || !commitPattern.test(value.commit))
		throw new Error("Release manifest commit must be a full Git commit SHA.");
	if (!Array.isArray(value.artifacts))
		throw new Error("Release manifest artifacts must be an array.");

	const artifacts = new Map();
	for (const record of value.artifacts) {
		if (!record || typeof record !== "object" || Array.isArray(record))
			throw new Error("Release manifest contains an invalid artifact record.");
		const filename = typeof record.filename === "string" ? record.filename : "";
		if (!filename || basename(filename) !== filename || artifacts.has(filename))
			throw new Error(
				`Release manifest contains an invalid or duplicate filename: ${filename || "(empty)"}.`,
			);
		const sha256 =
			typeof record.sha256 === "string" ? record.sha256.toLowerCase() : "";
		if (!sha256Pattern.test(sha256))
			throw new Error(`${filename} has an invalid SHA-256 digest.`);
		const sha512 = parseSha512(
			typeof record.sha512 === "string" ? record.sha512 : "",
			`${filename} SHA-512`,
		);
		artifacts.set(filename, {
			filename,
			bytes: parsePositiveBytes(record.bytes, `${filename} size`),
			sha256,
			sha512,
		});
	}

	const expected = expectedArtifactNames(version);
	if (
		artifacts.size !== expected.length ||
		expected.some((filename) => !artifacts.has(filename))
	)
		throw new Error(
			`Release manifest must contain exactly ${expected.join(", ")}.`,
		);
	return artifacts;
}

export function parseSha256Sums(source) {
	const checksums = new Map();
	for (const [index, rawLine] of source
		.replaceAll("\r", "")
		.split("\n")
		.entries()) {
		if (!rawLine.trim()) continue;
		const match = rawLine.match(/^([a-fA-F0-9]{64}) {2}([^\s/]+)$/);
		if (!match) throw new Error(`SHA256SUMS line ${index + 1} is malformed.`);
		const [, digest, filename] = match;
		if (checksums.has(filename))
			throw new Error(`SHA256SUMS repeats ${filename}.`);
		checksums.set(filename, digest.toLowerCase());
	}
	if (!checksums.size) throw new Error("SHA256SUMS is empty.");
	return checksums;
}

export function parseLatestMac(source) {
	let version;
	let path;
	let sha512;
	let releaseDate;
	let inFiles = false;
	let currentFile;
	const files = [];
	const topLevelFields = new Set();

	const finishFile = () => {
		if (currentFile) {
			const { fields: _fields, ...file } = currentFile;
			files.push(file);
		}
		currentFile = undefined;
	};
	const claimTopLevelField = (field) => {
		if (topLevelFields.has(field))
			throw new Error(`latest-mac.yml repeats top-level ${field}.`);
		topLevelFields.add(field);
	};
	const claimFileField = (field) => {
		if (!currentFile)
			throw new Error(`latest-mac.yml has ${field} outside a file record.`);
		if (currentFile.fields.has(field))
			throw new Error(`latest-mac.yml repeats file ${field}.`);
		currentFile.fields.add(field);
	};

	for (const rawLine of source.replaceAll("\r", "").split("\n")) {
		if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
		if (rawLine.includes("\t"))
			throw new Error("latest-mac.yml must not use tab indentation.");
		const indentation = rawLine.length - rawLine.trimStart().length;
		const line = rawLine.trim();
		if (indentation === 0) {
			finishFile();
			inFiles = false;
			if (line === "files:") {
				claimTopLevelField("files");
				inFiles = true;
			} else if (line.startsWith("version:")) {
				claimTopLevelField("version");
				version = parseYamlScalar(
					line.slice("version:".length),
					"Updater version",
				);
			} else if (line.startsWith("path:")) {
				claimTopLevelField("path");
				path = parseYamlScalar(line.slice("path:".length), "Updater path");
			} else if (line.startsWith("sha512:")) {
				claimTopLevelField("sha512");
				sha512 = parseSha512(
					parseYamlScalar(line.slice("sha512:".length), "Updater SHA-512"),
					"Updater SHA-512",
				);
			} else if (line.startsWith("releaseDate:")) {
				claimTopLevelField("releaseDate");
				releaseDate = parseYamlScalar(
					line.slice("releaseDate:".length),
					"Updater release date",
				);
			} else {
				throw new Error(
					`latest-mac.yml contains unsupported top-level content: ${line}.`,
				);
			}
			continue;
		}
		if (!inFiles)
			throw new Error(
				`latest-mac.yml contains unexpected nested content: ${line}.`,
			);
		if (indentation === 2 && line.startsWith("- url:")) {
			finishFile();
			currentFile = {
				fields: new Set(["url"]),
				url: parseYamlScalar(line.slice("- url:".length), "Updater file URL"),
			};
		} else if (indentation === 4 && currentFile && line.startsWith("sha512:")) {
			claimFileField("sha512");
			currentFile.sha512 = parseSha512(
				parseYamlScalar(line.slice("sha512:".length), "Updater file SHA-512"),
				"Updater file SHA-512",
			);
		} else if (indentation === 4 && currentFile && line.startsWith("size:")) {
			claimFileField("size");
			currentFile.bytes = parsePositiveBytes(
				parseYamlScalar(line.slice("size:".length), "Updater file size"),
				"Updater file size",
			);
		} else {
			throw new Error(
				`latest-mac.yml contains unsupported file content or indentation: ${line}.`,
			);
		}
	}
	finishFile();

	if (!version || !path || !sha512 || !releaseDate)
		throw new Error(
			"latest-mac.yml must contain top-level version, path, sha512, and releaseDate fields.",
		);
	if (!Number.isFinite(Date.parse(releaseDate)) || !releaseDate.includes("T"))
		throw new Error("latest-mac.yml contains an invalid release date.");
	if (!files.length)
		throw new Error("latest-mac.yml does not contain updater files.");
	for (const file of files) {
		if (!file.url || !file.sha512 || !file.bytes)
			throw new Error("latest-mac.yml contains an incomplete updater file.");
	}
	return { version, path, sha512, releaseDate, files };
}

export function verifyReleaseMetadata({
	version,
	manifest,
	checksums,
	updater,
	downloadFilename,
}) {
	const artifacts = validateReleaseManifest(manifest, version);
	if (
		checksums.size !== artifacts.size ||
		[...artifacts.values()].some(
			(artifact) => checksums.get(artifact.filename) !== artifact.sha256,
		)
	)
		throw new Error(
			"SHA256SUMS must match every release-manifest artifact exactly.",
		);

	const expectedDmg = `Kestrel-Apple-Silicon-${version}.dmg`;
	const expectedZip = `Kestrel-Apple-Silicon-${version}.zip`;
	if (downloadFilename !== expectedDmg)
		throw new Error(
			`Public download points to ${downloadFilename}; expected ${expectedDmg}.`,
		);
	if (updater.version !== version)
		throw new Error(
			`Updater version ${updater.version} does not match ${version}.`,
		);
	if (updater.path !== expectedZip)
		throw new Error(
			`Updater path ${updater.path} does not match ${expectedZip}.`,
		);

	const updaterFiles = new Map();
	for (const file of updater.files) {
		if (basename(file.url) !== file.url || updaterFiles.has(file.url))
			throw new Error(
				`latest-mac.yml contains an invalid or duplicate file URL: ${file.url}.`,
			);
		updaterFiles.set(file.url, file);
	}
	if (
		updaterFiles.size !== 2 ||
		!updaterFiles.has(expectedDmg) ||
		!updaterFiles.has(expectedZip)
	)
		throw new Error(
			`latest-mac.yml must contain exactly ${expectedDmg} and ${expectedZip}.`,
		);

	for (const filename of [expectedDmg, expectedZip]) {
		const artifact = artifacts.get(filename);
		const updateFile = updaterFiles.get(filename);
		if (
			!artifact ||
			!updateFile ||
			artifact.bytes !== updateFile.bytes ||
			artifact.sha512 !== updateFile.sha512
		)
			throw new Error(
				`Updater metadata for ${filename} does not match the release manifest.`,
			);
	}
	const updatePath = updaterFiles.get(expectedZip);
	if (!updatePath || updater.sha512 !== updatePath.sha512)
		throw new Error(
			"Updater top-level SHA-512 does not match its ZIP file record.",
		);
	return {
		artifacts,
		downloadArtifact: artifacts.get(expectedDmg),
		updaterArtifact: artifacts.get(expectedZip),
	};
}

export async function fetchHttpsResponse({
	fetchImpl = fetch,
	url,
	label,
	init = {},
	timeoutMs = 15_000,
}) {
	const { signal: callerSignal, ...requestInit } = init;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = callerSignal
		? AbortSignal.any([callerSignal, timeoutSignal])
		: timeoutSignal;
	let currentUrl = new URL(url);
	const visited = new Set();

	for (let redirects = 0; redirects <= 5; redirects += 1) {
		if (currentUrl.protocol !== "https:")
			throw new Error(`${label} must use HTTPS at every redirect.`);
		const current = currentUrl.toString();
		if (visited.has(current))
			throw new Error(`${label} entered a redirect loop.`);
		visited.add(current);

		const response = await fetchImpl(currentUrl, {
			...requestInit,
			redirect: "manual",
			signal,
		});
		if (!redirectStatuses.has(response.status)) return response;

		const location = response.headers.get("location");
		await response.body?.cancel().catch(() => undefined);
		if (!location)
			throw new Error(`${label} returned a redirect without a location.`);
		currentUrl = new URL(location, currentUrl);
	}
	throw new Error(`${label} exceeded 5 redirects.`);
}

async function fetchRequired(fetchImpl, url, label, init = {}) {
	const response = await fetchHttpsResponse({
		fetchImpl,
		url,
		label,
		init,
	});
	if (!response.ok)
		throw new Error(`${label} returned HTTP ${response.status}.`);
	return response;
}

async function readMetadata(response, label) {
	const declaredBytes = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredBytes) && declaredBytes > maximumMetadataBytes) {
		throw new Error(`${label} exceeds 1 MB.`);
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let source = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maximumMetadataBytes) {
				await reader.cancel();
				throw new Error(`${label} exceeds 1 MB.`);
			}
			source += decoder.decode(value, { stream: true });
		}
		return source + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

function assertArtifactDigest(actual, expected, label) {
	if (
		actual.bytes !== expected.bytes ||
		actual.sha256 !== expected.sha256 ||
		actual.sha512 !== expected.sha512
	) {
		throw new Error(`${label} bytes do not match the release manifest.`);
	}
}

async function hashWebArtifact(fetchImpl, url, label, expected, signal) {
	const response = await fetchHttpsResponse({
		fetchImpl,
		url,
		label,
		init: { method: "GET", signal },
		timeoutMs: 5 * 60_000,
	});
	if (!response.ok)
		throw new Error(`${label} returned HTTP ${response.status}.`);
	const declaredBytes = Number(response.headers.get("content-length"));
	if (
		Number.isSafeInteger(declaredBytes) &&
		declaredBytes > 0 &&
		declaredBytes !== expected.bytes
	) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(
			`${label} declares ${declaredBytes} bytes; expected ${expected.bytes}.`,
		);
	}
	if (!response.body) throw new Error(`${label} returned no artifact body.`);

	const sha256 = createHash("sha256");
	const sha512 = createHash("sha512");
	const reader = response.body.getReader();
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maximumArtifactBytes || bytes > expected.bytes) {
				await reader.cancel();
				throw new Error(`${label} exceeds its expected bounded size.`);
			}
			sha256.update(value);
			sha512.update(value);
		}
	} finally {
		reader.releaseLock();
	}
	const actual = {
		bytes,
		sha256: sha256.digest("hex"),
		sha512: sha512.digest("base64"),
	};
	assertArtifactDigest(actual, expected, label);
}

async function readLocalMetadata(path, label) {
	const details = await stat(path);
	if (!details.isFile() || details.size > maximumMetadataBytes)
		throw new Error(`${label} must be a file no larger than 1 MB.`);
	return readFile(path, "utf8");
}

async function hashLocalArtifact(path, label, expected) {
	const details = await stat(path);
	if (
		!details.isFile() ||
		details.size <= 0 ||
		details.size > maximumArtifactBytes
	) {
		throw new Error(`${label} must be a positive bounded file.`);
	}
	const sha256 = createHash("sha256");
	const sha512 = createHash("sha512");
	let bytes = 0;
	for await (const chunk of createReadStream(path)) {
		bytes += chunk.byteLength;
		if (bytes > maximumArtifactBytes || bytes > expected.bytes)
			throw new Error(`${label} exceeds its expected bounded size.`);
		sha256.update(chunk);
		sha512.update(chunk);
	}
	assertArtifactDigest(
		{
			bytes,
			sha256: sha256.digest("hex"),
			sha512: sha512.digest("base64"),
		},
		expected,
		label,
	);
}

export async function verifyLocalReleaseBundle({
	releaseDirectory,
	version,
	expectedCommit,
}) {
	if (!commitPattern.test(expectedCommit))
		throw new Error("Expected release commit must be a full Git commit SHA.");
	const [manifestSource, checksumsSource, updaterSource] = await Promise.all([
		readLocalMetadata(
			join(releaseDirectory, "release-manifest.json"),
			"release-manifest.json",
		),
		readLocalMetadata(join(releaseDirectory, "SHA256SUMS"), "SHA256SUMS"),
		readLocalMetadata(
			join(releaseDirectory, "latest-mac.yml"),
			"latest-mac.yml",
		),
	]);
	let manifest;
	try {
		manifest = JSON.parse(manifestSource);
	} catch {
		throw new Error("release-manifest.json is not valid JSON.");
	}
	if (manifest.commit !== expectedCommit)
		throw new Error(
			`Release manifest commit ${String(manifest.commit)} does not match ${expectedCommit}.`,
		);
	const result = verifyReleaseMetadata({
		version,
		manifest,
		checksums: parseSha256Sums(checksumsSource),
		updater: parseLatestMac(updaterSource),
		downloadFilename: `Kestrel-Apple-Silicon-${version}.dmg`,
	});
	await Promise.all(
		[...result.artifacts.values()].map((artifact) =>
			hashLocalArtifact(
				join(releaseDirectory, artifact.filename),
				artifact.filename,
				artifact,
			),
		),
	);
	return {
		version,
		commit: expectedCommit,
		artifacts: [...result.artifacts.keys()],
	};
}

export async function verifyPublicReleaseArtifacts({
	version,
	expectedCommit,
	downloadUrl,
	manifestUrl,
	checksumsUrl,
	updateBaseUrl,
	fetchImpl = fetch,
}) {
	if (!commitPattern.test(expectedCommit))
		throw new Error(
			"Expected public release commit must be a full Git commit SHA.",
		);
	const updateFeedUrl = new URL(
		"latest-mac.yml",
		`${updateBaseUrl.toString().replace(/\/$/, "")}/`,
	);
	const [manifestResponse, checksumsResponse, updaterResponse] =
		await Promise.all([
			fetchRequired(fetchImpl, manifestUrl, "PUBLIC_RELEASE_MANIFEST_URL"),
			fetchRequired(fetchImpl, checksumsUrl, "PUBLIC_RELEASE_CHECKSUMS_URL"),
			fetchRequired(
				fetchImpl,
				updateFeedUrl,
				"KESTREL_UPDATE_URL/latest-mac.yml",
			),
		]);
	const [manifestSource, checksumsSource, updaterSource] = await Promise.all([
		readMetadata(manifestResponse, "PUBLIC_RELEASE_MANIFEST_URL"),
		readMetadata(checksumsResponse, "PUBLIC_RELEASE_CHECKSUMS_URL"),
		readMetadata(updaterResponse, "KESTREL_UPDATE_URL/latest-mac.yml"),
	]);
	let manifest;
	try {
		manifest = JSON.parse(manifestSource);
	} catch {
		throw new Error("PUBLIC_RELEASE_MANIFEST_URL is not valid JSON.");
	}
	if (manifest.commit !== expectedCommit)
		throw new Error(
			`Public release manifest commit ${String(manifest.commit)} does not match ${expectedCommit}.`,
		);
	const result = verifyReleaseMetadata({
		version,
		manifest,
		checksums: parseSha256Sums(checksumsSource),
		updater: parseLatestMac(updaterSource),
		downloadFilename: decodeURIComponent(basename(downloadUrl.pathname)),
	});
	const updaterArtifactUrl = new URL(
		result.updaterArtifact.filename,
		`${updateBaseUrl.toString().replace(/\/$/, "")}/`,
	);
	const artifactController = new AbortController();
	try {
		await Promise.all([
			hashWebArtifact(
				fetchImpl,
				downloadUrl,
				"PUBLIC_DOWNLOAD_URL",
				result.downloadArtifact,
				artifactController.signal,
			),
			hashWebArtifact(
				fetchImpl,
				updaterArtifactUrl,
				"KESTREL_UPDATE_URL updater ZIP",
				result.updaterArtifact,
				artifactController.signal,
			),
		]);
	} catch (error) {
		artifactController.abort();
		throw error;
	}
	return {
		version,
		downloadFilename: result.downloadArtifact.filename,
		updaterFilename: result.updaterArtifact.filename,
	};
}
