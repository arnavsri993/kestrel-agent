import { describe, expect, it } from "vitest";
import {
	isRoutingUnsafeMetadataValue,
	RoutingDisplayNameSchema,
	RoutingModelIdentifierSchema,
	RoutingOpaqueIdentifierSchema,
	RoutingProfileIdentifierSchema,
	RoutingSafeLabelSchema,
} from "./contracts";

describe("routing metadata", () => {
	it("accepts legitimate identifiers and labels through their documented limits", () => {
		expect(RoutingOpaqueIdentifierSchema.safeParse("a".repeat(100)).success).toBe(true);
		expect(RoutingModelIdentifierSchema.safeParse("vendor/model-v1").success).toBe(true);
		expect(RoutingModelIdentifierSchema.safeParse("m".repeat(200)).success).toBe(true);
		expect(RoutingProfileIdentifierSchema.safeParse("p".repeat(300)).success).toBe(true);
		expect(RoutingSafeLabelSchema.safeParse("Work model (fast)").success).toBe(true);
		expect(RoutingDisplayNameSchema.safeParse("d".repeat(300)).success).toBe(true);
	});

	it("rejects URLs, credentials and addresses while allowing ordinary punctuation", () => {
		for (const value of ["https://example.com", "See custom+v1://host", "user@example.com", "api-key-secret", "www.example.com"]) {
			expect(isRoutingUnsafeMetadataValue(value), value).toBe(true);
		}
		for (const value of ["vendor/model-v1", "Model + fast", "1http://host", "_http://host"]) {
			expect(isRoutingUnsafeMetadataValue(value), value).toBe(false);
		}
	});

	it("rejects oversized values before metadata scans, even when schema checks continue", () => {
		for (const value of ["a+".repeat(30_000), "a".repeat(301), "a".repeat(30_000) + "@example.com"]) {
			expect(isRoutingUnsafeMetadataValue(value)).toBe(true);
			for (const schema of [RoutingOpaqueIdentifierSchema, RoutingModelIdentifierSchema, RoutingProfileIdentifierSchema, RoutingSafeLabelSchema, RoutingDisplayNameSchema]) {
				expect(schema.safeParse(value).success).toBe(false);
			}
		}
	});
});
