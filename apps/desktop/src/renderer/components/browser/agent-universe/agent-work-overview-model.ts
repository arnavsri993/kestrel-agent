import type { AgentRun } from "@kestrel/shared-types";
import { agentSessionRecency } from "../../../agent-workspace";
import type {
	AgentNodeProjection,
	AgentSystemProjection,
	AgentUniverseSnapshot,
} from "./agent-universe-model";

export type AgentWorkGroupId =
	| "needs-attention"
	| "working"
	| "finished"
	| "ready";

export interface AgentWorkOverviewChild {
	id: string;
	name: string;
	statusLabel: string;
	workspaceName: string;
	recency: string;
	updatedAt: string;
	statusStale: boolean;
}

export interface AgentWorkOverviewItem {
	id: string;
	name: string;
	groupId: AgentWorkGroupId;
	statusLabel: string;
	workspaceName: string;
	recency: string;
	updatedAt: string;
	statusStale: boolean;
	delegatedCount: number;
	children: AgentWorkOverviewChild[];
	revealChildren: boolean;
}

export interface AgentWorkOverviewGroup {
	id: AgentWorkGroupId;
	label: string;
	items: AgentWorkOverviewItem[];
}

export interface AgentWorkOverviewOptions {
	runsLoading?: boolean;
	runsError?: string;
	now?: number;
}

const GROUPS: ReadonlyArray<Pick<AgentWorkOverviewGroup, "id" | "label">> = [
	{ id: "needs-attention", label: "Needs attention" },
	{ id: "working", label: "Working" },
	{ id: "finished", label: "Finished" },
	{ id: "ready", label: "Ready" },
];

const ATTENTION_RUN_STATUSES = new Set<AgentRun["status"]>([
	"waiting_approval",
	"waiting_input",
	"failed",
]);

function timestampValue(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function latestNode(
	nodes: readonly AgentNodeProjection[],
	predicate: (run: AgentRun) => boolean,
): AgentNodeProjection | undefined {
	return nodes
		.filter((node) => node.latestRun && predicate(node.latestRun))
		.sort(
			(left, right) =>
				timestampValue(right.latestRun!.updatedAt) -
					timestampValue(left.latestRun!.updatedAt) ||
				left.id.localeCompare(right.id),
		)[0];
}

function attentionStatusLabel(run: AgentRun, delegated: boolean): string {
	const label =
		run.status === "waiting_approval"
			? "Needs approval"
			: run.status === "waiting_input"
				? "Waiting for input"
				: "Run failed";
	return delegated ? `Delegated work: ${label.toLocaleLowerCase()}` : label;
}

function runStatusLabel(run: AgentRun): string {
	return {
		running: "Working",
		waiting_approval: "Needs approval",
		waiting_input: "Waiting for input",
		completed: "Run finished",
		cancelled: "Cancelled",
		failed: "Run failed",
	}[run.status];
}

function availabilityLabel(
	label: string,
	hasRun: boolean,
	options: AgentWorkOverviewOptions,
): { label: string; stale: boolean } {
	if (options.runsError) {
		return hasRun
			? { label: `Last known: ${label}`, stale: true }
			: { label: "Status unavailable", stale: false };
	}
	if (options.runsLoading) {
		return hasRun
			? { label: `Last known: ${label}`, stale: true }
			: { label: "Checking status", stale: false };
	}
	return { label, stale: false };
}

function classifySystem(
	system: AgentSystemProjection,
	options: AgentWorkOverviewOptions,
): { groupId: AgentWorkGroupId; statusLabel: string; statusStale: boolean } {
	const root =
		system.nodes.find((node) => node.id === system.rootNodeId) ??
		system.nodes[0];
	const attention = latestNode(system.nodes, (run) =>
		ATTENTION_RUN_STATUSES.has(run.status),
	);
	if (attention?.latestRun) {
		const status = availabilityLabel(
			attentionStatusLabel(
				attention.latestRun,
				attention.id !== system.rootNodeId,
			),
			true,
			options,
		);
		return {
			groupId: "needs-attention",
			statusLabel: status.label,
			statusStale: status.stale,
		};
	}

	const running = latestNode(
		system.nodes,
		(run) => run.status === "running",
	);
	if (running?.latestRun) {
		const status = availabilityLabel(
			running.id === system.rootNodeId
				? "Working"
				: "Delegated work is working",
			true,
			options,
		);
		return {
			groupId: "working",
			statusLabel: status.label,
			statusStale: status.stale,
		};
	}

	if (
		root?.latestRun?.status === "completed" ||
		root?.latestRun?.status === "cancelled"
	) {
		const status = availabilityLabel(
			runStatusLabel(root.latestRun),
			true,
			options,
		);
		return {
			groupId: "finished",
			statusLabel: status.label,
			statusStale: status.stale,
		};
	}

	const status = availabilityLabel("Ready", Boolean(root?.latestRun), options);
	return {
		groupId: "ready",
		statusLabel: status.label,
		statusStale: status.stale,
	};
}

function childStatus(
	node: AgentNodeProjection,
	options: AgentWorkOverviewOptions,
): { label: string; stale: boolean } {
	const label = node.latestRun ? runStatusLabel(node.latestRun) : "Ready";
	return availabilityLabel(label, Boolean(node.latestRun), options);
}

function searchableText(
	system: AgentSystemProjection,
	node?: AgentNodeProjection,
): string {
	return [
		node?.name ?? system.name,
		node?.workspaceName ?? system.workspaceName ?? "",
		node?.latestRun ? runStatusLabel(node.latestRun) : "ready",
	]
		.join(" ")
		.toLocaleLowerCase();
}

/**
 * Builds one truthful row per persistent agent. Descendants can raise the
 * owner's priority, but never become duplicate top-level rows.
 */
export function buildAgentWorkOverview(
	snapshot: AgentUniverseSnapshot,
	query: string,
	options: AgentWorkOverviewOptions = {},
): AgentWorkOverviewGroup[] {
	const needle = query.trim().toLocaleLowerCase();
	const groups = new Map<AgentWorkGroupId, AgentWorkOverviewItem[]>(
		GROUPS.map(({ id }) => [id, []]),
	);

	for (const system of snapshot.systems) {
		const root =
			system.nodes.find((node) => node.id === system.rootNodeId) ??
			system.nodes[0];
		if (!root) continue;
		const descendants = system.nodes.filter(
			(node) => node.id !== system.rootNodeId,
		);
		const rootMatches = !needle || searchableText(system, root).includes(needle);
		const matchingChildren = needle
			? descendants.filter((node) => searchableText(system, node).includes(needle))
			: descendants;
		if (!rootMatches && matchingChildren.length === 0) continue;

		const classification = classifySystem(system, options);
		const visibleChildren = rootMatches ? descendants : matchingChildren;
		const children = visibleChildren.map((node): AgentWorkOverviewChild => {
			const status = childStatus(node, options);
			return {
				id: node.id,
				name: node.name,
				statusLabel: status.label,
				workspaceName:
					node.workspaceName ?? system.workspaceName ?? "No project",
				recency: agentSessionRecency(node.updatedAt, options.now),
				updatedAt: node.updatedAt,
				statusStale: status.stale,
			};
		});
		const item: AgentWorkOverviewItem = {
			id: system.rootNodeId,
			name: system.name,
			groupId: classification.groupId,
			statusLabel: classification.statusLabel,
			workspaceName:
				root.workspaceName ?? system.workspaceName ?? "No project",
			recency: agentSessionRecency(system.lastActivityAt, options.now),
			updatedAt: system.lastActivityAt,
			statusStale: classification.statusStale,
			delegatedCount: descendants.length,
			children,
			revealChildren: Boolean(needle && matchingChildren.length > 0),
		};
		groups.get(classification.groupId)!.push(item);
	}

	return GROUPS.map(({ id, label }) => ({
		id,
		label,
		items: groups.get(id)!,
	}));
}
