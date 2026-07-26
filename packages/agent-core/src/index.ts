import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import type {
  AgentState,
  Approval,
  CoreRequest,
  CoreResponse,
  MemoryRecord,
  ModelRoutingDecision,
  SelectedAttachment,
  TaskOpportunity,
  WorkspaceSnapshot,
} from "@kestrel/shared-types";
import {
  PRODUCT_IDENTITY,
  WorkspaceSnapshotSchema,
} from "@kestrel/shared-types";
import { KestrelDatabase } from "@kestrel/database";
import { mayExecute } from "@kestrel/policy-engine";
import {
  DevelopmentCalendarConnector,
  DevelopmentEmailConnector,
  type CalendarConnector,
  type EmailConnector,
} from "./connectors";
import { PreResponseContextResolver } from "./context-resolver";
import {
  FIXTURE_NOW,
  fixtureMemories,
  initialActivity,
  teacherApproval,
  teacherOpportunity,
} from "./fixtures";
import { OpportunityEngine } from "./opportunity-engine";
import { ModelRouter } from "./model-router";
import { AgentRuntime } from "./runtime";
import { AgentLoop } from "./agent-loop";
import {
  ProviderPool,
  createEnvironmentModelProviders,
  textContent,
  type ModelContentPart,
  type ModelProvider,
} from "./providers";
import { SkillRegistry, installSkillTools } from "./extensions/skills";
import {
  SkillLearningManager,
  installSkillLearningTools,
} from "./extensions/skill-learning";
import { PluginRegistry } from "./extensions/plugins";
import { PluginMcpManager } from "./extensions/plugin-mcp";
import { PersonalityRegistry, type AgentPersonality } from "./personality";
import {
  TaskOrchestrator,
  installOrchestrationTools,
  parseScheduleExpression,
} from "./orchestration";
import { UserModelStore } from "./user-model";
import {
  RemoteBackendManager,
  RemoteControl,
  installRemoteExecutionTool,
  type RemoteExecutionConfiguration,
} from "./remote";
import {
  EncryptedDatabaseWebCache,
  NetworkPolicyWebClient,
  installWebTools,
  type WebAccessOptions,
} from "./web-tools";
import {
  ChannelGateway,
  installChannelTools,
  type ChannelRuntimeConfiguration,
  type ChannelEnvelope,
} from "./channels";
import { MemoryManager, installMemoryTools } from "./memory";
import {
  ArtifactManager,
  installMediaTools,
  type MediaGenerationProvider,
} from "./media-artifacts";
import {
  ManagedPolicyStore,
  installManagedPolicy,
  type ManagedPolicy,
} from "./administration";
import { UsageGovernor } from "./usage-governor";
import type { VoiceTranscriptionProvider } from "./media-providers";
import { ObservabilityManager } from "./observability";
import { DreamingManager } from "./dreaming";
import { PresenceManager } from "./presence";
import { NativeNodeManager } from "./native-nodes";
import {
  EventApplicationManager,
  installEventApplicationTools,
} from "./event-applications";
import { SkinManager } from "./skins";
import { PetManager } from "./pets";
import { PetHatchManager } from "./pet-hatch";
import {
  HONCHO_TOOL_NAMES,
  HonchoMemoryProvider,
  installHonchoMemoryTools,
} from "./honcho-memory";

export interface AgentCoreDependencies {
  database: KestrelDatabase;
  email?: EmailConnector;
  calendar?: CalendarConnector;
  now?: () => string;
  workspaceRoots?: string[];
  modelProviders?: ModelProvider[];
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
  readonly modelRouter = new ModelRouter();
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
    this.email = deps.email ?? new DevelopmentEmailConnector();
    this.calendar = deps.calendar ?? new DevelopmentCalendarConnector();
    this.state =
      deps.database.getState<AgentState>("agentState") ?? "waiting_approval";
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
      teacherOpportunity;
    this.currentRouting =
      deps.database.getState<ModelRoutingDecision>("modelRouting") ??
      this.modelRouter.select({
        taskId: this.opportunity.id,
        riskLevel: this.opportunity.riskLevel,
        complexity: 0.34,
        qualitySensitivity: this.opportunity.importance,
        latencySensitivity: this.opportunity.urgency,
        estimatedComputeCost: this.opportunity.estimatedComputeCost,
        dailyModelCostRemaining: 2.5,
        deterministicEligible: true,
        requiresTools: true,
        selectedAt: this.now(),
      });
    this.seed();
    this.context = new PreResponseContextResolver(() =>
      this.deps.database.listMemories(),
    );
    this.runtime = new AgentRuntime(
      this.deps.database,
      this.deps.workspaceRoots ?? [],
      () => this.now(),
      this.deps.githubToken,
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
    this.memory = new MemoryManager(deps.database);
    this.userModel = this.memory.userModel;
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
    this.agentLoop = new AgentLoop(
      this.deps.database,
      this.runtime,
      this.providerPool,
      undefined,
      (message) => {
        if (message.role === "user")
          this.memory.captureExplicit(message.content, message.id);
        const session = this.runtime.getSession(message.sessionId);
        this.honchoMemory.captureMessage(
          message,
          session.workspaceRoot,
        );
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

  private seed(): void {
    if (this.deps.database.listMemories().length === 0)
      fixtureMemories.forEach((item) => this.deps.database.upsertMemory(item));
    if (this.deps.database.listApprovals().length === 0)
      this.deps.database.saveApproval(teacherApproval);
    if (this.deps.database.listActivity().length === 0)
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
        {
          id: "gmail",
          name: "Gmail",
          status: "development_adapter",
          detail: "Deterministic adapter · OAuth not configured",
        },
        {
          id: "calendar",
          name: "Google Calendar",
          status: "development_adapter",
          detail: "Deterministic adapter · OAuth not configured",
        },
        {
          id: "files",
          name: "Selected folders",
          status: workspaceRoots.length ? "connected" : "disconnected",
          detail: workspaceRoots.length
            ? `${workspaceRoots.length} granted · ${workspaceRoots.map((root) => basename(root)).join(", ")}`
            : "No folder access granted",
        },
        {
          id: "browser",
          name: "Browser extension",
          status: "disconnected",
          detail: "Pairing not configured",
        },
        {
          id: "github",
          name: "GitHub",
          status: "disconnected",
          detail: "Repository publishing deferred",
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
      updatedAt: this.now(),
    });
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private automaticRoute(
    taskId: string,
    message: string,
  ): ModelRoutingDecision {
    const normalized = message.toLowerCase();
    const wordCount = message.trim().split(/\s+/).filter(Boolean).length;
    const highConsequence =
      /\b(deploy|publish|production|delete|payment|legal|medical|credential|security)\b/.test(
        normalized,
      );
    const complexity = Math.min(
      1,
      wordCount / 500 +
        (/```|\b(debug|refactor|migrate|architecture|review)\b/.test(normalized)
          ? 0.38
          : 0.12),
    );
    const spending = this.usageGovernor.spending();
    const policy = this.usageGovernor.getPolicy();
    const route = this.modelRouter.select({
      taskId,
      riskLevel: highConsequence
        ? "high_consequence"
        : /\b(write|edit|change|create|run)\b/.test(normalized)
          ? "sensitive"
          : "read_only",
      complexity,
      qualitySensitivity: highConsequence
        ? 0.95
        : Math.min(0.9, 0.45 + complexity / 2),
      latencySensitivity: wordCount < 80 ? 0.8 : 0.45,
      estimatedComputeCost: Math.max(0.002, wordCount * 0.00002),
      dailyModelCostRemaining: Math.max(
        0,
        policy.dailyBudgetUsd - spending.dailyUsd,
      ),
      deterministicEligible: false,
      requiresTools:
        /\b(file|code|repository|web|browser|run|command|git)\b/.test(
          normalized,
        ),
      selectedAt: this.now(),
    });
    this.currentRouting = route;
    this.deps.database.setState("modelRouting", route);
    return route;
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
    this.currentRouting = this.modelRouter.select({
      taskId: "chat-device-troubleshooting",
      riskLevel: "read_only",
      complexity: 0.42,
      qualitySensitivity: 0.66,
      latencySensitivity: 0.86,
      estimatedComputeCost: 0.015,
      dailyModelCostRemaining: 2.5,
      deterministicEligible: true,
      requiresTools: false,
      selectedAt: this.now(),
    });
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
    if (!session.workspaceRoot)
      throw new Error("Attachments require a task workspace.");
    const root = realpathSync(session.workspaceRoot);
    const parts: ModelContentPart[] = [];
    let totalBytes = 0;
    for (const attachment of attachments) {
      const path = realpathSync(attachment.path);
      if (path !== root && !path.startsWith(`${root}${sep}`))
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
          return {
            ok: true,
            session: this.runtime.restoreCheckpoint(
              request.sessionId,
              request.checkpointId,
            ),
          };
        case "runtime-retry-agent": {
          const prior = this.runtime.rewindLastTurn(request.sessionId);
          const route =
            request.model === "auto"
              ? this.automaticRoute(`retry-${request.sessionId}`, prior.message)
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
          try {
            const result = await this.agentLoop.run({
              sessionId: request.sessionId,
              model: request.model,
              providerIds: request.providerIds,
              ...(request.providerModels || route
                ? {
                    providerModels: {
                      ...(route ? { "codex-subscription": route.model } : {}),
                      ...request.providerModels,
                    },
                  }
                : {}),
              ...(route
                ? {
                    reasoningEffort: route.reasoningEffort,
                    serviceTier: route.serviceTier,
                  }
                : {}),
              userContent: textContent(prior.message),
              signal: controller.signal,
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
            });
            return {
              ok: true,
              run: result.run,
              ...(route ? { routing: route } : {}),
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
          return {
            ok: true,
            messages: this.runtime.listMessages(request.sessionId),
          };
        case "runtime-list-runs":
          return {
            ok: true,
            runs: this.deps.database.listAgentRuns(request.sessionId),
          };
        case "runtime-list-executions":
          return {
            ok: true,
            executions: this.deps.database.listToolExecutions(
              request.sessionId,
            ),
          };
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
                  (this.deps.database.getPrivateState<{
                    removedMessages: number;
                  }>(`agent-run-compaction.${run.id}`)?.removedMessages ?? 0),
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
              }),
            ],
          };
        case "memory-forget":
          return { ok: true, memories: [this.memory.forget(request.id)] };
        case "memory-user-model-list":
          return { ok: true, userModelFacts: this.userModel.list() };
        case "memory-user-model-review":
          return {
            ok: true,
            userModelFacts: [
              this.userModel.review(request.id, request.decision),
            ],
          };
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
              this.eventApplications.markSubmitted(
                request.id,
                request.receipt,
              ),
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
            teams: this.orchestrator
              .listTeams()
              .map((team) => ({
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
            ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
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
          try {
            const personality = this.personalities.get(
              request.personalityId ?? this.selectedPersonalityId,
            );
            const selectedModel = personality.preferredModel ?? request.model;
            const route =
              selectedModel === "auto"
                ? this.automaticRoute(
                    `run-${request.sessionId}`,
                    request.message,
                  )
                : undefined;
            const runtimeSession = this.runtime.getSession(request.sessionId);
            const honchoContext =
              personality.memoryScope === "shared"
                ? await this.honchoMemory.contextFor({
                    sessionId: request.sessionId,
                    ...(runtimeSession.workspaceRoot
                      ? { workspaceRoot: runtimeSession.workspaceRoot }
                      : {}),
                    query: request.message,
                  })
                : "";
            const result = await this.agentLoop.run({
              sessionId: request.sessionId,
              model: selectedModel,
              providerIds: personality.providerIds?.length
                ? personality.providerIds
                : request.providerIds,
              ...(request.providerModels || route
                ? {
                    providerModels: {
                      ...(route ? { "codex-subscription": route.model } : {}),
                      ...request.providerModels,
                    },
                  }
                : {}),
              ...(route
                ? {
                    reasoningEffort: route.reasoningEffort,
                    serviceTier: route.serviceTier,
                  }
                : {}),
              ...(personality.toolNames
                ? { allowedTools: personality.toolNames }
                : {}),
              userContent: [
                ...textContent(request.message),
                ...this.attachmentParts(request.sessionId, request.attachments),
              ],
              instructions: [
                personality.instructions,
                ...(personality.memoryScope === "shared"
                  ? [this.userModel.promptContext(), honchoContext]
                  : []),
              ]
                .filter(Boolean)
                .join("\n\n"),
              ...(request.maximumTurns
                ? { maximumTurns: request.maximumTurns }
                : {}),
              ...(request.approvalStatus
                ? { approvalStatus: request.approvalStatus }
                : {}),
              signal: controller.signal,
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
            });
            return {
              ok: true,
              run: result.run,
              ...(route ? { routing: route } : {}),
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
        case "runtime-resume-agent": {
          if (request.streamId && this.activeStreams.has(request.streamId))
            throw new Error("Agent stream ID is already active.");
          const controller = new AbortController();
          const waitingRun = this.deps.database.getAgentRun(request.runId);
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
            const result = await this.agentLoop.resume({
              runId: request.runId,
              ...(request.approvalDecision
                ? { approvalDecision: request.approvalDecision }
                : {}),
              ...(request.maximumTurns
                ? { maximumTurns: request.maximumTurns }
                : {}),
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

  runAmbientMaintenance(at = new Date(this.now())): void {
    this.presence.beacon({
      instanceId: this.coreInstanceId,
      mode: "node",
      reason: "isolated agent core",
    });
    this.dreaming.runIfDue(at);
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

export {
  DevelopmentCalendarConnector,
  DevelopmentEmailConnector,
} from "./connectors";
export { PreResponseContextResolver } from "./context-resolver";
export {
  HonchoMemoryProvider,
  installHonchoMemoryTools,
  HONCHO_TOOL_NAMES,
  type HonchoClientFactory,
} from "./honcho-memory";
export { OpportunityEngine } from "./opportunity-engine";
export { ModelRouter, type ModelRoutingInput } from "./model-router";
export {
  AgentRuntime,
  type DeclarativeRuntimeHook,
  type RuntimeHook,
  type RuntimeHookContext,
  type RuntimeHookEvent,
  type RuntimeHookResult,
  type RuntimeModelTool,
  type ToolCallOptions,
} from "./runtime";
export {
  AgentLoop,
  type AgentLoopInput,
  type AgentLoopResult,
  type AgentLoopResumeInput,
} from "./agent-loop";
export { ContextCompactor, type CompactedContext } from "./context-compactor";
export * from "./providers";
export * from "./usage-governor";
export {
  SkillRegistry,
  installSkillTools,
  type ActivatedSkill,
  type SkillDescriptor,
} from "./extensions/skills";
export {
  MCP_PROTOCOL_VERSION,
  McpClient,
  McpRuntimeServer,
  StdioMcpTransport,
  StreamableHttpMcpTransport,
  bridgeMcpTools,
  type JsonRpcMessage,
  type McpTool,
  type McpToolResult,
  type McpTransport,
} from "./extensions/mcp";
export { PluginRegistry, type PluginDescriptor } from "./extensions/plugins";
export {
  PluginMcpManager,
  type PluginMcpConnection,
} from "./extensions/plugin-mcp";
export {
  PluginInstaller,
  PLUGIN_SIGNATURE_PATH,
  type InstalledPlugin,
  type PluginBundleDigest,
  type PluginInstallerOptions,
  type PluginTrustKey,
  type RemovedPlugin,
  type VerifiedPluginBundle,
} from "./extensions/plugin-installer";
export { PersonalityRegistry, type AgentPersonality } from "./personality";
export {
  AutomationDaemon,
  TaskOrchestrator,
  installOrchestrationTools,
  nextCronOccurrence,
  parseScheduleExpression,
  type DelegatedTaskInput,
  type DelegatedTaskResult,
  type GoalRecord,
  type GoalTask,
  type ScheduledAgentJob,
  type TeamMessage,
  type TeamRecord,
  type WorkflowRecord,
  type WorkflowStep,
} from "./orchestration";
export {
  ManagedPolicyStore,
  MigrationManager,
  installManagedPolicy,
  loadSignedManagedPolicy,
  type ManagedPolicy,
  type MigrationCategory,
  type MigrationItem,
  type MigrationPlan,
  type MigrationProduct,
  type MigrationSource,
  type MigrationTranslation,
  type OrganizationIdentity,
  type OrganizationMember,
} from "./administration";
export {
  UserModelStore,
  type UserModelFact,
  type UserModelKind,
  type UserModelStatus,
} from "./user-model";
export { MemoryManager, installMemoryTools, type MemoryInput } from "./memory";
export {
  SkillLearningManager,
  installSkillLearningTools,
} from "./extensions/skill-learning";
export {
  LanguageServerClient,
  StdioLanguageServerTransport,
  environmentLanguageServerClient,
  installCodeIntelligenceTools,
  type LanguageServerTransport,
  type LspMessage,
  type StdioLanguageServerOptions,
  type TextPosition,
} from "./code-intelligence";
export {
  ArtifactManager,
  installMediaTools,
  type ArtifactRecord,
  type GeneratedMedia,
  type MediaGenerationProvider,
} from "./media-artifacts";
export {
  OpenAiMediaProvider,
  OpenAiTranscriptionProvider,
  LocalDocumentProvider,
  FalMusicProvider,
  createEnvironmentMediaProviders,
  createEnvironmentTranscriptionProvider,
  type OpenAiMediaProviderOptions,
  type OpenAiTranscriptionProviderOptions,
  type FalMusicProviderOptions,
  type VoiceTranscriptionProvider,
} from "./media-providers";
export {
  BrowserController,
  VisualValidator,
  installBrowserTools,
  type BrowserAction,
  type BrowserAutomationBackend,
  type BrowserDiagnostic,
  type BrowserDownload,
  type BrowserSnapshot,
  type BrowserViewport,
  type DesktopAction,
  type ScreenshotFrame,
  type VisualComparison,
  type VisualValidationResult,
} from "./browser-automation";
export {
  ChannelGateway,
  ChannelProgressSession,
  NativeChannelAdapter,
  WebhookChannelAdapter,
  environmentChannelConfiguration,
  installChannelTools,
  signChannelEnvelope,
  type ChannelAdapter,
  type ChannelAttachment,
  type ChannelEnvelope,
  type ChannelProgressPhase,
  type ChannelRuntimeConfiguration,
  type NativeChannelAdapterOptions,
  type WebhookChannelAdapterOptions,
} from "./channels";
export {
  GoogleWorkspaceClient,
  environmentGoogleWorkspaceClient,
  installGoogleWorkspaceTools,
} from "./google-workspace";
export {
  DockerCliRemoteBackend,
  KubernetesCliRemoteBackend,
  RemoteBackendManager,
  RemoteControl,
  ServerlessHttpRemoteBackend,
  SshCliRemoteBackend,
  environmentRemoteExecutionConfiguration,
  installRemoteExecutionTool,
  type RemoteArtifact,
  type RemoteBackendKind,
  type RemoteCredential,
  type RemoteExecutionBackend,
  type RemoteExecutionConfiguration,
  type RemoteExecutionResult,
  type RemoteScope,
  type RemoteTarget,
  type RemoteTrustedIdentity,
} from "./remote";
export { RemoteHttpServer, type RemoteHttpServerOptions } from "./remote-http";
export {
  DEFAULT_OBSERVABILITY_CONFIGURATION,
  ObservabilityManager,
  renderPrometheusMetrics,
} from "./observability";
export { DEFAULT_DREAMING_CONFIGURATION, DreamingManager } from "./dreaming";
export { PresenceManager, type PresenceBeacon } from "./presence";
export { NativeNodeManager, type NativeNodeBeacon, type NativeNodeRecord, type NativeNodeCommand, type NativeNodeResult, type NativeNodeCapability, type LocationAccuracy } from "./native-nodes";
export { TenantFleet, type TenantCell, type TenantFleetRunner } from "./tenant-fleet";
export {
  EventApplicationManager,
  EVENT_APPLICATION_TOOL_NAMES,
  installEventApplicationTools,
  type EventApplication,
  type EventApplicationAnswer,
  type EventApplicationStatus,
  type EventAnswerSensitivity,
  type EventEligibilityItem,
} from "./event-applications";
export { BUILTIN_SKINS, SkinManager, contrast } from "./skins";
export { PetManager, checkedAssetUrl, webpDimensions } from "./pets";
export {
  PetHatchManager,
  type PetHatchCapability,
  type PetHatchDraft,
  type PetHatchResult,
} from "./pet-hatch";
export {
  BonjourAdvertiser,
  TailscaleExposureManager,
  TrustedProxyAuthorizer,
  type BonjourConfiguration,
  type BonjourMode,
  type GatewayCommandRunner,
  type GatewayProcessHandle,
  type GatewayProcessRunner,
  type TailscaleExposureConfiguration,
  type TailscaleExposureMode,
  type TailscaleExposureStatus,
  type TrustedProxyConfiguration,
  type TrustedProxyRequest,
} from "./gateway-networking";
export {
  BraveSearchProvider,
  NetworkPolicyWebClient,
  environmentWebAccessOptions,
  installWebTools,
  isPrivateNetworkAddress,
  type BraveSearchProviderOptions,
  type WebAccessOptions,
  type WebSearchProvider,
  type WebSearchResult,
} from "./web-tools";
export { createKestrelAcpAgent, type KestrelAcpOptions } from "./acp";
export {
  CAPABILITY_CATALOG,
  PARITY_SOURCE_SNAPSHOT,
  capabilitySummary,
  type CapabilityCatalogEntry,
  type ParityStatus,
  type ReferenceProduct,
} from "./capability-catalog";
export * from "./fixtures";
