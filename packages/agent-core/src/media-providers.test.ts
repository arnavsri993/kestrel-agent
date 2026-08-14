import { describe, expect, it } from "vitest";
import { 
  LocalDocumentProvider, 
  createEnvironmentMediaProviders, 
  createEnvironmentTranscriptionProvider,
  OpenAiMediaProvider,
  OpenAiTranscriptionProvider
} from "./media-providers.js";

describe("LocalDocumentProvider", () => {
  it("generates markdown document from prompt", async () => {
    const provider = new LocalDocumentProvider();
    const result = await provider.generate({ kind: "document", prompt: "# Hello\nWorld", signal: new AbortController().signal });
    expect(result.mediaType).toBe("text/markdown");
    expect(result.data.toString("utf8")).toBe("# Hello\nWorld");
    expect(result.model).toBe("local-markdown");
  });

  it("throws on invalid kind", async () => {
    const provider = new LocalDocumentProvider();
    await expect(provider.generate({ kind: "image", prompt: "test", signal: new AbortController().signal })).rejects.toThrow("The local document provider only creates Markdown documents.");
  });

  it("throws on empty prompt", async () => {
    const provider = new LocalDocumentProvider();
    await expect(provider.generate({ kind: "document", prompt: "", signal: new AbortController().signal })).rejects.toThrow("Document content is invalid.");
  });
});

describe("createEnvironmentMediaProviders", () => {
  it("always includes LocalDocumentProvider", () => {
    const providers = createEnvironmentMediaProviders({});
    expect(providers.length).toBe(1);
    expect(providers[0].id).toBe("local-document");
  });

  it("includes FalMusicProvider if FAL_KEY is present", () => {
    const providers = createEnvironmentMediaProviders({ FAL_KEY: "test-fal-key-that-is-long-enough" });
    expect(providers.length).toBe(2);
    expect(providers.map(p => p.id)).toContain("fal-music");
  });

  it("includes OpenAiMediaProvider if OPENAI_API_KEY is present", () => {
    const providers = createEnvironmentMediaProviders({ OPENAI_API_KEY: "test-openai-key" });
    expect(providers.length).toBe(2);
    expect(providers.map(p => p.id)).toContain("openai-media");
  });
});

describe("createEnvironmentTranscriptionProvider", () => {
  it("returns undefined if KESTREL_ALLOW_HOSTED_TRANSCRIPTION is not true", () => {
    const provider = createEnvironmentTranscriptionProvider({ OPENAI_API_KEY: "test" });
    expect(provider).toBeUndefined();
  });

  it("returns undefined if OPENAI_API_KEY is not set", () => {
    const provider = createEnvironmentTranscriptionProvider({ KESTREL_ALLOW_HOSTED_TRANSCRIPTION: "true" });
    expect(provider).toBeUndefined();
  });

  it("returns provider if both are set", () => {
    const provider = createEnvironmentTranscriptionProvider({ OPENAI_API_KEY: "test", KESTREL_ALLOW_HOSTED_TRANSCRIPTION: "true" });
    expect(provider?.id).toBe("openai-transcription");
  });
});

describe("OpenAiMediaProvider configuration", () => {
  it("throws on missing api key", () => {
    expect(() => new OpenAiMediaProvider({ apiKey: "" })).toThrow("OpenAI media provider API key is invalid.");
  });

  it("throws on invalid url", () => {
    expect(() => new OpenAiMediaProvider({ apiKey: "test", baseUrl: "not-a-url" })).toThrow("OpenAI media provider base URL must be a valid URL.");
  });

  it("throws on non-https url", () => {
    expect(() => new OpenAiMediaProvider({ apiKey: "test", baseUrl: "http://api.openai.com/v1" })).toThrow("OpenAI media provider base URL must be credential-free HTTPS.");
  });
});

describe("OpenAiTranscriptionProvider configuration", () => {
  it("throws on missing api key", () => {
    expect(() => new OpenAiTranscriptionProvider({ apiKey: "" })).toThrow("OpenAI transcription provider API key is invalid.");
  });

  it("throws on invalid url", () => {
    expect(() => new OpenAiTranscriptionProvider({ apiKey: "test", baseUrl: "not-a-url" })).toThrow("OpenAI transcription provider base URL must be a valid URL.");
  });
});
