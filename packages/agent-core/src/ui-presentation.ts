import { randomUUID } from "node:crypto";
import {
	UIPresentationOutputSchema,
	UIPresentationRequestSchema,
	UIPresentationSchema,
	type UIPresentationOutput,
} from "@kestrel/shared-types";
import { z } from "zod";
import type { AgentRuntime } from "./runtime";

export function createUIPresentation(
	input: unknown,
	now: () => string = () => new Date().toISOString(),
): UIPresentationOutput {
	const request = UIPresentationRequestSchema.parse(input);
	return UIPresentationOutputSchema.parse({
		presentation: UIPresentationSchema.parse({
			...request,
			id: `presentation-${randomUUID()}`,
			createdAt: now(),
			trust: "local_bounded",
		}),
	});
}

export function installUIPresentationTools(
	runtime: AgentRuntime,
	sessionId: string,
	now: () => string = () => new Date().toISOString(),
): string[] {
	const name = "ui.present";
	runtime.registerExternalTool({
		descriptor: {
			name,
			title: "Present structured result",
			description:
				"Present a bounded list, comparison, plan, or result card in the Kestrel conversation. This only renders local UI; it does not navigate, submit forms, add items to carts, or make purchases. External text and links remain untrusted.",
			category: "ui",
			riskLevel: "read_only",
			readOnly: true,
			requiresWorkspace: false,
			source: "builtin",
			tags: ["ui", "presentation", "cards", "commerce", "untrusted"],
		},
		inputSchema: z.toJSONSchema(UIPresentationRequestSchema) as Record<
			string,
			unknown
		>,
		execute: (_context, input) => createUIPresentation(input, now),
	});
	runtime.allowTool(sessionId, name);
	return [name];
}
