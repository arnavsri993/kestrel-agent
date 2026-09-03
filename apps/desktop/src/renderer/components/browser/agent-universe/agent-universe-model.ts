import type {
	AgentRun,
	RuntimeEvent,
	RuntimeSession,
	RuntimeSessionStatus,
} from "@kestrel/shared-types";
import {
	agentSessionIsRenderable,
	agentWorkspaceName,
} from "../../../agent-workspace";
import { sessionTitleForDisplay } from "../../../chat-title";

export interface AgentUniverseActivity {
	id: string;
	type: RuntimeEvent["type"];
	sessionId: string;
	executionId?: string;
	createdAt: string;
}

export interface AgentNodeProjection {
	id: string;
	systemId: string;
	parentId?: string;
	name: string;
	status: RuntimeSessionStatus;
	depth: number;
	workspaceRoot?: string;
	workspaceName?: string;
	allowedTools: string[];
	createdAt: string;
	updatedAt: string;
	latestRun?: AgentRun;
}

export interface AgentEdgeProjection {
	id: string;
	sourceId: string;
	targetId: string;
	kind: "delegation";
}

export interface AgentSystemProjection {
	id: string;
	name: string;
	status: RuntimeSessionStatus;
	rootNodeId: string;
	nodes: AgentNodeProjection[];
	edges: AgentEdgeProjection[];
	activeTaskCount: number;
	lastActivityAt: string;
	workspaceName?: string;
}

export interface AgentUniverseSnapshot {
	systems: AgentSystemProjection[];
	nodes: AgentNodeProjection[];
	edges: AgentEdgeProjection[];
	sessionCount: number;
}

export interface AgentUniverseProjectionOptions {
	runsBySession?: ReadonlyMap<string, readonly AgentRun[]>;
}

export function agentUniverseRunStatusLabel(status: AgentRun["status"]): string {
	return {
		running: "Working",
		waiting_approval: "Needs approval",
		waiting_input: "Waiting for input",
		completed: "Completed",
		cancelled: "Cancelled",
		failed: "Failed",
	}[status];
}

export function agentUniverseRunIsPending(status: AgentRun["status"]): boolean {
	return (
		status === "running" ||
		status === "waiting_approval" ||
		status === "waiting_input"
	);
}

const ACTIVITY_EVENT_TYPES = new Set<RuntimeEvent["type"]>([
	"session.created",
	"session.updated",
	"message.appended",
	"tool.started",
	"tool.completed",
	"group-memory.updated",
]);

function timestampValue(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function stableSessionCompare(left: RuntimeSession, right: RuntimeSession): number {
	return (
		timestampValue(right.updatedAt) - timestampValue(left.updatedAt) ||
		left.id.localeCompare(right.id)
	);
}

function stableNodeCompare(left: AgentNodeProjection, right: AgentNodeProjection): number {
	return left.depth - right.depth || left.id.localeCompare(right.id);
}

function uniqueRenderableSessions(sessions: RuntimeSession[]): RuntimeSession[] {
	const byId = new Map<string, RuntimeSession>();
	for (const session of sessions) {
		if (!agentSessionIsRenderable(session)) continue;
		const current = byId.get(session.id);
		if (!current || stableSessionCompare(session, current) < 0)
			byId.set(session.id, session);
	}
	return [...byId.values()];
}

function parentSessionIdFor(
	session: RuntimeSession,
	byId: ReadonlyMap<string, RuntimeSession>,
): string | undefined {
	if (!session.parentSessionId || session.parentSessionId === session.id)
		return undefined;
	return byId.has(session.parentSessionId) ? session.parentSessionId : undefined;
}

/**
 * Follow a session's recorded ownership chain without trusting it to be
 * complete or acyclic. A deterministic member of a corrupt cycle becomes the
 * system root; the visual projection later breaks only that corrupt back-edge.
 */
function rootIdFor(
	session: RuntimeSession,
	byId: ReadonlyMap<string, RuntimeSession>,
): string {
	const path: string[] = [];
	const seen = new Map<string, number>();
	let current: RuntimeSession | undefined = session;
	while (current) {
		const seenAt = seen.get(current.id);
		if (seenAt !== undefined) {
			return [...path.slice(seenAt)].sort((left, right) => left.localeCompare(right))[0]!;
		}
		seen.set(current.id, path.length);
		path.push(current.id);
		const parentId = parentSessionIdFor(current, byId);
		current = parentId ? byId.get(parentId) : undefined;
	}
	return path.at(-1) ?? session.id;
}

function latestRunFor(
	sessionId: string,
	runsBySession?: ReadonlyMap<string, readonly AgentRun[]>,
): AgentRun | undefined {
	const runs = runsBySession?.get(sessionId);
	if (!runs?.length) return undefined;
	return [...runs].sort(
		(left, right) =>
			timestampValue(right.updatedAt) - timestampValue(left.updatedAt) ||
			left.id.localeCompare(right.id),
	)[0];
}

function depthMapForSystem(
	rootId: string,
	sessions: RuntimeSession[],
	byId: ReadonlyMap<string, RuntimeSession>,
): Map<string, number> {
	const children = new Map<string, string[]>();
	for (const session of sessions) {
		const parentId = parentSessionIdFor(session, byId);
		// The selected cycle root is the only corrupt edge we intentionally break.
		if (!parentId || session.id === rootId) continue;
		const siblings = children.get(parentId) ?? [];
		siblings.push(session.id);
		children.set(parentId, siblings);
	}
	for (const siblingIds of children.values()) siblingIds.sort();

	const depths = new Map<string, number>([[rootId, 0]]);
	const queue = [rootId];
	while (queue.length) {
		const parentId = queue.shift()!;
		const parentDepth = depths.get(parentId) ?? 0;
		for (const childId of children.get(parentId) ?? []) {
			if (depths.has(childId)) continue;
			depths.set(childId, Math.min(8, parentDepth + 1));
			queue.push(childId);
		}
	}

	// A malformed graph can still contain a disconnected component after the
	// corrupt edge is broken. Keep it inspectable instead of dropping it.
	for (const session of [...sessions].sort(stableSessionCompare)) {
		if (depths.has(session.id)) continue;
		let depth = 1;
		let current = session;
		const visited = new Set<string>();
		while (current.id !== rootId && !visited.has(current.id)) {
			visited.add(current.id);
			const parentId = parentSessionIdFor(current, byId);
			if (!parentId) break;
			if (depths.has(parentId)) {
				depth += depths.get(parentId)!;
				break;
			}
			const parent = byId.get(parentId);
			if (!parent) break;
			current = parent;
			depth += 1;
		}
		depths.set(session.id, Math.min(8, depth));
	}
	return depths;
}

/**
 * Project the encrypted runtime's durable sessions into the small, renderer-
 * owned shape needed by Agent Universe. No names, providers, priorities, or
 * activity scores are inferred here.
 */
export function projectAgentUniverse(
	sessions: RuntimeSession[],
	options: AgentUniverseProjectionOptions = {},
): AgentUniverseSnapshot {
	const visible = uniqueRenderableSessions(sessions);
	const byId = new Map(visible.map((session) => [session.id, session]));
	const rootIds = new Set(visible.map((session) => rootIdFor(session, byId)));
	const systems: AgentSystemProjection[] = [];

	for (const rootId of [...rootIds].sort((left, right) => left.localeCompare(right))) {
		const root = byId.get(rootId);
		if (!root) continue;
		const systemSessions = visible.filter(
			(session) => rootIdFor(session, byId) === rootId,
		);
		const depths = depthMapForSystem(rootId, systemSessions, byId);
		const nodes = systemSessions
			.map((session): AgentNodeProjection => {
				const parentId =
					session.id === rootId
						? undefined
						: parentSessionIdFor(session, byId);
				const workspaceName = agentWorkspaceName(session.workspaceRoot);
				const latestRun = latestRunFor(session.id, options.runsBySession);
				return {
					id: session.id,
					systemId: rootId,
					...(parentId ? { parentId } : {}),
					name: sessionTitleForDisplay(session.title),
					status: session.status,
					depth: depths.get(session.id) ?? 1,
					...(session.workspaceRoot ? { workspaceRoot: session.workspaceRoot } : {}),
					...(workspaceName ? { workspaceName } : {}),
					allowedTools: [...session.allowedTools],
					createdAt: session.createdAt,
					updatedAt: session.updatedAt,
					...(latestRun ? { latestRun } : {}),
				};
			})
			.sort(stableNodeCompare);
		const nodeIds = new Set(nodes.map((node) => node.id));
		const edges = nodes.flatMap((node): AgentEdgeProjection[] => {
			if (!node.parentId || !nodeIds.has(node.parentId)) return [];
			return [
				{
					id: `${node.parentId}->${node.id}`,
					sourceId: node.parentId,
					targetId: node.id,
					kind: "delegation",
				},
			];
		});
		const lastActivityAt = systemSessions.reduce(
			(latest, session) =>
				timestampValue(session.updatedAt) > timestampValue(latest)
					? session.updatedAt
					: latest,
			root.updatedAt,
		);
		systems.push({
			id: root.id,
			name: sessionTitleForDisplay(root.title),
			status: root.status,
			rootNodeId: root.id,
			nodes,
			edges,
			activeTaskCount: nodes.filter((node) =>
				node.latestRun ? agentUniverseRunIsPending(node.latestRun.status) : false,
			).length,
			lastActivityAt,
			...(agentWorkspaceName(root.workspaceRoot)
				? { workspaceName: agentWorkspaceName(root.workspaceRoot) }
				: {}),
		});
	}

	systems.sort(
		(left, right) =>
			timestampValue(right.lastActivityAt) - timestampValue(left.lastActivityAt) ||
			left.id.localeCompare(right.id),
	);
	return {
		systems,
		nodes: systems.flatMap((system) => system.nodes),
		edges: systems.flatMap((system) => system.edges),
		sessionCount: visible.length,
	};
}

export function stableAgentHash(value: string): number {
	// FNV-1a is small, deterministic, and more than sufficient for visual phase.
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

export function stableAgentAngle(id: string, band = 0): number {
	const unit = stableAgentHash(`${id}:${band}`) / 4_294_967_296;
	return unit * Math.PI * 2 - Math.PI / 2;
}

export function agentUniverseSearchMatches(
	snapshot: AgentUniverseSnapshot,
	query: string,
): { systemIds: Set<string>; nodeIds: Set<string> } {
	const needle = query.trim().toLocaleLowerCase();
	const systemIds = new Set<string>();
	const nodeIds = new Set<string>();
	if (!needle) return { systemIds, nodeIds };
	for (const system of snapshot.systems) {
		const systemMatches = [system.name, system.workspaceName ?? ""]
			.join(" ")
			.toLocaleLowerCase()
			.includes(needle);
		if (systemMatches) systemIds.add(system.id);
		for (const node of system.nodes) {
			if (
				systemMatches ||
				[node.name, node.workspaceName ?? ""].join(" ").toLocaleLowerCase().includes(needle)
			)
				nodeIds.add(node.id);
		}
	}
	return { systemIds, nodeIds };
}

export function appendAgentUniverseActivity(
	activities: AgentUniverseActivity[],
	event: RuntimeEvent,
): AgentUniverseActivity[] {
	if (!ACTIVITY_EVENT_TYPES.has(event.type)) return activities;
	const last = activities.at(-1);
	if (
		last &&
		last.sessionId === event.sessionId &&
		last.type === event.type &&
		timestampValue(event.createdAt) - timestampValue(last.createdAt) < 450
	)
		return activities;
	const activity: AgentUniverseActivity = {
		id: event.id,
		type: event.type,
		sessionId: event.sessionId,
		...(event.executionId ? { executionId: event.executionId } : {}),
		createdAt: event.createdAt,
	};
	return [...activities, activity].slice(-32);
}
