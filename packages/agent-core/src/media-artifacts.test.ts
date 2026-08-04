import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { AgentRuntime } from "./runtime";
import { ArtifactManager, installMediaTools } from "./media-artifacts";
import {
  LocalDocumentProvider,
  FalMusicProvider,
  OpenAiMediaProvider,
  OpenAiTranscriptionProvider,
  createEnvironmentTranscriptionProvider,
} from "./media-providers";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("media artifact workflow", () => {
  it("does not activate hosted transcription from a credential alone", () => {
    expect(createEnvironmentTranscriptionProvider({ OPENAI_API_KEY: "key" })).toBeUndefined();
    expect(createEnvironmentTranscriptionProvider({
      OPENAI_API_KEY: "key",
      KESTREL_ALLOW_HOSTED_TRANSCRIPTION: "true",
    })?.id).toBe("openai-transcription");
    expect(() => new OpenAiMediaProvider({ apiKey: "key", baseUrl: "not-a-url" })).toThrow("valid URL");
    expect(() => new OpenAiTranscriptionProvider({ apiKey: "key", baseUrl: "not-a-url" })).toThrow("valid URL");
  });

  it("recovers from malformed persisted artifact state", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-artifacts-"));
    directories.push(root);
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const manager = new ArtifactManager(database, root);
    database.setPrivateState("media.artifacts", { corrupted: true });
    expect(manager.list()).toEqual([]);
    database.setPrivateState("media.artifacts", [null, { id: "incomplete" }]);
    expect(manager.list()).toEqual([]);
    database.close();
  });

  it("approval-gates generation, writes verified bytes, and records provenance privately", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-artifacts-"));
    directories.push(root);
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48,
      0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    const manager = new ArtifactManager(database, root, [
      {
        id: "fake-media",
        generate: async () => ({
          data: png,
          mediaType: "image/png",
          model: "test-image",
          providerRequestId: "request-secret",
          estimatedCostUsd: 0.01,
        }),
      },
    ]);
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Media" });
    installMediaTools(runtime, manager, session.id);
    const input = {
      providerId: "fake-media",
      prompt: "one pixel",
      kind: "image",
      filename: "pixel",
    };
    expect(
      (
        await runtime.callTool(session.id, "media.generate", input, {
          idempotencyKey: "pixel",
        })
      ).status,
    ).toBe("blocked");
    const generated = await runtime.callTool(
      session.id,
      "media.generate",
      input,
      { approvalStatus: "approved", idempotencyKey: "pixel" },
    );
    expect(generated).toMatchObject({
      status: "verified",
      output: {
        filename: "pixel.png",
        mediaType: "image/png",
        width: 1,
        height: 1,
        providerId: "fake-media",
      },
    });
    expect(manager.inspect("pixel.png")).toMatchObject({
      mediaType: "image/png",
      width: 1,
      height: 1,
      sha256: generated.output?.sha256,
    });
    expect(manager.preview(manager.list()[0]!.id, Number.NaN)).toMatchObject({
      dataBase64: Buffer.from(png).toString("base64"),
      truncated: false,
    });
    await expect(manager.generate({ providerId: "fake-media", prompt: "one pixel", kind: "image", maximumBytes: Number.NaN }, new AbortController().signal)).rejects.toThrow("byte limit is invalid");
    expect(manager.list()).toHaveLength(1);
    const ciphertext = database.db
      .prepare(
        "SELECT value_ciphertext FROM private_runtime_state WHERE key = ?",
      )
      .get("media.artifacts") as { value_ciphertext: string };
    expect(ciphertext.value_ciphertext).not.toContain("request-secret");
    database.close();
  });

  it("uses the production OpenAI image and speech contracts without exposing its credential", async () => {
    const requests: Array<{
      url: string;
      authorization: string;
      body: string;
    }> = [];
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48,
      0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    const provider = new OpenAiMediaProvider({
      apiKey: "media-secret",
      fetcher: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: String(
            new Headers(init?.headers).get("authorization"),
          ),
          body: String(init?.body),
        });
        if (String(input).endsWith("/images/generations"))
          return new Response(
            JSON.stringify({
              data: [{ b64_json: Buffer.from(png).toString("base64") }],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-request-id": "image-request",
              },
            },
          );
        return new Response(Uint8Array.from([0x49, 0x44, 0x33, 1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-request-id": "speech-request",
          },
        });
      },
    });
    expect(
      await provider.generate({
        prompt: "a kestrel",
        kind: "image",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      mediaType: "image/png",
      model: "gpt-image-1.5",
      providerRequestId: "image-request",
    });
    expect(
      await provider.generate({
        prompt: "hello",
        kind: "audio",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      mediaType: "audio/mpeg",
      model: "gpt-4o-mini-tts",
      providerRequestId: "speech-request",
    });
    expect(requests[0]).toMatchObject({
      url: "https://api.openai.com/v1/images/generations",
      authorization: "Bearer media-secret",
      body: expect.stringContaining("gpt-image-1.5"),
    });
    expect(requests[1]?.body).toContain("gpt-4o-mini-tts");
    expect(
      JSON.stringify(
        await new LocalDocumentProvider().generate({
          prompt: "# Report",
          kind: "document",
          signal: new AbortController().signal,
        }),
      ),
    ).toContain("local-markdown");
  });

  it("bounds OpenAI image response bodies before parsing them", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: "cGl4ZWw=" }] })));
        controller.close();
      },
      cancel() {
        cancelled = true;
      }
    });
    const provider = new OpenAiMediaProvider({
      apiKey: "media-secret",
      fetcher: async () => new Response(body, { status: 200, headers: { "content-length": "150000001", "content-type": "application/json" } })
    });

    await expect(provider.generate({ prompt: "a kestrel", kind: "image", signal: new AbortController().signal })).rejects.toThrow("OpenAI image response exceeds 150 MB");
    expect(cancelled).toBe(true);
  });

  it("creates retained opaque-origin widgets through an approval-gated tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-widgets-"));
    directories.push(root);
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const manager = new ArtifactManager(database, root);
    const runtime = new AgentRuntime(database);
    const session = runtime.createSession({ title: "Widgets" });
    installMediaTools(runtime, manager, session.id);
    const input = {
      title: "Test chooser",
      widget_code: `<div class="card"><button onclick="this.textContent='Selected'">Choose</button></div>`,
    };
    expect(
      (
        await runtime.callTool(session.id, "show_widget", input, {
          idempotencyKey: "widget-1",
        })
      ).status,
    ).toBe("blocked");
    const result = await runtime.callTool(session.id, "show_widget", input, {
      approvalStatus: "approved",
      idempotencyKey: "widget-1",
    });
    expect(result).toMatchObject({
      status: "verified",
      output: {
        artifact: {
          mediaType: "text/html",
          artifactKind: "widget",
          title: "Test chooser",
          sessionId: session.id,
        },
        sandbox: {
          opaqueOrigin: true,
          network: false,
          parentAccess: false,
        },
      },
    });
    const record = manager.list()[0]!;
    const document = readFileSync(record.path, "utf8");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("navigator.userActivation.isActive");
    expect(document).toContain("Selected");
    expect(() =>
      manager.createWidget({
        title: "Unsafe",
        code: '<meta http-equiv="refresh" content="0;url=https://example.com">',
        sessionId: session.id,
      }),
    ).toThrow("security metadata");
    database.close();
  });

  it("submits fal MiniMax Music 2.6, constrains the download host, and records paid provenance", async () => {
    let submitted: Record<string, unknown> | undefined;
    const provider = new FalMusicProvider({
      apiKey: "fal-secret-value",
      client: {
        subscribe: async (_model: string, options: Record<string, unknown>) => {
          submitted = options;
          return {
            data: {
              audio: {
                url: "https://v3b.fal.media/files/test/output.mp3",
                content_type: "audio/mpeg",
                file_size: 7,
              },
            },
            requestId: "fal-music-request",
          };
        },
      } as never,
      fetcher: async () =>
        new Response(Uint8Array.from([0x49, 0x44, 0x33, 1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
    });
    const result = await provider.generate({
      prompt: "Warm analog ambient loop with a patient pulse",
      kind: "music",
      instrumental: true,
      format: "mp3",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      mediaType: "audio/mpeg",
      model: "fal-ai/minimax-music/v2.6",
      providerRequestId: "fal-music-request",
      estimatedCostUsd: 0.15,
    });
    expect(submitted).toMatchObject({
      input: {
        is_instrumental: true,
        audio_setting: { format: "mp3" },
      },
      logs: false,
    });
  });

  it("sends bounded reference images through the OpenAI image edits contract", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48,
      0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    let captured:
      | {
          url: string;
          authorization: string;
          model?: FormDataEntryValue;
          image?: FormDataEntryValue;
          size?: FormDataEntryValue;
          quality?: FormDataEntryValue;
        }
      | undefined;
    const provider = new OpenAiMediaProvider({
      apiKey: "edit-secret",
      fetcher: async (input, init) => {
        const form = init?.body as FormData;
        captured = {
          url: String(input),
          authorization: String(
            new Headers(init?.headers).get("authorization"),
          ),
          ...(form.get("model") ? { model: form.get("model")! } : {}),
          ...(form.get("image[]") ? { image: form.get("image[]")! } : {}),
          ...(form.get("size") ? { size: form.get("size")! } : {}),
          ...(form.get("quality") ? { quality: form.get("quality")! } : {}),
        };
        return new Response(
          JSON.stringify({
            data: [{ b64_json: Buffer.from(png).toString("base64") }],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-request-id": "edit-request",
            },
          },
        );
      },
    });
    const result = await provider.generate({
      prompt: "preserve the mascot",
      kind: "image",
      model: "gpt-image-2",
      referenceImages: [{ data: png, mediaType: "image/png" }],
      size: "1536x1024",
      quality: "medium",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      mediaType: "image/png",
      model: "gpt-image-2",
      providerRequestId: "edit-request",
    });
    expect(captured).toMatchObject({
      url: "https://api.openai.com/v1/images/edits",
      authorization: "Bearer edit-secret",
      model: "gpt-image-2",
      size: "1536x1024",
      quality: "medium",
    });
    expect(captured?.image).toBeInstanceOf(Blob);
  });

  it("sends bounded multipart voice recordings through the production transcription contract", async () => {
    let captured:
      | {
          url: string;
          authorization: string;
          model?: FormDataEntryValue;
          file?: FormDataEntryValue;
        }
      | undefined;
    const provider = new OpenAiTranscriptionProvider({
      apiKey: "voice-secret",
      fetcher: async (input, init) => {
        const form = init?.body as FormData;
        const model = form.get("model");
        const file = form.get("file");
        captured = {
          url: String(input),
          authorization: String(
            new Headers(init?.headers).get("authorization"),
          ),
          ...(model ? { model } : {}),
          ...(file ? { file } : {}),
        };
        return new Response(
          JSON.stringify({ text: "  inspect the failing test  " }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-request-id": "voice-request",
            },
          },
        );
      },
    });
    const result = await provider.transcribe({
      data: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]),
      mediaType: "audio/webm",
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      text: "inspect the failing test",
      model: "gpt-4o-transcribe",
      providerRequestId: "voice-request",
    });
    expect(captured).toMatchObject({
      url: "https://api.openai.com/v1/audio/transcriptions",
      authorization: "Bearer voice-secret",
      model: "gpt-4o-transcribe",
    });
    expect(captured?.file).toBeInstanceOf(Blob);
    expect((captured?.file as Blob).type).toBe("audio/webm");
  });
});
