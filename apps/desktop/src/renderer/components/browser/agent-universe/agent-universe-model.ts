import type {
	AgentRun,
	AgentPlanetAssetId,
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
	kind: "agent" | "subagent";
	parentId?: string;
	name: string;
	status: RuntimeSessionStatus;
	depth: number;
	planetAssetId?: AgentPlanetAssetId;
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
	/**
	 * The overview has eight planet slots so the spatial metaphor stays
	 * readable. These ids are a view concern only: `systems`, `nodes`, and
	 * `sessionCount` contain every explicit agent and its real subagent
	 * descendants, while ordinary conversations remain outside this map.
	 */
	overviewSystemIds: string[];
	overflowSystemIds: string[];
	nodes: AgentNodeProjection[];
	edges: AgentEdgeProjection[];
	sessionCount: number;
}

/** The overview's planet count; overflow remains available through focus. */
export const AGENT_UNIVERSE_PLANET_LIMIT = 8;

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

function parentSessionIdFor(
	session: RuntimeSession,
	byId: ReadonlyMap<string, RuntimeSession>,
): string | undefined {
	if (!session.parentSessionId || session.parentSessionId === session.id)
		return undefined;
	return byId.has(session.parentSessionId) ? session.parentSessionId : undefined;
}

/**
 * Build only the descendants that the runtime explicitly marked as
 * subagents. A title, a parent pointer, or a top-level chat is never enough to
 * turn a conversation into a planet or moon. The visited set keeps malformed
 * child cycles bounded without inventing a second system root.
 */
function agentSystemSessions(
	root: RuntimeSession,
	byId: ReadonlyMap<string, RuntimeSession>,
	childrenByParent: ReadonlyMap<string, readonly string[]>,
): RuntimeSession[] {
	const result: RuntimeSession[] = [root];
	const visited = new Set<string>([root.id]);
	const queue = [root.id];
	while (queue.length > 0) {
		const parentId = queue.shift()!;
		for (const childId of childrenByParent.get(parentId) ?? []) {
			if (visited.has(childId)) continue;
			const child = byId.get(childId);
			if (!child || child.kind !== "subagent") continue;
			visited.add(child.id);
			result.push(child);
			queue.push(child.id);
		}
	}
	return result;
}

function depthMapForSystem(
	rootId: string,
	sessions: RuntimeSession[],
	byId: ReadonlyMap<string, RuntimeSession>,
): Map<string, number> {
	const children = new Map<string, string[]>();
	for (const session of sessions) {
		if (session.id === rootId || session.kind !== "subagent") continue;
		const parentId = parentSessionIdFor(session, byId);
		if (!parentId) continue;
		const siblingIds = children.get(parentId) ?? [];
		siblingIds.push(session.id);
		children.set(parentId, siblingIds);
	}
	for (const siblingIds of children.values()) siblingIds.sort();

	const depths = new Map<string, number>([[rootId, 0]]);
	const queue = [rootId];
	while (queue.length > 0) {
		const parentId = queue.shift()!;
		const parentDepth = depths.get(parentId) ?? 0;
		for (const childId of children.get(parentId) ?? []) {
			if (depths.has(childId)) continue;
			depths.set(childId, Math.min(8, parentDepth + 1));
			queue.push(childId);
		}
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
	const childrenByParent = new Map<string, string[]>();
	for (const session of visible) {
		if (session.kind !== "subagent" || !session.parentSessionId) continue;
		const childIds = childrenByParent.get(session.parentSessionId) ?? [];
		childIds.push(session.id);
		childrenByParent.set(session.parentSessionId, childIds);
	}
	for (const childIds of childrenByParent.values()) childIds.sort();
	const roots = visible.filter((session) => session.kind === "agent");
	const systems: AgentSystemProjection[] = [];

	for (const root of [...roots].sort((left, right) => left.id.localeCompare(right.id))) {
		const systemSessions = agentSystemSessions(root, byId, childrenByParent);
		const depths = depthMapForSystem(root.id, systemSessions, byId);
		const nodes = systemSessions
			.map((session): AgentNodeProjection => {
				const parentId =
					session.id === root.id
						? undefined
						: parentSessionIdFor(session, byId);
				const workspaceName = agentWorkspaceName(session.workspaceRoot);
				const latestRun = latestRunFor(session.id, options.runsBySession);
				return {
					id: session.id,
					systemId: root.id,
					kind: session.kind === "agent" ? "agent" : "subagent",
					...(parentId ? { parentId } : {}),
					name: sessionTitleForDisplay(session.title),
					status: session.status,
					depth: depths.get(session.id) ?? 1,
					...(session.kind === "agent" && session.planetAssetId
						? { planetAssetId: session.planetAssetId }
						: {}),
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
	const overviewSystemIds = systems
		.slice(0, AGENT_UNIVERSE_PLANET_LIMIT)
		.map((system) => system.id);
	const overviewSystemIdSet = new Set(overviewSystemIds);
	const overflowSystemIds = systems
		.filter((system) => !overviewSystemIdSet.has(system.id))
		.map((system) => system.id);
	return {
		systems,
		overviewSystemIds,
		overflowSystemIds,
		nodes: systems.flatMap((system) => system.nodes),
		edges: systems.flatMap((system) => system.edges),
		sessionCount: systems.reduce((count, system) => count + system.nodes.length, 0),
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
