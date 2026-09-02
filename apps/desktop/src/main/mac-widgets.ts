import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentState, WorkspaceSnapshot } from "@kestrel/shared-types";

export const MAC_WIDGETS_GROUP_ID = "group.com.kestrel.desktop";
export const MAC_WIDGETS_FILE_NAME = "widgets.json";

const MAX_WIDGET_TEXT = 120;

export interface MacWidgetSnapshot {
	schemaVersion: 1;
	updatedAt: string;
	status: {
		kind: AgentState;
		label: string;
		detail: string;
	};
	focus: {
		title: string;
		detail: string;
	};
	queue: {
		approvals: number;
		activeWorkers: number;
		maximumWorkers: number;
	};
	pulse: {
		model: string;
		modelCostToday: number;
		modelBudgetDaily: number;
		connectedConnections: number;
		totalConnections: number;
	};
}

export function macWidgetsGroupContainerPath(
	homeDirectory = homedir(),
): string {
	return join(homeDirectory, "Library", "Group Containers", MAC_WIDGETS_GROUP_ID);
}

/**
 * Desktop smoke tests use an isolated user-data directory. Keep their widget
 * snapshots inside that directory instead of writing to the real account's
 * shared App Group container. The packaged app continues to use the App Group
 * path when no test directory is supplied.
 */
export function macWidgetsSnapshotDirectory(
	homeDirectory = homedir(),
	testUserDataDirectory?: string,
): string {
	return testUserDataDirectory
		? join(testUserDataDirectory, "mac-widgets")
		: macWidgetsGroupContainerPath(homeDirectory);
}

function boundedText(value: string, fallback: string): string {
	const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
	if (!normalized) return fallback;
	if (normalized.length <= MAX_WIDGET_TEXT) return normalized;
	return `${normalized.slice(0, MAX_WIDGET_TEXT - 1).trimEnd()}…`;
}

function boundedCount(value: number, maximum = 999): number {
	return Math.min(maximum, Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)));
}

function boundedMoney(value: number): number {
	return Math.min(
		1_000_000,
		Math.max(0, Number.isFinite(value) ? Math.round(value * 100) / 100 : 0),
	);
}

function statusCopy(
	state: AgentState,
	approvalCount: number,
	focusTitle: string,
): { label: string; detail: string } {
	switch (state) {
		case "working":
			return { label: "Working", detail: `On ${focusTitle}` };
		case "waiting_approval":
			return {
				label: "Needs you",
				detail:
					approvalCount === 1
						? "One action is waiting for approval"
						: approvalCount > 1
							? `${approvalCount} actions are waiting for approval`
							: "Kestrel is waiting for a review",
			};
		case "observing":
			return { label: "Observing", detail: "Watching for a useful next step" };
		case "paused":
			return { label: "Paused", detail: "Resume Kestrel when you are ready" };
		case "offline":
			return { label: "Offline", detail: "Open Kestrel to reconnect the local core" };
		case "error":
			return { label: "Needs attention", detail: "Open Kestrel to inspect the issue" };
		case "updating":
			return { label: "Updating", detail: "Kestrel will be ready again shortly" };
		case "idle":
		default:
			return { label: "Ready", detail: "Ask Kestrel to start something useful" };
	}
}

export function widgetSnapshotFromWorkspace(
	snapshot: WorkspaceSnapshot,
	now = new Date(),
): MacWidgetSnapshot {
	const approvals = boundedCount(
		snapshot.approvals.filter((approval) => approval.status === "pending").length,
	);
	const opportunityTitle = boundedText(
		snapshot.opportunity.title,
		"Your next move",
	);
	const focusTitle =
		snapshot.opportunity.status === "completed" ||
		snapshot.opportunity.status === "ignored"
			? "Your next move"
			: opportunityTitle;
	const copy = statusCopy(snapshot.agentState, approvals, focusTitle);
	const connectedConnections = snapshot.connections.filter(
		(connection) =>
			connection.status === "connected" ||
			connection.status === "development_adapter",
	).length;

	return {
		schemaVersion: 1,
		updatedAt: now.toISOString(),
		status: {
			kind: snapshot.agentState,
			label: copy.label,
			detail: boundedText(copy.detail, "Open Kestrel for details"),
		},
		focus: {
			title: focusTitle,
			detail: boundedText(
				snapshot.agentState === "working"
					? "Kestrel is carrying the current task forward."
					: snapshot.agentState === "waiting_approval"
						? "Review the requested action before Kestrel continues."
						: "Kestrel is ready for your next task.",
				"Kestrel is ready for your next task.",
			),
		},
		queue: {
			approvals,
			activeWorkers: boundedCount(snapshot.resourceUsage.activeWorkers, 64),
			maximumWorkers: boundedCount(snapshot.resourceUsage.maximumWorkers, 64),
		},
		pulse: {
			model: boundedText(
				snapshot.modelRouting.currentDecision.model,
				"Automatic routing",
			),
			modelCostToday: boundedMoney(snapshot.resourceUsage.modelCostToday),
			modelBudgetDaily: boundedMoney(snapshot.resourceUsage.modelBudgetDaily),
			connectedConnections: boundedCount(connectedConnections),
			totalConnections: boundedCount(snapshot.connections.length),
		},
	};
}

export class MacWidgetsStore {
	readonly snapshotPath: string;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly containerPath = macWidgetsGroupContainerPath()) {
		this.snapshotPath = join(containerPath, MAC_WIDGETS_FILE_NAME);
	}

	async write(snapshot: MacWidgetSnapshot): Promise<void> {
		const nextWrite = this.writeQueue.then(() => this.writeSnapshot(snapshot));
		this.writeQueue = nextWrite.catch(() => undefined);
		return nextWrite;
	}

	private async writeSnapshot(snapshot: MacWidgetSnapshot): Promise<void> {
		await mkdir(this.containerPath, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			await chmod(temporaryPath, 0o600);
			await rename(temporaryPath, this.snapshotPath);
			await chmod(this.snapshotPath, 0o600);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async clear(): Promise<void> {
		await this.writeQueue;
		await rm(this.snapshotPath, { force: true });
	}

	async read(): Promise<MacWidgetSnapshot | undefined> {
		try {
			return JSON.parse(await readFile(this.snapshotPath, "utf8")) as MacWidgetSnapshot;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
}
