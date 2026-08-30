import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import type { KestrelDatabase } from "@kestrel/database";
import { mayExecute } from "@kestrel/policy-engine";
import type {
	AgentState,
	Approval,
	BrowserTabFolderNamingGroup,
	CoreRequest,
	CoreResponse,
	MemoryRecord,
	MemoryRecallStatus,
	ModelProfile,
	ModelRoutingDecision,
	RoutingPolicy,
	SelectedAttachment,
	TaskOpportunity,
	WorkspaceSnapshot,
} from "@kestrel/shared-types";
import {
	AgentStateSchema,
	buildMemoryRecallReceipt,
	PRODUCT_IDENTITY,
	WorkspaceSnapshotSchema,
	validateNewTabGreeting,
} from "@kestrel/shared-types";
import {
	installManagedPolicy,
	type ManagedPolicy,
	ManagedPolicyStore,
} from "./administration";
import { AgentLoop, type AgentLoopResult } from "./agent-loop";
import { selectBrowserContext } from "./browser-context";
import {
	type ChannelEnvelope,
	ChannelGateway,
	type ChannelRuntimeConfiguration,
	installChannelTools,
} from "./channels";
import {
	AgentConfigurationManager,
	installAgentConfigurationTools,
} from "./configuration";
import {
	type CalendarConnector,
	DevelopmentCalendarConnector,
	DevelopmentEmailConnector,
	UnavailableCalendarConnector,
	UnavailableEmailConnector,
	type EmailConnector,
} from "./connectors";
import { PreResponseContextResolver } from "./context-resolver";
import { DreamingManager } from "./dreaming";
import {
	EventApplicationManager,
	installEventApplicationTools,
} from "./event-applications";
import { PluginMcpManager } from "./extensions/plugin-mcp";
import { PluginRegistry } from "./extensions/plugins";
import {
	installSkillLearningTools,
	SkillLearningManager,
} from "./extensions/skill-learning";
import { installSkillTools, SkillRegistry } from "./extensions/skills";
import {
	emptyOpportunity,
	fixtureMemories,
	initialActivity,
	teacherApproval,
	teacherOpportunity,
} from "./fixtures";
import type { GoogleWorkspaceClient } from "./google-workspace";
import {
	HONCHO_TOOL_NAMES,
	HonchoMemoryProvider,
	installHonchoMemoryTools,
} from "./honcho-memory";
import { LifeContextService } from "./life-context";
import {
	ArtifactManager,
	installMediaTools,
	type MediaGenerationProvider,
} from "./media-artifacts";
import type { VoiceTranscriptionProvider } from "./media-providers";
import { installMemoryTools, MemoryManager } from "./memory";
import {
	AdaptiveModelRouter,
	detectModelRefusal,
	ModelRegistry,
	TaskRequirementAnalyzer,
} from "./model-orchestration";
import { WritingAssistant } from "./writing-assistant";
import { WritingProfileStore } from "./writing-profile";
import { NativeNodeManager } from "./native-nodes";
import { ObservabilityManager } from "./observability";
import { OpportunityEngine } from "./opportunity-engine";
import {
	installOrchestrationTools,
	parseScheduleExpression,
	TaskOrchestrator,
} from "./orchestration";
import { type AgentPersonality, PersonalityRegistry } from "./personality";
import { PetHatchManager } from "./pet-hatch";
import { PetManager } from "./pets";
import { PresenceManager } from "./presence";
import {
	CodexAppServerProvider,
	type CodexBrowserMcpAttachment,
	createEnvironmentModelProviders,
	type ModelContentPart,
	type ModelProvider,
	ProviderPool,
	ProviderPoolError,
	type ModelResult,
	type ProviderAttempt,
	textContent,
} from "./providers";
import {
	installRemoteExecutionTool,
	RemoteBackendManager,
	RemoteControl,
	type RemoteExecutionConfiguration,
} from "./remote";
import { AgentRuntime } from "./runtime";
import { SkinManager } from "./skins";
import { UsageGovernor } from "./usage-governor";
import type { UserModelStore } from "./user-model";
import {
	EncryptedDatabaseWebCache,
	installWebTools,
	NetworkPolicyWebClient,
	type WebAccessOptions,
} from "./web-tools";
import type { BrowserMcpCallSession } from "./browser-mcp-session";
import {
	NEW_TAB_GREETING_SYSTEM_PROMPT,
	newTabGreetingUserPrompt,
} from "./new-tab-greeting";
import {
	BROWSER_TAB_FOLDER_NAMING_SYSTEM_PROMPT,
	browserTabFolderNamingPrompt,
	fallbackBrowserTabFolderNames,
	parseBrowserTabFolderNames,
} from "./browser-tab-folder-naming";

function persistedCompactionCount(value: unknown): number {
	if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
	const count = (value as { removedMessages?: unknown }).removedMessages;
	return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
		? count
		: 0;
}

export interface AgentCoreDependencies {
	database: KestrelDatabase;
	/** Seed the deterministic teacher-scheduling data used by preview and test surfaces. */
	seedDevelopmentFixtures?: boolean;
	email?: EmailConnector;
	calendar?: CalendarConnector;
	googleWorkspace?: GoogleWorkspaceClient;
	now?: () => string;
	workspaceRoots?: string[];
	configuredWorkspaceRoots?: string[];
	modelProviders?: ModelProvider[];
	modelProfiles?: ModelProfile[];
	routingPolicy?: RoutingPolicy;
	skillRoots?: string[];
	learnedSkillRoot?: string;
	pluginRoots?: string[];
	managedPluginRoots?: string[];
	honchoApiKey?: string;
	customPersonalities?: Array<Omit<AgentPersonality, "builtin">>;
	onAgentTextDelta?: (event: {
		streamId: string;
		sessionId: string;
		delta: string;
	}) => void;
	webAccess?: WebAccessOptions;
	channels?: ChannelRuntimeConfiguration;
	artifactRoot?: string;
	petRoot?: string;
	mediaProviders?: MediaGenerationProvider[];
	transcriptionProvider?: VoiceTranscriptionProvider;
	managedPolicy?: Omit<ManagedPolicy, "updatedAt">;
	githubToken?: string;
	remoteExecution?: RemoteExecutionConfiguration;
}

export class AgentCore {
	readonly email: EmailConnector;
	readonly calendar: CalendarConnector;
	readonly opportunities = new OpportunityEngine();
	readonly modelRegistry: ModelRegistry;
	readonly requirementAnalyzer = new TaskRequirementAnalyzer();
	readonly modelRouter: AdaptiveModelRouter;
	readonly runtime: AgentRuntime;
	readonly providerPool: ProviderPool;
	readonly usageGovernor: UsageGovernor;
	readonly agentLoop: AgentLoop;
	readonly skillRegistry?: SkillRegistry;
	readonly skillLearning?: SkillLearningManager;
	readonly pluginRegistry?: PluginRegistry;
	readonly pluginMcpManager?: PluginMcpManager;
	readonly personalities: PersonalityRegistry;
	readonly orchestrator: TaskOrchestrator;
	readonly userModel: UserModelStore;
	readonly context: PreResponseContextResolver;
	readonly memory: MemoryManager;
	readonly lifeContext: LifeContextService;
	readonly writingProfile: WritingProfileStore;
	readonly writingAssistant: WritingAssistant;
	readonly remote: RemoteControl;
	readonly remoteBackendManager?: RemoteBackendManager;
	readonly web?: NetworkPolicyWebClient;
	readonly channelGateway: ChannelGateway;
	readonly artifacts?: ArtifactManager;
	readonly managedPolicy: ManagedPolicyStore;
	readonly observability: ObservabilityManager;
	readonly dreaming: DreamingManager;
	readonly presence: PresenceManager;
	readonly nativeNodes: NativeNodeManager;
	readonly eventApplications: EventApplicationManager;
	readonly skins: SkinManager;
	readonly pets: PetManager | undefined;
	readonly petHatch: PetHatchManager | undefined;
	readonly honchoMemory: HonchoMemoryProvider;
	readonly configuration: AgentConfigurationManager;
	private state: AgentState;
	private opportunity: TaskOpportunity;
	private currentRouting: ModelRoutingDecision;
	private selectedPersonalityId: string;
	private readonly customPersonalitiesKey = "runtime.custom-personalities";
	private readonly activeStreams = new Map<
		string,
		{ controller: AbortController; sessionId: string; steering: string[] }
	>();
	private readonly coreInstanceId: string;

	constructor(private readonly deps: AgentCoreDependencies) {
		const seedDevelopmentFixtures = deps.seedDevelopmentFixtures === true;
		this.email = deps.email ?? (seedDevelopmentFixtures
			? new DevelopmentEmailConnector()
			: new UnavailableEmailConnector());
		this.calendar = deps.calendar ?? (seedDevelopmentFixtures
			? new DevelopmentCalendarConnector()
			: new UnavailableCalendarConnector());
		const storedState = AgentStateSchema.safeParse(
			deps.database.getState<unknown>("agentState"),
		);
		this.state = storedState.success
			? storedState.data
			: seedDevelopmentFixtures
				? "waiting_approval"
				: "idle";
		const storedPersonalities =
			deps.database.getPrivateState<Array<Omit<AgentPersonality, "builtin">>>(
				this.customPersonalitiesKey,
			) ?? [];
		const customPersonalities = [
			...new Map(
				[...(deps.customPersonalities ?? []), ...storedPersonalities].map(
					(personality) => [personality.id, personality],
				),
			).values(),
		];
		this.personalities = new PersonalityRegistry(customPersonalities);
		this.selectedPersonalityId =
			deps.database.getState<string>("selectedPersonality") ?? "pragmatic";
		this.personalities.get(this.selectedPersonalityId);
		this.opportunity =
			deps.database.getState<TaskOpportunity>("teacherOpportunity") ??
			(seedDevelopmentFixtures
				? teacherOpportunity
				: emptyOpportunity(this.now()));
		this.currentRouting = deps.database.getState<ModelRoutingDecision>(
			"modelRouting",
		) ?? {
			taskId: this.opportunity.id,
			model: "local-rules",
			reasoningEffort: "none",
			fastMode: false,
			serviceTier: "standard",
			execution: "local",
			rationale: "No model route has been required yet.",
			confidence: 1,
			selectedAt: this.now(),
		};
		this.seed(seedDevelopmentFixtures);
		this.context = new PreResponseContextResolver(() =>
			this.deps.database.listMemories(),
		);
		this.runtime = new AgentRuntime(
			this.deps.database,
			this.deps.workspaceRoots ?? [],
			() => this.now(),
			this.deps.githubToken,
			this.deps.configuredWorkspaceRoots ?? this.deps.workspaceRoots ?? [],
		);
		this.observability = new ObservabilityManager(
			this.deps.database,
			this.runtime,
			() => new Date(this.now()),
		);
		this.managedPolicy = new ManagedPolicyStore(deps.database);
		if (deps.managedPolicy) this.managedPolicy.set(deps.managedPolicy);
		if (this.managedPolicy.get()?.retentionDays)
			this.managedPolicy.enforceRetention();
		installManagedPolicy(this.runtime, this.managedPolicy);
		const mainSession = this.runtime.ensureMainSession();
		this.configuration = new AgentConfigurationManager(
			deps.database,
			() => new Date(this.now()),
		);
		installAgentConfigurationTools(
			this.runtime,
			this.configuration,
			mainSession.id,
		);
		this.runtime.setToolPolicyResolver(({ tool }) =>
			this.configuration.toolPolicy(tool.name),
		);
		this.memory = new MemoryManager(deps.database, () => new Date(this.now()));
		this.userModel = this.memory.userModel;
		this.lifeContext = new LifeContextService(
			deps.database,
			deps.googleWorkspace,
			() => new Date(this.now()),
			this.memory,
		);
		this.honchoMemory = new HonchoMemoryProvider(
			deps.database,
			deps.honchoApiKey,
		);
		this.dreaming = new DreamingManager(
			deps.database,
			() => new Date(this.now()),
		);
		this.presence = new PresenceManager(() => new Date(this.now()));
		this.nativeNodes = new NativeNodeManager(() => new Date(this.now()));
		this.eventApplications = new EventApplicationManager(
			deps.database,
			() => new Date(this.now()),
		);
		installEventApplicationTools(
			this.runtime,
			this.eventApplications,
			mainSession.id,
		);
		this.skins = new SkinManager(deps.database);
		this.pets = deps.petRoot
			? new PetManager(deps.database, deps.petRoot)
			: undefined;
		this.petHatch =
			deps.petRoot && this.pets
				? new PetHatchManager(
						deps.database,
						join(deps.petRoot, ".hatch"),
						deps.mediaProviders ?? [],
						this.pets,
						() => new Date(this.now()),
					)
				: undefined;
		this.coreInstanceId =
			deps.database.getPrivateState<string>("presence.core-instance-id") ??
			`node-${randomUUID()}`;
		deps.database.setPrivateState(
			"presence.core-instance-id",
			this.coreInstanceId,
		);
		this.presence.beacon({
			instanceId: this.coreInstanceId,
			mode: "node",
			reason: "isolated agent core",
		});
		installMemoryTools(this.runtime, this.memory, mainSession.id);
		if (deps.artifactRoot) {
			this.artifacts = new ArtifactManager(
				deps.database,
				deps.artifactRoot,
				deps.mediaProviders ?? [],
			);
			installMediaTools(this.runtime, this.artifacts, mainSession.id);
		}
		if (deps.webAccess) {
			this.web = new NetworkPolicyWebClient({
				...deps.webAccess,
				cache:
					deps.webAccess.cache ?? new EncryptedDatabaseWebCache(deps.database),
			});
			installWebTools(this.runtime, this.web, mainSession.id);
		}
		this.channelGateway = new ChannelGateway(
			deps.database,
			this.runtime,
			deps.channels?.adapters ?? [],
			deps.channels?.signingSecrets ?? {},
		);
		if (deps.channels?.adapters.length)
			installChannelTools(this.runtime, this.channelGateway, mainSession.id);
		const pluginRegistry = this.deps.pluginRoots?.length
			? new PluginRegistry(
					this.deps.pluginRoots,
					this.deps.database,
					this.deps.managedPluginRoots,
				)
			: undefined;
		if (pluginRegistry) {
			pluginRegistry.discover();
			this.pluginRegistry = pluginRegistry;
			this.pluginMcpManager = new PluginMcpManager(
				pluginRegistry,
				this.runtime,
			);
		}
		const skillRoots = [
			...(this.deps.skillRoots ?? []),
			...(this.deps.learnedSkillRoot ? [this.deps.learnedSkillRoot] : []),
			...(pluginRegistry?.skillRoots() ?? []),
		];
		if (skillRoots.length || pluginRegistry) {
			this.skillRegistry = new SkillRegistry(skillRoots);
			installSkillTools(this.runtime, this.skillRegistry, mainSession.id);
			if (this.deps.learnedSkillRoot) {
				this.skillLearning = new SkillLearningManager(
					this.deps.database,
					this.deps.learnedSkillRoot,
					this.skillRegistry,
				);
				installSkillLearningTools(
					this.runtime,
					this.skillLearning,
					mainSession.id,
				);
			}
		}
		this.providerPool = new ProviderPool(
			this.deps.modelProviders ?? createEnvironmentModelProviders(),
		);
		this.usageGovernor = new UsageGovernor(
			this.deps.database,
			() => new Date(this.deps.now?.() ?? Date.now()),
		);
		this.modelRegistry = new ModelRegistry(
			this.deps.database,
			this.providerPool.list(),
			this.deps.modelProfiles ?? [],
			() => new Date(this.now()),
		);
		this.modelRouter = new AdaptiveModelRouter(
			this.deps.database,
			this.modelRegistry,
			(providerId, model, inputTokens, outputTokens) =>
				this.usageGovernor.estimateCost(providerId, model, {
					inputTokens,
					outputTokens,
				}),
			(providerId, _endpointId) => {
				try {
					this.managedPolicy.assertProviderAllowed(providerId);
					return true;
				} catch {
					return false;
				}
			},
			() => new Date(this.now()),
		);
		if (this.deps.routingPolicy)
			this.modelRouter.setPolicy(this.deps.routingPolicy);
		this.writingProfile = new WritingProfileStore(
			deps.database,
			() => new Date(this.now()),
		);
		this.writingAssistant = new WritingAssistant({
			providerPool: this.providerPool,
			modelRegistry: this.modelRegistry,
			modelRouter: this.modelRouter,
			usageGovernor: this.usageGovernor,
			lifeContext: this.lifeContext,
			userModel: this.userModel,
			writingProfile: this.writingProfile,
			resolveRoute: (taskId, prompt, providerIds, role) =>
				this.automaticRoute(taskId, prompt, providerIds, [], role),
			providerAllowed: (providerId, poolId) =>
				this.providerAllowed(providerId, poolId),
			now: () => this.now(),
		});
		this.agentLoop = new AgentLoop(
			this.deps.database,
			this.runtime,
			this.providerPool,
			undefined,
			(message) => {
				if (message.role === "user" && this.sharedMemoryCaptureEnabled()) {
					const captureExplicit =
						this.configuration.current().memory.captureExplicit;
					if (captureExplicit)
						this.memory.captureExplicit(message.content, message.id);
					if (captureExplicit)
						this.lifeContext.captureConversation(message.content, message.id);
				}
				if (!this.sharedMemoryCaptureEnabled()) return;
				const session = this.runtime.getSession(message.sessionId);
				this.honchoMemory.captureMessage(message, session.workspaceRoot);
			},
			this.usageGovernor,
			(providerId, poolId) => {
				try {
					this.managedPolicy.assertProviderAllowed(poolId ?? providerId);
					return true;
				} catch {
					return false;
				}
			},
		);
		this.refreshHonchoTools();
		this.runtime.on("event", (event) => {
			if (
				event.type === "session.created" &&
				this.honchoMemory.configuration().enabled &&
				this.honchoMemory.configuration().recallMode !== "context"
			)
				installHonchoMemoryTools(this.runtime, this.honchoMemory, [
					event.sessionId,
				]);
		});
		this.orchestrator = new TaskOrchestrator(
			this.deps.database,
			this.runtime,
			this.agentLoop,
			() => new Date(this.now()),
			this.managedPolicy.get()?.maximumWorkers ?? 4,
			this.providerPool,
			this.modelRouter,
			this.modelRegistry,
			undefined,
			() => this.configuration.current().workflows.maximumTurns,
		);
		installOrchestrationTools(this.runtime, this.orchestrator, mainSession.id);
		this.remote = new RemoteControl(
			this.deps.database,
			this.runtime,
			this.orchestrator,
		);
		if (deps.remoteExecution) {
			this.remoteBackendManager = new RemoteBackendManager(
				deps.database,
				deps.remoteExecution.backends,
				deps.remoteExecution.artifactRoot,
			);
			this.remoteBackendManager.setTargets(deps.remoteExecution.targets);
			installRemoteExecutionTool(
				this.runtime,
				this.remoteBackendManager,
				mainSession.id,
			);
		}
	}

	private seed(seedDevelopmentFixtures: boolean): void {
		if (
			seedDevelopmentFixtures &&
			this.deps.database.listMemories().length === 0
		)
			fixtureMemories.forEach((item) => this.deps.database.upsertMemory(item));
		if (
			seedDevelopmentFixtures &&
			this.deps.database.listApprovals().length === 0
		)
			this.deps.database.saveApproval(teacherApproval);
		if (
			seedDevelopmentFixtures &&
			this.deps.database.listActivity().length === 0
		)
			initialActivity.forEach((item) => this.deps.database.addActivity(item));
		this.deps.database.setState("teacherOpportunity", this.opportunity);
		this.deps.database.setState("modelRouting", this.currentRouting);
	}

	snapshot(): WorkspaceSnapshot {
		const workspaceRoots = this.deps.workspaceRoots ?? [];
		return WorkspaceSnapshotSchema.parse({
			productName: PRODUCT_IDENTITY.productName,
			agentState: this.state,
			autonomyLevel: "assistant",
			opportunity: this.opportunity,
			approvals: this.deps.database.listApprovals(),
			memories: this.deps.database.listMemories(),
			activity: this.deps.database.listActivity(),
			connections: [
				...(this.deps.seedDevelopmentFixtures
					? [
							{
								id: "gmail",
								name: "Gmail",
								status: "development_adapter" as const,
								detail:
									"Sample data only · connect Google in Settings for live mail",
							},
							{
								id: "calendar",
								name: "Google Calendar",
								status: "development_adapter" as const,
								detail:
									"Sample data only · connect Google in Settings for live calendar",
							},
						]
					: []),
				{
					id: "files",
					name: "Selected folders",
					status: workspaceRoots.length ? "connected" : "disconnected",
					detail: workspaceRoots.length
						? `${workspaceRoots.length} granted · ${workspaceRoots.map((root) => basename(root)).join(", ")}`
						: "No folder access granted",
				},
			],
			resourceUsage: {
				modelCostToday: 0,
				modelBudgetDaily: 2.5,
				activeWorkers: 0,
				maximumWorkers: 2,
			},
			modelRouting: {
				model: "auto",
				reasoningEffort: "auto",
				fastMode: "auto",
				currentDecision: this.currentRouting,
			},
			personality: {
				selectedId: this.selectedPersonalityId,
				available: this.personalities
					.list()
					.map(
						({ instructions: _instructions, ...personality }) => personality,
					),
			},
			configuration: this.configuration.status(),
			memoryRecall: this.memoryRecallStatus(),
			updatedAt: this.now(),
		});
	}

	private now(): string {
		return this.deps.now?.() ?? new Date().toISOString();
	}

	private providerIdsForAttachments(
		providerIds: string[],
		attachments: SelectedAttachment[] = [],
	): string[] {
		if (attachments.length === 0) return providerIds;
		const textMediaTypes = new Set([
			"application/json",
			"application/xml",
			"application/javascript",
		]);
		const isTextAttachment = (attachment: SelectedAttachment) =>
			attachment.mediaType.startsWith("text/") ||
			textMediaTypes.has(attachment.mediaType);
		const required = {
			images: attachments.some((attachment) =>
				attachment.mediaType.startsWith("image/"),
			),
			audio: attachments.some((attachment) =>
				attachment.mediaType.startsWith("audio/"),
			),
			video: attachments.some((attachment) =>
				attachment.mediaType.startsWith("video/"),
			),
			documents: attachments.some(
				(attachment) =>
					!attachment.mediaType.startsWith("image/") &&
					!attachment.mediaType.startsWith("audio/") &&
					!attachment.mediaType.startsWith("video/") &&
					!isTextAttachment(attachment),
			),
		};
		const matching = this.providerPool
			.list()
			.filter(
				(provider) =>
					(!required.images || provider.capabilities.images) &&
					(!required.audio || provider.capabilities.audio) &&
					(!required.video || provider.capabilities.video) &&
					(!required.documents || provider.capabilities.documents),
			);
		if (matching.length === 0)
			throw new Error(
				"No configured model provider supports the selected attachments.",
			);
		if (providerIds.includes("auto"))
			return [
				...new Set(
					matching.flatMap((provider) =>
						[provider.id, provider.poolId].filter((id): id is string =>
							Boolean(id),
						),
					),
				),
			];
		const supportedIds = new Set(
			matching.flatMap((provider) =>
				[provider.id, provider.poolId].filter((id): id is string =>
					Boolean(id),
				),
			),
		);
		const filtered = providerIds.filter((providerId) =>
			supportedIds.has(providerId),
		);
		if (filtered.length === 0)
			throw new Error(
				"The selected model providers do not support the attachments.",
			);
		return filtered;
	}

	private automaticRoute(
		taskId: string,
		message: string,
		providerIds: string[] = ["auto"],
		attachments: SelectedAttachment[] = [],
		role: "worker" | "writer" | "reviewer" = "worker",
	): {
		route: ModelRoutingDecision;
		execution: ReturnType<AdaptiveModelRouter["executionPlan"]>;
		maximumContextCharacters: number;
		maximumOutputTokens: number;
		temperature: number;
		orchestrationInstructions: string;
		decision: ReturnType<AdaptiveModelRouter["route"]>;
		requirements: ReturnType<TaskRequirementAnalyzer["analyze"]>;
	} {
		this.modelRegistry.applyProviderHealth(this.providerPool.health());
		const routedProviderIds = this.providerIdsForAttachments(
			providerIds,
			attachments,
		);
		const requirements = this.requirementAnalyzer.analyze(taskId, message, {
			requiresVision: attachments.some((attachment) =>
				attachment.mediaType.startsWith("image/"),
			),
			requiresStructuredOutput: role === "writer" || role === "reviewer",
			requiresWriting: role === "writer" || role === "reviewer",
			requiresReview: role === "reviewer",
		});
		const taskPolicy = this.requirementAnalyzer.routingPolicy(
			message,
			this.modelRouter.policy(),
		);
		const decision = this.modelRouter.route(requirements, {
			role:
				role === "reviewer"
					? "reviewer"
					: role === "worker"
						? "worker"
						: requirements.parallelizable
							? "orchestrator"
							: "worker",
			allowedProviderIds: routedProviderIds,
			policy: taskPolicy,
		});
		if (decision.traceId)
			this.modelRouter.completeTrace(decision.traceId, { status: "running" });
		const execution = this.modelRouter.executionPlan(decision);
		const route: ModelRoutingDecision = {
			taskId,
			model: decision.model,
			providerId: decision.providerId,
			selectedModelId: decision.selectedModelId,
			tier: decision.tier,
			reasoningEffort: decision.reasoningLevel,
			fastMode: decision.fastMode,
			serviceTier: decision.fastMode ? "priority" : "standard",
			execution: this.modelRegistry.get(decision.selectedModelId).local
				? "local"
				: "configured_endpoint",
			rationale: decision.reasons.join(" "),
			confidence: decision.confidence,
			...(decision.traceId ? { traceId: decision.traceId } : {}),
			fallbackModelIds: decision.fallbackModelIds,
			reviewRequired: decision.settings.reviewRequired,
			selectedAt: decision.selectedAt,
		};
		this.currentRouting = route;
		this.deps.database.setState("modelRouting", route);
		const orchestrationInstructions = requirements.parallelizable
			? [
					"This request has independent specialist work. You are the accountable orchestrator.",
					"Create focused subtasks only when they can run independently or provide a useful review.",
					"Use orchestration.delegate with model auto and providerIds auto; give each worker only the files, constraints, decisions, and output contract it needs.",
					`Do not exceed ${decision.settings.parallelism} concurrent workers or the configured delegation depth. Reconcile contradictions and validate the integrated result before answering.`,
					decision.settings.reviewRequired
						? "Use an independent reviewer for consequential or low-confidence integration decisions."
						: "",
				]
					.filter(Boolean)
					.join(" ")
			: decision.settings.reviewRequired
				? "Validate the result with deterministic checks when available. Use an independent reviewer route if validation is inconclusive or confidence drops."
				: "";
		return {
			route,
			execution,
			maximumContextCharacters: decision.settings.maximumContextCharacters,
			maximumOutputTokens: decision.settings.maximumOutputTokens,
			temperature: decision.settings.temperature,
			orchestrationInstructions,
			decision,
			requirements,
		};
	}

	private providerAllowed(providerId: string, poolId?: string): boolean {
		try {
			this.managedPolicy.assertProviderAllowed(poolId ?? providerId);
			return true;
		} catch {
			return false;
		}
	}

	private estimateEphemeralModelCost(
		attempts: ProviderAttempt[],
		result?: ModelResult,
	): number {
		let actualCostUsd = 0;
		for (const attempt of attempts) {
			const winning =
				attempt.status === "completed" &&
				attempt.providerId === result?.providerId;
			const estimatedCostUsd = winning
				? this.usageGovernor.estimateCost(
						attempt.providerId,
						result.model,
						result.usage,
					)
				: 0;
			actualCostUsd += estimatedCostUsd;
		}
		return actualCostUsd;
	}

	private finishEphemeralRoute(
		automatic: ReturnType<AgentCore["automaticRoute"]>,
		status: "completed" | "failed",
		result?: ModelResult,
		actualCostUsd = 0,
	): void {
		const winning = result
			? this.modelRegistry
					.list()
					.find(
						(profile) =>
							profile.endpointId === result.providerId &&
							profile.model === result.model,
					)
			: undefined;
		this.modelRegistry.recordOutcome({
			modelId: winning?.id ?? automatic.decision.selectedModelId,
			capabilities: automatic.requirements.capabilities,
			succeeded: status === "completed",
			validationPassed: status === "completed",
			...(result ? { refused: detectModelRefusal(result).refused } : {}),
			actualCostUsd,
			observedAt: this.now(),
		});
		if (automatic.decision.traceId)
			this.modelRouter.completeTrace(automatic.decision.traceId, {
				status,
				actualCostUsd,
				escalated: winning?.id !== automatic.decision.selectedModelId,
			});
	}

	private async generateNewTabGreeting(
		request: Extract<CoreRequest, { type: "new-tab-greeting" }>,
	): Promise<CoreResponse> {
		const context = {
			currentTimeOfDay: request.currentTimeOfDay,
			usualVisitTime: request.usualVisitTime,
			visitFrequency: request.visitFrequency,
			todayVisit: request.todayVisit,
			...(request.firstName ? { firstName: request.firstName } : {}),
		};
		const prompt = newTabGreetingUserPrompt(context);
		const automatic = this.automaticRoute(
			"new-tab-greeting",
			prompt,
			["auto"],
		);
		let lease: { release(): void } | undefined;
		try {
			lease = this.usageGovernor.acquire();
			const poolResult = await this.providerPool.complete(
				{
					model: automatic.execution.model,
					reasoningEffort: automatic.route.reasoningEffort,
					serviceTier: automatic.route.serviceTier,
					messages: [
						{
							role: "system",
							content: textContent(NEW_TAB_GREETING_SYSTEM_PROMPT),
						},
						{ role: "user", content: textContent(prompt) },
					],
					maxOutputTokens: Math.min(
						automatic.maximumOutputTokens,
						64,
					),
					temperature: automatic.temperature,
					metadata: { surface: "new-tab-greeting" },
				},
				{
					providerIds: automatic.execution.providerIds,
					providerModels: automatic.execution.providerModels,
					automaticRouting: false,
					canAttempt: (_providerId, _model, attemptIndex) =>
						this.usageGovernor.canAttempt(attemptIndex),
					providerAllowed: (providerId, poolId) =>
						this.providerAllowed(providerId, poolId),
					signal: AbortSignal.timeout(8_000),
				},
			);
			const actualCostUsd = this.estimateEphemeralModelCost(
				poolResult.attempts,
				poolResult.result,
			);
			this.usageGovernor.recordEphemeralCost(actualCostUsd);
			const greeting = validateNewTabGreeting(poolResult.result.text);
			if (!greeting) {
				this.finishEphemeralRoute(
					automatic,
					"failed",
					poolResult.result,
					actualCostUsd,
				);
				throw new Error("The generated New Tab greeting failed its safety checks.");
			}
			this.finishEphemeralRoute(
				automatic,
				"completed",
				poolResult.result,
				actualCostUsd,
			);
			return {
				ok: true,
				newTabGreeting: greeting,
				routing: automatic.route,
			};
		} catch (error) {
			if (error instanceof ProviderPoolError) {
				const actualCostUsd = this.estimateEphemeralModelCost(
					error.attempts,
				);
				this.finishEphemeralRoute(
					automatic,
					"failed",
					undefined,
					actualCostUsd,
				);
			} else if (!(error instanceof Error) || !error.message.includes("safety checks")) {
				this.finishEphemeralRoute(automatic, "failed");
			}
			throw error;
		} finally {
			lease?.release();
		}
	}

	private async generateBrowserTabFolderNames(
		groups: BrowserTabFolderNamingGroup[],
	): Promise<CoreResponse> {
		const fallback = fallbackBrowserTabFolderNames(groups);
		if (groups.length === 0 || this.providerPool.list().length === 0)
			return { ok: true, browserTabFolderNames: fallback };

		const prompt = browserTabFolderNamingPrompt(groups);
		let automatic: ReturnType<AgentCore["automaticRoute"]>;
		try {
			automatic = this.automaticRoute(
				"browser-tab-folder-names",
				"Generate concise, topic-specific labels for related browser-tab clusters.",
				["auto"],
			);
		} catch {
			// Naming is an enhancement to the deterministic grouping plan. A missing
			// or unavailable model must never prevent the user from reviewing tabs.
			return { ok: true, browserTabFolderNames: fallback };
		}

		let lease: { release(): void } | undefined;
		try {
			lease = this.usageGovernor.acquire();
			const poolResult = await this.providerPool.complete(
				{
					model: automatic.execution.model,
					reasoningEffort: automatic.route.reasoningEffort,
					serviceTier: automatic.route.serviceTier,
					messages: [
						{
							role: "system",
							content: textContent(BROWSER_TAB_FOLDER_NAMING_SYSTEM_PROMPT),
						},
						{ role: "user", content: textContent(prompt) },
					],
					maxOutputTokens: Math.min(automatic.maximumOutputTokens, 512),
					temperature: Math.min(automatic.temperature, 0.3),
					metadata: { surface: "browser-tab-folder-names" },
				},
				{
					providerIds: automatic.execution.providerIds,
					providerModels: automatic.execution.providerModels,
					automaticRouting: false,
					canAttempt: (_providerId, _model, attemptIndex) =>
						this.usageGovernor.canAttempt(attemptIndex),
					providerAllowed: (providerId, poolId) =>
						this.providerAllowed(providerId, poolId),
					signal: AbortSignal.timeout(8_000),
				},
			);
			const actualCostUsd = this.estimateEphemeralModelCost(
				poolResult.attempts,
				poolResult.result,
			);
			this.usageGovernor.recordEphemeralCost(actualCostUsd);
			const names = parseBrowserTabFolderNames(
				poolResult.result.text,
				groups,
			);
			if (!names) {
				this.finishEphemeralRoute(
					automatic,
					"failed",
					poolResult.result,
					actualCostUsd,
				);
				return { ok: true, browserTabFolderNames: fallback };
			}
			this.finishEphemeralRoute(
				automatic,
				"completed",
				poolResult.result,
				actualCostUsd,
			);
			return { ok: true, browserTabFolderNames: names };
		} catch (error) {
			if (error instanceof ProviderPoolError) {
				this.finishEphemeralRoute(
					automatic,
					"failed",
					undefined,
					this.estimateEphemeralModelCost(error.attempts),
				);
			} else {
				this.finishEphemeralRoute(automatic, "failed");
			}
			return { ok: true, browserTabFolderNames: fallback };
		} finally {
			lease?.release();
		}
	}

	private recordAutomaticOutcome(
		automatic: ReturnType<AgentCore["automaticRoute"]>,
		result: AgentLoopResult,
	): void {
		if (result.run.status === "waiting_approval") {
			this.deps.database.setPrivateState(
				`agent-run-routing.${result.run.id}`,
				automatic,
			);
			return;
		}
		const audits = this.deps.database.listModelCallAudits(result.run.id);
		const actualCostUsd = audits.reduce(
			(sum, audit) => sum + audit.estimatedCostUsd,
			0,
		);
		const winning = result.modelResult
			? this.modelRegistry
					.list()
					.find(
						(profile) =>
							profile.endpointId === result.modelResult?.providerId &&
							profile.model === result.modelResult.model,
					)
			: undefined;
		const modelId = winning?.id ?? automatic.decision.selectedModelId;
		const completed = result.run.status === "completed";
		const refusal = detectModelRefusal(result.modelResult ?? { text: "" });
		this.modelRegistry.recordOutcome({
			modelId,
			capabilities: automatic.requirements.capabilities,
			succeeded: completed,
			validationPassed: completed,
			refused: refusal.refused,
			...(refusal.reason ? { refusalReason: refusal.reason } : {}),
			...((result.run.refusalRecoveryCount ?? 0) > 0
				? { recoverySucceeded: completed }
				: {}),
			latencyMs: audits.reduce((sum, audit) => sum + audit.durationMs, 0),
			actualCostUsd,
			escalated: modelId !== automatic.decision.selectedModelId,
			observedAt: this.now(),
		});
		if (automatic.decision.traceId) {
			this.modelRouter.completeTrace(automatic.decision.traceId, {
				status: completed
					? "completed"
					: result.run.status === "cancelled"
						? "cancelled"
						: result.run.status === "failed"
							? "failed"
							: "running",
				actualCostUsd,
				escalated: modelId !== automatic.decision.selectedModelId,
			});
		}
	}

	private recordAutomaticFailure(
		automatic: ReturnType<AgentCore["automaticRoute"]>,
		cancelled: boolean,
	): void {
		this.modelRegistry.recordOutcome({
			modelId: automatic.decision.selectedModelId,
			capabilities: automatic.requirements.capabilities,
			succeeded: false,
			validationPassed: false,
			escalated: false,
			observedAt: this.now(),
		});
		if (automatic.decision.traceId) {
			this.modelRouter.completeTrace(automatic.decision.traceId, {
				status: cancelled ? "cancelled" : "failed",
				escalated: false,
			});
		}
	}

	private async ensureIndependentReview(
		automatic: ReturnType<AgentCore["automaticRoute"]>,
		sessionId: string,
		result: AgentLoopResult,
	): Promise<void> {
		if (!automatic.route.reviewRequired || result.run.status !== "completed")
			return;
		const review = await this.orchestrator.delegate({
			parentSessionId: sessionId,
			title: "Independent result review",
			prompt: [
				"Review the completed agent result below for correctness, safety, and evidence.",
				"This is an independent review route. Identify any concrete defect or missing validation; do not delegate further.",
				`Result:\n${result.assistantMessage?.content.slice(0, 50_000) ?? "[No assistant text was returned.]"}`,
			].join("\n\n"),
			model: "auto",
			providerIds: automatic.execution.providerIds,
			role: "reviewer",
			allowedTools: [],
			requiredCapabilities: { code_review: 0.95, reliability: 0.9 },
			maximumTurns: this.configuration.current().workflows.maximumTurns,
		});
		if (review.result.run.status !== "completed")
			throw new Error("The required independent reviewer did not complete.");
	}

	resolveChannelSession(envelope: ChannelEnvelope): string {
		const sessionId = this.deps.channels?.sessionRoutes[envelope.channelId];
		if (!sessionId) throw new Error("Inbound channel route is not configured.");
		this.runtime.getSession(sessionId);
		return sessionId;
	}

	private updateApproval(approval: Approval): void {
		this.deps.database.saveApproval(approval);
	}

	approve(approvalId: string): WorkspaceSnapshot {
		const approval = this.deps.database
			.listApprovals()
			.find((item) => item.id === approvalId);
		if (!approval) throw new Error("Approval not found");
		if (approval.status === "executed") return this.snapshot();

		const approved: Approval = { ...approval, status: "approved" };
		this.updateApproval(approved);
		const policy = mayExecute({
			risk: approval.riskLevel,
			approvalStatus: approved.status,
		});
		if (!policy.allowed) throw new Error(policy.reason);
		this.state = "working";
		this.deps.database.setState("agentState", this.state);

		const execution = this.deps.database.idempotent(
			`teacher-plan:${approval.id}`,
			() => {
				const message = this.email.sendDraft({
					operationId: `email:${approval.id}`,
					...approval.proposedEmail,
				});
				const event = this.calendar.createEvent({
					operationId: `calendar:${approval.id}`,
					...approval.proposedCalendarEvent,
				});
				if (!this.email.verifySent(message.messageId))
					throw new Error(
						"Sent message could not be read back from the provider adapter.",
					);
				if (!this.calendar.verifyEvent(event.eventId))
					throw new Error(
						"Calendar event could not be read back from the provider adapter.",
					);
				return { messageId: message.messageId, eventId: event.eventId };
			},
		);

		const timestamp = this.now();
		if (!execution.repeated) {
			this.deps.database.addActivity({
				id: "activity-user-approved",
				title: "Plan approved",
				detail: "External email and calendar actions were authorized.",
				timestamp,
				status: "verified",
				sourceIds: [approval.id],
			});
			this.deps.database.addActivity({
				id: "activity-email-sent",
				title: "Reply sent and verified",
				detail: `Provider adapter read back ${execution.result.messageId}.`,
				timestamp,
				status: "verified",
				sourceIds: [execution.result.messageId],
			});
			this.deps.database.addActivity({
				id: "activity-event-created",
				title: "Calendar event created and verified",
				detail: `Provider adapter read back ${execution.result.eventId}.`,
				timestamp,
				status: "verified",
				sourceIds: [execution.result.eventId],
			});
			const memory: MemoryRecord = {
				id: "memory-test-date-decision",
				type: "episodic",
				content:
					"Monday was selected for the Algebra II test because Friday swim compressed the day and the weekend provided study time.",
				structuredData: {
					category: "projects",
					choice: "Monday",
					messageId: execution.result.messageId,
					eventId: execution.result.eventId,
				},
				sourceIds: [
					approval.id,
					execution.result.messageId,
					execution.result.eventId,
				],
				sourceType: "verified-action",
				createdAt: timestamp,
				updatedAt: timestamp,
				confidence: 1,
				importance: 0.85,
				sensitivity: "personal",
				status: "active",
				entityIds: ["class-algebra-2", "person-ms-rivera"],
				userConfirmed: true,
				inferred: false,
			};
			this.deps.database.upsertMemory(memory);
			this.deps.database.addActivity({
				id: "activity-memory-updated",
				title: "Decision saved to memory",
				detail: "Stored the verified choice, reason, message ID, and event ID.",
				timestamp,
				status: "verified",
				sourceIds: [memory.id],
			});
		}

		this.updateApproval({
			...approved,
			status: "executed",
			executedAt: timestamp,
		});
		this.opportunity = { ...this.opportunity, status: "completed" };
		this.deps.database.setState("teacherOpportunity", this.opportunity);
		this.state = "idle";
		this.deps.database.setState("agentState", this.state);
		return this.snapshot();
	}

	reject(approvalId: string): WorkspaceSnapshot {
		const approval = this.deps.database
			.listApprovals()
			.find((item) => item.id === approvalId);
		if (!approval) throw new Error("Approval not found");
		if (approval.status === "executed")
			throw new Error(
				"A verified completed action cannot be retroactively rejected.",
			);
		this.updateApproval({ ...approval, status: "rejected" });
		this.opportunity = { ...this.opportunity, status: "ignored" };
		this.state = "idle";
		this.deps.database.setState("teacherOpportunity", this.opportunity);
		this.deps.database.setState("agentState", this.state);
		this.deps.database.addActivity({
			id: "activity-plan-rejected",
			title: "Plan rejected",
			detail: "No email or calendar action was executed.",
			timestamp: this.now(),
			status: "blocked",
			sourceIds: [approvalId],
		});
		return this.snapshot();
	}

	editApproval(approvalId: string, emailBody: string): WorkspaceSnapshot {
		const approval = this.deps.database
			.listApprovals()
			.find((item) => item.id === approvalId);
		if (!approval) throw new Error("Approval not found");
		if (approval.status !== "pending")
			throw new Error("Only a pending plan can be edited.");
		this.updateApproval({
			...approval,
			proposedEmail: { ...approval.proposedEmail, body: emailBody },
		});
		this.deps.database.addActivity({
			id: `activity-plan-edited-${randomUUID()}`,
			title: "Draft edited",
			detail:
				"The pending email text changed; no external action was executed.",
			timestamp: this.now(),
			status: "reasoned",
			sourceIds: [approvalId],
		});
		return this.snapshot();
	}

	troubleshoot(message: string): string {
		this.currentRouting = {
			taskId: "chat-device-troubleshooting",
			model: "local-rules",
			reasoningEffort: "none",
			fastMode: false,
			serviceTier: "standard",
			execution: "local",
			rationale:
				"Verified local troubleshooting rules cover this demonstration without a model request.",
			confidence: 1,
			selectedAt: this.now(),
		};
		this.deps.database.setState("modelRouting", this.currentRouting);
		const categories = this.context.categoriesFor(message);
		const resolved = this.context.resolve({
			userMessage: message,
			detectedIntent: "device-troubleshooting",
			detectedEntities: ["DJI controller", "mobile device"],
			possibleContextCategories: categories,
			maximumRetrievedItems: 6,
		});
		const contextText = resolved.confirmed
			.map((item) => item.content)
			.join(" ")
			.toLowerCase();
		if (
			contextText.includes("developer beta") &&
			contextText.includes("another cable") &&
			contextText.includes("launches dji fly")
		) {
			return "Because the controller powers the phone, launches DJI Fly, and another cable already failed, the physical link is not the first suspect. Your iPhone 16 Pro is also running an iOS developer beta, which may be incompatible with DJI Fly's current connection layer. Check DJI's current compatibility notes or test this controller with a stable-iOS device before treating the controller as defective. I would preserve the current setup and avoid repeating the cable and restart steps you've already completed.";
		}
		return "I found incomplete device context. I can inspect the exact phone, OS, controller, symptoms, and prior attempts before ranking the next safe test.";
	}

	setPaused(paused: boolean): WorkspaceSnapshot {
		this.state = paused
			? "paused"
			: this.deps.database
						.listApprovals()
						.some((item) => item.status === "pending")
				? "waiting_approval"
				: "idle";
		this.deps.database.setState("agentState", this.state);
		return this.snapshot();
	}

	setPersonality(personalityId: string): WorkspaceSnapshot {
		this.personalities.get(personalityId);
		this.selectedPersonalityId = personalityId;
		this.deps.database.setState("selectedPersonality", personalityId);
		return this.snapshot();
	}

	private sharedMemoryCaptureEnabled(): boolean {
		return (
			this.personalities.get(this.selectedPersonalityId).memoryScope ===
			"shared"
		);
	}

	private sharedMemoryInjectionEnabled(personalityId?: string): boolean {
		const personality = this.personalities.get(
			personalityId ?? this.selectedPersonalityId,
		);
		return (
			personality.memoryScope === "shared" &&
			this.configuration.current().memory.useSharedContext
		);
	}

	private memoryRecallStatus(personalityId?: string): MemoryRecallStatus {
		const configuration = this.configuration.current();
		const personality = this.personalities.get(
			personalityId ?? this.selectedPersonalityId,
		);
		const injectionEnabled = this.sharedMemoryInjectionEnabled(personality.id);
		let offReason: string | undefined;
		if (!injectionEnabled) {
			if (personality.memoryScope === "isolated")
				offReason = `${personality.name} uses isolated memory, so shared life context is not injected into chat.`;
			else if (!configuration.memory.useSharedContext)
				offReason =
					"Shared context is disabled in agent configuration (memory.useSharedContext).";
		}
		const honcho = this.honchoMemory.status();
		return {
			chatInjection: injectionEnabled ? "active" : "off",
			...(offReason ? { offReason } : {}),
			activeMemories: this.memory.activeMemories().length,
			confirmedPreferences: this.userModel.list("confirmed").length,
			explicitCapture: configuration.memory.captureExplicit,
			personalityScope: personality.memoryScope,
			personalityName: personality.name,
			useSharedContext: configuration.memory.useSharedContext,
			...(honcho.configuration.enabled && honcho.state === "error"
				? { honchoLastError: honcho.detail }
				: {}),
		};
	}

	createPersonality(
		personality: Omit<AgentPersonality, "builtin">,
	): WorkspaceSnapshot {
		this.personalities.register(personality);
		this.persistCustomPersonalities();
		return this.snapshot();
	}

	removePersonality(personalityId: string): WorkspaceSnapshot {
		this.personalities.remove(personalityId);
		if (this.selectedPersonalityId === personalityId)
			this.setPersonality("pragmatic");
		this.persistCustomPersonalities();
		return this.snapshot();
	}

	private persistCustomPersonalities(): void {
		this.deps.database.setPrivateState(
			this.customPersonalitiesKey,
			this.personalities
				.list()
				.filter((personality) => !personality.builtin)
				.map(({ builtin: _builtin, ...personality }) => personality),
		);
	}

	private pluginSummaries() {
		const connected = new Set(
			this.pluginMcpManager
				?.list()
				.map((connection) => connection.pluginName) ?? [],
		);
		return (this.pluginRegistry?.summary() ?? []).map((plugin) => ({
			...plugin,
			mcpConnected: connected.has(plugin.name),
		}));
	}

	private attachmentParts(
		sessionId: string,
		attachments: SelectedAttachment[] = [],
	): ModelContentPart[] {
		if (attachments.length === 0) return [];
		const session = this.runtime.getSession(sessionId);
		const workspaceAttachments = attachments.filter(
			(attachment) => attachment.source !== "external",
		);
		if (workspaceAttachments.length > 0 && !session.workspaceRoot)
			throw new Error("Workspace attachments require a task workspace.");
		const root = session.workspaceRoot
			? realpathSync(session.workspaceRoot)
			: undefined;
		const parts: ModelContentPart[] = [];
		let totalBytes = 0;
		for (const attachment of attachments) {
			const path = realpathSync(attachment.path);
			if (
				attachment.source !== "external" &&
				(!root || (path !== root && !path.startsWith(`${root}${sep}`)))
			)
				throw new Error("Attachment escapes the task workspace.");
			const metadata = statSync(path);
			if (!metadata.isFile() || metadata.size > 10 * 1024 * 1024)
				throw new Error(
					"Attachments must be regular files no larger than 10 MB.",
				);
			totalBytes += metadata.size;
			if (totalBytes > 25 * 1024 * 1024)
				throw new Error("Attachments are limited to 25 MB per message.");
			const bytes = readFileSync(path);
			const name = basename(path);
			if (
				attachment.mediaType.startsWith("text/") ||
				[
					"application/json",
					"application/xml",
					"application/javascript",
				].includes(attachment.mediaType)
			) {
				if (bytes.byteLength > 1_000_000 || bytes.includes(0))
					throw new Error(
						"Text attachments must be UTF-8-like files no larger than 1 MB.",
					);
				parts.push({
					type: "text",
					text: `[Attachment: ${name}]\n${bytes.toString("utf8")}`,
				});
			} else if (attachment.mediaType.startsWith("image/"))
				parts.push({
					type: "image",
					data: bytes.toString("base64"),
					mediaType: attachment.mediaType,
					source: "base64",
				});
			else if (attachment.mediaType.startsWith("audio/"))
				parts.push({
					type: "audio",
					data: bytes.toString("base64"),
					mediaType: attachment.mediaType,
					source: "base64",
				});
			else if (attachment.mediaType.startsWith("video/"))
				parts.push({
					type: "video",
					data: bytes.toString("base64"),
					mediaType: attachment.mediaType,
					source: "base64",
					name,
				});
			else
				parts.push({
					type: "document",
					data: bytes.toString("base64"),
					mediaType: attachment.mediaType,
					source: "base64",
					name,
				});
		}
		return parts;
	}

	async handle(request: CoreRequest): Promise<CoreResponse> {
		try {
			switch (request.type) {
				case "snapshot":
					return { ok: true, snapshot: this.snapshot() };
				case "communication-code-search":
					return {
						ok: true,
						communicationMatches: this.deps.googleWorkspace
							? await this.deps.googleWorkspace.searchLoginCodes({
										after: request.after,
										domain: request.domain,
										maxResults: request.maxResults,
									signal: AbortSignal.timeout(30_000),
								})
							: [],
					};
				case "approve":
					return { ok: true, snapshot: this.approve(request.approvalId) };
				case "reject":
					return { ok: true, snapshot: this.reject(request.approvalId) };
				case "edit-approval":
					return {
						ok: true,
						snapshot: this.editApproval(request.approvalId, request.emailBody),
					};
				case "troubleshoot":
					return {
						ok: true,
						answer: this.troubleshoot(request.message),
						routing: this.currentRouting,
						snapshot: this.snapshot(),
					};
				case "new-tab-greeting":
					return await this.generateNewTabGreeting(request);
				case "browser-name-tab-folders":
					return await this.generateBrowserTabFolderNames(request.groups);
				case "set-paused":
					return { ok: true, snapshot: this.setPaused(request.paused) };
				case "set-personality":
					return {
						ok: true,
						snapshot: this.setPersonality(request.personalityId),
					};
				case "create-personality":
					return {
						ok: true,
						snapshot: this.createPersonality({
							id: request.personality.id,
							name: request.personality.name,
							description: request.personality.description,
							instructions: request.personality.instructions,
							memoryScope: request.personality.memoryScope,
							...(request.personality.preferredModel
								? { preferredModel: request.personality.preferredModel }
								: {}),
							...(request.personality.providerIds
								? { providerIds: request.personality.providerIds }
								: {}),
							...(request.personality.toolNames
								? { toolNames: request.personality.toolNames }
								: {}),
						}),
					};
				case "remove-personality":
					return {
						ok: true,
						snapshot: this.removePersonality(request.personalityId),
					};
				case "plugin-list":
					return { ok: true, plugins: this.pluginSummaries() };
				case "plugin-set-enabled": {
					if (!this.pluginRegistry || !this.skillRegistry)
						throw new Error("Plugin discovery is not configured.");
					if (!request.enabled)
						await this.pluginMcpManager?.disconnect(request.name);
					const previous = this.pluginRegistry.get(request.name).enabled;
					try {
						this.pluginRegistry.setEnabled(request.name, request.enabled);
						this.skillRegistry.setRoots([
							...(this.deps.skillRoots ?? []),
							...(this.deps.learnedSkillRoot
								? [this.deps.learnedSkillRoot]
								: []),
							...this.pluginRegistry.skillRoots(),
						]);
					} catch (error) {
						this.pluginRegistry.setEnabled(request.name, previous);
						this.skillRegistry.setRoots([
							...(this.deps.skillRoots ?? []),
							...(this.deps.learnedSkillRoot
								? [this.deps.learnedSkillRoot]
								: []),
							...this.pluginRegistry.skillRoots(),
						]);
						throw error;
					}
					return { ok: true, plugins: this.pluginSummaries() };
				}
				case "plugin-connect-mcp": {
					if (!this.pluginMcpManager)
						throw new Error("Plugin MCP is not configured.");
					await this.pluginMcpManager.connect(
						request.name,
						this.runtime.ensureMainSession().id,
					);
					return { ok: true, plugins: this.pluginSummaries() };
				}
				case "plugin-disconnect-mcp": {
					if (!this.pluginMcpManager)
						throw new Error("Plugin MCP is not configured.");
					await this.pluginMcpManager.disconnect(request.name);
					return { ok: true, plugins: this.pluginSummaries() };
				}
				case "runtime-list-sessions":
					return { ok: true, sessions: this.runtime.listSessions() };
				case "runtime-create-session": {
					const session = this.runtime.createSession({
						title: request.title,
						...(request.workspaceRoot
							? { workspaceRoot: request.workspaceRoot }
							: {}),
					});
					this.pluginMcpManager?.attachSession(session.id);
					return { ok: true, session };
				}
				case "runtime-fork-session":
					return {
						ok: true,
						session: this.runtime.forkSession(request.sessionId, request.title),
					};
				case "runtime-checkpoint-session":
					return {
						ok: true,
						session: this.runtime.checkpoint(
							request.sessionId,
							request.summary,
						),
					};
				case "runtime-restore-checkpoint":
					this.abortActiveStreamsForHistoryRollback(request.sessionId);
					return {
						ok: true,
						session: this.runtime.restoreCheckpoint(
							request.sessionId,
							request.checkpointId,
						),
					};
				case "runtime-retry-agent": {
					this.abortActiveStreamsForHistoryRollback(request.sessionId);
					const priorMessage = this.runtime.retryLastTurnMessage(
						request.sessionId,
					);
					const route =
						request.model === "auto"
							? this.automaticRoute(
									`retry-${request.sessionId}`,
									priorMessage,
									request.providerIds,
								)
							: undefined;
					const controller = new AbortController();
					const active = request.streamId
						? {
								controller,
								sessionId: request.sessionId,
								steering: [] as string[],
							}
						: undefined;
					if (request.streamId && active)
						this.activeStreams.set(request.streamId, active);
					const executionSignal = AbortSignal.any([
						controller.signal,
						AbortSignal.timeout(
							this.modelRouter.policy().maximumTaskDurationMs,
						),
					]);
					try {
						const personality = this.personalities.get(
							this.selectedPersonalityId,
						);
						const configuration = this.configuration.current();
						const runtimeSession = this.runtime.getSession(request.sessionId);
						const sharedMemoryEnabled =
							this.sharedMemoryInjectionEnabled(personality.id);
						const honchoContext = sharedMemoryEnabled
							? await this.honchoMemory.contextFor({
									sessionId: request.sessionId,
									...(runtimeSession.workspaceRoot
										? { workspaceRoot: runtimeSession.workspaceRoot }
										: {}),
									query: priorMessage,
								})
							: "";
						const localContext = sharedMemoryEnabled
							? this.lifeContext.assembleContext({
									query: priorMessage,
								})
							: undefined;
						const userModelContext = this.userModel.promptContext();
						const memoryRecallReceipt = buildMemoryRecallReceipt({
							...(localContext
								? { localMemoryCount: localContext.memories.length }
								: {}),
							userModelContext,
							honchoContext,
						});
						const result = await this.agentLoop.retry({
							sessionId: request.sessionId,
							model: route?.execution.model ?? request.model,
							providerIds: route?.execution.providerIds ?? request.providerIds,
							...(request.providerModels || route
								? {
										providerModels: {
											...route?.execution.providerModels,
											...request.providerModels,
										},
									}
								: {}),
							...(route
								? {
										reasoningEffort: route.route.reasoningEffort,
										serviceTier: route.route.serviceTier,
										maximumContextCharacters: route.maximumContextCharacters,
										maximumOutputTokens: route.maximumOutputTokens,
										temperature: route.temperature,
										...(route.route.fallbackModelIds
											? { fallbackModelIds: route.route.fallbackModelIds }
											: {}),
									}
								: {}),
							allowedTools: this.configuration.filterToolNames(
								this.runtime
									.discoverTools(request.sessionId)
									.map((tool) => tool.name),
								personality.toolNames,
								{
									includeProtectedRecovery:
										personality.toolNames === undefined ||
										(personality.toolNames.length > 0 &&
											this.configuration.isConfigurationRequest(priorMessage)),
								},
							),
							instructions: [
								personality.instructions,
								this.configuration.instructions(),
								...(sharedMemoryEnabled
									? [
											this.userModel.promptContext(),
											localContext?.prompt ?? "",
											honchoContext,
										]
									: []),
							]
								.filter(Boolean)
								.join("\n\n"),
							maximumTurns: configuration.workflows.maximumTurns,
							signal: executionSignal,
							...(request.streamId
								? {
										onTextDelta: (delta: string) =>
											this.deps.onAgentTextDelta?.({
												streamId: request.streamId!,
												sessionId: request.sessionId,
												delta,
											}),
									}
								: {}),
							...(active
								? { takeSteering: () => active.steering.splice(0) }
								: {}),
							...(memoryRecallReceipt ? { memoryRecallReceipt } : {}),
						});
						if (route) {
							await this.ensureIndependentReview(
								route,
								request.sessionId,
								result,
							);
							this.recordAutomaticOutcome(route, result);
						}
						return {
							ok: true,
							run: result.run,
							...(route ? { routing: route.route } : {}),
							...(result.assistantMessage
								? { messages: [result.assistantMessage] }
								: {}),
							...(result.pendingExecution
								? { execution: result.pendingExecution }
								: {}),
						};
					} catch (error) {
						if (route)
							this.recordAutomaticFailure(route, executionSignal.aborted);
						throw error;
					} finally {
						if (request.streamId) this.activeStreams.delete(request.streamId);
					}
				}
				case "runtime-resume-session":
					return {
						ok: true,
						session: this.runtime.resumeSession(request.sessionId),
					};
				case "runtime-cancel-session":
					return {
						ok: true,
						session: this.runtime.cancelSession(request.sessionId),
					};
				case "runtime-append-message":
					return {
						ok: true,
						messages: [
							this.runtime.appendMessage({
								sessionId: request.sessionId,
								role: request.role,
								content: request.content,
								...(request.parentMessageId
									? { parentMessageId: request.parentMessageId }
									: {}),
								...(request.toolExecutionId
									? { toolExecutionId: request.toolExecutionId }
									: {}),
							}),
						],
					};
				case "runtime-list-messages":
					{
						if (
							request.limit === undefined &&
							request.beforeMessageId === undefined
						)
							return {
								ok: true,
								messages: this.runtime.listMessages(request.sessionId),
							};
						const page = this.runtime.listMessagesPage(
							request.sessionId,
							{
								...(request.beforeMessageId
									? { beforeMessageId: request.beforeMessageId }
									: {}),
								...(request.limit !== undefined ? { limit: request.limit } : {}),
							},
						);
						return {
							ok: true,
							messages: page.messages,
							hasMoreMessages: page.hasMore,
						};
					}
				case "runtime-list-runs":
					return {
						ok: true,
						runs: this.deps.database.listAgentRuns(request.sessionId),
					};
				case "runtime-list-executions": {
					if (request.sessionId)
						return {
							ok: true,
							executions: this.deps.database.listToolExecutions(
								request.sessionId,
							),
						};
					const executions = this.deps.database.listAllToolExecutions();
					const limit = request.limit ?? 80;
					return {
						ok: true,
						executions: executions.slice(-limit),
					};
				}
				case "runtime-list-action-receipts":
					return {
						ok: true,
						receipts: this.deps.database.listActionReceipts(
							request.sessionId,
							request.limit,
						),
					};
				case "runtime-list-pending-tool-approvals": {
					const runs = this.deps.database.listWaitingAgentRuns();
					const executions = runs.flatMap((run) => {
						if (!run.pendingToolExecutionId) return [];
						const execution = this.deps.database.getToolExecution(
							run.pendingToolExecutionId,
						);
						return execution ? [execution] : [];
					});
					return { ok: true, runs, executions };
				}
				case "runtime-session-usage": {
					this.runtime.getSession(request.sessionId);
					const runs = this.deps.database.listAgentRuns(request.sessionId);
					const calls = runs.flatMap((run) =>
						this.deps.database.listModelCallAudits(run.id),
					);
					return {
						ok: true,
						usage: {
							sessionId: request.sessionId,
							runs: runs.length,
							modelCalls: calls.length,
							inputTokens: calls.reduce(
								(sum, call) => sum + call.inputTokens,
								0,
							),
							outputTokens: calls.reduce(
								(sum, call) => sum + call.outputTokens,
								0,
							),
							cachedInputTokens: calls.reduce(
								(sum, call) => sum + (call.cachedInputTokens ?? 0),
								0,
							),
							reasoningTokens: calls.reduce(
								(sum, call) => sum + (call.reasoningTokens ?? 0),
								0,
							),
							estimatedCostUsd: calls.reduce(
								(sum, call) => sum + call.estimatedCostUsd,
								0,
							),
							compactedMessages: runs.reduce(
								(sum, run) =>
									sum +
									persistedCompactionCount(
										this.deps.database.getPrivateState<unknown>(
											`agent-run-compaction.${run.id}`,
										),
									),
								0,
							),
						},
					};
				}
				case "runtime-get-usage-policy":
					return { ok: true, usagePolicy: this.usageGovernor.getPolicy() };
				case "runtime-set-usage-policy":
					return {
						ok: true,
						usagePolicy: this.usageGovernor.setPolicy(request.policy),
					};
				case "runtime-search-messages":
					return {
						ok: true,
						messages: this.runtime.searchMessages(request.query, request.limit),
					};
				case "memory-list":
					return { ok: true, memories: this.memory.list() };
				case "memory-remember":
					return {
						ok: true,
						memories: [
							this.memory.remember({
								type: request.memoryType,
								content: request.content,
								structuredData: { capture: "direct-user-control" },
								sourceIds: [request.sourceId],
								sourceType: "explicit-user-control",
								confidence: 1,
								importance: 0.75,
								sensitivity: request.sensitivity,
								entityIds: [],
								userConfirmed: true,
								inferred: false,
								subject: request.subject,
								...(request.layer ? { layer: request.layer } : {}),
								confirmationStatus: "explicit",
							}),
						],
					};
				case "memory-correct":
					return {
						ok: true,
						memories: [
							this.memory.correct(request.id, {
								content: request.content,
								...(request.memoryType ? { type: request.memoryType } : {}),
								...(request.sensitivity
									? { sensitivity: request.sensitivity }
									: {}),
								...(request.layer ? { layer: request.layer } : {}),
							}),
						],
					};
				case "memory-forget":
					return { ok: true, memories: [this.memory.forget(request.id)] };
				case "memory-versions":
					return {
						ok: true,
						memoryVersions: this.memory.versions(request.id),
					};
				case "memory-run-maintenance":
					return { ok: true, memories: this.lifeContext.maintain().memories };
				case "memory-user-model-list":
					return { ok: true, userModelFacts: this.userModel.list() };
				case "memory-user-model-review":
					return {
						ok: true,
						userModelFacts: [
							this.userModel.review(request.id, request.decision),
						],
					};
				case "people-list":
					return { ok: true, people: this.lifeContext.listPeople() };
				case "people-upsert":
					return {
						ok: true,
						people: [
							this.lifeContext.upsertPerson({
								...(request.id ? { id: request.id } : {}),
								displayName: request.displayName,
								nicknames: request.nicknames,
								...(request.relationship
									? { relationship: request.relationship }
									: {}),
								...(request.organization
									? { organization: request.organization }
									: {}),
								...(request.role ? { role: request.role } : {}),
								...(request.timeZone ? { timeZone: request.timeZone } : {}),
								...(request.tone ? { tone: request.tone } : {}),
								...(request.formality ? { formality: request.formality } : {}),
								...(request.email ? { email: request.email } : {}),
								...(request.phone ? { phone: request.phone } : {}),
								sourceId: request.sourceId,
								sensitivity: request.sensitivity,
							}),
						],
					};
				case "people-delete":
					return {
						ok: true,
						people: [this.lifeContext.deletePerson(request.id)],
						memories: this.memory.list(),
					};
				case "calendar-list":
					return {
						ok: true,
						calendarEvents: this.lifeContext.listCalendar(
							request.startsAt,
							request.endsAt,
						),
						calendarProviders: this.lifeContext.providerStatuses(),
					};
				case "calendar-sync":
					return {
						ok: true,
						calendarEvents: await this.lifeContext.syncGoogle(
							request.startsAt,
							request.endsAt,
						),
						calendarProviders: this.lifeContext.providerStatuses(),
					};
				case "calendar-create-local":
					return {
						ok: true,
						calendarEvents: [
							this.lifeContext.createLocalEvent({
								title: request.title,
								startsAt: request.startsAt,
								endsAt: request.endsAt,
								...(request.description
									? { description: request.description }
									: {}),
								...(request.location ? { location: request.location } : {}),
								origin: request.origin,
								confidence: request.confidence,
								sourceId: request.sourceId,
							}),
						],
					};
				case "calendar-delete-local":
					return {
						ok: true,
						calendarEvents: [this.lifeContext.deleteLocalEvent(request.id)],
					};
				case "life-context-preview":
					return {
						ok: true,
						contextBundle: this.lifeContext.assembleContext({
							query: request.query,
							includeSensitive: request.includeSensitive,
							includeRestricted: request.includeRestricted,
							persistUsage: false,
						}),
					};
				case "writing-profile-get":
					return {
						ok: true,
						writingProfile: this.writingProfile.status(),
					};
				case "writing-profile-configure":
					return {
						ok: true,
						writingProfile: this.writingProfile.configure(request.config),
					};
				case "writing-profile-ingest":
					return {
						ok: true,
						writingProfile: this.writingProfile.ingest({
							text: request.text,
							consent: request.consent,
							useAsExemplar: request.useAsExemplar,
						}),
					};
				case "writing-profile-reset":
					return {
						ok: true,
						writingProfile: this.writingProfile.reset(),
					};
				case "writing-context-preview":
					return {
						ok: true,
						writingContextPreview: this.writingAssistant.preview({
							...(request.recipient ? { recipient: request.recipient } : {}),
							purpose: request.purpose,
							includeSensitive: request.includeSensitive,
						}),
					};
				case "writing-generate": {
					const generated = await this.writingAssistant.generate({
						...(request.recipient ? { recipient: request.recipient } : {}),
						purpose: request.purpose,
						...(request.sourceText ? { sourceText: request.sourceText } : {}),
						genre: request.genre,
						...(request.tone ? { tone: request.tone } : {}),
						adaptationStrength: request.adaptationStrength,
						includeSensitive: request.includeSensitive,
						providerIds: request.providerIds,
						...(request.providerModels
							? { providerModels: request.providerModels }
							: {}),
						...(request.writerModel
							? { writerModel: request.writerModel }
							: {}),
						...(request.reviewerModel
							? { reviewerModel: request.reviewerModel }
							: {}),
						signal: AbortSignal.timeout(25 * 60_000),
					});
					return {
						ok: true,
						writingResult: generated.result,
						writingRoutes: generated.routes,
						writingProfile: generated.profile,
						writingContextPreview: generated.context,
					};
				}
				case "honcho-memory-get":
					return { ok: true, honchoMemoryStatus: this.honchoMemory.status() };
				case "honcho-memory-configure": {
					const honchoMemoryStatus = this.honchoMemory.configure(
						request.configuration,
					);
					this.refreshHonchoTools();
					return { ok: true, honchoMemoryStatus };
				}
				case "honcho-memory-verify":
					return {
						ok: true,
						honchoMemoryStatus: await this.honchoMemory.verify(),
					};
				case "dreaming-get":
					return { ok: true, dreamingStatus: this.dreaming.status() };
				case "dreaming-set":
					return {
						ok: true,
						dreamingStatus: this.dreaming.configure(request.configuration),
					};
				case "dreaming-run":
					return {
						ok: true,
						dreamingStatus: this.dreaming.run(request.preview),
					};
				case "dreaming-review":
					return {
						ok: true,
						dreamingStatus: this.dreaming.review(request.id, request.decision),
					};
				case "presence-list":
					this.presence.beacon({
						instanceId: this.coreInstanceId,
						mode: "node",
						reason: "isolated agent core",
					});
					return { ok: true, presence: this.presence.list() };
				case "presence-beacon":
					return {
						ok: true,
						presence: [
							this.presence.beacon({
								instanceId: request.instanceId,
								mode: request.mode,
								...(request.version ? { version: request.version } : {}),
								...(request.reason ? { reason: request.reason } : {}),
							}),
						],
					};
				case "event-applications-list":
					return {
						ok: true,
						eventApplications: this.eventApplications.list(),
					};
				case "event-applications-create":
					return {
						ok: true,
						eventApplications: [
							this.eventApplications.create({
								title: request.title,
								organizer: request.organizer,
								url: request.url,
								...(request.deadline ? { deadline: request.deadline } : {}),
							}),
						],
					};
				case "event-applications-update":
					return {
						ok: true,
						eventApplications: [
							this.eventApplications.update(request.id, {
								...(request.status ? { status: request.status } : {}),
								...(request.eligibility
									? { eligibility: request.eligibility }
									: {}),
								...(request.answers ? { answers: request.answers } : {}),
							}),
						],
					};
				case "event-applications-submitted":
					return {
						ok: true,
						eventApplications: [
							this.eventApplications.markSubmitted(request.id, request.receipt),
						],
					};
				case "event-applications-remove":
					this.eventApplications.remove(request.id);
					return {
						ok: true,
						eventApplications: this.eventApplications.list(),
					};
				case "skill-learning-list": {
					if (!this.skillLearning)
						throw new Error("Learned skills are not configured.");
					return {
						ok: true,
						skillProposals: this.skillLearning.list(),
						skillFeedback: this.skillLearning.listFeedback(),
					};
				}
				case "skill-learning-suggest": {
					if (!this.skillLearning)
						throw new Error("Learned skills are not configured.");
					return {
						ok: true,
						skillProposals: [
							this.skillLearning.suggestForSession(request.sessionId),
						],
					};
				}
				case "skill-learning-propose": {
					if (!this.skillLearning)
						throw new Error("Learned skills are not configured.");
					return {
						ok: true,
						skillProposals: [this.skillLearning.propose(request)],
					};
				}
				case "skill-learning-review": {
					if (!this.skillLearning)
						throw new Error("Learned skills are not configured.");
					return {
						ok: true,
						skillProposals: [
							this.skillLearning.review(request.id, request.decision),
						],
					};
				}
				case "skill-learning-feedback": {
					if (!this.skillLearning)
						throw new Error("Learned skills are not configured.");
					return {
						ok: true,
						skillFeedback: [
							this.skillLearning.feedback({
								skillName: request.skillName,
								succeeded: request.succeeded,
								feedback: request.feedback,
								sourceIds: request.sourceIds,
							}),
						],
					};
				}
				case "web-search-direct": {
					if (!this.web) throw new Error("Web search is not configured.");
					const result = await this.web.search(
						request.query,
						request.maximumResults,
						new AbortController().signal,
					);
					return {
						ok: true,
						webResults: result.results,
						cached: result.cached,
					};
				}
				case "web-fetch-direct": {
					if (!this.web) throw new Error("Web fetch is not configured.");
					return { ok: true, webPage: await this.web.fetch(request.url) };
				}
				case "orchestration-list":
					return {
						ok: true,
						goals: this.orchestrator.listGoals(),
						teams: this.orchestrator.listTeams().map((team) => ({
							...team,
							usage: this.orchestrator.teamUsage(team.id),
						})),
						jobs: this.orchestrator
							.listJobs()
							.map(
								({
									prompt: _prompt,
									instructions: _instructions,
									providerModels: _models,
									...job
								}) => job,
							),
					};
				case "orchestration-model-registry":
					this.modelRegistry.applyProviderHealth(this.providerPool.health());
					return { ok: true, modelProfiles: this.modelRegistry.list() };
				case "orchestration-routing-policy-get":
					return { ok: true, routingPolicy: this.modelRouter.policy() };
				case "orchestration-routing-policy-set":
					return {
						ok: true,
						routingPolicy: this.modelRouter.setPolicy(request.policy),
					};
				case "orchestration-routing-traces":
					return { ok: true, routingTraces: this.modelRouter.traces() };
				case "orchestration-routing-feedback":
					this.modelRegistry.recordOutcome({
						modelId: request.modelId,
						capabilities: request.capabilities,
						succeeded: request.outcome !== "rejected",
						validationPassed: request.outcome === "accepted",
						...(request.reviewerConfidence === undefined
							? {}
							: { reviewerConfidence: request.reviewerConfidence }),
						rewritten: request.outcome === "corrected",
						observedAt: this.now(),
					});
					return { ok: true, modelProfiles: this.modelRegistry.list() };
				case "orchestration-goal-create":
					return {
						ok: true,
						goals: [
							this.orchestrator.createGoal(
								request.sessionId,
								request.title,
								request.objective,
								request.tasks,
							),
						],
					};
				case "orchestration-goal-update":
					return {
						ok: true,
						goals: [
							this.orchestrator.updateGoal(request.goalId, {
								...(request.status ? { status: request.status } : {}),
								...(request.taskId ? { taskId: request.taskId } : {}),
								...(request.taskStatus
									? { taskStatus: request.taskStatus }
									: {}),
								...(request.assigneeSessionId !== undefined
									? { assigneeSessionId: request.assigneeSessionId }
									: {}),
							}),
						],
					};
				case "orchestration-opportunity-to-goal":
					return {
						ok: true,
						goals: [
							this.orchestrator.goalFromOpportunity(
								request.sessionId,
								this.opportunity,
							),
						],
					};
				case "orchestration-team-create":
					return {
						ok: true,
						teams: [
							this.orchestrator.createTeam(
								request.parentSessionId,
								request.title,
								request.memberSessionIds,
								request.sharedPlan,
							),
						],
					};
				case "orchestration-team-update":
					return {
						ok: true,
						teams: [
							this.orchestrator.updateTeam(request.teamId, {
								...(request.memberSessionIds
									? { memberSessionIds: request.memberSessionIds }
									: {}),
								...(request.sharedPlan
									? { sharedPlan: request.sharedPlan }
									: {}),
							}),
						],
					};
				case "orchestration-team-message": {
					const message = this.orchestrator.sendPeerMessage(
						request.teamId,
						request.fromSessionId,
						request.toSessionId,
						request.text,
					);
					return {
						ok: true,
						teams: [
							this.orchestrator
								.listTeams()
								.find((team) => team.id === request.teamId)!,
						],
						answer: message.id,
					};
				}
				case "orchestration-delegate": {
					const delegated = await this.orchestrator.delegate({
						parentSessionId: request.parentSessionId,
						title: request.title,
						prompt: request.prompt,
						model: request.model,
						providerIds: request.providerIds,
						isolateWorktree: request.isolateWorktree,
						...(request.reasoningEffort
							? { reasoningEffort: request.reasoningEffort }
							: {}),
						...(request.role ? { role: request.role } : {}),
						...(request.requiredCapabilities
							? { requiredCapabilities: request.requiredCapabilities }
							: {}),
						...(request.allowedTools
							? { allowedTools: request.allowedTools }
							: {}),
					});
					return {
						ok: true,
						taskId: delegated.taskId,
						session: this.runtime.getSession(delegated.sessionId),
						run: delegated.result.run,
						...(delegated.route ? { delegationRouting: delegated.route } : {}),
						...(delegated.result.assistantMessage
							? { messages: [delegated.result.assistantMessage] }
							: {}),
					};
				}
				case "orchestration-handoff":
					return {
						ok: true,
						messages: [
							this.orchestrator.handoff(
								request.childSessionId,
								request.summary,
							),
						],
					};
				case "orchestration-schedule": {
					const {
						prompt: _prompt,
						instructions: _instructions,
						providerModels: _models,
						...job
					} = this.orchestrator.schedule({
						sessionId: request.sessionId,
						title: request.title,
						prompt: request.prompt,
						model: request.model,
						providerIds: request.providerIds,
						schedule: parseScheduleExpression(
							request.expression,
							new Date(this.now()),
						),
					});
					return { ok: true, jobs: [job] };
				}
				case "orchestration-job-cancel": {
					const {
						prompt: _prompt,
						instructions: _instructions,
						providerModels: _models,
						...job
					} = this.orchestrator.cancelJob(request.jobId);
					return { ok: true, jobs: [job] };
				}
				case "orchestration-job-resume": {
					const {
						prompt: _prompt,
						instructions: _instructions,
						providerModels: _models,
						...job
					} = await this.orchestrator.resumeJob(request.jobId);
					return { ok: true, jobs: [job] };
				}
				case "enterprise-summary": {
					const policy = this.managedPolicy.get();
					return {
						ok: true,
						...(policy
							? {
									enterprisePolicy: {
										organizationId: policy.organizationId,
										version: policy.version,
										maximumWorkers: policy.maximumWorkers,
										...(policy.retentionDays
											? { retentionDays: policy.retentionDays }
											: {}),
										...(policy.analyticsEnabled !== undefined
											? { analyticsEnabled: policy.analyticsEnabled }
											: {}),
										ssoConfigured: Boolean(policy.sso),
										updatedAt: policy.updatedAt,
									},
									...(policy.analyticsEnabled === false
										? {}
										: { enterpriseAnalytics: this.managedPolicy.analytics() }),
									organizationMembers: this.managedPolicy.listMembers(),
								}
							: {}),
					};
				}
				case "enterprise-enforce-retention":
					return {
						ok: true,
						retentionResult: this.managedPolicy.enforceRetention(),
					};
				case "enterprise-member-upsert":
					return {
						ok: true,
						organizationMembers: [
							this.managedPolicy.provisionMember(request.member),
						],
					};
				case "enterprise-member-deactivate":
					return {
						ok: true,
						organizationMembers: [
							this.managedPolicy.deactivateMember(request.externalId),
						],
					};
				case "enterprise-verify-identity": {
					const identity = this.managedPolicy.verifyIdentityToken(
						request.token,
					);
					return { ok: true, answer: JSON.stringify(identity) };
				}
				case "observability-get":
					return {
						ok: true,
						observabilityConfiguration: this.observability.configuration(),
						observabilityStatus: this.observability.status(),
					};
				case "observability-set": {
					await this.observability.configure(
						request.configuration,
						request.headerValue,
					);
					return {
						ok: true,
						observabilityConfiguration: this.observability.configuration(),
						observabilityStatus: this.observability.status(),
					};
				}
				case "observability-test": {
					await this.observability.test();
					return {
						ok: true,
						observabilityConfiguration: this.observability.configuration(),
						observabilityStatus: this.observability.status(),
					};
				}
				case "media-list-artifacts":
					return { ok: true, artifacts: this.artifacts?.list() ?? [] };
				case "media-preview-artifact": {
					if (!this.artifacts)
						throw new Error("Artifact storage is not configured.");
					return {
						ok: true,
						artifactPreview: this.artifacts.preview(
							request.artifactId,
							request.maximumBytes,
						),
					};
				}
				case "media-transcribe": {
					if (!this.deps.transcriptionProvider)
						throw new Error(
							"Voice transcription is not configured. Add an OpenAI credential in Connections.",
						);
					const data = Buffer.from(request.dataBase64, "base64");
					if (
						data.byteLength === 0 ||
						data.toString("base64").replace(/=+$/, "") !==
							request.dataBase64.replace(/=+$/, "")
					)
						throw new Error("Voice recording contains invalid base64 data.");
					const result = await this.deps.transcriptionProvider.transcribe({
						data,
						mediaType: request.mediaType,
						signal: AbortSignal.timeout(120_000),
					});
					return { ok: true, transcription: result };
				}
				case "channel-list":
					return { ok: true, channels: this.channelGateway?.list() ?? [] };
				case "channel-interaction-get":
					return {
						ok: true,
						channelInteractionConfiguration:
							this.channelGateway.interactionConfiguration(),
					};
				case "channel-interaction-set":
					return {
						ok: true,
						channelInteractionConfiguration:
							this.channelGateway.configureInteraction(request.configuration),
					};
				case "skin-get":
					return { ok: true, skinStatus: this.skins.status() };
				case "skin-select":
					return { ok: true, skinStatus: this.skins.select(request.skinId) };
				case "skin-import":
					return { ok: true, skinStatus: this.skins.import(request.source) };
				case "skin-remove":
					return { ok: true, skinStatus: this.skins.remove(request.skinId) };
				case "pet-get":
					return { ok: true, petStatus: this.requirePets().status() };
				case "pet-gallery":
					return {
						ok: true,
						petGallery: await this.requirePets().gallery(
							request.query,
							request.limit,
						),
					};
				case "pet-install":
					return {
						ok: true,
						petStatus: await this.requirePets().install(
							request.slug,
							request.select,
							undefined,
							request.force,
						),
					};
				case "pet-select":
					return {
						ok: true,
						petStatus: this.requirePets().select(request.slug),
					};
				case "pet-configure":
					return {
						ok: true,
						petStatus: this.requirePets().configure({
							...(request.enabled !== undefined
								? { enabled: request.enabled }
								: {}),
							...(request.scale !== undefined ? { scale: request.scale } : {}),
							...(request.renderMode !== undefined
								? { renderMode: request.renderMode }
								: {}),
							...(request.poppedOut !== undefined
								? { poppedOut: request.poppedOut }
								: {}),
						}),
					};
				case "pet-remove":
					return {
						ok: true,
						petStatus: this.requirePets().remove(request.slug),
					};
				case "pet-asset":
					return { ok: true, petAsset: this.requirePets().asset(request.slug) };
				case "pet-decoder-diagnostic":
					return {
						ok: true,
						petDecoderDiagnostic: await this.requirePets().verifyDecoder(),
					};
				case "pet-hatch-status":
					return {
						ok: true,
						petHatchCapability: this.requirePetHatch().capability(),
						petHatchDrafts: this.requirePetHatch().drafts(),
					};
				case "pet-hatch-drafts":
					return {
						ok: true,
						petHatchCapability: this.requirePetHatch().capability(),
						petHatchDrafts: await this.requirePetHatch().generateDrafts(
							{
								concept: request.concept,
								style: request.style,
								count: request.count,
							},
							AbortSignal.timeout(180_000),
						),
					};
				case "pet-hatch-complete": {
					const result = await this.requirePetHatch().hatch(
						{
							draftId: request.draftId,
							slug: request.slug,
							displayName: request.displayName,
							description: request.description,
						},
						AbortSignal.timeout(420_000),
					);
					const { petStatus, ...petHatchResult } = result;
					return { ok: true, petStatus, petHatchResult };
				}
				case "runtime-list-providers": {
					const configured = this.providerPool.list();
					const logical = [
						...new Map(
							configured.map((provider) => [
								provider.poolId ?? provider.id,
								{
									id: provider.poolId ?? provider.id,
									capabilities: provider.capabilities,
								},
							]),
						).values(),
					];
					const auto = configured.length
						? [
								{
									id: "auto",
									capabilities: {
										streaming: configured.some(
											(provider) => provider.capabilities.streaming,
										),
										tools: configured.some(
											(provider) => provider.capabilities.tools,
										),
										images: configured.some(
											(provider) => provider.capabilities.images,
										),
										audio: configured.some(
											(provider) => provider.capabilities.audio,
										),
										documents: configured.some(
											(provider) => provider.capabilities.documents,
										),
										video: configured.some(
											(provider) => provider.capabilities.video,
										),
										local: configured.every(
											(provider) => provider.capabilities.local,
										),
									},
								},
							]
						: [];
					return { ok: true, providers: [...logical, ...auto] };
				}
				case "runtime-verify-provider":
					return {
						ok: true,
						providerVerifications: await this.providerPool.verify(
							request.providerId,
							AbortSignal.timeout(8_000),
						),
					};
				case "runtime-run-agent": {
					if (request.streamId && this.activeStreams.has(request.streamId))
						throw new Error("Agent stream ID is already active.");
					const controller = new AbortController();
					const active = request.streamId
						? {
								controller,
								sessionId: request.sessionId,
								steering: [] as string[],
							}
						: undefined;
					if (request.streamId && active)
						this.activeStreams.set(request.streamId, active);
					const executionSignal = AbortSignal.any([
						controller.signal,
						AbortSignal.timeout(
							this.modelRouter.policy().maximumTaskDurationMs,
						),
					]);
					let route: ReturnType<AgentCore["automaticRoute"]> | undefined;
					try {
						const personality = this.personalities.get(
							request.personalityId ?? this.selectedPersonalityId,
						);
						const configuration = this.configuration.current();
						const selectedModel = personality.preferredModel ?? request.model;
						const selectedProviderIds = personality.providerIds?.length
							? personality.providerIds
							: request.providerIds;
						route =
							selectedModel === "auto"
								? this.automaticRoute(
										`run-${request.sessionId}`,
										request.message,
										selectedProviderIds,
										request.attachments,
									)
								: undefined;
						const runtimeSession = this.runtime.getSession(request.sessionId);
						const sharedMemoryEnabled = this.sharedMemoryInjectionEnabled(
							personality.id,
						);
						const honchoContext = sharedMemoryEnabled
							? await this.honchoMemory.contextFor({
									sessionId: request.sessionId,
									...(runtimeSession.workspaceRoot
										? { workspaceRoot: runtimeSession.workspaceRoot }
										: {}),
									query: request.message,
								})
							: "";
						const localContext = sharedMemoryEnabled
							? this.lifeContext.assembleContext({
									query: request.message,
								})
							: undefined;
						const userModelContext = this.userModel.promptContext();
						const memoryRecallReceipt = buildMemoryRecallReceipt({
							...(localContext
								? { localMemoryCount: localContext.memories.length }
								: {}),
							userModelContext,
							honchoContext,
						});
						const result = await this.agentLoop.run({
							sessionId: request.sessionId,
							model: route?.execution.model ?? selectedModel,
							providerIds: route?.execution.providerIds ?? selectedProviderIds,
							...(request.providerModels || route
								? {
										providerModels: {
											...route?.execution.providerModels,
											...request.providerModels,
										},
									}
								: {}),
							...(route
								? {
										reasoningEffort: route.route.reasoningEffort,
										serviceTier: route.route.serviceTier,
										maximumContextCharacters: route.maximumContextCharacters,
										maximumOutputTokens: route.maximumOutputTokens,
										temperature: route.temperature,
										...(route.route.fallbackModelIds
											? { fallbackModelIds: route.route.fallbackModelIds }
											: {}),
									}
								: request.reasoningEffort
									? { reasoningEffort: request.reasoningEffort }
									: {}),
							...(personality.toolNames
								? {
										allowedTools: this.configuration.filterToolNames(
											this.runtime
												.discoverTools(request.sessionId)
												.map((tool) => tool.name),
											personality.toolNames,
											{
												includeProtectedRecovery:
													personality.toolNames !== undefined &&
													personality.toolNames.length > 0 &&
													this.configuration.isConfigurationRequest(
														request.message,
													),
											},
										),
									}
								: {
										allowedTools: this.configuration.filterToolNames(
											this.runtime
												.discoverTools(request.sessionId)
												.map((tool) => tool.name),
										),
									}),
							userContent: [
								...textContent(request.message),
								...this.attachmentParts(request.sessionId, request.attachments),
							],
							...(request.browserContext
								? {
										ephemeralContext: textContent(
											selectBrowserContext(request.browserContext),
										),
									}
								: {}),
							instructions: [
								personality.instructions,
								route?.orchestrationInstructions,
								this.configuration.instructions(),
								...(sharedMemoryEnabled
									? [
											this.userModel.promptContext(),
											localContext?.prompt ?? "",
											honchoContext,
										]
									: []),
							]
								.filter(Boolean)
								.join("\n\n"),
							maximumTurns: Math.min(
								request.maximumTurns ?? configuration.workflows.maximumTurns,
								configuration.workflows.maximumTurns,
							),
							...(request.approvalStatus
								? { approvalStatus: request.approvalStatus }
								: {}),
							signal: executionSignal,
							...(request.streamId
								? {
										onTextDelta: (delta: string) =>
											this.deps.onAgentTextDelta?.({
												streamId: request.streamId!,
												sessionId: request.sessionId,
												delta,
											}),
									}
								: {}),
							...(active
								? { takeSteering: () => active.steering.splice(0) }
								: {}),
							...(memoryRecallReceipt ? { memoryRecallReceipt } : {}),
						});
						if (route) {
							await this.ensureIndependentReview(
								route,
								request.sessionId,
								result,
							);
							this.recordAutomaticOutcome(route, result);
						}
						return {
							ok: true,
							run: result.run,
							...(route ? { routing: route.route } : {}),
							...(result.assistantMessage
								? { messages: [result.assistantMessage] }
								: {}),
							...(result.pendingExecution
								? { execution: result.pendingExecution }
								: {}),
						};
					} catch (error) {
						if (route)
							this.recordAutomaticFailure(route, executionSignal.aborted);
						throw error;
					} finally {
						if (request.streamId) this.activeStreams.delete(request.streamId);
					}
				}
				case "runtime-resume-agent": {
					if (request.streamId && this.activeStreams.has(request.streamId))
						throw new Error("Agent stream ID is already active.");
					const controller = new AbortController();
					const waitingRun = this.deps.database.getAgentRun(request.runId);
					const rejectedConfigurationProposalId =
						request.approvalDecision === "rejected" &&
						waitingRun?.pendingToolName === "agent.config.apply" &&
						waitingRun.pendingToolExecutionId
							? String(
									this.deps.database.getToolExecution(
										waitingRun.pendingToolExecutionId,
									)?.input.proposalId ?? "",
								)
							: "";
					if (rejectedConfigurationProposalId)
						this.configuration.rejectProposal(
							rejectedConfigurationProposalId,
							"User declined the one-time apply approval.",
						);
					const active =
						request.streamId && waitingRun
							? {
									controller,
									sessionId: waitingRun.sessionId,
									steering: [] as string[],
								}
							: undefined;
					if (request.streamId && active)
						this.activeStreams.set(request.streamId, active);
					try {
						const configuration = this.configuration.current();
						const automatic = this.deps.database.getPrivateState<
							ReturnType<AgentCore["automaticRoute"]>
						>(`agent-run-routing.${request.runId}`);
						const result = await this.agentLoop.resume({
							runId: request.runId,
							approvalDecision: request.approvalDecision,
							maximumTurns: Math.min(
								request.maximumTurns ?? configuration.workflows.maximumTurns,
								configuration.workflows.maximumTurns,
							),
							signal: controller.signal,
							...(request.streamId && waitingRun
								? {
										onTextDelta: (delta: string) =>
											this.deps.onAgentTextDelta?.({
												streamId: request.streamId!,
												sessionId: waitingRun.sessionId,
												delta,
											}),
									}
								: {}),
							...(active
								? { takeSteering: () => active.steering.splice(0) }
								: {}),
						});
						if (automatic && result.run.status !== "waiting_approval") {
							await this.ensureIndependentReview(
								automatic,
								result.run.sessionId,
								result,
							);
							this.recordAutomaticOutcome(automatic, result);
							this.deps.database.setPrivateState(
								`agent-run-routing.${request.runId}`,
								null,
							);
						}
						return {
							ok: true,
							run: result.run,
							...(result.assistantMessage
								? { messages: [result.assistantMessage] }
								: {}),
							...(result.pendingExecution
								? { execution: result.pendingExecution }
								: {}),
						};
					} finally {
						if (request.streamId) this.activeStreams.delete(request.streamId);
					}
				}
				case "runtime-cancel-stream": {
					const active = this.activeStreams.get(request.streamId);
					if (!active)
						return { ok: true, answer: "Agent stream is not active." };
					active.controller.abort(new Error("Cancelled by the user."));
					return { ok: true, answer: "Cancellation requested." };
				}
				case "runtime-steer-agent": {
					const active = this.activeStreams.get(request.streamId);
					if (!active || active.sessionId !== request.sessionId)
						throw new Error("Agent stream is not active for this session.");
					if (active.steering.length >= 20)
						throw new Error("Agent steering queue is full.");
					active.steering.push(request.message);
					return { ok: true, answer: "Steering message queued." };
				}
				case "runtime-discover-tools":
					return {
						ok: true,
						tools: this.runtime.discoverTools(request.sessionId, request.query),
					};
				case "runtime-call-tool":
					return {
						ok: true,
						execution: await this.runtime.callTool(
							request.sessionId,
							request.toolName,
							request.input,
							{
								...(request.approvalStatus
									? { approvalStatus: request.approvalStatus }
									: {}),
								...(request.idempotencyKey
									? { idempotencyKey: request.idempotencyKey }
									: {}),
								...(request.externalContent
									? { externalContent: request.externalContent }
									: {}),
							},
						),
					};
				case "runtime-cancel-execution":
					return {
						ok: true,
						answer: this.runtime.cancelExecution(request.executionId)
							? "Cancellation requested."
							: "Execution is not active.",
					};
				case "runtime-list-approval-rules":
					return { ok: true, approvalRules: this.runtime.listApprovalRules() };
				case "runtime-set-approval-rule":
					return {
						ok: true,
						approvalRules: [
							this.runtime.setApprovalRule({
								toolName: request.toolName,
								decision: request.decision,
								scope: request.scope,
								...(request.sessionId ? { sessionId: request.sessionId } : {}),
							}),
						],
					};
				case "runtime-remove-approval-rule":
					return {
						ok: true,
						approvalRules: [this.runtime.removeApprovalRule(request.id)],
					};
			}
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof Error ? error.message : "Agent Core request failed",
			};
		}
	}

	private requirePets(): PetManager {
		if (!this.pets)
			throw new Error("Pet storage is not configured for this runtime.");
		return this.pets;
	}

	private requirePetHatch(): PetHatchManager {
		if (!this.petHatch)
			throw new Error("Pet hatch storage is not configured for this runtime.");
		return this.petHatch;
	}

	private refreshHonchoTools(): void {
		const configuration = this.honchoMemory.configuration();
		if (configuration.enabled && configuration.recallMode !== "context") {
			installHonchoMemoryTools(
				this.runtime,
				this.honchoMemory,
				this.runtime.listSessions().map((session) => session.id),
			);
			return;
		}
		for (const toolName of HONCHO_TOOL_NAMES)
			this.runtime.unregisterExternalTool(toolName);
	}

	async runAmbientMaintenance(at = new Date(this.now())): Promise<void> {
		this.presence.beacon({
			instanceId: this.coreInstanceId,
			mode: "node",
			reason: "isolated agent core",
		});
		this.dreaming.runIfDue(at);
		this.configuration.runImprovementScanIfDue(at);
		this.lifeContext.maintain();
		await this.lifeContext.syncGoogleIfStale(at);
	}

	private abortActiveStreamsForHistoryRollback(sessionId: string): void {
		for (const active of this.activeStreams.values()) {
			if (active.sessionId === sessionId && !active.controller.signal.aborted)
				active.controller.abort(
					new Error(
						"Active agent stream cancelled because the session history was rolled back.",
					),
				);
		}
	}

	attachCodexBrowserMcp(attachment: CodexBrowserMcpAttachment): void {
		for (const provider of this.providerPool.list()) {
			if (provider instanceof CodexAppServerProvider)
				provider.attachBrowserMcp(attachment);
		}
	}

	resolveCodexBrowserMcpSession(): BrowserMcpCallSession {
		const sessionIds = new Set<string>();
		for (const provider of this.providerPool.list()) {
			if (!(provider instanceof CodexAppServerProvider)) continue;
			const resolved = provider.activeBrowserMcpSession();
			if (!resolved.ok) {
				if (resolved.reason === "ambiguous")
					return { ok: false, reason: "ambiguous" };
				continue;
			}
			sessionIds.add(resolved.sessionId);
		}
		if (sessionIds.size === 1)
			return { ok: true, sessionId: [...sessionIds][0]! };
		if (sessionIds.size > 1) return { ok: false, reason: "ambiguous" };
		return { ok: false, reason: "none" };
	}

	async close(): Promise<void> {
		for (const active of this.activeStreams.values())
			active.controller.abort(new Error("Agent Core is shutting down."));
		this.activeStreams.clear();
		await this.pluginMcpManager?.close();
		await this.honchoMemory.flush();
		await this.observability.shutdown();
		await this.providerPool.close();
		this.runtime.close();
		this.deps.database.close();
	}
}

export { createKestrelAcpAgent, type KestrelAcpOptions } from "./acp";
export {
	installManagedPolicy,
	loadSignedManagedPolicy,
	type ManagedPolicy,
	ManagedPolicyStore,
	type MigrationCategory,
	type MigrationItem,
	MigrationManager,
	type MigrationPlan,
	type MigrationProduct,
	type MigrationSource,
	type MigrationTranslation,
	type OrganizationIdentity,
	type OrganizationMember,
} from "./administration";
export {
	AgentLoop,
	type AgentLoopInput,
	type AgentLoopResult,
	type AgentLoopResumeInput,
	type AgentLoopRetryInput,
	CHAT_CONFIGURATION_INSTRUCTIONS,
	LOCAL_FIRST_TOOL_INSTRUCTIONS,
	SessionRunBusyError,
} from "./agent-loop";
export { readBoundedResponseBytes } from "./bounded-http";
export {
	type BrowserAction,
	type BrowserActionResult,
	type BrowserAutomationBackend,
	BrowserController,
	normalizeIsolatedBrowserOrigins,
	type BrowserDiagnostic,
	type BrowserDownload,
	type BrowserSnapshot,
	type BrowserViewport,
	type DesktopAction,
	installBrowserTools,
	type ScreenshotFrame,
	type VisualComparison,
	type VisualValidationResult,
	VisualValidator,
} from "./browser-automation";
export {
	annotateAccessibilityTree,
	ELEMENT_REF_PATTERN,
	isBrowserElementRef,
	normalizeBrowserElementRef,
	type AnnotatedBrowserTree,
	type BrowserInteractiveRef,
} from "./browser-element-refs";
export { summarizeBrowserActivity } from "./browser-activity";
export {
	diffBrowserSnapshots,
	type BrowserObservationChange,
	type BrowserObservationDiff,
	type BrowserObservationNode,
	type BrowserObservationSnapshot,
} from "./browser-observation";
export {
	BROWSER_RECOVERY_HINT_KINDS,
	BROWSER_RECOVERY_REASON_CODES,
	type BrowserEffectState,
	BrowserRecoveryError,
	type BrowserRecoveryGuidance,
	type BrowserRecoveryHint,
	type BrowserRecoveryHintKind,
	type BrowserRecoveryOperation,
	type BrowserRecoveryReasonCode,
	type BrowserRecoverySurface,
	browserRecoveryReason,
	toBrowserRecoveryError,
} from "./browser-recovery";
export {
	CAPABILITY_CATALOG,
	type CapabilityCatalogEntry,
	capabilitySummary,
	PARITY_SOURCE_SNAPSHOT,
	type ParityStatus,
	type ReferenceProduct,
} from "./capability-catalog";
export {
	type ChannelAdapter,
	type ChannelAttachment,
	type ChannelEnvelope,
	ChannelGateway,
	type ChannelProgressPhase,
	ChannelProgressSession,
	type ChannelRuntimeConfiguration,
	environmentChannelConfiguration,
	installChannelTools,
	NativeChannelAdapter,
	type NativeChannelAdapterOptions,
	signChannelEnvelope,
	WebhookChannelAdapter,
	type WebhookChannelAdapterOptions,
} from "./channels";
export {
	environmentLanguageServerClient,
	installCodeIntelligenceTools,
	LanguageServerClient,
	type LanguageServerTransport,
	type LspMessage,
	type StdioLanguageServerOptions,
	StdioLanguageServerTransport,
	type TextPosition,
} from "./code-intelligence";
export {
	AgentConfigurationManager,
	type AgentConfigurationSurfaceRegistration,
	CONFIGURATION_TOOL_NAMES,
	DEFAULT_AGENT_CONFIGURATION,
	installAgentConfigurationTools,
} from "./configuration";
export {
	DevelopmentCalendarConnector,
	DevelopmentEmailConnector,
} from "./connectors";
export { type CompactedContext, ContextCompactor } from "./context-compactor";
export {
	modelVisibleToolResult,
	redactSensitiveContent,
} from "./tool-result-guardrails";
export { PreResponseContextResolver } from "./context-resolver";
export { DEFAULT_DREAMING_CONFIGURATION, DreamingManager } from "./dreaming";
export {
	EVENT_APPLICATION_TOOL_NAMES,
	type EventAnswerSensitivity,
	type EventApplication,
	type EventApplicationAnswer,
	EventApplicationManager,
	type EventApplicationStatus,
	type EventEligibilityItem,
	installEventApplicationTools,
} from "./event-applications";
export {
	bridgeMcpTools,
	type JsonRpcMessage,
	MCP_PROTOCOL_VERSION,
	McpClient,
	McpRuntimeServer,
	type McpTool,
	type McpToolResult,
	type McpTransport,
	StdioMcpTransport,
	StreamableHttpMcpTransport,
} from "./extensions/mcp";
export {
	type BrowserMcpCallSession,
	resolveUniqueMappedSession,
} from "./browser-mcp-session";
export {
	LocalBrowserMcpServer,
	type LocalBrowserMcpServerOptions,
} from "./local-mcp-http";
export {
	type InstalledPlugin,
	PLUGIN_SIGNATURE_PATH,
	type PluginBundleDigest,
	PluginInstaller,
	type PluginInstallerOptions,
	type PluginTrustKey,
	type RemovedPlugin,
	type VerifiedPluginBundle,
} from "./extensions/plugin-installer";
export {
	type PluginMcpConnection,
	PluginMcpManager,
} from "./extensions/plugin-mcp";
export { type PluginDescriptor, PluginRegistry } from "./extensions/plugins";
export {
	installSkillLearningTools,
	SkillLearningManager,
} from "./extensions/skill-learning";
export {
	type ActivatedSkill,
	installSkillTools,
	type SkillDescriptor,
	SkillRegistry,
} from "./extensions/skills";
export * from "./fixtures";
export {
	BonjourAdvertiser,
	type BonjourConfiguration,
	type BonjourMode,
	type GatewayCommandRunner,
	type GatewayProcessHandle,
	type GatewayProcessRunner,
	type TailscaleExposureConfiguration,
	TailscaleExposureManager,
	type TailscaleExposureMode,
	type TailscaleExposureStatus,
	TrustedProxyAuthorizer,
	type TrustedProxyConfiguration,
	type TrustedProxyRequest,
} from "./gateway-networking";
export {
	environmentGoogleWorkspaceClient,
	GoogleWorkspaceClient,
	installGoogleWorkspaceTools,
} from "./google-workspace";
export {
	HONCHO_TOOL_NAMES,
	type HonchoClientFactory,
	HonchoMemoryProvider,
	installHonchoMemoryTools,
} from "./honcho-memory";
export {
	LifeContextService,
	type PersonInput,
} from "./life-context";
export {
	ArtifactManager,
	type ArtifactRecord,
	type GeneratedMedia,
	installMediaTools,
	type MediaGenerationProvider,
} from "./media-artifacts";
export {
	createEnvironmentMediaProviders,
	createEnvironmentTranscriptionProvider,
	FalMusicProvider,
	type FalMusicProviderOptions,
	LocalDocumentProvider,
	OpenAiMediaProvider,
	type OpenAiMediaProviderOptions,
	OpenAiTranscriptionProvider,
	type OpenAiTranscriptionProviderOptions,
	type VoiceTranscriptionProvider,
} from "./media-providers";
export { installMemoryTools, type MemoryInput, MemoryManager } from "./memory";
export {
	AdaptiveModelRouter,
	DEFAULT_ROUTING_POLICY,
	ModelRegistry,
	type RouteOptions,
	type RoutingOutcome,
	TaskRequirementAnalyzer,
	type TaskRequirements,
} from "./model-orchestration";
export {
	type LocationAccuracy,
	type NativeNodeBeacon,
	type NativeNodeCapability,
	type NativeNodeCommand,
	NativeNodeManager,
	type NativeNodeRecord,
	type NativeNodeResult,
} from "./native-nodes";
export {
	DEFAULT_OBSERVABILITY_CONFIGURATION,
	ObservabilityManager,
	renderPrometheusMetrics,
} from "./observability";
export { OpportunityEngine } from "./opportunity-engine";
export {
	AutomationDaemon,
	type DelegatedTaskInput,
	type DelegatedTaskResult,
	type GoalRecord,
	type GoalTask,
	installOrchestrationTools,
	nextCronOccurrence,
	parseScheduleExpression,
	type ScheduledAgentJob,
	TaskOrchestrator,
	type TeamMessage,
	type TeamRecord,
	type WorkflowRecord,
	type WorkflowStep,
} from "./orchestration";
export { type AgentPersonality, PersonalityRegistry } from "./personality";
export {
	type PetHatchCapability,
	type PetHatchDraft,
	PetHatchManager,
	type PetHatchResult,
} from "./pet-hatch";
export { checkedAssetUrl, PetManager, webpDimensions } from "./pets";
export { type PresenceBeacon, PresenceManager } from "./presence";
export * from "./providers";
export {
	DockerCliRemoteBackend,
	environmentRemoteExecutionConfiguration,
	installRemoteExecutionTool,
	KubernetesCliRemoteBackend,
	type RemoteArtifact,
	type RemoteBackendKind,
	RemoteBackendManager,
	RemoteControl,
	type RemoteCredential,
	type RemoteExecutionBackend,
	type RemoteExecutionConfiguration,
	type RemoteExecutionResult,
	type RemoteScope,
	type RemoteTarget,
	type RemoteTrustedIdentity,
	ServerlessHttpRemoteBackend,
	SshCliRemoteBackend,
} from "./remote";
export { RemoteHttpServer, type RemoteHttpServerOptions } from "./remote-http";
export {
	AgentRuntime,
	type DeclarativeRuntimeHook,
	type RuntimeHook,
	type RuntimeHookContext,
	type RuntimeHookEvent,
	type RuntimeHookResult,
	type RuntimeModelTool,
	type RuntimeToolPolicyContext,
	type RuntimeToolPolicyDecision,
	type ToolCallOptions,
} from "./runtime";
export { BUILTIN_SKINS, contrast, SkinManager } from "./skins";
export {
	type TenantCell,
	TenantFleet,
	type TenantFleetRunner,
} from "./tenant-fleet";
export * from "./usage-governor";
export {
	type UserModelFact,
	type UserModelKind,
	type UserModelStatus,
	UserModelStore,
} from "./user-model";
export {
	BraveSearchProvider,
	type BraveSearchProviderOptions,
	environmentWebAccessOptions,
	installWebTools,
	isPrivateNetworkAddress,
	NetworkPolicyWebClient,
	type WebAccessOptions,
	type WebSearchProvider,
	type WebSearchResult,
} from "./web-tools";
export {
	WritingAssistant,
	type WritingAutomaticRoute,
	type WritingRouteResolver,
} from "./writing-assistant";
export {
	WritingProfileStore,
	WRITING_PROFILE_STORAGE_KEY,
} from "./writing-profile";
