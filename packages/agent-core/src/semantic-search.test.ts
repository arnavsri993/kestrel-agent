import { describe, expect, it } from "vitest";
import { localSemanticEmbedding, semanticSimilarity } from "./semantic-search";

describe("Semantic Search", () => {
  describe("localSemanticEmbedding", () => {
    it("generates a normalized Float32Array of length 256", () => {
      const embedding = localSemanticEmbedding("Hello world!");
      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBe(256);

      // Check normalization (magnitude should be close to 1)
      let magnitude = 0;
      for (const component of embedding) {
        magnitude += component * component;
      }
      expect(Math.abs(magnitude - 1)).toBeLessThan(0.01);
    });

    it("handles empty strings", () => {
      const embedding = localSemanticEmbedding("");
      expect(embedding).toBeInstanceOf(Float32Array);
      let sum = 0;
      for (const component of embedding) {
        sum += component;
      }
      expect(sum).toBe(0);
    });

    it("handles strings with only punctuation or short tokens", () => {
      const embedding = localSemanticEmbedding("a ! ? b");
      let sum = 0;
      for (const component of embedding) {
        sum += component;
      }
      expect(sum).toBe(0);
    });
  });

  describe("semanticSimilarity", () => {
    it("returns 1 for identical text embeddings", () => {
      const e1 = localSemanticEmbedding("This is a test document about software engineering.");
      const e2 = localSemanticEmbedding("This is a test document about software engineering.");
      const score = semanticSimilarity(e1, e2);
      expect(score).toBeGreaterThan(0.99); // Due to float imprecision
    });

    it("returns a high score for similar texts", () => {
      const e1 = localSemanticEmbedding("Software engineering is fun.");
      const e2 = localSemanticEmbedding("Software engineers enjoy building applications.");
      const score = semanticSimilarity(e1, e2);
      expect(score).toBeGreaterThan(0.2); // They share some structure/stemming
    });

    it("returns a lower score for dissimilar texts", () => {
      const e1 = localSemanticEmbedding("Software engineering is fun.");
      const e2 = localSemanticEmbedding("I like eating bananas and apples.");
      const similarScore = semanticSimilarity(e1, localSemanticEmbedding("Software developers build cool things."));
      const dissimilarScore = semanticSimilarity(e1, e2);
      expect(dissimilarScore).toBeLessThan(similarScore);
    });

    it("bounds the score between 0 and 1", () => {
      const e1 = new Float32Array(256).fill(0);
      const e2 = new Float32Array(256).fill(0);
      e1[0] = 2; // Artificially large value
      e2[0] = 2;
      const score = semanticSimilarity(e1, e2);
      expect(score).toBe(1); // Clamped to 1

      const e3 = new Float32Array(256).fill(0);
      e3[0] = -2;
      const negativeScore = semanticSimilarity(e1, e3);
      expect(negativeScore).toBe(0); // Clamped to 0
    });
  });
});
