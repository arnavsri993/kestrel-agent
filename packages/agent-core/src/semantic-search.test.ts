import { describe, expect, test } from "vitest";
import { localSemanticEmbedding, semanticSimilarity } from "./semantic-search";

describe("Semantic Search", () => {
	test("localSemanticEmbedding generates a valid Float32Array", () => {
		const vector = localSemanticEmbedding("Hello world this is a test");
		expect(vector).toBeInstanceOf(Float32Array);
		expect(vector.length).toBe(256);

		// Check if the vector is normalized
		let magnitude = 0;
		for (let i = 0; i < vector.length; i++) {
			magnitude += vector[i]! * vector[i]!;
		}
		expect(magnitude).toBeCloseTo(1.0, 5);
	});

	test("localSemanticEmbedding handles empty strings", () => {
		const vector = localSemanticEmbedding("");
		expect(vector).toBeInstanceOf(Float32Array);
		expect(vector.length).toBe(256);

		// All components should be 0 since magnitude is 0
		let sum = 0;
		for (let i = 0; i < vector.length; i++) {
			sum += vector[i]!;
		}
		expect(sum).toBe(0);
	});

	test("semanticSimilarity calculates cosine similarity correctly", () => {
		const vec1 = localSemanticEmbedding(
			"The quick brown fox jumps over the lazy dog",
		);
		const vec2 = localSemanticEmbedding(
			"A quick brown fox leaps over a lazy dog",
		);
		const vec3 = localSemanticEmbedding(
			"Quantum mechanics is a fundamental theory in physics",
		);

		const similarity12 = semanticSimilarity(vec1, vec2);
		const similarity13 = semanticSimilarity(vec1, vec3);

		// Similarity between related sentences should be higher than unrelated
		expect(similarity12).toBeGreaterThan(similarity13);
		expect(similarity12).toBeGreaterThan(0);
		expect(similarity12).toBeLessThanOrEqual(1);

		// Similarity of identical vectors should be 1
		const similarity11 = semanticSimilarity(vec1, vec1);
		expect(similarity11).toBeCloseTo(1.0, 5);
	});
});
