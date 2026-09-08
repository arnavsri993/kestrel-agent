import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import {
	createUIPresentation,
	installUIPresentationTools,
} from "./ui-presentation";
import { AgentRuntime } from "./runtime";

const NOW = "2026-09-02T12:00:00.000Z";

describe("bounded structured UI presentations", () => {
	it("installs a read-only ui.present tool and returns a trusted local envelope", async () => {
		const database = new KestrelDatabase(":memory:", createEncryptionKey());
		const runtime = new AgentRuntime(database, [], () => NOW);
		const session = runtime.createSession({ title: "Presentation" });

		try {
			expect(installUIPresentationTools(runtime, session.id, () => NOW)).toEqual([
				"ui.present",
			]);
			const descriptor = runtime
				.discoverTools(session.id)
				.find((tool) => tool.name === "ui.present");
			expect(descriptor).toMatchObject({
				category: "ui",
				riskLevel: "read_only",
				readOnly: true,
			});

			const execution = await runtime.callTool(session.id, "ui.present", {
				kind: "list",
				title: "Shortlist",
				description: "A bounded set of options.",
				items: [
					{
						title: "Option A",
						summary: "A source-backed option.",
						price: "$20",
						links: [
							{ label: "View source", url: "https://example.test/item-a" },
						],
					},
				],
			});

			expect(execution).toMatchObject({
				status: "verified",
				output: {
					presentation: {
						kind: "list",
						title: "Shortlist",
						createdAt: NOW,
						trust: "local_bounded",
					},
				},
			});
		} finally {
			database.close();
		}
	});

	it("rejects credential-bearing links and inconsistent comparison rows", () => {
		for (const url of [
			"https://user:secret@example.test/item",
			"https://example.test/item?access_token=secret",
			"https://example.test/item?api_key=secret",
			"https://example.test/item#access_token=secret",
		])
			expect(() =>
				createUIPresentation({
					kind: "result",
					title: "Unsafe link",
					summary: "Review this result.",
					links: [{ label: "Open", url }],
				}),
			).toThrow("credential-free HTTP(S)");

		expect(
			createUIPresentation({
				kind: "result",
				title: "Safe link",
				summary: "Review this result.",
				links: [
					{
						label: "Open",
						url: "https://example.test/item?utm_source=kestrel#details",
					},
				],
			}),
		).toMatchObject({
			presentation: {
				links: [
					{ url: "https://example.test/item?utm_source=kestrel#details" },
				],
			},
		});

		expect(() =>
			createUIPresentation({
				kind: "comparison",
				title: "Compare",
				columns: [
					{ key: "one", label: "One" },
					{ key: "two", label: "Two" },
				],
				rows: [{ label: "Price", values: ["$10"] }],
			}),
		).toThrow("one value per column");
	});
});
