import { describe, expect, it } from "vitest";
import { CoreRequestSchema, RendererRequestSchema } from "@kestrel/shared-types";
import { isNativeMemoryRecoveryInternalRequest, NATIVE_MEMORY_RECOVERY_REQUEST_TYPES } from "./native-memory-recovery-requests";

describe("native memory recovery request boundary", () => {
	it("reserves the data-bearing Core requests for the recovery host", () => {
		for (const request of [
			{ type: "memory-recovery-export", sessionId: "session" },
			{ type: "memory-recovery-preview", sessionId: "session", encoded: "backup" },
		]) {
			expect(RendererRequestSchema.safeParse(request).success).toBe(true);
			expect(CoreRequestSchema.safeParse(request).success).toBe(true);
			expect(isNativeMemoryRecoveryInternalRequest(request.type)).toBe(true);
		}
	});

	it("leaves native picker requests and approved recovery application available", () => {
		for (const type of [...NATIVE_MEMORY_RECOVERY_REQUEST_TYPES, "memory-recovery-apply", "runtime-run-agent"]) {
			expect(isNativeMemoryRecoveryInternalRequest(type)).toBe(false);
		}
	});
});
