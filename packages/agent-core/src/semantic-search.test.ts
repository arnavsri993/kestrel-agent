import { describe, expect, it } from "vitest";
import { localSemanticEmbedding, semanticSimilarity } from "./semantic-search.js";

describe("Semantic Search", () => {
  describe("localSemanticEmbedding", () => {
    it("returns a Float32Array of 256 dimensions", () => {
      const embedding = localSemanticEmbedding("hello world");
      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBe(256);
    });

    it("returns a normalized vector (magnitude of 1)", () => {
      const embedding = localSemanticEmbedding("test vector normalization");
      let magnitudeSquared = 0;
      for (const val of embedding) {
        magnitudeSquared += val * val;
      }
      expect(magnitudeSquared).toBeCloseTo(1, 5);
    });

    it("returns a zero vector for empty or non-word strings", () => {
      const embedding = localSemanticEmbedding("!!!");
      let magnitudeSquared = 0;
      for (const val of embedding) {
        magnitudeSquared += val * val;
      }
      expect(magnitudeSquared).toBe(0);
    });
  });

  describe("semanticSimilarity", () => {
    it("returns 1 for identical strings", () => {
      const a = localSemanticEmbedding("the quick brown fox jumps over the lazy dog");
      const b = localSemanticEmbedding("the quick brown fox jumps over the lazy dog");
      expect(semanticSimilarity(a, b)).toBeCloseTo(1, 5);
    });

    it("returns high similarity for similar strings", () => {
      const a = localSemanticEmbedding("running fast in the park");
      const b = localSemanticEmbedding("run fast in the park");
      expect(semanticSimilarity(a, b)).toBeGreaterThan(0.8);
    });

    it("returns higher similarity for related strings compared to unrelated ones", () => {
      const target = localSemanticEmbedding("artificial intelligence and machine learning");
      const similar = localSemanticEmbedding("machine learning AI system");
      const unrelated = localSemanticEmbedding("delicious chocolate chip cookies recipe");

      const similarScore = semanticSimilarity(target, similar);
      const unrelatedScore = semanticSimilarity(target, unrelated);

      expect(similarScore).toBeGreaterThan(unrelatedScore);
    });
    
    it("handles zero vectors gracefully", () => {
      const a = localSemanticEmbedding("hello");
      const b = localSemanticEmbedding("");
      expect(semanticSimilarity(a, b)).toBe(0);
    });
  });
});
