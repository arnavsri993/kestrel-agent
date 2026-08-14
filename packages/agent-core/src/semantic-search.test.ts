import { describe, it, expect } from "vitest";
import { localSemanticEmbedding, semanticSimilarity } from "./semantic-search";

describe("Semantic Search", () => {
  describe("localSemanticEmbedding", () => {
    it("should generate an embedding for a simple string", () => {
      const embedding = localSemanticEmbedding("hello world");
      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBe(256);
    });

    it("should handle empty strings", () => {
      const embedding = localSemanticEmbedding("");
      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBe(256);
      expect(embedding.every((val) => val === 0)).toBe(true);
    });

    it("should generate a normalized unit vector", () => {
      const embedding = localSemanticEmbedding("test vector normalization");
      let magnitude = 0;
      for (const component of embedding) magnitude += component * component;
      expect(magnitude).toBeCloseTo(1, 4);
    });

    it("should process special characters and punctuation gracefully", () => {
      const embedding1 = localSemanticEmbedding("hello, world!");
      const embedding2 = localSemanticEmbedding("hello world");
      expect(semanticSimilarity(embedding1, embedding2)).toBeGreaterThan(0.9);
    });
  });

  describe("semanticSimilarity", () => {
    it("should return 1 for identical embeddings", () => {
      const embedding = localSemanticEmbedding("identical text sequence");
      expect(semanticSimilarity(embedding, embedding)).toBeCloseTo(1, 4);
    });

    it("should return a high score for similar text", () => {
      const text1 = localSemanticEmbedding("the quick brown fox");
      const text2 = localSemanticEmbedding("quick brown foxes");
      const similarity = semanticSimilarity(text1, text2);
      expect(similarity).toBeGreaterThan(0.5);
    });

    it("should return a lower score for completely different text", () => {
      const text1 = localSemanticEmbedding("artificial intelligence");
      const text2 = localSemanticEmbedding("making a peanut butter sandwich");
      const similarity = semanticSimilarity(text1, text2);
      // Not strictly 0 due to random projection collisions, but should be relatively low
      expect(similarity).toBeLessThan(0.4);
    });

    it("should handle zero vectors", () => {
      const empty1 = localSemanticEmbedding("");
      const empty2 = localSemanticEmbedding("");
      expect(semanticSimilarity(empty1, empty2)).toBe(0);
    });
  });
});
