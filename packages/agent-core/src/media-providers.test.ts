import { describe, it, expect, vi } from "vitest";
import {
  LocalDocumentProvider,
  OpenAiMediaProvider,
  FalMusicProvider,
  OpenAiTranscriptionProvider,
  createEnvironmentMediaProviders,
  createEnvironmentTranscriptionProvider,
} from "./media-providers";
import type { FalClient } from "@fal-ai/client";

describe("LocalDocumentProvider", () => {
  it("should generate a document successfully", async () => {
    const provider = new LocalDocumentProvider();
    const result = await provider.generate({
      prompt: "# Hello World",
      kind: "document",
      signal: new AbortController().signal,
    });
    expect(result.mediaType).toBe("text/markdown");
    expect(result.model).toBe("local-markdown");
    expect(result.data.toString("utf8")).toBe("# Hello World");
  });

  it("should throw an error for unsupported kinds", async () => {
    const provider = new LocalDocumentProvider();
    await expect(
      provider.generate({
        prompt: "test",
        kind: "image",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("The local document provider only creates Markdown documents.");
  });

  it("should throw an error for empty prompt", async () => {
    const provider = new LocalDocumentProvider();
    await expect(
      provider.generate({
        prompt: "",
        kind: "document",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("Document content is invalid.");
  });

  it("should throw an error for excessively long prompt", async () => {
    const provider = new LocalDocumentProvider();
    await expect(
      provider.generate({
        prompt: "a".repeat(1_000_001),
        kind: "document",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("Document content is invalid.");
  });
});

describe("OpenAiMediaProvider", () => {
  it("should throw error on invalid api key", () => {
    expect(() => new OpenAiMediaProvider({ apiKey: "" })).toThrow("OpenAI media provider API key is invalid.");
    expect(() => new OpenAiMediaProvider({ apiKey: "a".repeat(1001) })).toThrow("OpenAI media provider API key is invalid.");
  });

  it("should throw error on invalid base url", () => {
    expect(() => new OpenAiMediaProvider({ apiKey: "valid", baseUrl: "http://api.openai.com" })).toThrow("OpenAI media provider base URL must be credential-free HTTPS.");
    expect(() => new OpenAiMediaProvider({ apiKey: "valid", baseUrl: "https://user:pass@api.openai.com" })).toThrow("OpenAI media provider base URL must be credential-free HTTPS.");
  });

  it("should generate image successfully", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from("fake-image").toString("base64") }] }),
      headers: new Headers({ "x-request-id": "req-123" }),
    });
    const provider = new OpenAiMediaProvider({ apiKey: "test-key", fetcher: mockFetcher as any });

    const result = await provider.generate({
      prompt: "a cat",
      kind: "image",
      signal: new AbortController().signal,
    });
    expect(mockFetcher).toHaveBeenCalled();
    expect(result.mediaType).toBe("image/png");
    expect(result.providerRequestId).toBe("req-123");
    expect(result.data.toString()).toBe("fake-image");
  });

  it("should handle error during image generation", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({ error: { message: "Bad image request" } }),
    });
    const provider = new OpenAiMediaProvider({ apiKey: "test-key", fetcher: mockFetcher as any });

    await expect(provider.generate({
      prompt: "a cat",
      kind: "image",
      signal: new AbortController().signal,
    })).rejects.toThrow("OpenAI image generation failed (400: Bad image request).");
  });

  it("should generate speech successfully", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "100", "x-request-id": "req-456" }),
      arrayBuffer: async () => new Uint8Array(100).buffer,
    });
    const provider = new OpenAiMediaProvider({ apiKey: "test-key", fetcher: mockFetcher as any });

    const result = await provider.generate({
      prompt: "hello",
      kind: "audio",
      signal: new AbortController().signal,
    });
    expect(mockFetcher).toHaveBeenCalled();
    expect(result.mediaType).toBe("audio/mpeg");
    expect(result.providerRequestId).toBe("req-456");
    expect(result.data.byteLength).toBe(100);
  });
});

describe("FalMusicProvider", () => {
  it("should throw error on invalid api key", () => {
    expect(() => new FalMusicProvider({ apiKey: "" })).toThrow("fal music API key is invalid.");
    expect(() => new FalMusicProvider({ apiKey: "short" })).toThrow("fal music API key is invalid.");
  });

  it("should generate music successfully", async () => {
    const mockClient = {
      subscribe: vi.fn().mockResolvedValue({
        data: { audio: { url: "https://fal.media/audio.mp3", content_type: "audio/mpeg", file_size: 100 } },
        requestId: "req-123",
      })
    } as unknown as FalClient;
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "audio/mpeg" }),
      arrayBuffer: async () => new Uint8Array(100).buffer,
    });

    const provider = new FalMusicProvider({ apiKey: "valid-api-key", client: mockClient, fetcher: mockFetcher as any });

    const result = await provider.generate({
      prompt: "make a nice song",
      kind: "music",
      signal: new AbortController().signal,
    });
    expect(mockClient.subscribe).toHaveBeenCalled();
    expect(mockFetcher).toHaveBeenCalled();
    expect(result.mediaType).toBe("audio/mpeg");
    expect(result.providerRequestId).toBe("req-123");
    expect(result.data.byteLength).toBe(100);
  });
});

describe("OpenAiTranscriptionProvider", () => {
  it("should throw error on invalid api key", () => {
    expect(() => new OpenAiTranscriptionProvider({ apiKey: "" })).toThrow("OpenAI transcription provider API key is invalid.");
  });

  it("should transcribe successfully", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "hello world" }),
      headers: new Headers({ "x-request-id": "req-123" }),
    });
    const provider = new OpenAiTranscriptionProvider({ apiKey: "test-key", fetcher: mockFetcher as any });

    const result = await provider.transcribe({
      data: new Uint8Array(100),
      mediaType: "audio/mpeg",
      signal: new AbortController().signal,
    });
    expect(mockFetcher).toHaveBeenCalled();
    expect(result.text).toBe("hello world");
    expect(result.providerRequestId).toBe("req-123");
  });
});

describe("Environment Providers", () => {
  it("createEnvironmentMediaProviders", () => {
    const env = {
      FAL_KEY: "valid-fal-key",
      OPENAI_API_KEY: "valid-openai-key",
    };
    const providers = createEnvironmentMediaProviders(env);
    expect(providers.length).toBe(3);
    expect(providers[0]).toBeInstanceOf(LocalDocumentProvider);
    expect(providers[1]).toBeInstanceOf(FalMusicProvider);
    expect(providers[2]).toBeInstanceOf(OpenAiMediaProvider);
  });

  it("createEnvironmentTranscriptionProvider", () => {
    const env = { OPENAI_API_KEY: "valid-openai-key" };
    const provider = createEnvironmentTranscriptionProvider(env);
    expect(provider).toBeInstanceOf(OpenAiTranscriptionProvider);
  });

  it("createEnvironmentTranscriptionProvider without key", () => {
    const env = {};
    const provider = createEnvironmentTranscriptionProvider(env);
    expect(provider).toBeUndefined();
  });
});
