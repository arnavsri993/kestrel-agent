import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeChromiumHost } from "./build-native-chromium-host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.env.KESTREL_NATIVE_TEST_APP
	? resolve(process.env.KESTREL_NATIVE_TEST_APP)
	: await buildNativeChromiumHost();
const executable = join(app, "Contents", "MacOS", "Kestrel");
const profile = await mkdtemp(
	join(tmpdir(), "kestrel-native-download-capture-"),
);
const payload = "kestrel-live-download-bytes\n";
let downloadHits = 0;

const server = createServer((request, response) => {
	if (request.url === "/kestrel-live-download.txt") {
		downloadHits += 1;
		response.writeHead(200, {
			"content-type": "text/plain; charset=utf-8",
			"content-disposition":
				'attachment; filename="kestrel-live-download.txt"',
			"content-length": Buffer.byteLength(payload),
		});
		response.end(payload);
		return;
	}
	response.writeHead(404);
	response.end("missing");
});
await new Promise((resolvePromise, rejectPromise) => {
	server.once("error", rejectPromise);
	server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
assert(address && typeof address !== "string");
const downloadUrl = `http://127.0.0.1:${address.port}/kestrel-live-download.txt`;

async function runPhase(args, requiredMarkers, label) {
	let output = "";
	const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	await new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(
			() =>
				rejectPromise(new Error(`Timed out waiting for ${label}: ${output}`)),
			45_000,
		);
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectPromise(error);
		});
		const check = () => {
			if (requiredMarkers.every((marker) => output.includes(marker))) {
				clearTimeout(timeout);
				resolvePromise();
			}
		};
		child.stdout.on("data", check);
		child.stderr.on("data", check);
		child.once("exit", (code) => {
			if (!requiredMarkers.every((marker) => output.includes(marker))) {
				clearTimeout(timeout);
				rejectPromise(
					new Error(`Native Chromium host exited ${code}: ${output}`),
				);
			}
		});
		check();
	});
	const code = await new Promise((resolvePromise) => {
		if (child.exitCode !== null) {
			resolvePromise(child.exitCode);
			return;
		}
		child.once("exit", (exitCode) => resolvePromise(exitCode));
	});
	assert.equal(code, 0, `${label} exited ${code}: ${output}`);
	return output;
}

try {
	const captureOutput = await runPhase(
		[
			"--kestrel-cache-path",
			profile,
			"--kestrel-ephemeral-core",
			"--kestrel-durable-profile",
			"--kestrel-smoke-download-url",
			downloadUrl,
			"--kestrel-exit-after-ready-ms",
			"20000",
		],
		[
			"KESTREL_NATIVE_CHROMIUM_HOST_READY",
			"KESTREL_NATIVE_CHROMIUM_DURABLE_PROFILE_ENABLED",
			"KESTREL_NATIVE_CHROMIUM_DOWNLOAD_CAPTURE_OK",
		],
		"live CEF download capture",
	);
	assert.match(
		captureOutput,
		/KESTREL_NATIVE_CHROMIUM_DOWNLOAD_CAPTURE_OK filename=kestrel-live-download\.txt bytes=\d+/,
	);
	assert.equal(
		downloadHits > 0,
		true,
		"CEF must request the attachment URL from the local smoke server.",
	);

	const library = JSON.parse(
		await readFile(join(profile, "browser-library.json"), "utf8"),
	);
	assert.equal(
		library.downloads.some(
			(item) =>
				item.filename === "kestrel-live-download.txt" &&
				item.status === "completed" &&
				item.sourceUrl === downloadUrl,
		),
		true,
		`Expected a completed live download record: ${JSON.stringify(library.downloads)}`,
	);
	const saved = await readFile(
		join(profile, "downloads", "kestrel-live-download.txt"),
		"utf8",
	);
	assert.equal(saved, payload);

	const restoreOutput = await runPhase(
		[
			"--kestrel-cache-path",
			profile,
			"--kestrel-ephemeral-core",
			"--kestrel-durable-profile",
			"--kestrel-exit-after-ready-ms",
			"8000",
		],
		[
			"KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_LOADED",
			"KESTREL_NATIVE_CHROMIUM_HOST_READY",
		],
		"download metadata restore",
	);
	assert.match(
		restoreOutput,
		/KESTREL_NATIVE_CHROMIUM_DURABLE_LIBRARY_LOADED bookmarks=\d+ history=\d+ downloads=[1-9]\d* permissions=\d+/,
	);
	const restored = JSON.parse(
		await readFile(join(profile, "browser-library.json"), "utf8"),
	);
	assert.equal(
		restored.downloads.some(
			(item) => item.filename === "kestrel-live-download.txt",
		),
		true,
	);

	console.log(
		"Native Chromium live download capture: CEF DownloadHandler wrote the file and durable library metadata survived restart.",
	);
} finally {
	await new Promise((resolvePromise) => server.close(resolvePromise));
	await rm(profile, { recursive: true, force: true });
}
