import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentRuntime } from "./runtime";
import { ArtifactManager, installMediaTools } from "./media-artifacts";
import { LocalDocumentProvider, OpenAiMediaProvider, OpenAiTranscriptionProvider } from "./media-providers";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("media artifact workflow", () => {
  it("approval-gates generation, writes verified bytes, and records provenance privately", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-artifacts-"));
    directories.push(root);
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0,0x49,0x48,0x44,0x52,0,0,0,1,0,0,0,1]);
    const manager = new ArtifactManager(database, root, [{
      id: "fake-media", generate: async () => ({ data: png, mediaType: "image/png", model: "test-image", providerRequestId: "request-secret", estimatedCostUsd: 0.01 })
    }]);
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Media" });
    installMediaTools(runtime, manager, session.id);
    const input = { providerId: "fake-media", prompt: "one pixel", kind: "image", filename: "pixel" };
    expect((await runtime.callTool(session.id, "media.generate", input, { idempotencyKey: "pixel" })).status).toBe("blocked");
    const generated = await runtime.callTool(session.id, "media.generate", input, { approvalStatus: "approved", idempotencyKey: "pixel" });
    expect(generated).toMatchObject({ status: "verified", output: { filename: "pixel.png", mediaType: "image/png", width: 1, height: 1, providerId: "fake-media" } });
    expect(manager.inspect("pixel.png")).toMatchObject({ mediaType: "image/png", width: 1, height: 1, sha256: generated.output?.sha256 });
    expect(manager.list()).toHaveLength(1);
    const ciphertext = database.db.prepare("SELECT value_ciphertext FROM private_runtime_state WHERE key = ?").get("media.artifacts") as { value_ciphertext: string };
    expect(ciphertext.value_ciphertext).not.toContain("request-secret");
    database.close();
  });

  it("uses the production OpenAI image and speech contracts without exposing its credential", async () => {
    const requests: Array<{ url: string; authorization: string; body: string }> = [];
    const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0,0x49,0x48,0x44,0x52,0,0,0,1,0,0,0,1]);
    const provider = new OpenAiMediaProvider({ apiKey: "media-secret", fetcher: async (input, init) => {
      requests.push({ url: String(input), authorization: String(new Headers(init?.headers).get("authorization")), body: String(init?.body) });
      if (String(input).endsWith("/images/generations")) return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(png).toString("base64") }] }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "image-request" } });
      return new Response(Uint8Array.from([0x49,0x44,0x33,1,2,3]), { status: 200, headers: { "content-type": "audio/mpeg", "x-request-id": "speech-request" } });
    } });
    expect(await provider.generate({ prompt: "a kestrel", kind: "image", signal: new AbortController().signal })).toMatchObject({ mediaType: "image/png", model: "gpt-image-1.5", providerRequestId: "image-request" });
    expect(await provider.generate({ prompt: "hello", kind: "audio", signal: new AbortController().signal })).toMatchObject({ mediaType: "audio/mpeg", model: "gpt-4o-mini-tts", providerRequestId: "speech-request" });
    expect(requests[0]).toMatchObject({ url: "https://api.openai.com/v1/images/generations", authorization: "Bearer media-secret", body: expect.stringContaining("gpt-image-1.5") });
    expect(requests[1]?.body).toContain("gpt-4o-mini-tts");
    expect(JSON.stringify(await new LocalDocumentProvider().generate({ prompt: "# Report", kind: "document", signal: new AbortController().signal }))).toContain("local-markdown");
  });

  it("sends bounded multipart voice recordings through the production transcription contract", async () => {
    let captured: { url: string; authorization: string; model?: FormDataEntryValue; file?: FormDataEntryValue } | undefined;
    const provider = new OpenAiTranscriptionProvider({ apiKey: "voice-secret", fetcher: async (input, init) => {
      const form = init?.body as FormData;
      const model = form.get("model"); const file = form.get("file");
      captured = { url: String(input), authorization: String(new Headers(init?.headers).get("authorization")), ...(model ? { model } : {}), ...(file ? { file } : {}) };
      return new Response(JSON.stringify({ text: "  inspect the failing test  " }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "voice-request" } });
    } });
    const result = await provider.transcribe({ data: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), mediaType: "audio/webm", signal: new AbortController().signal });
    expect(result).toEqual({ text: "inspect the failing test", model: "gpt-4o-transcribe", providerRequestId: "voice-request" });
    expect(captured).toMatchObject({ url: "https://api.openai.com/v1/audio/transcriptions", authorization: "Bearer voice-secret", model: "gpt-4o-transcribe" });
    expect(captured?.file).toBeInstanceOf(Blob);
    expect((captured?.file as Blob).type).toBe("audio/webm");
  });
});
