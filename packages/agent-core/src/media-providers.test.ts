import { describe, expect, it, vi } from "vitest";
import { 
  OpenAiMediaProvider, 
  LocalDocumentProvider, 
  OpenAiTranscriptionProvider,
  createEnvironmentMediaProviders,
  createEnvironmentTranscriptionProvider
} from "./media-providers";

describe("Media Providers", () => {
  describe("LocalDocumentProvider", () => {
    it("generates markdown document", async () => {
      const provider = new LocalDocumentProvider();
      const result = await provider.generate({
        kind: "document",
        prompt: "# Hello World",
        signal: new AbortController().signal
      });

      expect(result.mediaType).toBe("text/markdown");
      expect(result.model).toBe("local-markdown");
      expect(Buffer.from(result.data).toString("utf8")).toBe("# Hello World");
    });

    it("throws when requesting non-document kind", async () => {
      const provider = new LocalDocumentProvider();
      await expect(provider.generate({
        kind: "image",
        prompt: "A beautiful sunset",
        signal: new AbortController().signal
      })).rejects.toThrow("only creates Markdown documents");
    });
  });

  describe("createEnvironmentMediaProviders", () => {
    it("creates LocalDocumentProvider by default", () => {
      const providers = createEnvironmentMediaProviders({});
      expect(providers.length).toBe(1);
      expect(providers[0].id).toBe("local-document");
    });

    it("creates OpenAiMediaProvider if OPENAI_API_KEY is present", () => {
      const providers = createEnvironmentMediaProviders({ OPENAI_API_KEY: "test-key" });
      expect(providers.length).toBe(2);
      expect(providers.map(p => p.id)).toContain("openai-media");
    });
  });

  describe("createEnvironmentTranscriptionProvider", () => {
    it("returns undefined if KESTREL_ALLOW_HOSTED_TRANSCRIPTION is not true", () => {
      const provider = createEnvironmentTranscriptionProvider({ OPENAI_API_KEY: "test-key" });
      expect(provider).toBeUndefined();
    });

    it("returns OpenAiTranscriptionProvider if configured correctly", () => {
      const provider = createEnvironmentTranscriptionProvider({ 
        OPENAI_API_KEY: "test-key",
        KESTREL_ALLOW_HOSTED_TRANSCRIPTION: "true"
      });
      expect(provider).toBeDefined();
      expect(provider?.id).toBe("openai-transcription");
    });
  });

  describe("OpenAiMediaProvider", () => {
    it("validates baseUrl", () => {
      expect(() => new OpenAiMediaProvider({ 
        apiKey: "test", 
        baseUrl: "not-a-url" 
      })).toThrow("valid URL");
      
      expect(() => new OpenAiMediaProvider({ 
        apiKey: "test", 
        baseUrl: "http://api.openai.com" 
      })).toThrow("HTTPS");
    });

    it("generates an image via fetcher", async () => {
      const mockFetcher = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "x-request-id": "req-123" }),
        json: async () => ({
          data: [{ b64_json: Buffer.from("fake-image").toString("base64") }]
        })
      });

      const provider = new OpenAiMediaProvider({
        apiKey: "test-key",
        fetcher: mockFetcher as any
      });

      const result = await provider.generate({
        kind: "image",
        prompt: "A beautiful sunset",
        signal: new AbortController().signal
      });

      expect(result.mediaType).toBe("image/png");
      expect(result.providerRequestId).toBe("req-123");
      expect(result.data.toString()).toBe("fake-image");
      
      expect(mockFetcher).toHaveBeenCalledWith(
        "https://api.openai.com/v1/images/generations",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            authorization: "Bearer test-key"
          })
        })
      );
    });

    it("generates speech via fetcher", async () => {
      const mockFetcher = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 
          "x-request-id": "req-audio",
          "content-length": "100"
        }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
      });

      const provider = new OpenAiMediaProvider({
        apiKey: "test-key",
        fetcher: mockFetcher as any
      });

      const result = await provider.generate({
        kind: "audio",
        prompt: "Hello world",
        signal: new AbortController().signal
      });

      expect(result.mediaType).toBe("audio/mpeg");
      expect(result.providerRequestId).toBe("req-audio");
      expect(result.data).toBeInstanceOf(Uint8Array);
      
      expect(mockFetcher).toHaveBeenCalledWith(
        "https://api.openai.com/v1/audio/speech",
        expect.objectContaining({
          method: "POST"
        })
      );
    });
  });

  describe("OpenAiTranscriptionProvider", () => {
    it("transcribes audio via fetcher", async () => {
      const mockFetcher = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "x-request-id": "req-transcribe" }),
        json: async () => ({ text: "Transcribed text" })
      });

      const provider = new OpenAiTranscriptionProvider({
        apiKey: "test-key",
        fetcher: mockFetcher as any
      });

      const result = await provider.transcribe({
        data: new Uint8Array([1, 2, 3]),
        mediaType: "audio/webm",
        signal: new AbortController().signal
      });

      expect(result.text).toBe("Transcribed text");
      expect(result.providerRequestId).toBe("req-transcribe");
      
      expect(mockFetcher).toHaveBeenCalledWith(
        "https://api.openai.com/v1/audio/transcriptions",
        expect.objectContaining({
          method: "POST"
        })
      );
    });
  });
});
