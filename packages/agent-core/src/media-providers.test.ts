import { describe, test, expect, vi } from "vitest";
import { 
  LocalDocumentProvider, 
  createEnvironmentMediaProviders, 
  createEnvironmentTranscriptionProvider,
  OpenAiMediaProvider,
  OpenAiTranscriptionProvider
} from "./media-providers";

describe("LocalDocumentProvider", () => {
  test("generates markdown document", async () => {
    const provider = new LocalDocumentProvider();
    const result = await provider.generate({
      kind: "document",
      prompt: "# Hello",
      signal: new AbortController().signal
    });

    expect(result.mediaType).toBe("text/markdown");
    expect(result.data.toString("utf8")).toBe("# Hello");
  });

  test("throws if kind is not document", async () => {
    const provider = new LocalDocumentProvider();
    await expect(provider.generate({
      kind: "image",
      prompt: "test",
      signal: new AbortController().signal
    })).rejects.toThrow("only creates Markdown");
  });
});

describe("createEnvironmentMediaProviders", () => {
  test("returns only local document provider if no keys", () => {
    const providers = createEnvironmentMediaProviders({});
    expect(providers.length).toBe(1);
    expect(providers[0]).toBeInstanceOf(LocalDocumentProvider);
  });

  test("includes FalMusicProvider if FAL_KEY is present", () => {
    const providers = createEnvironmentMediaProviders({ FAL_KEY: "valid_key_here" });
    expect(providers.some(p => p.id === "fal-music")).toBe(true);
  });

  test("includes OpenAiMediaProvider if OPENAI_API_KEY is present", () => {
    const providers = createEnvironmentMediaProviders({ OPENAI_API_KEY: "valid_key" });
    expect(providers.some(p => p.id === "openai-media")).toBe(true);
  });
});

describe("createEnvironmentTranscriptionProvider", () => {
  test("returns undefined if no keys or flag", () => {
    expect(createEnvironmentTranscriptionProvider({})).toBeUndefined();
    expect(createEnvironmentTranscriptionProvider({ OPENAI_API_KEY: "valid" })).toBeUndefined();
  });

  test("returns provider if key and flag are present", () => {
    const provider = createEnvironmentTranscriptionProvider({ 
      OPENAI_API_KEY: "valid", 
      KESTREL_ALLOW_HOSTED_TRANSCRIPTION: "true" 
    });
    expect(provider).toBeInstanceOf(OpenAiTranscriptionProvider);
  });
});

describe("OpenAiMediaProvider", () => {
  test("throws on invalid API key", () => {
    expect(() => new OpenAiMediaProvider({ apiKey: "" })).toThrow();
  });

  test("throws on invalid base URL", () => {
    expect(() => new OpenAiMediaProvider({ apiKey: "key", baseUrl: "not-a-url" })).toThrow();
    expect(() => new OpenAiMediaProvider({ apiKey: "key", baseUrl: "http://api.openai.com/v1" })).toThrow(/credential-free HTTPS/);
  });

  test("handles successful image generation", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: () => Promise.resolve({
        data: [{ b64_json: Buffer.from("test-image").toString("base64") }]
      })
    });

    const provider = new OpenAiMediaProvider({ apiKey: "key", fetcher });
    const result = await provider.generate({
      kind: "image",
      prompt: "a cat",
      signal: new AbortController().signal
    });

    expect(result.mediaType).toBe("image/png");
    expect(result.data.toString("utf8")).toBe("test-image");
  });

  test("handles successful speech generation", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "100" }),
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer)
    });

    const provider = new OpenAiMediaProvider({ apiKey: "key", fetcher });
    const result = await provider.generate({
      kind: "audio",
      prompt: "hello world",
      signal: new AbortController().signal
    });

    expect(result.mediaType).toBe("audio/mpeg");
    expect(result.data.byteLength).toBe(3);
  });
});

describe("OpenAiTranscriptionProvider", () => {
  test("throws on invalid parameters", () => {
    expect(() => new OpenAiTranscriptionProvider({ apiKey: "" })).toThrow();
  });

  test("handles successful transcription", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: () => Promise.resolve({ text: "hello world" })
    });

    const provider = new OpenAiTranscriptionProvider({ apiKey: "key", fetcher });
    const result = await provider.transcribe({
      data: new Uint8Array([1, 2, 3]),
      mediaType: "audio/mp3",
      signal: new AbortController().signal
    });

    expect(result.text).toBe("hello world");
  });
});
