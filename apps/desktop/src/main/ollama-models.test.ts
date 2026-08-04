import { describe, expect, it } from "vitest";
import { normalizeOllamaModels } from "./ollama-models";

describe("normalizeOllamaModels", () => {
  it("returns no models for malformed response roots or collections", () => {
    expect(normalizeOllamaModels(null)).toEqual([]);
    expect(normalizeOllamaModels([])).toEqual([]);
    expect(normalizeOllamaModels({ models: null })).toEqual([]);
    expect(normalizeOllamaModels({ models: "not-a-list" })).toEqual([]);
  });

  it("filters malformed entries while preserving bounded model details", () => {
    expect(normalizeOllamaModels({
      models: [
        null,
        [],
        { name: "", size: 2 },
        { name: "llama3", size: 1.9, modified_at: "2026-08-03T00:00:00Z" },
        { name: "qwen", size: "large" },
      ],
    })).toEqual([
      { name: "llama3", size: 1, modifiedAt: "2026-08-03T00:00:00Z" },
      { name: "qwen", size: 0 },
    ]);
  });
});
