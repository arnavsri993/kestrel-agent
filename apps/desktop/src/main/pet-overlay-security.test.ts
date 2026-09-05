import type { RendererRequest } from "@kestrel/shared-types";
import { describe, expect, it } from "vitest";
import {
	PetOverlayRequestAccess,
	petOverlayActivityForRuntimeEvent,
} from "./pet-overlay-security";

const petStreamId = "pet-123e4567-e89b-42d3-a456-426614174000";

describe("pet overlay IPC access", () => {
	it("allows only workspace-free sessions and their cancellable streams", () => {
		const access = new PetOverlayRequestAccess();
		expect(() => access.assertAllowed({ type: "pet-get" })).not.toThrow();
		expect(() =>
			access.assertAllowed({
				type: "runtime-create-session",
				title: "Pet · Pet task",
			}),
		).not.toThrow();
		expect(() =>
			access.assertAllowed({
				type: "runtime-create-session",
				title: "Pet · Pet task",
				workspaceRoot: "/private/project",
			}),
		).toThrow("cannot request access");
		expect(() =>
			access.assertAllowed({
				type: "runtime-create-session",
				title: "Unattributed quick task",
			}),
		).toThrow("visibly attributed");
		expect(() =>
			access.assertAllowed({
				type: "runtime-create-session",
				title: "Pet · Persistent agent attempt",
				kind: "agent",
			}),
		).toThrow("cannot create persistent agents");
		expect(() =>
			access.assertAllowed({
				type: "runtime-create-session",
				title: "Pet · Planet attempt",
				planetAssetId: "earth",
			}),
		).toThrow("cannot create persistent agents");

		access.registerSession("pet-session");
		expect(() =>
			access.assertAllowed({
				type: "runtime-run-agent",
				sessionId: "other-session",
				message: "Do work",
				model: "auto",
				providerIds: ["auto"],
				streamId: petStreamId,
			}),
		).toThrow("pet-owned session");
		expect(() =>
			access.assertAllowed({
				type: "runtime-run-agent",
				sessionId: "pet-session",
				message: "Do work",
				model: "auto",
				providerIds: ["auto"],
			}),
		).toThrow("cancellable stream");

		expect(() =>
			access.assertAllowed({
				type: "runtime-run-agent",
				sessionId: "pet-session",
				message: "Do work",
				model: "auto",
				providerIds: ["auto"],
				streamId: petStreamId,
			}),
		).not.toThrow();
		const baseRun: Extract<RendererRequest, { type: "runtime-run-agent" }> = {
			type: "runtime-run-agent",
			sessionId: "pet-session",
			message: "Do work",
			model: "auto",
			providerIds: ["auto"],
			streamId: "pet-123e4567-e89b-42d3-a456-426614174001",
		};
		const broadenedRuns: Array<
			Partial<Extract<RendererRequest, { type: "runtime-run-agent" }>>
		> = [
			{ approvalStatus: "approved" },
			{
				attachments: [
					{
						path: "/private/project/secret.txt",
						name: "secret.txt",
						mediaType: "text/plain",
						size: 10,
					},
				],
			},
			{ model: "hosted-model", providerIds: ["openai"] },
			{ providerModels: { openai: "hosted-model" } },
			{ maximumTurns: 50 },
			{ personalityId: "operator" },
		];
		for (const override of broadenedRuns)
			expect(() => access.assertAllowed({ ...baseRun, ...override })).toThrow(
				"fixed automatic routing",
			);
		expect(() =>
			access.assertAllowed({
				...baseRun,
				message: "x".repeat(10_001),
			}),
		).toThrow("10,000 characters");
		expect(() =>
			access.assertAllowed({
				...baseRun,
				streamId: "123e4567-e89b-42d3-a456-426614174000",
			}),
		).toThrow("isolated pet stream");
		access.beginStream(petStreamId);
		expect(() =>
			access.assertAllowed({
				...baseRun,
				streamId: "pet-123e4567-e89b-42d3-a456-426614174002",
			}),
		).toThrow("only one quick task");
		expect(() =>
			access.assertAllowed({
				type: "runtime-cancel-stream",
				streamId: petStreamId,
			}),
		).not.toThrow();
		expect(() =>
			access.assertAllowed({
				type: "runtime-cancel-stream",
				streamId: "main-stream",
			}),
		).toThrow("pet-owned stream");
		access.finishStream(petStreamId);
		access.registerSession("next-pet-session");
		expect(() => access.assertAllowed(baseRun)).toThrow("pet-owned session");
	});

	it("rejects privileged main-window requests and clears ownership", () => {
		const access = new PetOverlayRequestAccess();
		expect(() => access.assertAllowed({ type: "credential-list" })).toThrow(
			"not allowed",
		);
		access.registerSession("pet-session");
		access.beginStream(petStreamId);
		expect(access.drainStreamIds()).toEqual([petStreamId]);
		expect(access.drainStreamIds()).toEqual([]);
		expect(() =>
			access.assertAllowed({
				type: "runtime-cancel-stream",
				streamId: petStreamId,
			}),
		).toThrow("pet-owned stream");
	});

	it("exposes only an activity state for events from the owned session", () => {
		const access = new PetOverlayRequestAccess();
		access.registerSession("pet-session");
		const event = {
			id: "event-1",
			type: "tool.progress" as const,
			sessionId: "pet-session",
			executionId: "execution-1",
			payload: {
				message: "private output",
				path: "/private/project/secret.txt",
			},
			createdAt: "2026-07-27T12:00:00.000Z",
		};

		expect(petOverlayActivityForRuntimeEvent(access, event)).toBe("run");
		expect(
			petOverlayActivityForRuntimeEvent(access, {
				...event,
				sessionId: "main-session",
			}),
		).toBeUndefined();
		expect(
			petOverlayActivityForRuntimeEvent(access, {
				...event,
				type: "message.appended",
				payload: { role: "assistant", content: "private answer" },
			}),
		).toBe("wave");
		expect(
			petOverlayActivityForRuntimeEvent(access, {
				...event,
				type: "tool.completed",
				payload: { status: "failed", error: "private failure" },
			}),
		).toBe("failed");
		expect(
			petOverlayActivityForRuntimeEvent(access, {
				...event,
				type: "session.updated",
				payload: { action: "private action" },
			}),
		).toBeUndefined();
	});
});
