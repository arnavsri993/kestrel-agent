import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalRuntimeProgress } from "@kestrel/shared-types";
import { LocalRuntimeManager, type LocalRuntimeManifest } from "./local-runtime-manager";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function testManifest(bytes: Uint8Array, sha256 = createHash("sha256").update(bytes).digest("hex")): LocalRuntimeManifest {
  return {
    runtime: "ollama",
    version: "test",
    platform: "darwin",
    architectures: ["arm64"],
    url: "https://github.com/ollama/ollama/releases/download/test/ollama-darwin.tgz",
    fileName: "ollama-darwin.tgz",
    sha256,
    bytes: bytes.byteLength,
    binaryPath: "ollama"
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; kill(signal?: NodeJS.Signals): boolean };
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
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url === manifest.url) return new Response(archive, { status: 200 });
      if (url.endsWith("/api/tags")) {
        if (!serviceReady) throw new TypeError("connection refused");
        return Response.json({ models: modelInstalled ? [{ name: "qwen:test", size: 42 }] : [] });
      }
      if (url.endsWith("/api/pull")) {
        modelInstalled = true;
        return new Response(`${JSON.stringify({ status: "pulling manifest", completed: 1, total: 1 })}\n`, { status: 200 });
      }
      if (url.endsWith("/api/chat")) return Response.json({ done: true, message: { content: "READY" } });
      throw new Error(`Unexpected URL: ${url}`);
    };
    const execute = async (_file: string, args: string[]) => {
      if (args[0] === "-tzf") return { stdout: "ollama\nlibreal.dylib\nliblink.dylib\n", stderr: "" };
      if (args[0] === "-xzf") {
        const destination = args[args.indexOf("-C") + 1]!;
        await writeFile(join(destination, "ollama"), "verified binary");
        await writeFile(join(destination, "libreal.dylib"), "verified library");
        await symlink("libreal.dylib", join(destination, "liblink.dylib"));
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    const manager = new LocalRuntimeManager(root, (event) => progress.push(event), {
      fetch: fetcher,
      execFile: execute,
      platform: "darwin",
      architecture: "arm64",
      manifest,
      spawn: (() => {
        serviceReady = true;
        return fakeChild();
      }) as unknown as typeof import("node:child_process").spawn
    });

    const status = await manager.bootstrap("qwen:test");

    expect(status).toMatchObject({
      automaticSupported: true,
      managedRuntime: true,
      ollamaAvailable: true,
      source: "managed",
      runtimeVersion: "test",
      localModels: [{ name: "qwen:test", size: 42 }],
      verifiedModel: "qwen:test"
    });
    expect(progress.map((event) => event.stage)).toEqual(expect.arrayContaining([
      "detecting",
      "downloading-runtime",
      "verifying-runtime",
      "installing-runtime",
      "starting-runtime",
      "downloading-model",
      "verifying-model",
      "ready"
    ]));
    const marker = JSON.parse(await readFile(join(root, "local-runtime", "ollama", "test", "workstrand-install.json"), "utf8"));
    expect(marker).toMatchObject({ version: "test", sha256: manifest.sha256, binaryPath: "ollama" });
    const verification = JSON.parse(await readFile(join(root, "local-runtime", "last-verification.json"), "utf8"));
    expect(verification).toMatchObject({ model: "qwen:test" });
    await manager.stop();

    serviceReady = false;
    const relaunched = new LocalRuntimeManager(root, () => undefined, {
      fetch: fetcher,
      execFile: execute,
      platform: "darwin",
      architecture: "arm64",
      manifest,
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
  });

  it("removes a partial install when the signed checksum does not match", async () => {
    const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
    roots.push(root);
    const archive = new TextEncoder().encode("tampered");
    const manifest = testManifest(archive, "0".repeat(64));
    const progress: LocalRuntimeProgress[] = [];
    const manager = new LocalRuntimeManager(root, (event) => progress.push(event), {
      fetch: (async (input) => {
        if (String(input).endsWith("/api/tags")) throw new TypeError("connection refused");
        return new Response(archive, { status: 200 });
      }) as typeof fetch,
      platform: "darwin",
      architecture: "arm64",
      manifest
    });

    await expect(manager.bootstrap("qwen:test")).rejects.toThrow("checksum");
    expect(progress.at(-1)).toMatchObject({ stage: "error" });
    await expect(readFile(join(root, "local-runtime", "ollama", "test", "workstrand-install.json"), "utf8")).rejects.toThrow();
  });

  it("fails closed to manual setup on unsupported platforms", async () => {
    const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
    roots.push(root);
    const archive = new TextEncoder().encode("archive");
    const manager = new LocalRuntimeManager(root, () => undefined, {
      fetch: (async () => { throw new TypeError("connection refused"); }) as typeof fetch,
      platform: "win32",
      architecture: "x64",
      manifest: testManifest(archive)
    });

    const status = await manager.status();
    expect(status).toMatchObject({ automaticSupported: false, ollamaAvailable: false, source: "none" });
    await expect(manager.bootstrap("qwen:test")).rejects.toThrow("manual setup");
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
    await expect(manager.bootstrap("qwen:test")).rejects.toThrow("manual setup");
  });

  it("cancels an oversized model-list response before parsing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "workstrand-local-runtime-"));
    roots.push(root);
    let cancelled = false;
    const reader = {
      read: async () => ({ done: false, value: { byteLength: 1_000_001 } as Uint8Array }),
      cancel: async () => {
        cancelled = true;
      },
      releaseLock: () => undefined,
    };
    const manager = new LocalRuntimeManager(root, () => undefined, {
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: { getReader: () => reader },
      }) as unknown as Response,
      platform: "darwin",
      architecture: "arm64",
      manifest: testManifest(new TextEncoder().encode("archive")),
    });

    await expect(manager.listModels()).rejects.toThrow("The local model service response exceeds 1 MB.");
    expect(cancelled).toBe(true);
  });
});
