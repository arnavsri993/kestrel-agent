import { localSemanticEmbedding, semanticSimilarity } from "./semantic-search";
import { dayFingerprint } from "./memory-consolidation";
import { randomUUID } from "node:crypto";
import type { KestrelDatabase } from "@kestrel/database";
import {
	MemoryDocumentSaveSchema,
	MemoryDocumentSchema,
	MemoryWorkspaceDaySummarySaveSchema,
	MemoryWorkspaceQuerySchema,
	MemoryWorkspaceSchema,
	type AgentIdentity,
	type MemoryDocument,
	type MemoryDocumentSave,
	type MemoryPassage,
	type MemoryWorkspace,
	type MemoryWorkspaceDaySummary,
	type MemoryWorkspaceDaySummarySave,
	type MemoryWorkspaceQuery,
	type RuntimeSession,
	type TimelineEvent,
} from "@kestrel/shared-types";
import type { MemoryManager } from "./memory";
import type { MemorySubstrate } from "./memory-substrate";

export interface MemoryWorkspaceServiceOptions {
	database: KestrelDatabase;
	substrate: MemorySubstrate;
	legacyMemory: MemoryManager;
	now?: () => Date;
}

export interface MemoryWorkspaceSearchInput {
	query: string;
	agentId?: string;
	sessionId?: string;
	maximumCharacters?: number;
}

function unique(values: readonly (string | undefined)[]): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function dayKey(iso: string): string {
	const value = new Date(iso);
	return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-");
}

function terms(value: string): string[] {
	return unique(value.toLocaleLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]{2,}/gu) ?? []);
}

function tier(value: string | undefined): MemoryDocument["tier"] {
	return value === "short_term" || value === "mid_term" ? value : "long_term";
}

export class MemoryWorkspaceService {
	private readonly database: KestrelDatabase;
	// Kept as explicit dependencies so the workspace cannot silently become a
	// second memory system with a separate lifecycle.
	private readonly substrate: MemorySubstrate;
	private readonly legacyMemory: MemoryManager;
	private readonly now: () => Date;

	constructor(options: MemoryWorkspaceServiceOptions) {
		this.database = options.database;
		this.substrate = options.substrate;
		this.legacyMemory = options.legacyMemory;
		this.now = options.now ?? (() => new Date());
	}

	read(input: Partial<MemoryWorkspaceQuery> = {}): MemoryWorkspace {
		void this.substrate;
		const query = MemoryWorkspaceQuerySchema.parse(input);
		const scope = this.scope(query.viewerId);
		const relevantDomains = this.relevantDomains(scope, query.domainId);
		const allDocuments = [
			...this.database.listMemoryWorkspaceDocuments(),
			...this.projectLegacyDocuments().filter(document => !this.database.hasMemoryWorkspaceDocumentRecord(document.id)),
		];
		const documents = allDocuments
			.filter(document => !query.domainId || document.domainIds.includes(query.domainId) || document.passages.some(passage => passage.domainIds.includes(query.domainId!)))
			.map(document => this.projectDocument(query.domainId ? { ...document, passages: document.passages.filter(passage => passage.domainIds.includes(query.domainId!)) } : document, scope, relevantDomains, query.includeSensitive))
			.filter((document): document is MemoryDocument => Boolean(document))
			.filter(document => !query.domainId || document.domainIds.includes(query.domainId))
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));

		const events = this.database.listTimelineEvents({
			...(query.startAt ? { startAt: query.startAt } : {}),
			...(query.endAt ? { endAt: query.endAt } : {}),
			includeSensitive: query.includeSensitive,
			includeRestricted: false,
			limit: 2_000,
			ascending: true,
		}).filter(event => this.eventVisible(event, scope, relevantDomains));
		const persisted = this.database.listMemoryWorkspaceDaySummaries(query.viewerId, query.domainId);
		const byDay = new Map<string, TimelineEvent[]>();
		for (const event of events) {
			const day = dayKey(event.startedAt);
			byDay.set(day, [...(byDay.get(day) ?? []), event]);
		}
		const days = [...byDay.entries()].map(([day, dayEvents]) => {
			const saved = persisted.find(item => item.day === day && item.domainId === query.domainId && item.fingerprint === dayFingerprint(dayEvents));
			return {
				day,
				summary: saved?.summary ?? this.deterministicSummary(dayEvents),
				summaryMethod: saved?.summaryMethod ?? "deterministic" as const,
				...(saved ? { summaryUpdatedAt: saved.updatedAt } : {}),
				events: dayEvents,
				eventCount: dayEvents.length,
				sourceIds: unique(dayEvents.flatMap(event => [event.id, event.sourceId])),
			};
		}).sort((left, right) => right.day.localeCompare(left.day));
		const domainIds = unique([
			...documents.flatMap(document => document.domainIds),
			...events.flatMap(event => event.projectIds),
		]).filter(id => scope.user || relevantDomains.has(id));
		return MemoryWorkspaceSchema.parse({
			query,
			viewers: this.visibleViewers(scope),
			domains: domainIds.map(id => ({ id, label: this.database.listMemoryEntities({ kind: "project", limit: 1_000 }).find(entity => entity.structuredData.projectId === id)?.canonicalName ?? (id === "personal" ? "Personal" : id) })),
			documents,
			days,
			generatedAt: this.now().toISOString(),
			summaryMethod: days.some(day => day.summaryMethod === "model") ? "model" : "deterministic",
			truncated: events.length === 2_000,
		});
	}

	save(input: MemoryDocumentSave): MemoryDocument {
		const parsed = MemoryDocumentSaveSchema.parse(input);
		const scope = this.scope(parsed.viewerId);
		if (!parsed.id && (parsed.kind === "person" || parsed.kind === "tool")) {
			const duplicate = this.read({ viewerId: parsed.viewerId }).documents.find(item => item.kind === parsed.kind && item.title.normalize("NFKC").toLocaleLowerCase() === parsed.title.normalize("NFKC").toLocaleLowerCase());
			if (duplicate) throw new Error("This identity already has a memory document. Select it to update its context.");
		}
		const existing = parsed.id ? this.database.getMemoryWorkspaceDocument(parsed.id) : undefined;
		const prior = existing ?? (parsed.id ? this.projectLegacyDocuments().find(item => item.id === parsed.id) : undefined);
		if (prior && !scope.user && prior.ownerAgentId !== scope.identity?.id) throw new Error("Inherited memory is read-only. Update the owned source instead.");
		if (prior && (prior.kind !== parsed.kind || prior.canonicalEntityId !== parsed.canonicalEntityId)) throw new Error("A memory identity cannot be changed by editing its text.");
		if (prior && parsed.expectedVersion === undefined) throw new Error("A version is required to update memory.");
		if (parsed.passages.some(passage => passage.ownerAgentId !== (scope.user ? parsed.ownerAgentId : scope.identity!.id)) && !scope.user) throw new Error("An agent cannot change another owner’s passage.");
		if (existing && !scope.user && existing.ownerAgentId !== scope.identity?.id)
			throw new Error("An agent may edit only its own memory documents.");
		const ownerAgentId = scope.user ? (prior?.ownerAgentId ?? (prior?.passages.length === 1 ? prior.passages[0]?.ownerAgentId : undefined) ?? parsed.ownerAgentId) : scope.identity!.id;
		if (ownerAgentId) this.scope(ownerAgentId);
		const domains = unique(parsed.domainIds);
		if (!scope.user) {
			const allowed = this.relevantDomains(scope);
			if (domains.some(id => !allowed.has(id))) throw new Error("Memory domain is outside this agent's scope.");
		}
		const timestamp = this.now().toISOString();
		const sourceIds = unique(parsed.sourceIds.length ? parsed.sourceIds : ["explicit-user-control"]);
		if (prior && prior.passages.length > 1 && parsed.text !== prior.text) throw new Error("This document contains separately scoped evidence. Edit its source notes to preserve their visibility.");
		const passages = parsed.passages.length && parsed.passages.map(item => item.text).join("\n\n") === parsed.text ? parsed.passages : [{
			id: `passage-${randomUUID()}`, text: parsed.text, domainIds: domains,
			...(ownerAgentId ? { ownerAgentId } : {}), sharing: parsed.sharing,
			sourceIds, sensitivity: parsed.sensitivity, confidence: parsed.confidence,
			confirmation: parsed.confirmation,
		}];
		const document = MemoryDocumentSchema.parse({
			...parsed,
			id: parsed.id ?? `workspace-memory-${randomUUID()}`,
			...(ownerAgentId ? { ownerAgentId } : {}),
			domainIds: domains, sourceIds, passages,
			origin: parsed.origin,
			createdAt: existing?.createdAt ?? timestamp,
			updatedAt: timestamp,
			version: (existing?.version ?? 0) + 1,
		});
		if (!existing && parsed.id && parsed.expectedVersion !== undefined) {
			const projected = this.projectLegacyDocuments().find(item => item.id === parsed.id);
			if (projected && projected.version === parsed.expectedVersion && !this.database.hasMemoryWorkspaceDocumentRecord(parsed.id)) return this.database.upsertMemoryWorkspaceDocument(document, 0);
		}
		return this.database.upsertMemoryWorkspaceDocument(document, parsed.expectedVersion);
	}

	forget(id: string, viewerId = "user", expectedVersion?: number): boolean {
		const scope = this.scope(viewerId);
		const stored = this.database.getMemoryWorkspaceDocument(id);
		if (stored && !scope.user && stored.ownerAgentId !== scope.identity?.id)
			throw new Error("An agent may forget only its own memory documents.");
		if (!stored && !scope.user) throw new Error("Projected memory can only be forgotten by the user.");
		const forgotten = this.database.forgetMemoryWorkspaceDocument(id, expectedVersion);
		if (id.startsWith("workspace:legacy-memory:")) this.substrate.forget(id.slice("workspace:legacy-memory:".length));
		if (id.startsWith("workspace:agent-memory:")) this.database.deleteAgentMemory(id.slice("workspace:agent-memory:".length));
		return forgotten;
	}

	saveDaySummary(input: MemoryWorkspaceDaySummarySave): MemoryWorkspaceDaySummary {
		const parsed = MemoryWorkspaceDaySummarySaveSchema.parse(input);
		this.scope(parsed.viewerId);
		const day = this.read({ viewerId: parsed.viewerId, ...(parsed.domainId ? { domainId: parsed.domainId } : {}) }).days.find(item => item.day === parsed.day);
		if (!day || parsed.fingerprint !== dayFingerprint(day.events) || parsed.eventIds.some(id => !day.events.some(event => event.id === id))) throw new Error("Day evidence changed before summary could be saved.");
		const existing = this.database.getMemoryWorkspaceDaySummary(parsed.viewerId, parsed.domainId, parsed.day);
		const timestamp = this.now().toISOString();
		return this.database.upsertMemoryWorkspaceDaySummary({
			...parsed,
			id: existing?.id ?? `workspace-day-${randomUUID()}`,
			createdAt: existing?.createdAt ?? timestamp,
			updatedAt: timestamp,
			version: (existing?.version ?? 0) + 1,
		}, parsed.expectedVersion);
	}

	search(input: MemoryWorkspaceSearchInput): MemoryDocument[] {
		let viewerId = input.agentId ?? (input.sessionId
			? this.database.getAgentIdentityBySession(input.sessionId)?.id
			: undefined) ?? "user";
		const session = input.sessionId ? this.database.listRuntimeSessions().find(item => item.id === input.sessionId) : undefined;
		if (input.sessionId && (!session || session.privacyMode === "private" || session.privacyMode === "incognito"))
			return [];
		if (!input.agentId && session && session.kind !== "agent" && !session.parentSessionId) viewerId = "user";
		const queryTerms = terms(input.query).filter(term => !["the", "and", "about", "with", "this", "that", "for", "to", "of", "is", "are", "message", "draft"].includes(term));
		if (!queryTerms.length) return [];
		const queryVector = localSemanticEmbedding(queryTerms.join(" "));
		const matches = this.read({ viewerId }).documents.filter(document => document.kind !== "knowledge").map(document => {
			const haystack = terms(`${document.title} ${document.text}`);
			const matches = queryTerms.filter(term => haystack.some(candidate => candidate === term || candidate.startsWith(term) || term.startsWith(candidate))).length;
			const semantic = semanticSimilarity(queryVector, localSemanticEmbedding(`${document.title} ${document.text}`));
			const relevance = matches / queryTerms.length;
			const ageDays = Math.max(0, (this.now().getTime() - Date.parse(document.updatedAt)) / 86_400_000);
			const recency = 1 / (1 + ageDays / 30);
			const domainMatch = session?.projectId && document.domainIds.includes(session.projectId) ? 1 : 0;
			const durability = document.tier === "long_term" ? 1 : document.tier === "mid_term" ? 0.6 : 0.2;
			return { document, score: relevance > 0 || semantic >= 0.45
				? relevance * 0.55 + semantic * 0.25 + domainMatch * 0.08 + document.confidence * 0.05 + recency * 0.04 + durability * 0.03 : 0 };
		}).filter(item => item.score > 0)
			.sort((left, right) => right.score - left.score || right.document.confidence - left.document.confidence || right.document.updatedAt.localeCompare(left.document.updatedAt))
			.slice(0, 12).map(item => item.document);
		let remaining = Math.max(200, Math.min(12_000, input.maximumCharacters ?? 12_000));
		return matches.flatMap(document => { if (remaining < 100) return []; const text = document.text.slice(0, remaining); remaining -= text.length + 200; return [{ ...document, text }]; });
	}

	retrieve(input: MemoryWorkspaceSearchInput): string {
		const maximum = Math.max(200, Math.min(20_000, input.maximumCharacters ?? 6_000));
		let result = "";
		for (const document of this.search(input)) {
			const line = `## ${document.title}\n${document.text}\n`;
			if (result.length + line.length > maximum) {
				if (!result) result = line.slice(0, maximum - 1) + "…";
				break;
			}
			result += line;
		}
		return result.trim();
	}

	private scope(viewerId: string): { user: boolean; identity?: AgentIdentity; session?: RuntimeSession; ancestors: Set<string> } {
		if (viewerId === "user") return { user: true, ancestors: new Set() };
		const identity = this.database.getAgentIdentity(viewerId) ?? this.database.getAgentIdentityBySession(viewerId);
		if (!identity || identity.status === "deleted") throw new Error("Unknown memory viewer.");
		const session = identity.sessionId ? this.database.listRuntimeSessions().find(item => item.id === identity.sessionId) : undefined;
		if (session?.privacyMode === "private" || session?.privacyMode === "incognito")
			throw new Error("Memory is unavailable for private and incognito sessions.");
		const ancestors = new Set<string>();
		let parentId = identity.parentAgentId;
		for (let depth = 0; parentId && depth < 100; depth += 1) {
			if (ancestors.has(parentId)) break;
			ancestors.add(parentId);
			parentId = this.database.getAgentIdentity(parentId)?.parentAgentId;
		}
		return { user: false, identity, ...(session ? { session } : {}), ancestors };
	}

	private relevantDomains(scope: ReturnType<MemoryWorkspaceService["scope"]>, requested?: string): Set<string> {
		if (scope.user) return new Set(requested ? [requested] : ["*"]);
		const domains = new Set<string>();
		if (scope.session?.projectId) domains.add(scope.session.projectId);
		for (const event of this.database.listTimelineEvents({ agentId: scope.identity!.id, limit: 2_000 }))
			for (const id of event.projectIds) domains.add(id);
		if (requested) {
			if (!domains.has(requested)) throw new Error("Memory domain is outside this agent's scope.");
			return new Set([requested]);
		}
		return domains;
	}

	private visibleViewers(scope: ReturnType<MemoryWorkspaceService["scope"]>) {
		const identities = this.database.listAgentIdentities(false);
		const visible = identities.filter(item => { const session = item.sessionId ? this.database.listRuntimeSessions().find(session => session.id === item.sessionId) : undefined; return session?.privacyMode !== "private" && session?.privacyMode !== "incognito" && (!session || session.kind === "agent" || Boolean(session.parentSessionId) || item.id === "agent-main"); });
		return [{ id: "user", label: "You" }, ...visible.map(item => ({
			id: item.id, label: item.name, ...(item.parentAgentId ? { parentId: item.parentAgentId } : {}),
			...(item.sessionId ? { sessionId: item.sessionId } : {}),
		}))];
	}

	private projectDocument(document: MemoryDocument, scope: ReturnType<MemoryWorkspaceService["scope"]>, domains: Set<string>, includeSensitive: boolean): MemoryDocument | undefined {
		const ownerSession = document.ownerAgentId ? this.database.getAgentIdentity(document.ownerAgentId)?.sessionId : undefined;
		const runtime = ownerSession ? this.database.listRuntimeSessions().find(item => item.id === ownerSession) : undefined;
		if (runtime?.privacyMode === "private" || runtime?.privacyMode === "incognito") return undefined;
		const passages = (document.passages.length ? document.passages : [{
			id: `${document.id}:body`, text: document.text, domainIds: document.domainIds,
			...(document.ownerAgentId ? { ownerAgentId: document.ownerAgentId } : {}), sharing: document.sharing,
			sourceIds: document.sourceIds, sensitivity: document.sensitivity,
			confidence: document.confidence, confirmation: document.confirmation,
		}]).filter(passage => {
			if (!includeSensitive && (passage.sensitivity === "sensitive" || passage.sensitivity === "restricted")) return false;
			if (scope.user) return domains.has("*") || passage.domainIds.some(id => domains.has(id));
			if (passage.ownerAgentId === scope.identity!.id) return true;
			if (passage.sharing !== "domain_shared") return false;
			if (passage.ownerAgentId && !scope.ancestors.has(passage.ownerAgentId)) return false;
			return passage.domainIds.some(id => domains.has(id));
		});
		if (!passages.length) return undefined;
		return MemoryDocumentSchema.parse({
			...document,
			text: passages.map(passage => passage.text).join("\n\n"),
			domainIds: unique(passages.flatMap(passage => passage.domainIds)),
			sourceIds: unique(passages.flatMap(passage => passage.sourceIds)),
			passages,
			confidence: Math.min(...passages.map(passage => passage.confidence)),
			confirmation: passages.every(passage => passage.confirmation === "confirmed") ? "confirmed" : "inferred",
		});
	}

	private eventVisible(event: TimelineEvent, scope: ReturnType<MemoryWorkspaceService["scope"]>, domains: Set<string>): boolean {
		const runtime = event.sourceSessionId || event.sessionId
			? this.database.listRuntimeSessions().find(item => item.id === (event.sourceSessionId ?? event.sessionId))
			: undefined;
		if (runtime?.privacyMode === "private" || runtime?.privacyMode === "incognito") return false;
		if (scope.user) return domains.has("*") || event.projectIds.some(id => domains.has(id));
		if (event.agentId === scope.identity!.id || event.subagentId === scope.identity!.id) return true;
		return Boolean(event.projectIds.some(id => domains.has(id)) && event.agentId && scope.ancestors.has(event.agentId));
	}

	private projectLegacyDocuments(): MemoryDocument[] {
		const output: MemoryDocument[] = [];
		for (const memory of this.legacyMemory.activeMemories()) {
			const domains = unique(memory.relatedProjectIds ?? []);
			output.push(this.legacyDocument({
				id: `workspace:legacy-memory:${memory.id}`, kind: "memory",
				title: memory.subject ?? memory.type, text: memory.content,
				tier: tier(memory.layer ?? (memory.importance >= 0.85 && memory.confidence >= 0.85 ? "long_term" : memory.type === "episodic" ? "short_term" : "mid_term")), domainIds: domains.length ? domains : ["personal"],
				sourceIds: memory.sourceIds, confidence: memory.confidence,
				confirmation: memory.userConfirmed ? "confirmed" : "inferred",
				sensitivity: memory.sensitivity, createdAt: memory.createdAt, updatedAt: memory.updatedAt,
			}));
		}
		for (const identity of this.database.listAgentIdentities(true)) {
			for (const memory of this.database.listAgentMemories(identity.id, { limit: 1_000 })) {
				if (memory.status !== "active") continue;
				if (memory.id.startsWith("agent-memory-") && this.legacyMemory.list().some(item => item.id === memory.id.slice("agent-memory-".length))) continue;
				output.push(this.legacyDocument({
					id: `workspace:agent-memory:${memory.id}`, kind: "memory", title: memory.kind,
					text: memory.content, tier: tier(memory.horizon), domainIds: memory.projectIds,
					ownerAgentId: memory.agentId, sourceIds: memory.sourceIds, confidence: memory.confidence,
					confirmation: "inferred", sensitivity: memory.sensitivity,
					createdAt: memory.createdAt, updatedAt: memory.updatedAt,
				}));
			}
		}
		for (const person of this.database.listPeople()) {
			const evidence = this.database.listTimelineEvents({ personIds: [person.id], limit: 2_000 });
			const domains = unique(evidence.flatMap(event => event.projectIds));
			const facts = person.facts.filter(fact => fact.status === "active");
			const identityText = [person.relationship, person.organization, person.role].filter(Boolean).join(" · ");
			const passages: MemoryPassage[] = [identityText ? {
				id: `${person.id}:identity`, text: identityText, domainIds: domains.length ? domains : ["personal"],
				...(person.agentId ? { ownerAgentId: person.agentId } : {}),
				sharing: "owner_only", sourceIds: person.sourceIds,
				sensitivity: person.sensitivity, confidence: person.confidence,
				confirmation: person.identityStatus === "confirmed" ? "confirmed" : "inferred",
			} as MemoryPassage : undefined, ...facts.map((fact): MemoryPassage => ({
				id: fact.id, text: `${fact.key}: ${fact.value}`, domainIds: domains.length ? domains : ["personal"],
				...(person.agentId ? { ownerAgentId: person.agentId } : {}),
				sharing: "owner_only" as const,
				sourceIds: fact.sourceIds, sensitivity: fact.sensitivity, confidence: fact.confidence,
				confirmation: fact.userConfirmed ? "confirmed" as const : "inferred" as const,
			}))].filter((value): value is MemoryPassage => Boolean(value));
			if (!passages.length) continue;
			output.push(MemoryDocumentSchema.parse({
				id: `workspace:person:${person.id}`, kind: "person", title: person.displayName,
				text: passages.map(item => item.text).join("\n"), tier: "long_term",
				domainIds: unique(passages.flatMap(item => item.domainIds)), ownerAgentId: person.agentId,
				sharing: domains.length ? "domain_shared" : "owner_only",
				sourceIds: unique(passages.flatMap(item => item.sourceIds)), confidence: person.confidence,
				confirmation: person.identityStatus === "confirmed" ? "confirmed" : "inferred",
				sensitivity: person.sensitivity, passages, canonicalEntityId: person.id,
				origin: "legacy", createdAt: person.createdAt, updatedAt: person.updatedAt, version: 1,
			}));
		}
		for (const entity of this.database.listMemoryEntities({ limit: 2_000 })) {
			if (entity.kind === "person" || entity.status !== "active") continue;
			const evidence = this.database.listTimelineEvents({ entityIds: [entity.id], limit: 2_000 });
			const domains = unique(evidence.flatMap(event => event.projectIds));
			const kind = entity.kind === "application" || entity.kind === "product" ? "tool" : "knowledge";
			output.push(this.legacyDocument({
				id: `workspace:${kind}:${entity.id}`, kind, title: entity.canonicalName,
				text: entity.description ?? entity.canonicalName, tier: "long_term",
				domainIds: domains.length ? domains : ["personal"], sourceIds: entity.sourceIds,
				confidence: entity.confidence, confirmation: "inferred", sensitivity: entity.sensitivity,
				createdAt: entity.createdAt, updatedAt: entity.updatedAt, canonicalEntityId: entity.id,
				sharing: domains.length ? "domain_shared" : "owner_only",
			}));
		}
		// Tool identity follows observed runtime tool namespaces, never connection status.
		const toolEvents = new Map<string, TimelineEvent[]>();
		for (const event of this.database.listTimelineEvents({ limit: 2_000, ascending: false }).filter(event => this.eventVisible(event, this.scope("user"), new Set(["*"])))) {
			const name = event.structuredData.toolName;
			if (typeof name !== "string" || !name.includes(".") || event.structuredData.runtimeEventType !== "tool.completed") continue;
			const tool = name.split(".")[0]!;
			const values = toolEvents.get(tool) ?? []; values.push(event); toolEvents.set(tool, values);
		}
		for (const [tool, events] of toolEvents) {
			const groups = new Map<string, TimelineEvent[]>();
			for (const event of events) { const key = JSON.stringify([event.agentId, [...event.projectIds].sort()]); groups.set(key, [...(groups.get(key) ?? []), event]); }
			const passages: MemoryPassage[] = [...groups.entries()].slice(0, 100).map(([key, values]) => ({
				id: `tool-passage-${values[0]!.id}`.slice(0, 200),
				text: `Observed ${tool} work: ${unique(values.slice(0, 6).map(event => String(event.structuredData.toolName))).join(", ")}. ${values[0]!.textSummary.slice(0, 400)}`,
				domainIds: values[0]!.projectIds, ...(values[0]!.agentId ? { ownerAgentId: values[0]!.agentId } : {}),
				sharing: "owner_only", sourceIds: values.slice(0, 40).map(event => event.id), sensitivity: "personal", confidence: 1, confirmation: "confirmed",
			}));
			output.push(MemoryDocumentSchema.parse({ id: `workspace:tool:runtime:${tool}`.slice(0, 200), kind: "tool", title: tool,
				text: passages.map(passage => passage.text).join("\n\n"), passages, domainIds: unique(passages.flatMap(passage => passage.domainIds)),
				canonicalEntityId: `tool:${tool}`, sourceIds: unique(passages.flatMap(passage => passage.sourceIds)).slice(0, 500),
				confidence: 1, confirmation: "confirmed", origin: "evidence", tier: "mid_term", createdAt: events.at(-1)!.createdAt, updatedAt: events[0]!.updatedAt }));
		}
		return output;
	}

	private legacyDocument(input: Omit<MemoryDocument, "origin" | "version" | "passages" | "sharing"> & { sharing?: MemoryDocument["sharing"] }): MemoryDocument {
		const sharing = input.sharing ?? (input.domainIds.includes("personal") ? "owner_only" : "domain_shared");
		return MemoryDocumentSchema.parse({ ...input, sharing, origin: "legacy", version: 1, passages: [{
			id: `${input.id}:passage`, text: input.text, domainIds: input.domainIds,
			...(input.ownerAgentId ? { ownerAgentId: input.ownerAgentId } : {}), sharing,
			sourceIds: input.sourceIds, sensitivity: input.sensitivity,
			confidence: input.confidence, confirmation: input.confirmation,
		}] });
	}

	private deterministicSummary(events: readonly TimelineEvent[]): string {
		const periods = ["Morning", "Afternoon", "Evening"];
		return periods.flatMap((label, index) => {
			const candidates = events.filter(event => { const hour = new Date(event.startedAt).getHours(); return (hour < 12 ? 0 : hour < 18 ? 1 : 2) === index && event.importance >= 0.35 && event.eventType !== "system"; });
			const selected = [...candidates].sort((a, b) => b.importance - a.importance).slice(0, 2);
			const summaries = unique(selected.map(event => event.textSummary.replace(/\s+/gu, " ").trim().slice(0, 220)));
			return summaries.length ? [`${label}: ${summaries.join(" ")}`] : [];
		}).join("\n\n") || "No significant activity recorded for this day.";
	}
}
