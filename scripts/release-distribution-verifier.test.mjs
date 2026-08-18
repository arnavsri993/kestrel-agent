import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	fetchHttpsResponse,
	parseLatestMac,
	parseSha256Sums,
	validateReleaseManifest,
	verifyLocalReleaseBundle,
	verifyPublicReleaseArtifacts,
	verifyReleaseMetadata,
} from "./release-distribution-verifier.mjs";

const version = "1.2.3";
const commit = "a".repeat(40);
const artifactBodies = new Map(
	["dmg", "pkg", "zip"].map((extension) => [
		`Kestrel-Apple-Silicon-${version}.${extension}`,
		Buffer.from(`${extension} release bytes`),
	]),
);
const temporaryRoots = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function digest(body, algorithm, encoding) {
	return createHash(algorithm).update(body).digest(encoding);
}

function fixtureManifest(overrides = {}) {
	return {
		schemaVersion: 2,
		product: "Kestrel",
		platform: "darwin",
		architecture: "arm64",
		distribution: "internet",
		version,
		commit,
		artifacts: [...artifactBodies].map(([filename, body]) => ({
			filename,
			bytes: body.byteLength,
			sha256: digest(body, "sha256", "hex"),
			sha512: digest(body, "sha512", "base64"),
		})),
		...overrides,
	};
}

function fixtureChecksums(manifest = fixtureManifest()) {
	return `${manifest.artifacts
		.map((artifact) => `${artifact.sha256}  ${artifact.filename}`)
		.join("\n")}\n`;
}

function fixtureUpdater(manifest = fixtureManifest()) {
	const byExtension = new Map(
		manifest.artifacts.map((artifact) => [
			artifact.filename.split(".").at(-1),
			artifact,
		]),
	);
	const zip = byExtension.get("zip");
	const dmg = byExtension.get("dmg");
	return `version: ${version}
files:
  - url: ${zip.filename}
    sha512: ${zip.sha512}
    size: ${zip.bytes}
  - url: ${dmg.filename}
    sha512: ${dmg.sha512}
    size: ${dmg.bytes}
path: ${zip.filename}
sha512: ${zip.sha512}
releaseDate: '2026-07-28T00:00:00.000Z'
`;
}

function writeLocalBundle(manifest = fixtureManifest()) {
	const root = mkdtempSync(join(tmpdir(), "kestrel-release-bundle-"));
	temporaryRoots.push(root);
	for (const [filename, body] of artifactBodies)
		writeFileSync(join(root, filename), body);
	writeFileSync(
		join(root, "release-manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	writeFileSync(join(root, "SHA256SUMS"), fixtureChecksums(manifest));
	writeFileSync(join(root, "latest-mac.yml"), fixtureUpdater(manifest));
	return root;
}

describe("public release artifact coherence", () => {
	it("accepts one version and digest set across every release surface", () => {
		const manifest = fixtureManifest();
		const result = verifyReleaseMetadata({
			version,
			manifest,
			checksums: parseSha256Sums(fixtureChecksums(manifest)),
			updater: parseLatestMac(fixtureUpdater(manifest)),
			downloadFilename: `Kestrel-Apple-Silicon-${version}.dmg`,
		});

		expect(result.downloadArtifact).toMatchObject({
			filename: `Kestrel-Apple-Silicon-${version}.dmg`,
		});
		expect(result.updaterArtifact).toMatchObject({
			filename: `Kestrel-Apple-Silicon-${version}.zip`,
		});
	});

	it("accepts the beta channel metadata filename", () => {
		const manifest = fixtureManifest();
		const metadata = "beta-mac.yml";
		expect(
			verifyReleaseMetadata({
				version,
				manifest,
				checksums: parseSha256Sums(fixtureChecksums(manifest)),
				updater: parseLatestMac(fixtureUpdater(manifest), metadata),
				downloadFilename: `Kestrel-Apple-Silicon-${version}.dmg`,
				metadataName: metadata,
			}),
		).toMatchObject({
			downloadArtifact: {
				filename: `Kestrel-Apple-Silicon-${version}.dmg`,
			},
		});
	});

	it("rejects a stale manifest version", () => {
		expect(() =>
			validateReleaseManifest(fixtureManifest({ version: "1.2.2" }), version),
		).toThrow(/manifest version is 1\.2\.2; expected 1\.2\.3/);
	});

	it("rejects malformed semantic versions", () => {
		expect(() => validateReleaseManifest(fixtureManifest(), "1.2.3-.")).toThrow(
			/Invalid public release version/,
		);
	});

	it("rejects checksums that do not match the manifest", () => {
		const manifest = fixtureManifest();
		const checksums = parseSha256Sums(fixtureChecksums(manifest)).set(
			`Kestrel-Apple-Silicon-${version}.dmg`,
			"0".repeat(64),
		);
		expect(() =>
			verifyReleaseMetadata({
				version,
				manifest,
				checksums,
				updater: parseLatestMac(fixtureUpdater(manifest)),
				downloadFilename: `Kestrel-Apple-Silicon-${version}.dmg`,
			}),
		).toThrow(/SHA256SUMS must match/);
	});

	it("rejects updater hashes that do not match the manifest", () => {
		const manifest = fixtureManifest();
		const updater = parseLatestMac(fixtureUpdater(manifest));
		updater.files[0].sha512 = Buffer.alloc(64).toString("base64");
		expect(() =>
			verifyReleaseMetadata({
				version,
				manifest,
				checksums: parseSha256Sums(fixtureChecksums(manifest)),
				updater,
				downloadFilename: `Kestrel-Apple-Silicon-${version}.dmg`,
			}),
		).toThrow(/Updater metadata .* does not match/);
	});

	it("rejects ambiguous or unsupported updater YAML", () => {
		const valid = fixtureUpdater();
		expect(() => parseLatestMac(`${valid}version: ${version}\n`)).toThrow(
			/repeats top-level version/,
		);
		expect(() =>
			parseLatestMac(valid.replace("    size:", "      size:")),
		).toThrow(/unsupported file content or indentation/);
		expect(() => parseLatestMac(`${valid}unexpected: value\n`)).toThrow(
			/unsupported top-level content/,
		);
	});

	it("verifies the configured distribution metadata and public artifact bytes", async () => {
		const manifest = fixtureManifest();
		const urls = {
			download: new URL(
				`https://downloads.example.test/Kestrel-Apple-Silicon-${version}.dmg`,
			),
			manifest: new URL("https://downloads.example.test/release-manifest.json"),
			checksums: new URL("https://downloads.example.test/SHA256SUMS"),
			updates: new URL("https://updates.example.test/releases/"),
		};
		const fetchImpl = async (input, init = {}) => {
			const url = String(input);
			if (url === urls.download.toString() && init.method === "GET")
				return new Response(
					artifactBodies.get(`Kestrel-Apple-Silicon-${version}.dmg`),
					{ status: 200 },
				);
			if (
				url ===
					new URL(
						`Kestrel-Apple-Silicon-${version}.zip`,
						urls.updates,
					).toString() &&
				init.method === "GET"
			)
				return new Response(
					artifactBodies.get(`Kestrel-Apple-Silicon-${version}.zip`),
					{ status: 200 },
				);
			if (url === urls.manifest.toString())
				return new Response(JSON.stringify(manifest), { status: 200 });
			if (url === urls.checksums.toString())
				return new Response(fixtureChecksums(manifest), { status: 200 });
			if (url === new URL("latest-mac.yml", urls.updates).toString())
				return new Response(fixtureUpdater(manifest), { status: 200 });
			return new Response("missing", { status: 404 });
		};

		await expect(
			verifyPublicReleaseArtifacts({
				version,
				expectedCommit: commit,
				downloadUrl: urls.download,
				manifestUrl: urls.manifest,
				checksumsUrl: urls.checksums,
				updateBaseUrl: urls.updates,
				fetchImpl,
			}),
		).resolves.toEqual({
			version,
			downloadFilename: `Kestrel-Apple-Silicon-${version}.dmg`,
			updaterFilename: `Kestrel-Apple-Silicon-${version}.zip`,
		});
	});

	it("rejects a same-size public DMG with the wrong digest", async () => {
		const manifest = fixtureManifest();
		const downloadUrl = new URL(
			`https://downloads.example.test/Kestrel-Apple-Silicon-${version}.dmg`,
		);
		const manifestUrl = new URL(
			"https://downloads.example.test/release-manifest.json",
		);
		const checksumsUrl = new URL("https://downloads.example.test/SHA256SUMS");
		const updateBaseUrl = new URL("https://updates.example.test/releases/");
		const fetchImpl = async (input, init = {}) => {
			const url = String(input);
			if (url === manifestUrl.toString())
				return new Response(JSON.stringify(manifest), { status: 200 });
			if (url === checksumsUrl.toString())
				return new Response(fixtureChecksums(manifest), { status: 200 });
			if (url === new URL("latest-mac.yml", updateBaseUrl).toString())
				return new Response(fixtureUpdater(manifest), { status: 200 });
			if (url === downloadUrl.toString() && init.method === "GET")
				return new Response(
					Buffer.alloc(
						artifactBodies.get(`Kestrel-Apple-Silicon-${version}.dmg`)
							.byteLength,
					),
					{ status: 200 },
				);
			if (
				url ===
					new URL(
						`Kestrel-Apple-Silicon-${version}.zip`,
						updateBaseUrl,
					).toString() &&
				init.method === "GET"
			)
				return new Response(
					artifactBodies.get(`Kestrel-Apple-Silicon-${version}.zip`),
					{ status: 200 },
				);
			return new Response("missing", { status: 404 });
		};

		await expect(
			verifyPublicReleaseArtifacts({
				version,
				expectedCommit: commit,
				downloadUrl,
				manifestUrl,
				checksumsUrl,
				updateBaseUrl,
				fetchImpl,
			}),
		).rejects.toThrow(/PUBLIC_DOWNLOAD_URL bytes do not match/);
	});

	it("requires the updater ZIP itself to be available", async () => {
		const manifest = fixtureManifest();
		const downloadUrl = new URL(
			`https://downloads.example.test/Kestrel-Apple-Silicon-${version}.dmg`,
		);
		const manifestUrl = new URL(
			"https://downloads.example.test/release-manifest.json",
		);
		const checksumsUrl = new URL("https://downloads.example.test/SHA256SUMS");
		const updateBaseUrl = new URL("https://updates.example.test/releases/");
		const fetchImpl = async (input, init = {}) => {
			const url = String(input);
			if (url === manifestUrl.toString())
				return new Response(JSON.stringify(manifest), { status: 200 });
			if (url === checksumsUrl.toString())
				return new Response(fixtureChecksums(manifest), { status: 200 });
			if (url === new URL("latest-mac.yml", updateBaseUrl).toString())
				return new Response(fixtureUpdater(manifest), { status: 200 });
			if (url === downloadUrl.toString() && init.method === "GET")
				return new Response(
					artifactBodies.get(`Kestrel-Apple-Silicon-${version}.dmg`),
					{ status: 200 },
				);
			return new Response("missing", { status: 404 });
		};

		await expect(
			verifyPublicReleaseArtifacts({
				version,
				expectedCommit: commit,
				downloadUrl,
				manifestUrl,
				checksumsUrl,
				updateBaseUrl,
				fetchImpl,
			}),
		).rejects.toThrow(/updater ZIP returned HTTP 404/);
	});

	it("rejects any redirect through plain HTTP", async () => {
		const fetchImpl = async () =>
			new Response(null, {
				status: 302,
				headers: { location: "http://downloads.example.test/manifest.json" },
			});

		await expect(
			verifyPublicReleaseArtifacts({
				version,
				expectedCommit: commit,
				downloadUrl: new URL(
					`https://downloads.example.test/Kestrel-Apple-Silicon-${version}.dmg`,
				),
				manifestUrl: new URL(
					"https://downloads.example.test/release-manifest.json",
				),
				checksumsUrl: new URL("https://downloads.example.test/SHA256SUMS"),
				updateBaseUrl: new URL("https://updates.example.test/releases/"),
				fetchImpl,
			}),
		).rejects.toThrow(/must use HTTPS at every redirect/);
	});

	it("rejects redirect loops before contacting an endpoint repeatedly", async () => {
		let requests = 0;
		await expect(
			fetchHttpsResponse({
				url: new URL("https://downloads.example.test/manifest.json"),
				label: "release manifest",
				fetchImpl: async () => {
					requests += 1;
					return new Response(null, {
						status: 302,
						headers: {
							location: "https://downloads.example.test/manifest.json",
						},
					});
				},
			}),
		).rejects.toThrow(/redirect loop/);
		expect(requests).toBe(1);
	});

	it("stops reading oversized release metadata", async () => {
		const manifest = fixtureManifest();
		const downloadUrl = new URL(
			`https://downloads.example.test/Kestrel-Apple-Silicon-${version}.dmg`,
		);
		const manifestUrl = new URL(
			"https://downloads.example.test/release-manifest.json",
		);
		const checksumsUrl = new URL("https://downloads.example.test/SHA256SUMS");
		const updateBaseUrl = new URL("https://updates.example.test/releases/");
		const fetchImpl = async (input, init = {}) => {
			const url = String(input);
			if (url === manifestUrl.toString())
				return new Response("x".repeat(1024 * 1024 + 1), { status: 200 });
			if (url === checksumsUrl.toString())
				return new Response(fixtureChecksums(manifest), { status: 200 });
			if (url === new URL("latest-mac.yml", updateBaseUrl).toString())
				return new Response(fixtureUpdater(manifest), { status: 200 });
			return new Response("missing", { status: 404 });
		};

		await expect(
			verifyPublicReleaseArtifacts({
				version,
				expectedCommit: commit,
				downloadUrl,
				manifestUrl,
				checksumsUrl,
				updateBaseUrl,
				fetchImpl,
			}),
		).rejects.toThrow(/PUBLIC_RELEASE_MANIFEST_URL exceeds 1 MB/);
	});

	it("verifies every local release artifact against the bundle metadata", async () => {
		const root = writeLocalBundle();

		await expect(
			verifyLocalReleaseBundle({
				releaseDirectory: root,
				version,
				expectedCommit: commit,
			}),
		).resolves.toMatchObject({
			version,
			commit,
		});

		writeFileSync(
			join(root, `Kestrel-Apple-Silicon-${version}.dmg`),
			Buffer.alloc(
				artifactBodies.get(`Kestrel-Apple-Silicon-${version}.dmg`).byteLength,
			),
		);
		await expect(
			verifyLocalReleaseBundle({
				releaseDirectory: root,
				version,
				expectedCommit: commit,
			}),
		).rejects.toThrow(/DMG|dmg.*bytes do not match/i);
	});

	it("requires the local manifest to name the packaged source commit", async () => {
		const root = writeLocalBundle();
		await expect(
			verifyLocalReleaseBundle({
				releaseDirectory: root,
				version,
				expectedCommit: "b".repeat(40),
			}),
		).rejects.toThrow(/manifest commit .* does not match/);
	});
});
