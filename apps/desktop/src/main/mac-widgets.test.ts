import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "@kestrel/shared-types";
import {
	MAC_WIDGETS_GROUP_ID,
	MacWidgetsStore,
	macWidgetsGroupContainerPath,
	macWidgetsSnapshotDirectory,
	widgetSnapshotFromWorkspace,
} from "./mac-widgets";

function snapshotFixture(): WorkspaceSnapshot {
	return {
		productName: "Kestrel",
		agentState: "waiting_approval",
		autonomyLevel: "assistant",
		opportunity: {
			id: "opportunity-1",
			title: "Prepare the launch brief",
			description: "Review the latest notes and prepare a concise launch brief.",
			reasonDetected: "The project has a new milestone.",
			triggerEventIds: [],
			relatedEntityIds: [],
			relevantMemoryIds: [],
			proposedGoal: "Finish the launch brief",
			expectedOutputs: [],
			confidence: 0.8,
			urgency: 0.5,
			importance: 0.8,
			expectedUtility: 1,
			estimatedInterruptionCost: 0,
			estimatedComputeCost: 0,
			riskLevel: "low",
			requiredApprovalLevel: 1,
			status: "awaiting_approval",
			createdAt: "2026-08-23T07:00:00.000Z",
			priority: 1,
		},
		approvals: [
			{
				id: "approval-1",
				title: "Send the launch brief",
				recommendation: "Review and send",
				reasoning: "The draft is ready.",
				proposedEmail: { to: "owner@example.com", subject: "Launch", body: "Draft" },
				proposedCalendarEvent: { title: "Launch", startsAt: "2026-08-24T09:00:00.000Z", durationMinutes: 30 },
				proposedStudyBlocks: [],
				evidence: [],
				riskLevel: "low",
				approvalLevel: 1,
				status: "pending",
				policySuggestion: "Review before sending.",
				createdAt: "2026-08-23T07:00:00.000Z",
			},
		],
		memories: [],
		activity: [],
		connections: [
			{ id: "local", name: "Local", status: "connected", detail: "Ready" },
			{ id: "calendar", name: "Calendar", status: "disconnected", detail: "Not connected" },
		],
		resourceUsage: {
			modelCostToday: 1.239,
			modelBudgetDaily: 10,
			activeWorkers: 2,
			maximumWorkers: 4,
		},
		modelRouting: {
			model: "auto",
			reasoningEffort: "auto",
			fastMode: "auto",
			currentDecision: {
				taskId: "task-1",
				model: "gpt-5.6-sol",
				reasoningEffort: "medium",
				fastMode: false,
				serviceTier: "standard",
				execution: "local",
				rationale: "Local fixture",
				selectedAt: "2026-08-23T07:00:00.000Z",
			},
		},
		personality: { selectedId: "default", available: [] },
		configuration: {
			currentVersionId: "config-version-00000000-0000-4000-8000-000000000000",
			sequence: 1,
			sha256: "a".repeat(64),
			knownGood: true,
			pendingProposals: 0,
			pendingImprovements: 0,
			ui: {
				density: "comfortable",
				showToolActivity: true,
				showConfigurationDiffs: true,
				announceVerification: true,
			},
		},
		updatedAt: "2026-08-23T07:00:00.000Z",
		memoryRecall: {
			chatInjection: "active",
			activeMemories: 0,
			confirmedPreferences: 0,
			explicitCapture: true,
			personalityScope: "shared",
			personalityName: "Pragmatic",
			useSharedContext: true,
		},
	};
}

describe("macOS widget bridge", () => {
	it("derives a bounded, content-light snapshot for useful widgets", () => {
		const result = widgetSnapshotFromWorkspace(snapshotFixture(), new Date("2026-08-23T07:30:00.000Z"));

		expect(result).toMatchObject({
			schemaVersion: 1,
			updatedAt: "2026-08-23T07:30:00.000Z",
			status: {
				kind: "waiting_approval",
				label: "Needs you",
				detail: "One action is waiting for approval",
			},
			focus: { title: "Prepare the launch brief" },
			queue: { approvals: 1, activeWorkers: 2, maximumWorkers: 4 },
			pulse: {
				model: "gpt-5.6-sol",
				modelCostToday: 1.24,
				modelBudgetDaily: 10,
				connectedConnections: 1,
				totalConnections: 2,
			},
		});
		expect(JSON.stringify(result)).not.toContain("Draft");
	});

	it("writes an owner-only atomic group-container snapshot", async () => {
		const root = mkdtempSync(join(tmpdir(), "kestrel-widget-test-"));
		try {
			const container = macWidgetsGroupContainerPath(root);
			mkdirSync(container, { recursive: true });
			const store = new MacWidgetsStore(container);
			const snapshot = widgetSnapshotFromWorkspace(snapshotFixture());

			await store.write(snapshot);

			expect(JSON.parse(readFileSync(store.snapshotPath, "utf8"))).toEqual(snapshot);
			expect(statSync(store.snapshotPath).mode & 0o777).toBe(0o600);
			expect(await store.read()).toEqual(snapshot);
			expect(container).toContain(join("Library", "Group Containers", MAC_WIDGETS_GROUP_ID));
			await store.clear();
			expect(await store.read()).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps isolated desktop test snapshots out of the real App Group", () => {
		const testUserData = "/tmp/kestrel-isolated-profile";

		expect(macWidgetsSnapshotDirectory("/Users/example", testUserData)).toBe(
			"/tmp/kestrel-isolated-profile/mac-widgets",
		);
		expect(macWidgetsSnapshotDirectory("/Users/example")).toBe(
			macWidgetsGroupContainerPath("/Users/example"),
		);
	});
});
