import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import {
	AgentCore,
	DevelopmentEmailConnector,
	type ModelProvider,
} from "./index";

const NOW = "2026-08-25T15:00:00.000Z";

function writingProvider(
	complete: ModelProvider["complete"],
): ModelProvider {
	return {
		id: "writing-provider",
		defaultModel: "gpt-5.6-terra",
		capabilities: {
			streaming: true,
			tools: true,
			images: false,
			audio: false,
			documents: false,
			local: false,
		},
		profileHints: {
			capabilities: {
				creative_writing: 0.99,
				structured_output: 0.99,
				instruction_following: 0.99,
				reliability: 0.98,
			},
			features: { structuredOutput: true, reasoningLevels: true },
		},
		complete,
	};
}

function result(
	request: Parameters<ModelProvider["complete"]>[0],
	toolName: string,
	argumentsValue: Record<string, unknown>,
) {
	return {
		providerId: "writing-provider",
		model: request.model,
		text: "",
		toolCalls: [{ id: `call-${toolName}`, name: toolName, arguments: argumentsValue }],
		usage: { inputTokens: 80, outputTokens: 40 },
		finishReason: "tool_calls" as const,
	};
}

describe("Writing Studio", () => {
	it("previews confirmed context and gates sensitive recipient records", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const core = new AgentCore({
			database,
			now: () => NOW,
		});
		const person = core.lifeContext.upsertPerson({
			displayName: "Taylor",
			relationship: "Project collaborator",
			tone: "Concise and warm",
			sourceId: "desktop-user",
			sensitivity: "sensitive",
		});

		const excluded = await core.handle({
			type: "writing-context-preview",
			recipient: "Taylor",
			purpose: "confirm the meeting",
			genre: "email",
			includeSensitive: false,
		});
		const included = await core.handle({
			type: "writing-context-preview",
			recipient: "Taylor",
			purpose: "confirm the meeting",
			genre: "email",
			includeSensitive: true,
		});

		expect(excluded).toMatchObject({
			ok: true,
			writingContextPreview: {
				sensitiveIncluded: false,
				restrictedIncluded: false,
			},
		});
		if (excluded.ok && excluded.writingContextPreview)
			expect(excluded.writingContextPreview.recipient).toBeUndefined();
		expect(included).toMatchObject({
			ok: true,
			writingContextPreview: {
				sensitiveIncluded: true,
				recipient: { id: person.id, displayName: "Taylor" },
			},
		});
		await core.close();
	});

	it("uses context-aware writer and independent reviewer calls without sending or persisting a draft", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const email = new DevelopmentEmailConnector();
		const requests: Array<Parameters<ModelProvider["complete"]>[0]> = [];
		const provider = writingProvider(async (request) => {
			requests.push(request);
			const name = request.tools?.[0]?.name;
			if (name === "writing_candidates")
				return result(request, name, {
					candidateA: {
						subject: "Meeting confirmation",
						body: "Hi Taylor,\n\nI can make the meeting on 2026-08-27.\n\nThanks,",
						changeSummary: ["Kept the note concise."],
					},
					candidateB: {
						subject: "Meeting confirmation",
						body: "Hi Taylor,\n\n2026-08-27 works for me. Looking forward to it.",
						changeSummary: ["Used a warmer close."],
					},
				});
			if (name === "writing_review")
				return result(request, name, {
					selected: "candidateB",
					approved: true,
					missingAnchors: [],
					inventedClaims: [],
					issues: [],
					reviewerNote: "Both candidates preserve the stated date.",
				});
			throw new Error(`Unexpected writing tool ${name ?? "none"}.`);
		});
		const core = new AgentCore({
			database,
			email,
			modelProviders: [provider],
			now: () => NOW,
		});
		core.lifeContext.upsertPerson({
			displayName: "Taylor",
			relationship: "Project collaborator",
			tone: "Concise and warm",
			sourceId: "desktop-user",
			sensitivity: "personal",
		});
		const mainSession = core.runtime.ensureMainSession();
		const messageCountBefore = core.runtime.listMessages(mainSession.id).length;

		const response = await core.handle({
			type: "writing-generate",
			recipient: "Taylor",
			purpose: "confirm the meeting on 2026-08-27",
			genre: "email",
			adaptationStrength: "balanced",
			includeSensitive: false,
			providerIds: ["auto"],
		});

		expect(response).toMatchObject({
			ok: true,
			writingResult: {
				recipient: "Taylor",
				sourceMode: "compose",
				quality: { modelReviewed: true, status: "passed" },
			},
			writingRoutes: [
				{ taskId: expect.stringContaining("writing-writer") },
				{ taskId: expect.stringContaining("writing-reviewer") },
			],
		});
		expect(requests).toHaveLength(2);
		expect(requests[0]?.messages[1]?.content[0]).toMatchObject({
			type: "text",
		});
		expect(requests[0]?.messages[1]?.content[0]).toMatchObject({
			text: expect.stringContaining("Project collaborator"),
		});
		expect(core.runtime.listMessages(mainSession.id)).toHaveLength(
			messageCountBefore,
		);
		expect(email.sent.size).toBe(0);
		await core.close();
	});

	it("repairs a missing factual anchor once and marks the draft for user attention", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		let calls = 0;
		const provider = writingProvider(async (request) => {
			calls += 1;
			const name = request.tools?.[0]?.name;
			if (name === "writing_candidates")
				return result(request, name, {
					candidateA: {
						body: "Hi, the meeting works for me.",
						changeSummary: [],
					},
					candidateB: {
						body: "That time works for me.",
						changeSummary: [],
					},
				});
			if (name === "writing_review")
				return result(request, name, {
					selected: "candidateA",
					approved: false,
					missingAnchors: ["2026"],
					inventedClaims: [],
					issues: ["The date was omitted."],
					reviewerNote: "Repair the date before use.",
				});
			if (name === "writing_repair")
				return result(request, name, {
					body: "Hi, the meeting on 2026-08-27 works for me.",
					resolvedIssues: ["Restored the date."],
				});
			throw new Error(`Unexpected writing tool ${name ?? "none"}.`);
		});
		const core = new AgentCore({
			database,
			modelProviders: [provider],
			now: () => NOW,
		});

		const response = await core.handle({
			type: "writing-generate",
			purpose: "confirm the meeting on 2026-08-27",
			genre: "message",
			adaptationStrength: "light",
			includeSensitive: false,
			providerIds: ["auto"],
		});

		expect(response).toMatchObject({
			ok: true,
			writingResult: {
				body: "Hi, the meeting on 2026-08-27 works for me.",
				quality: {
					factualAnchorCoverage: 1,
					status: "needs_attention",
					 reviewerIssues: ["2026", "The date was omitted."],
				},
			},
		});
		expect(calls).toBe(3);
		await core.close();
	});
});
