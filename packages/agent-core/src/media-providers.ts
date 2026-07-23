import type { GeneratedMedia, MediaGenerationProvider } from "./media-artifacts";

export interface OpenAiMediaProviderOptions {
  apiKey: string;
  baseUrl?: string;
  imageModel?: string;
  speechModel?: string;
  voice?: string;
  fetcher?: typeof fetch;
}

export interface VoiceTranscriptionProvider {
  readonly id: string;
  transcribe(input: { data: Uint8Array; mediaType: string; signal: AbortSignal }): Promise<{ text: string; model: string; providerRequestId?: string }>;
}

export interface OpenAiTranscriptionProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetcher?: typeof fetch;
}

async function boundedError(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 8_000);
  try { const parsed = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } }; return `${String(parsed.error?.code ?? response.status)}: ${String(parsed.error?.message ?? response.statusText)}`; }
  catch { return `${response.status}: ${response.statusText}`; }
}

export class OpenAiMediaProvider implements MediaGenerationProvider {
  readonly id = "openai-media";
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: OpenAiMediaProviderOptions) {
    if (!options.apiKey || options.apiKey.length > 1_000) throw new Error("OpenAI media provider API key is invalid.");
    const url = new URL(options.baseUrl ?? "https://api.openai.com/v1");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("OpenAI media provider base URL must be credential-free HTTPS.");
    this.baseUrl = url.toString().replace(/\/$/, ""); this.fetcher = options.fetcher ?? fetch;
  }

  async generate(input: { prompt: string; kind: "image" | "audio" | "video" | "document"; model?: string; signal: AbortSignal }): Promise<GeneratedMedia> {
    if (input.prompt.length < 1 || input.prompt.length > 100_000) throw new Error("Media prompt is invalid.");
    if (input.kind === "image") return this.image(input.prompt, input.model, input.signal);
    if (input.kind === "audio") return this.speech(input.prompt, input.model, input.signal);
    throw new Error("The OpenAI media provider currently supports image and speech generation; use a configured video provider or local document provider for other artifact kinds.");
  }

  private async image(prompt: string, requestedModel: string | undefined, signal: AbortSignal): Promise<GeneratedMedia> {
    const model = requestedModel ?? this.options.imageModel ?? "gpt-image-1.5";
    const response = await this.fetcher(`${this.baseUrl}/images/generations`, { method: "POST", signal, headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024", output_format: "png" }) });
    if (!response.ok) throw new Error(`OpenAI image generation failed (${await boundedError(response)}).`);
    const body = await response.json() as { data?: Array<{ b64_json?: unknown }> };
    const encoded = body.data?.[0]?.b64_json;
    if (typeof encoded !== "string" || encoded.length > 140_000_000) throw new Error("OpenAI image response did not include bounded base64 image data.");
    const data = Buffer.from(encoded, "base64");
    if (data.byteLength === 0 || data.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new Error("OpenAI image response contained invalid base64 data.");
    return { data, mediaType: "image/png", model, ...(response.headers.get("x-request-id") ? { providerRequestId: response.headers.get("x-request-id")!.slice(0, 200) } : {}) };
  }

  private async speech(prompt: string, requestedModel: string | undefined, signal: AbortSignal): Promise<GeneratedMedia> {
    const model = requestedModel ?? this.options.speechModel ?? "gpt-4o-mini-tts";
    const response = await this.fetcher(`${this.baseUrl}/audio/speech`, { method: "POST", signal, headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", accept: "audio/mpeg" }, body: JSON.stringify({ model, input: prompt, voice: this.options.voice ?? "alloy", response_format: "mp3" }) });
    if (!response.ok) throw new Error(`OpenAI speech generation failed (${await boundedError(response)}).`);
    const declared = Number(response.headers.get("content-length") ?? 0); if (declared > 100_000_000) throw new Error("OpenAI speech response exceeds 100 MB.");
    const data = new Uint8Array(await response.arrayBuffer()); if (data.byteLength === 0 || data.byteLength > 100_000_000) throw new Error("OpenAI speech response is empty or exceeds 100 MB.");
    return { data, mediaType: "audio/mpeg", model, ...(response.headers.get("x-request-id") ? { providerRequestId: response.headers.get("x-request-id")!.slice(0, 200) } : {}) };
  }
}

export class LocalDocumentProvider implements MediaGenerationProvider {
  readonly id = "local-document";
  async generate(input: { prompt: string; kind: "image" | "audio" | "video" | "document"; model?: string; signal: AbortSignal }): Promise<GeneratedMedia> {
    if (input.kind !== "document") throw new Error("The local document provider only creates Markdown documents.");
    if (!input.prompt || input.prompt.length > 1_000_000) throw new Error("Document content is invalid.");
    return { data: Buffer.from(input.prompt, "utf8"), mediaType: "text/markdown", model: input.model ?? "local-markdown" };
  }
}

export class OpenAiTranscriptionProvider implements VoiceTranscriptionProvider {
  readonly id = "openai-transcription";
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: OpenAiTranscriptionProviderOptions) {
    if (!options.apiKey || options.apiKey.length > 1_000) throw new Error("OpenAI transcription provider API key is invalid.");
    const url = new URL(options.baseUrl ?? "https://api.openai.com/v1");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("OpenAI transcription provider base URL must be credential-free HTTPS.");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async transcribe(input: { data: Uint8Array; mediaType: string; signal: AbortSignal }): Promise<{ text: string; model: string; providerRequestId?: string }> {
    if (!input.mediaType.startsWith("audio/") || input.mediaType.length > 200) throw new Error("Voice transcription requires an audio media type.");
    if (input.data.byteLength === 0 || input.data.byteLength > 25 * 1024 * 1024) throw new Error("Voice recording must be between 1 byte and 25 MB.");
    const model = this.options.model ?? "gpt-4o-transcribe";
    const form = new FormData();
    form.set("model", model);
    form.set("response_format", "json");
    const extension = input.mediaType.includes("webm") ? "webm" : input.mediaType.includes("wav") ? "wav" : input.mediaType.includes("mp4") ? "m4a" : "mp3";
    const recording = Uint8Array.from(input.data).buffer;
    form.set("file", new Blob([recording], { type: input.mediaType }), `kestrel-voice.${extension}`);
    const response = await this.fetcher(`${this.baseUrl}/audio/transcriptions`, { method: "POST", signal: input.signal, headers: { authorization: `Bearer ${this.options.apiKey}`, accept: "application/json" }, body: form });
    if (!response.ok) throw new Error(`OpenAI transcription failed (${await boundedError(response)}).`);
    const body = await response.json() as { text?: unknown };
    if (typeof body.text !== "string" || body.text.trim().length === 0 || body.text.length > 1_000_000) throw new Error("OpenAI transcription response did not include bounded text.");
    return { text: body.text.trim(), model, ...(response.headers.get("x-request-id") ? { providerRequestId: response.headers.get("x-request-id")!.slice(0, 200) } : {}) };
  }
}

export function createEnvironmentMediaProviders(environment: NodeJS.ProcessEnv = process.env): MediaGenerationProvider[] {
  const providers: MediaGenerationProvider[] = [new LocalDocumentProvider()];
  if (environment.OPENAI_API_KEY) providers.push(new OpenAiMediaProvider({ apiKey: environment.OPENAI_API_KEY, ...(environment.KESTREL_OPENAI_IMAGE_MODEL ? { imageModel: environment.KESTREL_OPENAI_IMAGE_MODEL } : {}), ...(environment.KESTREL_OPENAI_SPEECH_MODEL ? { speechModel: environment.KESTREL_OPENAI_SPEECH_MODEL } : {}), ...(environment.KESTREL_OPENAI_VOICE ? { voice: environment.KESTREL_OPENAI_VOICE } : {}) }));
  return providers;
}

export function createEnvironmentTranscriptionProvider(environment: NodeJS.ProcessEnv = process.env): VoiceTranscriptionProvider | undefined {
  if (!environment.OPENAI_API_KEY) return undefined;
  return new OpenAiTranscriptionProvider({ apiKey: environment.OPENAI_API_KEY, ...(environment.KESTREL_OPENAI_TRANSCRIPTION_MODEL ? { model: environment.KESTREL_OPENAI_TRANSCRIPTION_MODEL } : {}) });
}
