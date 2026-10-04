import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalRuntimeProgress } from "@kestrel/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import {
	LocalRuntimeManager,
	type LocalRuntimeManifest,
} from "./local-runtime-manager";

import { CredentialBroker, PlaintextSecretProtection } from "./credential-broker";
import { ProviderAccountStore } from "./provider-account-store";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

function testManifest(
	bytes: Uint8Array,
	sha256 = createHash("sha256").update(bytes).digest("hex"),
): LocalRuntimeManifest {
	return {
		runtime: "ollama",
		version: "test",
		platform: "darwin",
		architectures: ["arm64"],
		url: "https://github.com/ollama/ollama/releases/download/test/ollama-darwin.tgz",
		fileName: "ollama-darwin.tgz",
		sha256,
		bytes: bytes.byteLength,
		binaryPath: "ollama",
	};
}

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		exitCode: number | null;
		kill(signal?: NodeJS.Signals): boolean;
	};
	child.exitCode = null;
	child.kill = () => {
		child.exitCode = 0;
		queueMicrotask(() => child.emit("exit", 0, null));
		return true;
	};
	return child;
}

describe("managed local runtime", () => {
	it("downloads, checksum-verifies, installs, starts, pulls, and live-verifies one model", async () => {
		const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
		roots.push(root);
		const archive = new TextEncoder().encode("archive");
		const manifest = testManifest(archive);
		const progress: LocalRuntimeProgress[] = [];
		let serviceReady = false;
		let modelInstalled = false;
		const isolatedOrigin = "http://127.0.0.1:43123";
		let spawnedHost = "";
		const fetcher: typeof fetch = async (input) => {
			const url = String(input);
			if (url === manifest.url) return new Response(archive, { status: 200 });
			if (!url.startsWith(isolatedOrigin))
				throw new Error(`Unexpected local model origin: ${url}`);
			if (url.endsWith("/api/tags")) {
				if (!serviceReady) throw new TypeError("connection refused");
				return Response.json({
					models: modelInstalled ? [{ name: "qwen:test", size: 42 }] : [],
				});
			}
			if (url.endsWith("/api/pull")) {
				modelInstalled = true;
				return new Response(
					`${JSON.stringify({ status: "pulling manifest", completed: 1, total: 1 })}\n`,
					{ status: 200 },
				);
			}
			if (url.endsWith("/api/chat"))
				return Response.json({ done: true, message: { content: "READY" } });
			throw new Error(`Unexpected URL: ${url}`);
		};
		const execute = async (_file: string, args: string[]) => {
			if (args[0] === "-tzf")
				return { stdout: "ollama\nlibreal.dylib\nliblink.dylib\n", stderr: "" };
			if (args[0] === "-xzf") {
				const destination = args[args.indexOf("-C") + 1]!;
				await writeFile(join(destination, "ollama"), "verified binary");
				await writeFile(join(destination, "libreal.dylib"), "verified library");
				await symlink("libreal.dylib", join(destination, "liblink.dylib"));
				return { stdout: "", stderr: "" };
			}
			throw new Error(`Unexpected command: ${args.join(" ")}`);
		};
		const manager = new LocalRuntimeManager(
			root,
			(event) => progress.push(event),
			{
				fetch: fetcher,
				execFile: execute,
				platform: "darwin",
				architecture: "arm64",
				manifest,
				origin: isolatedOrigin,
				spawn: ((
					_file: string,
					_args: readonly string[],
					options: import("node:child_process").SpawnOptions,
				) => {
					spawnedHost = String(options?.env?.OLLAMA_HOST ?? "");
					serviceReady = true;
					return fakeChild();
				}) as unknown as typeof import("node:child_process").spawn,
			},
		);

		const status = await manager.bootstrap("qwen:test");

		expect(status).toMatchObject({
			automaticSupported: true,
			managedRuntime: true,
			ollamaAvailable: true,
			source: "managed",
			runtimeVersion: "test",
			localModels: [{ name: "qwen:test", size: 42 }],
			verifiedModel: "qwen:test",
		});
		expect(progress.map((event) => event.stage)).toEqual(
			expect.arrayContaining([
				"detecting",
				"downloading-runtime",
				"verifying-runtime",
				"installing-runtime",
				"starting-runtime",
				"downloading-model",
				"verifying-model",
				"ready",
			]),
		);
		expect(spawnedHost).toBe("127.0.0.1:43123");
		const marker = JSON.parse(
			await readFile(
				join(
					root,
					"local-runtime",
					"ollama",
					"test",
					"workstrand-install.json",
				),
				"utf8",
			),
		);
		expect(marker).toMatchObject({
			version: "test",
			sha256: manifest.sha256,
			binaryPath: "ollama",
		});
		const verification = JSON.parse(
			await readFile(
				join(root, "local-runtime", "last-verification.json"),
				"utf8",
			),
		);
		expect(verification).toMatchObject({ model: "qwen:test" });
		await manager.stop();

		serviceReady = false;
		const relaunched = new LocalRuntimeManager(root, () => undefined, {
			fetch: fetcher,
			execFile: execute,
			platform: "darwin",
			architecture: "arm64",
			manifest,
			origin: isolatedOrigin,
			spawn: (() => {
				serviceReady = true;
				return fakeChild();
			}) as unknown as typeof import("node:child_process").spawn,
		});
		await relaunched.startManagedIfInstalled();
		expect(serviceReady).toBe(true);
		await expect(relaunched.listModels()).resolves.toEqual([
			{ name: "qwen:test", size: 42 },
		]);
		await relaunched.stop();

		serviceReady = false;
		const warmed = new LocalRuntimeManager(root, () => undefined, {
			fetch: fetcher,
			execFile: execute,
			platform: "darwin",
			architecture: "arm64",
			manifest,
			origin: isolatedOrigin,
			spawn: (() => {
				serviceReady = true;
				return fakeChild();
			}) as unknown as typeof import("node:child_process").spawn,
		});
		await warmed.ensureChatReady();
		expect(serviceReady).toBe(true);
		await warmed.stop();
	});

	it("rejects a managed runtime origin outside the loopback interface", async () => {
		const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
		roots.push(root);

		expect(
			() =>
				new LocalRuntimeManager(root, () => undefined, {
					origin: "https://models.example.com:443",
				}),
		).toThrow("explicit loopback HTTP port");
	});

	it("does not probe a loopback service when model discovery is disabled", async () => {
		const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
		roots.push(root);
		let fetches = 0;
		const manager = new LocalRuntimeManager(root, () => undefined, {
			fetch: (async () => {
				fetches += 1;
				throw new Error("The isolated profile must not contact Ollama.");
			}) as typeof fetch,
			platform: "darwin",
			architecture: "arm64",
			modelDiscoveryDisabled: true,
		});

		await expect(manager.listModels()).resolves.toEqual([]);
		await expect(manager.status()).resolves.toMatchObject({
			ollamaAvailable: false,
			source: "none",
			localModels: [],
		});
		await manager.startManagedIfInstalled();
		expect(fetches).toBe(0);
	});

	it("prefers the recorded verified model over the first listed tag", async () => {
		const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
		roots.push(root);
		await mkdir(join(root, "local-runtime"), { recursive: true });
		await writeFile(
			join(root, "local-runtime", "last-verification.json"),
			JSON.stringify({
				model: "huihui_ai/qwen3.5-abliterated:9b",
				verifiedAt: "2026-08-10T00:00:00.000Z",
			}),
		);
		const manager = new LocalRuntimeManager(root, () => undefined);
		const models = [
			{ name: "smollm2:135m", size: 258_000_000 },
			{ name: "huihui_ai/qwen3.5-abliterated:9b", size: 6_600_000_000 },
		];

		await expect(manager.preferredModel(models)).resolves.toBe(
			"huihui_ai/qwen3.5-abliterated:9b",
		);
	});

	it("removes a partial install when the signed checksum does not match", async () => {
		const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
		roots.push(root);
		const archive = new TextEncoder().encode("tampered");
		const manifest = testManifest(archive, "0".repeat(64));
		const progress: LocalRuntimeProgress[] = [];
		const manager = new LocalRuntimeManager(
			root,
			(event) => progress.push(event),
			{
				fetch: (async (input) => {
					if (String(input).endsWith("/api/tags"))
						throw new TypeError("connection refused");
					return new Response(archive, { status: 200 });
				}) as typeof fetch,
				platform: "darwin",
				architecture: "arm64",
				manifest,
			},
		);

		await expect(manager.bootstrap("qwen:test")).rejects.toThrow("checksum");
		expect(progress.at(-1)).toMatchObject({ stage: "error" });
		await expect(
			readFile(
				join(
					root,
					"local-runtime",
					"ollama",
					"test",
					"workstrand-install.json",
				),
				"utf8",
			),
		).rejects.toThrow();
	});

	it("drops non-finite model progress values", async () => {
		const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
		roots.push(root);
		const progress: LocalRuntimeProgress[] = [];
		let modelInstalled = false;
		const manager = new LocalRuntimeManager(
			root,
			(event) => progress.push(event),
			{
				fetch: (async (input) => {
					const url = String(input);
					if (url.endsWith("/api/tags"))
						return Response.json({
							models: modelInstalled ? [{ name: "qwen:test" }] : [],
						});
					if (url.endsWith("/api/pull")) {
						modelInstalled = true;
						return new Response(
							'{"status":"pulling","completed":1e400,"total":1e400}\n',
							{ status: 200 },
						);
					}
					if (url.endsWith("/api/chat"))
						return Response.json({ done: true, message: { content: "READY" } });
					throw new Error(`Unexpected URL: ${url}`);
				}) as typeof fetch,
				platform: "darwin",
				architecture: "arm64",
				manifest: testManifest(new TextEncoder().encode("archive")),
			},
		);

		await manager.bootstrap("qwen:test");

		const malformed = progress.find(
			(event) =>
				event.stage === "downloading-model" && event.message === "pulling",
		);
		expect(malformed).toMatchObject({ stage: "downloading-model" });
		expect(malformed).not.toHaveProperty("downloadedBytes");
		expect(malformed).not.toHaveProperty("totalBytes");
		expect(malformed).not.toHaveProperty("percent");
	});

	it("fails closed to manual setup on unsupported platforms", async () => {
		const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
		roots.push(root);
		const archive = new TextEncoder().encode("archive");
		const manager = new LocalRuntimeManager(root, () => undefined, {
			fetch: (async () => {
				throw new TypeError("connection refused");
			}) as typeof fetch,
			platform: "win32",
			architecture: "x64",
			manifest: testManifest(archive),
		});

		const status = await manager.status();
		expect(status).toMatchObject({
			automaticSupported: false,
			ollamaAvailable: false,
			source: "none",
		});
		await expect(manager.bootstrap("qwen:test")).rejects.toThrow(
			"manual setup",
		);
	});

	it("leaves chat ready a no-op when no managed runtime is installed", async () => {
		const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
		roots.push(root);
		let spawned = false;
		const manager = new LocalRuntimeManager(root, () => undefined, {
			fetch: (async () => {
				throw new TypeError("connection refused");
			}) as typeof fetch,
			platform: "darwin",
			architecture: "arm64",
			manifest: testManifest(new TextEncoder().encode("archive")),
			spawn: (() => {
				spawned = true;
				return fakeChild();
			}) as unknown as typeof import("node:child_process").spawn,
		});

		await expect(manager.ensureChatReady()).resolves.toBeUndefined();
		expect(spawned).toBe(false);
	});

	it("does not offer the managed runtime on Intel Macs", async () => {
		const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
		roots.push(root);
		const manager = new LocalRuntimeManager(root, () => undefined, {
			fetch: (async () => {
				throw new TypeError("connection refused");
			}) as typeof fetch,
			platform: "darwin",
			architecture: "x64",
			manifest: testManifest(new TextEncoder().encode("archive")),
		});

		await expect(manager.status()).resolves.toMatchObject({
			automaticSupported: false,
			ollamaAvailable: false,
		});
		await expect(manager.bootstrap("qwen:test")).rejects.toThrow(
			"manual setup",
		);
	});

	it("rejects an oversized model list response while cancelling its body", async () => {
		const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
		roots.push(root);
		let cancelled = false;
		const oversizedPayload = new Uint8Array(1_000_001).fill(120);
		const manager = new LocalRuntimeManager(root, () => undefined, {
			fetch: (async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(oversizedPayload);
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 200 },
				)) as typeof fetch,
			manifest: testManifest(new TextEncoder().encode("archive")),
		});

		await expect(manager.listModels()).rejects.toThrow(
			"local model service response exceeds 1 MB",
		);
		expect(cancelled).toBe(true);
	});
});


async function guardedRuntimeFixture() {
	const root = await mkdtemp(join(tmpdir(), "kestrel-guarded-runtime-"));
	roots.push(root);
	const origin = "http://127.0.0.1:43123";
	const manifest = testManifest(new TextEncoder().encode("fixture-archive"));
	const install = join(root, "local-runtime", "ollama", manifest.version);
	await mkdir(install, { recursive: true });
	await writeFile(join(install, "ollama"), "fixture-binary");
	await chmod(join(install, "ollama"), 0o700);
	await writeFile(join(install, "workstrand-install.json"), JSON.stringify({ version: manifest.version, sha256: manifest.sha256, binaryPath: manifest.binaryPath }));
	const store = new ProviderAccountStore(join(root, "provider-accounts.json"), new CredentialBroker(join(root, "secure"), new PlaintextSecretProtection()), root);
	const counts = { fetches: 0, spawns: 0, kills: 0 };
	let ready = false;
	let verificationGate: Promise<void> | undefined;
	let verificationStarted: (() => void) | undefined;
	let probeGate: Promise<void> | undefined;
	let probeStarted: (() => void) | undefined;
	const manager = new LocalRuntimeManager(root, () => undefined, {
		manifest, origin, platform: "darwin", architecture: "arm64",
		fetch: (async (input) => {
			counts.fetches += 1;
			const url = String(input);
			if (url === `${origin}/api/tags`) {
				if (!ready) {
					probeStarted?.();
					await probeGate;
					throw new TypeError("fixture connection refused");
				}
				return Response.json({ models: [{ name: "fixture:test", size: 42 }] });
			}
			if (url === `${origin}/api/chat`) {
				verificationStarted?.();
				await verificationGate;
				return Response.json({ done: true, message: { content: "READY" } });
			}
			throw new Error("Unexpected fixture request");
		}) as typeof fetch,
		spawn: (() => {
			counts.spawns += 1;
			ready = true;
			const child = fakeChild();
			const kill = child.kill;
			child.kill = (signal) => {
				counts.kills += 1;
				ready = false;
				return kill(signal);
			};
			return child;
		}) as unknown as typeof import("node:child_process").spawn,
	});
	return {
		store, manager, counts, origin,
		seed: { KESTREL_ENABLE_OLLAMA: "1", KESTREL_OLLAMA_BASE_URL: origin, KESTREL_OLLAMA_MODEL: "fixture:test" },
		markExternalReady: () => { ready = true; },
		holdInitialProbe: () => {
			let release!: () => void;
			probeGate = new Promise<void>((resolve) => { release = resolve; });
			const started = new Promise<void>((resolve) => { probeStarted = resolve; });
			return { release, started };
		},
		holdVerification: () => {
			let release!: () => void;
			verificationGate = new Promise<void>((resolve) => { release = resolve; });
			const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
			return { release, started };
		},
	};
}

describe("persisted account and managed runtime lifecycle", () => {
	it.each(["absent", "disabled", "removed", "custom-port", "remote", "gateway"])(
		"does not fetch or spawn for an %s managed route, including onboarding status",
		async (state) => {
			const fixture = await guardedRuntimeFixture();
			const { store, manager, counts, origin, seed } = fixture;
			if (state === "disabled" || state === "removed") {
				await store.ensureLegacyAccounts(seed);
				if (state === "disabled") await store.update({ id: "legacy-ollama", enabled: false });
				else await store.remove("legacy-ollama");
				await store.ensureLegacyAccounts(seed);
			} else if (state !== "absent") {
				await store.create({
					providerId: "fixture-local", displayName: "Fixture local", authTransport: "local", enabled: true, headers: [],
					adapter: state === "gateway" ? "openai-compatible" : "ollama",
					baseUrl: state === "custom-port" ? "http://127.0.0.1:43124" : state === "remote" ? "https://models.example.test" : origin,
				});
			}
			const enabled = await store.hasEnabledManagedOllamaAccount(origin);
			expect(enabled).toBe(false);
			await manager.ensureChatReady(enabled);
			await expect(manager.status(enabled)).resolves.toMatchObject({ managedRuntime: true, ollamaAvailable: false, localModels: [] });
			expect(counts).toEqual({ fetches: 0, spawns: 0, kills: 0 });
		},
	);

	it("starts the enabled managed route and stops only its owned child when disabled", async () => {
		const { store, manager, counts, origin, seed } = await guardedRuntimeFixture();
		await store.ensureLegacyAccounts(seed);
		await manager.ensureChatReady(await store.hasEnabledManagedOllamaAccount(origin));
		expect(counts.spawns).toBe(1);
		await expect(manager.status(true)).resolves.toMatchObject({ ollamaAvailable: true });
		const fetches = counts.fetches;
		await store.update({ id: "legacy-ollama", enabled: false });
		await manager.ensureChatReady(await store.hasEnabledManagedOllamaAccount(origin));
		await manager.ensureChatReady(await store.hasEnabledManagedOllamaAccount(origin));
		expect(counts).toEqual({ fetches, spawns: 1, kills: 1 });
	});

	it("cancels a delayed normal readiness probe before it can spawn after disable", async () => {
		const { store, manager, counts, origin, seed, holdInitialProbe } = await guardedRuntimeFixture();
		await store.ensureLegacyAccounts(seed);
		const probe = holdInitialProbe();
		const warming = manager.ensureChatReady(await store.hasEnabledManagedOllamaAccount(origin));
		const rejected = expect(warming).rejects.toMatchObject({ name: "AbortError" });
		await probe.started;
		await store.update({ id: "legacy-ollama", enabled: false });
		await manager.ensureChatReady(await store.hasEnabledManagedOllamaAccount(origin));
		probe.release();
		await rejected;
		await manager.ensureChatReady(false);
		expect(counts).toEqual({ fetches: 1, spawns: 0, kills: 0 });
	});

	it("leaves an externally owned service running when the local route is disabled", async () => {
		const { store, manager, counts, origin, seed, markExternalReady } = await guardedRuntimeFixture();
		await store.ensureLegacyAccounts(seed);
		markExternalReady();
		await manager.ensureChatReady(await store.hasEnabledManagedOllamaAccount(origin));
		const fetches = counts.fetches;
		await store.update({ id: "legacy-ollama", enabled: false });
		await manager.ensureChatReady(await store.hasEnabledManagedOllamaAccount(origin));
		expect(counts).toEqual({ fetches, spawns: 0, kills: 0 });
	});

	it("allows explicit first-run setup and seeds its route without chat warmup cancelling setup", async () => {
		const { store, manager, counts, origin, seed, holdVerification } = await guardedRuntimeFixture();
		expect(await store.hasEnabledManagedOllamaAccount(origin)).toBe(false);
		await manager.ensureChatReady(false);
		expect(counts.fetches).toBe(0);
		const verification = holdVerification();
		const setup = manager.bootstrap("fixture:test");
		await verification.started;
		await manager.ensureChatReady(false);
		expect(counts.kills).toBe(0);
		verification.release();
		await expect(setup).resolves.toMatchObject({ verifiedModel: "fixture:test", ollamaAvailable: true });
		await store.ensureLegacyAccounts(seed);
		expect(await store.hasEnabledManagedOllamaAccount(origin)).toBe(true);
		await manager.ensureChatReady(await store.hasEnabledManagedOllamaAccount(origin));
		expect(counts.spawns).toBe(1);
		await manager.stop();
	});
});
