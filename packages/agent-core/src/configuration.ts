import { createHash, randomUUID } from "node:crypto";
import type { KestrelDatabase } from "@kestrel/database";
import {
  AgentConfigurationAuditEventSchema,
  AgentConfigurationDocumentSchema,
  AgentConfigurationPatchOperationSchema,
  AgentConfigurationProposalSchema,
  AgentConfigurationStatusSchema,
  AgentConfigurationSurfaceSchema,
  AgentConfigurationVersionSchema,
  AgentImprovementProposalSchema,
  ProtectedAgentBoundarySchema,
  type AgentConfigurationAuditEvent,
  type AgentConfigurationCheck,
  type AgentConfigurationDocument,
  type AgentConfigurationPatchOperation,
  type AgentConfigurationProposal,
  type AgentConfigurationStatus,
  type AgentConfigurationSurface,
  type AgentConfigurationVersion,
  type AgentImprovementProposal,
  type ProtectedAgentBoundary,
  type RiskLevel,
  type RuntimeToolDescriptor,
} from "@kestrel/shared-types";
import type { AgentRuntime } from "./runtime";

export const CONFIGURATION_TOOL_NAMES = [
  "agent.config.inspect",
  "agent.config.plan",
  "agent.config.apply",
  "agent.config.history",
  "agent.config.rollback-preview",
  "agent.config.audit",
  "agent.config.improvements",
  "agent.config.scan-improvements",
  "agent.config.rollback",
] as const;

const PROTECTED_RECOVERY_TOOLS = [
  ...CONFIGURATION_TOOL_NAMES,
  "workspace.undo",
] as const;

export const DEFAULT_AGENT_CONFIGURATION: AgentConfigurationDocument =
  AgentConfigurationDocumentSchema.parse({
    schemaVersion: 1,
    behavior: {
      userInstructions: "",
      responseStyle: "balanced",
      proactiveImprovementSuggestions: true,
    },
    prompts: { systemAddon: "" },
    tools: { enabled: ["*"], disabled: [] },
    permissions: { additionalApprovalTools: [] },
    workflows: {
      maximumTurns: 12,
      codeChangeMode: "isolated_pull_request",
      verifyBeforeApply: true,
      reversibleByDefault: true,
    },
    ui: {
      density: "comfortable",
      showToolActivity: true,
      showConfigurationDiffs: true,
      announceVerification: true,
    },
    memory: {
      captureExplicit: true,
      useSharedContext: true,
      improvementLookbackDays: 14,
      minimumFailureCount: 3,
    },
    integrations: { hostedFallback: "ask" },
    settings: {
      locale: "en-US",
      timezone: "America/Chicago",
      explainConfigurationChanges: true,
      improvementReviewCadenceHours: 24,
    },
  });

const EDITABLE_PATHS = [
  "/behavior/userInstructions",
  "/behavior/responseStyle",
  "/behavior/proactiveImprovementSuggestions",
  "/prompts/systemAddon",
  "/tools/enabled",
  "/tools/disabled",
  "/permissions/additionalApprovalTools",
  "/workflows/maximumTurns",
  "/ui/density",
  "/ui/showToolActivity",
  "/ui/showConfigurationDiffs",
  "/ui/announceVerification",
  "/memory/captureExplicit",
  "/memory/useSharedContext",
  "/memory/improvementLookbackDays",
  "/memory/minimumFailureCount",
  "/integrations/hostedFallback",
  "/settings/locale",
  "/settings/timezone",
  "/settings/explainConfigurationChanges",
  "/settings/improvementReviewCadenceHours",
] as const;

const EDITABLE_PATH_SET = new Set<string>(EDITABLE_PATHS);
const secretPattern =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{16,}\b|\bAKIA[A-Z0-9]{16}\b/i;
const protectedOverridePattern =
  /(?:\b(?:ignore|disable|remove|bypass|override)\b.{0,80}\b(?:safety|approval|permission|authentication|security|recovery|credential|secret)\b)|(?:\b(?:ask|request|tell|instruct|collect|solicit|accept|have|prompt|require|provide|send|share|paste|enter|reveal)\b.{0,100}\b(?:api\s*key|oauth|token|password|secret|private\s*key|credential|session\s*cookie)\b)|(?:\b(?:api\s*key|oauth|token|password|secret|private\s*key|credential|session\s*cookie)\b.{0,100}\b(?:ask|request|tell|instruct|collect|solicit|accept|have|prompt|require|provide|send|share|paste|enter|reveal)\b)/i;
const configurationRequestPattern =
  /\b(?:configur(?:e|ation)|setting|personality|system prompt|permission|workflow|memory|integration|rollback|restore|undo)\b|\b(?:make|keep|use|be|answer|respond|reply|write|explain|speak|talk)\b.{0,80}\b(?:concise|brief|detailed|coaching|coach|friendly|formal|casual|professional|tone|style|language|locale|timezone|instruction|response)\b/i;

const riskRank: Record<RiskLevel, number> = {
  read_only: 0,
  low: 1,
  external: 2,
  sensitive: 3,
  high_consequence: 4,
};

const builtInSurfaces: AgentConfigurationSurface[] = [
  {
    id: "behavior",
    title: "Behavior and personality",
    description:
      "User-owned instructions, response detail, and whether Kestrel may surface evidence-backed improvement ideas.",
    editablePaths: [
      "/behavior/userInstructions",
      "/behavior/responseStyle",
      "/behavior/proactiveImprovementSuggestions",
    ],
    riskLevel: "low",
    liveEffect: "Applied to new model turns without changing protected prompts.",
    examples: [
      "Be more concise.",
      "Use a coaching tone for planning.",
      "Stop proposing self-improvements.",
    ],
  },
  {
    id: "prompts",
    title: "Editable prompt layer",
    description:
      "An additive user prompt that cannot replace the protected credential, safety, approval, or local-first instructions.",
    editablePaths: ["/prompts/systemAddon"],
    riskLevel: "sensitive",
    liveEffect: "Added to subsequent agent turns after the protected core prompt.",
    examples: ["Always summarize the evidence before your recommendation."],
  },
  {
    id: "tools",
    title: "Tools and permissions",
    description:
      "Tool visibility, explicit denials, and additional approval requirements. Built-in risk floors and recovery tools cannot be weakened or hidden.",
    editablePaths: [
      "/tools/enabled",
      "/tools/disabled",
      "/permissions/additionalApprovalTools",
    ],
    riskLevel: "high_consequence",
    liveEffect:
      "Changes model-visible tools and can make selected tools stricter immediately.",
    examples: [
      "Disable hosted web tools.",
      "Ask every time before running git.push.",
    ],
  },
  {
    id: "workflows",
    title: "Internal workflows",
    description:
      "Editable execution limits layered on top of mandatory isolation, verification, reversibility, and pull-request delivery.",
    editablePaths: ["/workflows/maximumTurns"],
    riskLevel: "sensitive",
    liveEffect: "Caps future agent runs.",
    examples: ["Limit a task to eight model turns."],
  },
  {
    id: "ui",
    title: "Chat interface",
    description:
      "Conversation density and visibility of tool, diff, and verification feedback.",
    editablePaths: [
      "/ui/density",
      "/ui/showToolActivity",
      "/ui/showConfigurationDiffs",
      "/ui/announceVerification",
    ],
    riskLevel: "low",
    liveEffect: "Reflected by the desktop conversation after the apply event.",
    examples: ["Use compact chat density.", "Hide routine tool progress."],
  },
  {
    id: "memory",
    title: "Memory system",
    description:
      "Explicit capture, shared-context use, and private failure-monitor thresholds.",
    editablePaths: [
      "/memory/captureExplicit",
      "/memory/useSharedContext",
      "/memory/improvementLookbackDays",
      "/memory/minimumFailureCount",
    ],
    riskLevel: "sensitive",
    liveEffect: "Changes capture and recall behavior for new turns.",
    examples: ["Do not capture new explicit memories.", "Use a 30-day failure window."],
  },
  {
    id: "integrations",
    title: "Integration boundaries",
    description:
      "Controls whether hosted fallbacks are disabled, always allowed, or require a visible opt-in question. Credentials remain in protected native storage.",
    editablePaths: ["/integrations/hostedFallback"],
    riskLevel: "high_consequence",
    liveEffect: "Changes the network-boundary instruction on future turns.",
    examples: ["Never use hosted fallbacks.", "Ask before any hosted fallback."],
  },
  {
    id: "settings",
    title: "General settings",
    description:
      "Locale, timezone, explanation detail, and the cadence for private improvement review.",
    editablePaths: [
      "/settings/locale",
      "/settings/timezone",
      "/settings/explainConfigurationChanges",
      "/settings/improvementReviewCadenceHours",
    ],
    riskLevel: "low",
    liveEffect: "Changes subsequent planning and monitoring behavior.",
    examples: ["Use Europe/London time.", "Review weaknesses every 48 hours."],
  },
].map((surface) => AgentConfigurationSurfaceSchema.parse(surface));

const protectedBoundaries: ProtectedAgentBoundary[] = [
  {
    id: "core-safety",
    title: "Core safety policy",
    reason:
      "An editable agent cannot be allowed to remove the rules that constrain its own mutations.",
    safeAlternative:
      "Add narrower user behavior instructions or a stricter tool-denial rule.",
  },
  {
    id: "authentication",
    title: "Authentication and identity",
    reason:
      "OAuth ownership, session identity, and managed policy verification are enforced outside editable prompts.",
    safeAlternative:
      "Configure an account through its protected native connection flow.",
  },
  {
    id: "secret-storage",
    title: "Credential and secret storage",
    reason:
      "Secrets never belong in chat configuration, diffs, prompts, audit text, or model-visible state.",
    safeAlternative:
      "Use the protected credential broker or provider OAuth surface, then configure only the non-secret behavior here.",
  },
  {
    id: "approval-enforcement",
    title: "Approval enforcement",
    reason:
      "High-risk and self-modifying actions require a fresh one-time decision that persistent allow rules cannot bypass.",
    safeAlternative:
      "Add stricter approval patterns or deny the tool entirely.",
  },
  {
    id: "recovery",
    title: "Recovery and immutable history",
    reason:
      "Version history, audit records, rollback, isolation, and verification are append-only control-plane capabilities.",
    safeAlternative:
      "Create a new restoring version through chat; prior records remain available.",
  },
].map((boundary) => ProtectedAgentBoundarySchema.parse(boundary));

function canonicalDocument(
  value: AgentConfigurationDocument,
): AgentConfigurationDocument {
  return AgentConfigurationDocumentSchema.parse(structuredClone(value));
}

function documentSha256(value: AgentConfigurationDocument): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalDocument(value)))
    .digest("hex");
}

function pointerSegments(path: string): string[] {
  if (!path.startsWith("/") || path.includes("\0"))
    throw new Error("Configuration patch path is invalid.");
  return path
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function readPath(document: AgentConfigurationDocument, path: string): unknown {
  let value: unknown = document;
  for (const segment of pointerSegments(path)) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Configuration path ${path} does not exist.`);
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function writePath(
  document: AgentConfigurationDocument,
  path: string,
  value: unknown,
): void {
  const segments = pointerSegments(path);
  const leaf = segments.pop();
  if (!leaf) throw new Error("Configuration root cannot be replaced.");
  let owner: unknown = document;
  for (const segment of segments) {
    if (!owner || typeof owner !== "object" || Array.isArray(owner))
      throw new Error(`Configuration path ${path} does not exist.`);
    owner = (owner as Record<string, unknown>)[segment];
  }
  if (!owner || typeof owner !== "object" || Array.isArray(owner))
    throw new Error(`Configuration path ${path} does not exist.`);
  (owner as Record<string, unknown>)[leaf] = structuredClone(value);
}

function applyPatch(
  base: AgentConfigurationDocument,
  rawPatch: AgentConfigurationPatchOperation[],
): AgentConfigurationDocument {
  const patch = AgentConfigurationPatchOperationSchema.array().parse(rawPatch);
  const candidate = structuredClone(base);
  for (const operation of patch) {
    if (!EDITABLE_PATH_SET.has(operation.path)) {
      throw new Error(
        `Configuration path ${operation.path} belongs to the protected core or is not registered. Closest safe alternative: inspect the configuration catalog and change an editable path, add a stricter permission, or route a source change through the isolated code workflow.`,
      );
    }
    const value =
      operation.op === "remove"
        ? readPath(DEFAULT_AGENT_CONFIGURATION, operation.path)
        : operation.value;
    writePath(candidate, operation.path, value);
  }
  return canonicalDocument(candidate);
}

function patternMatches(pattern: string, value: string): boolean {
  const expression = new RegExp(
    `^${pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")}$`,
  );
  return expression.test(value);
}

function valuePreview(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered ?? "null";
}

function diffForPatch(
  before: AgentConfigurationDocument,
  after: AgentConfigurationDocument,
  patch: AgentConfigurationPatchOperation[],
): string {
  const paths = [...new Set(patch.map((operation) => operation.path))];
  const lines = [
    `--- agent-configuration@${documentSha256(before).slice(0, 12)}`,
    `+++ agent-configuration@${documentSha256(after).slice(0, 12)}`,
  ];
  for (const path of paths) {
    lines.push(`@@ ${path} @@`);
    lines.push(`-${valuePreview(readPath(before, path))}`);
    lines.push(`+${valuePreview(readPath(after, path))}`);
  }
  return lines.join("\n");
}

function patchBetween(
  before: AgentConfigurationDocument,
  after: AgentConfigurationDocument,
): AgentConfigurationPatchOperation[] {
  return EDITABLE_PATHS.flatMap((path) => {
    const previous = readPath(before, path);
    const next = readPath(after, path);
    return JSON.stringify(previous) === JSON.stringify(next)
      ? []
      : [
          AgentConfigurationPatchOperationSchema.parse({
            op: "replace",
            path,
            value: structuredClone(next),
          }),
        ];
  });
}

function riskForPath(path: string): RiskLevel {
  if (path.startsWith("/tools/") || path.startsWith("/permissions/"))
    return "high_consequence";
  if (path.startsWith("/integrations/")) return "high_consequence";
  if (
    path.startsWith("/prompts/") ||
    path.startsWith("/memory/") ||
    path.startsWith("/workflows/")
  )
    return "sensitive";
  return "low";
}

function riskForPatch(patch: AgentConfigurationPatchOperation[]): RiskLevel {
  return patch
    .map((operation) => riskForPath(operation.path))
    .sort((left, right) => riskRank[right] - riskRank[left])[0] ?? "low";
}

function validateBaseCandidate(
  candidate: AgentConfigurationDocument,
): AgentConfigurationCheck[] {
  const parsed = canonicalDocument(candidate);
  const editablePrompt = [
    parsed.behavior.userInstructions,
    parsed.prompts.systemAddon,
  ].join("\n");
  if (secretPattern.test(editablePrompt))
    throw new Error(
      "The proposed configuration appears to contain a secret or private key. Nothing was staged. Closest safe alternative: save the credential in the protected native credential or OAuth flow and configure only its non-secret behavior here.",
    );
  if (protectedOverridePattern.test(editablePrompt))
    throw new Error(
      "Editable prompts cannot override safety, authentication, approval, credential, or recovery controls. Nothing was staged. Closest safe alternative: describe the desired behavior without attempting to weaken the protected boundary.",
    );
  for (const toolName of PROTECTED_RECOVERY_TOOLS) {
    if (!parsed.tools.enabled.some((pattern) => patternMatches(pattern, toolName)))
      throw new Error(
        `The proposal would hide protected recovery tool ${toolName}. Keep recovery tools enabled and deny only the non-protected capability you do not want.`,
      );
    if (parsed.tools.disabled.some((pattern) => patternMatches(pattern, toolName)))
      throw new Error(
        `The proposal would disable protected recovery tool ${toolName}. Keep recovery tools enabled and deny only the non-protected capability you do not want.`,
      );
  }
  try {
    new Intl.DateTimeFormat(parsed.settings.locale, {
      timeZone: parsed.settings.timezone,
    }).format(new Date(0));
  } catch {
    throw new Error(
      "The proposed locale or timezone is not supported on this system. Nothing was staged; choose a valid BCP 47 locale and IANA timezone.",
    );
  }
  const roundTrip = canonicalDocument(
    JSON.parse(JSON.stringify(parsed)) as AgentConfigurationDocument,
  );
  if (documentSha256(roundTrip) !== documentSha256(parsed))
    throw new Error("Configuration serialization check failed.");
  return [
    {
      id: "schema",
      status: "passed",
      detail: "The candidate passed the complete typed configuration schema.",
    },
    {
      id: "protected-boundaries",
      status: "passed",
      detail:
        "Safety, authentication, secret storage, approval enforcement, isolation, verification, and recovery remain outside the editable plane.",
    },
    {
      id: "secret-scan",
      status: "passed",
      detail: "No credential or private-key pattern was found in editable text.",
    },
    {
      id: "recovery-reachability",
      status: "passed",
      detail: "Configuration history, approval, rollback, and undo tools remain reachable.",
    },
    {
      id: "isolated-simulation",
      status: "passed",
      detail:
        "The patch was applied to a cloned document and runtime invariants passed without changing the live agent.",
    },
    {
      id: "round-trip",
      status: "passed",
      detail:
        "The candidate survived canonical serialization with the same digest.",
    },
  ];
}

function configurationAudit(input: Omit<AgentConfigurationAuditEvent, "id">) {
  return AgentConfigurationAuditEventSchema.parse({
    ...input,
    id: `config-audit-${randomUUID()}`,
  });
}

export interface AgentConfigurationInspection {
  currentVersion: {
    id: string;
    sequence: number;
    sha256: string;
    knownGood: boolean;
  };
  current: AgentConfigurationDocument;
  surfaces: AgentConfigurationSurface[];
  protectedBoundaries: ProtectedAgentBoundary[];
  chatRoutableCapabilities: Array<{
    name: string;
    title: string;
    category: string;
    riskLevel: string;
    readOnly: boolean;
  }>;
  codeChangeWorkflow: {
    mode: "isolated_pull_request";
    detail: string;
  };
}

export interface AgentConfigurationSurfaceRegistration {
  surface: AgentConfigurationSurface;
  validate?: (
    candidate: AgentConfigurationDocument,
    current: AgentConfigurationDocument,
  ) => AgentConfigurationCheck[];
}

export class AgentConfigurationManager {
  private readonly lastImprovementScanKey =
    "agent.configuration.last-improvement-scan";
  private readonly surfaceRegistrations = new Map<
    string,
    AgentConfigurationSurfaceRegistration
  >();

  constructor(
    private readonly database: KestrelDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const surface of builtInSurfaces)
      this.registerSurface({ surface });
    this.initialize();
  }

  registerSurface(registration: AgentConfigurationSurfaceRegistration): void {
    const surface = AgentConfigurationSurfaceSchema.parse(
      registration.surface,
    );
    if (this.surfaceRegistrations.has(surface.id))
      throw new Error(`Configuration surface ${surface.id} is already registered.`);
    if (
      surface.editablePaths.some((path) => !EDITABLE_PATH_SET.has(path))
    )
      throw new Error(
        "A configuration surface may expose only paths owned by the current typed schema version.",
      );
    this.surfaceRegistrations.set(surface.id, {
      surface,
      ...(registration.validate ? { validate: registration.validate } : {}),
    });
  }

  currentVersion(): AgentConfigurationVersion {
    const id = this.database.getState<string>("agent.configuration.head");
    const version = id
      ? this.database.getAgentConfigurationVersion(id)
      : undefined;
    if (!version)
      throw new Error(
        "The active agent configuration is unavailable. Restore a known-good version before running the agent.",
      );
    const document = canonicalDocument(version.document);
    if (documentSha256(document) !== version.sha256)
      throw new Error(
        "The active agent configuration failed its integrity check. Restore a known-good version before running the agent.",
      );
    return { ...version, document };
  }

  current(): AgentConfigurationDocument {
    return structuredClone(this.currentVersion().document);
  }

  status(): AgentConfigurationStatus {
    const current = this.currentVersion();
    const rollback = this.database
      .listAgentConfigurationVersions()
      .filter((version) => version.sequence < current.sequence)
      .at(-1);
    return AgentConfigurationStatusSchema.parse({
      currentVersionId: current.id,
      sequence: current.sequence,
      sha256: current.sha256,
      knownGood: current.knownGood,
      pendingProposals: this.database
        .listAgentConfigurationProposals()
        .filter((proposal) => proposal.status === "staged").length,
      pendingImprovements: this.database
        .listAgentImprovementProposals()
        .filter((proposal) => proposal.status === "proposed").length,
      ...(rollback ? { rollbackVersionId: rollback.id } : {}),
      ui: current.document.ui,
    });
  }

  inspect(
    query = "",
    capabilities: RuntimeToolDescriptor[] = [],
  ): AgentConfigurationInspection {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (value: string) =>
      terms.length === 0 ||
      terms.every((term) => value.toLowerCase().includes(term));
    const current = this.currentVersion();
    return {
      currentVersion: {
        id: current.id,
        sequence: current.sequence,
        sha256: current.sha256,
        knownGood: current.knownGood,
      },
      current: structuredClone(current.document),
      surfaces: [...this.surfaceRegistrations.values()]
        .map((registration) => registration.surface)
        .filter((surface) =>
          matches(
            `${surface.id} ${surface.title} ${surface.description} ${surface.editablePaths.join(" ")}`,
          ),
        ),
      protectedBoundaries: protectedBoundaries.filter((boundary) =>
        matches(`${boundary.id} ${boundary.title} ${boundary.reason}`),
      ),
      chatRoutableCapabilities: capabilities
        .filter((tool) =>
          matches(
            `${tool.name} ${tool.title} ${tool.description} ${tool.category}`,
          ),
        )
        .map((tool) => ({
          name: tool.name,
          title: tool.title,
          category: tool.category,
          riskLevel: tool.riskLevel,
          readOnly: tool.readOnly,
        })),
      codeChangeWorkflow: {
        mode: "isolated_pull_request",
        detail:
          "If a request is not representable as data configuration, Kestrel must inspect instructions, create an isolated git worktree, make bounded source changes, run relevant tests, show the code diff, and publish an unmerged pull request. It may not patch the running protected core in place.",
      },
    };
  }

  plan(input: {
    requestSummary: string;
    sourceSessionId: string;
    patch?: AgentConfigurationPatchOperation[];
    improvementId?: string;
  }): AgentConfigurationProposal {
    const requestSummary = input.requestSummary.trim();
    if (!requestSummary || requestSummary.length > 2_000)
      throw new Error("A concise configuration request summary is required.");
    if (secretPattern.test(requestSummary))
      throw new Error(
        "The request summary appears to contain a secret. Nothing was persisted; remove the secret and use the protected credential flow.",
      );
    const improvement = input.improvementId
      ? this.database.getAgentImprovementProposal(input.improvementId)
      : undefined;
    if (input.improvementId && !improvement)
      throw new Error("Self-improvement proposal was not found.");
    if (improvement && improvement.status !== "proposed")
      throw new Error("Only a proposed self-improvement can be staged.");
    const patch = AgentConfigurationPatchOperationSchema.array().parse(
      improvement?.recommendedPatch ?? input.patch,
    );
    if (patch.length === 0)
      throw new Error("A configuration plan requires at least one change.");
    const base = this.currentVersion();
    if (improvement && improvement.baseVersionId !== base.id)
      throw new Error(
        "This self-improvement was derived from an older configuration version. Rescan improvements before staging it.",
      );
    const candidate = applyPatch(base.document, patch);
    const isolatedChecks = this.validateCandidate(candidate, base.document);
    const candidateSha256 = documentSha256(candidate);
    if (candidateSha256 === base.sha256)
      throw new Error(
        "The proposed patch does not change the active configuration. Nothing was staged.",
      );
    const timestamp = this.now().toISOString();
    const proposal = AgentConfigurationProposalSchema.parse({
      id: `config-proposal-${randomUUID()}`,
      requestSummary,
      origin: improvement ? "self_improvement" : "user_request",
      sourceSessionId: input.sourceSessionId,
      baseVersionId: base.id,
      baseSha256: base.sha256,
      candidateSha256,
      patch,
      diff: diffForPatch(base.document, candidate, patch),
      riskLevel: riskForPatch(patch),
      requiresExplicitApproval: true,
      isolatedChecks,
      status: "staged",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const audit = configurationAudit({
      action: "staged",
      actor: "agent",
      versionId: base.id,
      proposalId: proposal.id,
      detail: `Staged configuration plan: ${requestSummary}`,
      evidence: isolatedChecks.map((check) => `${check.id}: ${check.status}`),
      createdAt: timestamp,
    });
    this.database.db.transaction(() => {
      this.database.saveAgentConfigurationProposal(proposal);
      this.database.saveAgentConfigurationAuditEvent(audit);
      if (improvement)
        this.database.saveAgentImprovementProposal({
          ...improvement,
          status: "staged",
          updatedAt: timestamp,
        });
    })();
    return proposal;
  }

  apply(input: {
    proposalId: string;
    expectedBaseVersionId: string;
    preview: string;
  }): {
    proposal: AgentConfigurationProposal;
    version: AgentConfigurationVersion;
    verification: AgentConfigurationCheck[];
    auditEventId: string;
    undo: { targetVersionId: string; request: string };
  } {
    const proposal = this.database.getAgentConfigurationProposal(
      input.proposalId,
    );
    if (!proposal) throw new Error("Configuration plan was not found.");
    if (proposal.status !== "staged")
      throw new Error("Only a staged configuration plan can be applied.");
    if (
      input.expectedBaseVersionId !== proposal.baseVersionId ||
      input.preview !== proposal.diff
    )
      throw new Error(
        "The approved preview does not exactly match the staged configuration plan.",
      );
    const current = this.currentVersion();
    if (
      current.id !== proposal.baseVersionId ||
      current.sha256 !== proposal.baseSha256
    ) {
      const updatedAt = this.now().toISOString();
      const superseded = AgentConfigurationProposalSchema.parse({
        ...proposal,
        status: "superseded",
        updatedAt,
      });
      const audit = configurationAudit({
        action: "superseded",
        actor: "system",
        versionId: current.id,
        proposalId: proposal.id,
        detail:
          "Superseded a staged plan because the active configuration changed before approval.",
        evidence: [
          `staged base ${proposal.baseVersionId}`,
          `current head ${current.id}`,
        ],
        createdAt: updatedAt,
      });
      this.database.db.transaction(() => {
        this.database.saveAgentConfigurationProposal(superseded);
        this.database.saveAgentConfigurationAuditEvent(audit);
      })();
      throw new Error(
        "The agent configuration changed after this plan was staged. Nothing was applied; inspect and stage a fresh diff.",
      );
    }
    const candidate = applyPatch(current.document, proposal.patch);
    const verification = this.validateCandidate(candidate, current.document);
    if (documentSha256(candidate) !== proposal.candidateSha256)
      throw new Error(
        "The staged candidate digest changed. Nothing was applied; create a fresh plan.",
      );
    const timestamp = this.now().toISOString();
    const version = AgentConfigurationVersionSchema.parse({
      id: `config-version-${randomUUID()}`,
      sequence: current.sequence + 1,
      parentVersionId: current.id,
      sourceProposalId: proposal.id,
      document: candidate,
      sha256: proposal.candidateSha256,
      knownGood: true,
      createdBy: "user",
      createdAt: timestamp,
    });
    const appliedProposal = AgentConfigurationProposalSchema.parse({
      ...proposal,
      status: "applied",
      appliedVersionId: version.id,
      updatedAt: timestamp,
    });
    const audit = configurationAudit({
      action: "applied",
      actor: "user",
      versionId: version.id,
      proposalId: proposal.id,
      detail: `Applied approved configuration plan: ${proposal.requestSummary}`,
      evidence: [
        `base ${current.sha256}`,
        `candidate ${version.sha256}`,
        ...verification.map((check) => `${check.id}: ${check.status}`),
      ],
      createdAt: timestamp,
    });
    this.database.commitAgentConfigurationVersion({
      expectedHeadVersionId: current.id,
      version,
      proposal: appliedProposal,
      auditEvent: audit,
    });
    const persisted = this.currentVersion();
    if (
      persisted.id !== version.id ||
      persisted.sha256 !== version.sha256 ||
      JSON.stringify(persisted.document) !== JSON.stringify(version.document)
    )
      throw new Error(
        "Configuration read-back verification failed. Use rollback to restore the prior known-good version.",
      );
    for (const improvement of this.database
      .listAgentImprovementProposals()
      .filter(
        (candidateImprovement) =>
          candidateImprovement.status === "staged" &&
          JSON.stringify(candidateImprovement.recommendedPatch) ===
            JSON.stringify(proposal.patch),
      )) {
      this.database.saveAgentImprovementProposal({
        ...improvement,
        status: "applied",
        updatedAt: timestamp,
      });
    }
    return {
      proposal: appliedProposal,
      version,
      verification,
      auditEventId: audit.id,
      undo: {
        targetVersionId: current.id,
        request: `Restore configuration version ${current.id}`,
      },
    };
  }

  rollbackPreview(targetVersionId: string): string {
    const current = this.currentVersion();
    const target =
      this.database.getAgentConfigurationVersion(targetVersionId);
    if (!target) throw new Error("Rollback target was not found.");
    if (!target.knownGood)
      throw new Error("Only a known-good configuration version can be restored.");
    if (target.id === current.id)
      throw new Error("The requested configuration version is already active.");
    const patch = patchBetween(current.document, target.document);
    if (patch.length === 0)
      throw new Error("The rollback target has the same effective configuration.");
    return [
      `Restore known-good configuration version #${target.sequence}`,
      `Current: ${current.id}`,
      `Target: ${target.id}`,
      "",
      diffForPatch(current.document, target.document, patch),
    ]
      .join("\n");
  }

  rollback(input: {
    targetVersionId: string;
    reason: string;
    preview: string;
  }): {
    version: AgentConfigurationVersion;
    restoredFrom: AgentConfigurationVersion;
    verification: AgentConfigurationCheck[];
    auditEventId: string;
    undo: { targetVersionId: string; request: string };
  } {
    const reason = input.reason.trim();
    if (!reason || reason.length > 2_000)
      throw new Error("A concise rollback reason is required.");
    if (secretPattern.test(reason))
      throw new Error(
        "Rollback reasons cannot contain credentials or private keys. Remove the secret and record only the non-secret recovery context.",
      );
    const expectedPreview = this.rollbackPreview(input.targetVersionId);
    if (input.preview !== expectedPreview)
      throw new Error(
        "The approved rollback preview does not match the current history.",
      );
    const current = this.currentVersion();
    const target =
      this.database.getAgentConfigurationVersion(input.targetVersionId);
    if (!target || !target.knownGood)
      throw new Error("Known-good rollback target is unavailable.");
    const document = canonicalDocument(target.document);
    const verification = this.validateCandidate(document, current.document);
    const timestamp = this.now().toISOString();
    const version = AgentConfigurationVersionSchema.parse({
      id: `config-version-${randomUUID()}`,
      sequence: current.sequence + 1,
      parentVersionId: current.id,
      restoredFromVersionId: target.id,
      document,
      sha256: documentSha256(document),
      knownGood: true,
      createdBy: "user",
      createdAt: timestamp,
    });
    const audit = configurationAudit({
      action: "rolled_back",
      actor: "user",
      versionId: version.id,
      detail: `Restored known-good version ${target.id}: ${reason}`,
      evidence: [
        `replaced ${current.id}`,
        `restored ${target.id}`,
        ...verification.map((check) => `${check.id}: ${check.status}`),
      ],
      createdAt: timestamp,
    });
    this.database.commitAgentConfigurationVersion({
      expectedHeadVersionId: current.id,
      version,
      auditEvent: audit,
    });
    this.currentVersion();
    return {
      version,
      restoredFrom: target,
      verification,
      auditEventId: audit.id,
      undo: {
        targetVersionId: current.id,
        request: `Restore configuration version ${current.id}`,
      },
    };
  }

  history(): Array<{
    id: string;
    sequence: number;
    parentVersionId?: string;
    restoredFromVersionId?: string;
    sourceProposalId?: string;
    sha256: string;
    knownGood: boolean;
    current: boolean;
    createdBy: string;
    createdAt: string;
  }> {
    const currentId = this.currentVersion().id;
    return this.database
      .listAgentConfigurationVersions()
      .map(({ document: _document, ...version }) => ({
        id: version.id,
        sequence: version.sequence,
        ...(version.parentVersionId
          ? { parentVersionId: version.parentVersionId }
          : {}),
        ...(version.restoredFromVersionId
          ? { restoredFromVersionId: version.restoredFromVersionId }
          : {}),
        ...(version.sourceProposalId
          ? { sourceProposalId: version.sourceProposalId }
          : {}),
        sha256: version.sha256,
        knownGood: version.knownGood,
        current: version.id === currentId,
        createdBy: version.createdBy,
        createdAt: version.createdAt,
      }));
  }

  proposals(): AgentConfigurationProposal[] {
    return this.database.listAgentConfigurationProposals();
  }

  rejectProposal(proposalId: string, reason: string): AgentConfigurationProposal {
    const proposal =
      this.database.getAgentConfigurationProposal(proposalId);
    if (!proposal) throw new Error("Configuration plan was not found.");
    if (proposal.status !== "staged") return proposal;
    const updatedAt = this.now().toISOString();
    const rejected = AgentConfigurationProposalSchema.parse({
      ...proposal,
      status: "rejected",
      updatedAt,
    });
    const audit = configurationAudit({
      action: "rejected",
      actor: "user",
      versionId: this.currentVersion().id,
      proposalId,
      detail: `Rejected configuration plan: ${reason.trim().slice(0, 2_000) || "User declined the change."}`,
      evidence: ["live configuration unchanged"],
      createdAt: updatedAt,
    });
    this.database.db.transaction(() => {
      this.database.saveAgentConfigurationProposal(rejected);
      this.database.saveAgentConfigurationAuditEvent(audit);
      for (const improvement of this.database
        .listAgentImprovementProposals()
        .filter(
          (candidate) =>
            candidate.status === "staged" &&
            JSON.stringify(candidate.recommendedPatch) ===
              JSON.stringify(proposal.patch),
        ))
        this.database.saveAgentImprovementProposal({
          ...improvement,
          status: "dismissed",
          updatedAt,
        });
    })();
    return rejected;
  }

  audit(): AgentConfigurationAuditEvent[] {
    return this.database.listAgentConfigurationAuditEvents();
  }

  improvements(): AgentImprovementProposal[] {
    return this.database.listAgentImprovementProposals();
  }

  scanImprovements(force = true): AgentImprovementProposal[] {
    const configuration = this.current();
    const timestamp = this.now();
    if (!configuration.behavior.proactiveImprovementSuggestions) {
      this.database.setPrivateState(
        this.lastImprovementScanKey,
        timestamp.toISOString(),
      );
      return [];
    }
    if (!force && !this.improvementScanDue(timestamp, configuration)) return [];
    const cutoff =
      timestamp.getTime() -
      configuration.memory.improvementLookbackDays * 24 * 60 * 60 * 1_000;
    const groups = new Map<
      string,
      { verified: number; failed: number; cancelled: number }
    >();
    for (const execution of this.database
      .listAllToolExecutions()
      .filter((item) => Date.parse(item.startedAt) >= cutoff)) {
      if (execution.toolName.startsWith("agent.config.")) continue;
      const group = groups.get(execution.toolName) ?? {
        verified: 0,
        failed: 0,
        cancelled: 0,
      };
      if (execution.status === "verified") group.verified += 1;
      else if (execution.status === "failed") group.failed += 1;
      else if (execution.status === "cancelled") group.cancelled += 1;
      groups.set(execution.toolName, group);
    }
    const existingWeaknesses = new Set(
      this.improvements().map((proposal) => proposal.weaknessId),
    );
    const created: AgentImprovementProposal[] = [];
    for (const [toolName, group] of groups) {
      const attempts = group.verified + group.failed;
      const failureRate = attempts ? group.failed / attempts : 0;
      const weaknessId = `repeated-tool-failure:${toolName}`;
      if (
        existingWeaknesses.has(weaknessId) ||
        group.failed < configuration.memory.minimumFailureCount ||
        failureRate < 0.35
      )
        continue;
      const guidance = `Before using ${toolName}, verify its required inputs and preconditions. If it repeats the same failure, stop retrying, explain the evidence, and propose a safer alternative.`;
      if (configuration.behavior.userInstructions.includes(guidance)) continue;
      const nextInstructions = [
        configuration.behavior.userInstructions.trim(),
        guidance,
      ]
        .filter(Boolean)
        .join("\n");
      const createdAt = timestamp.toISOString();
      const proposal = AgentImprovementProposalSchema.parse({
        id: `agent-improvement-${randomUUID()}`,
        baseVersionId: this.currentVersion().id,
        weaknessId,
        title: `Reduce repeated ${toolName} failures`,
        rationale:
          "Recent local execution telemetry shows a repeatable weakness. This proposal changes only the editable behavior layer and still requires a reviewed configuration diff plus one-time approval.",
        evidence: [
          `${group.failed} failed and ${group.verified} verified executions in the last ${configuration.memory.improvementLookbackDays} days`,
          `${Math.round(failureRate * 100)}% observed failure rate across terminal attempts`,
          "No message content, tool input, secret, or external telemetry was inspected",
        ],
        recommendedPatch: [
          {
            op: "replace",
            path: "/behavior/userInstructions",
            value: nextInstructions,
          },
        ],
        riskLevel: "low",
        status: "proposed",
        createdAt,
        updatedAt: createdAt,
      });
      const audit = configurationAudit({
        action: "improvement_detected",
        actor: "system",
        versionId: this.currentVersion().id,
        detail: proposal.title,
        evidence: proposal.evidence,
        createdAt,
      });
      this.database.db.transaction(() => {
        this.database.saveAgentImprovementProposal(proposal);
        this.database.saveAgentConfigurationAuditEvent(audit);
      })();
      created.push(proposal);
      existingWeaknesses.add(weaknessId);
    }
    this.database.setPrivateState(
      this.lastImprovementScanKey,
      timestamp.toISOString(),
    );
    return created;
  }

  runImprovementScanIfDue(at = this.now()): AgentImprovementProposal[] {
    return this.scanImprovements(
      this.improvementScanDue(at, this.current()),
    );
  }

  instructions(): string {
    const configuration = this.current();
    const responseStyle = {
      concise: "Use concise responses while preserving essential evidence, risk, and next actions.",
      balanced:
        "Use balanced detail: lead with the outcome, then include evidence and next actions proportional to the task.",
      detailed:
        "Use detailed explanations with explicit evidence, assumptions, risks, and recovery steps.",
    }[configuration.behavior.responseStyle];
    const hostedBoundary = {
      ask: "Ask before using a hosted fallback and make the network boundary visible.",
      allowed:
        "Hosted fallbacks are user-enabled, but still prefer local capability and state when external processing occurs.",
      disabled:
        "Do not use hosted fallbacks. Explain the limitation and propose a local alternative.",
    }[configuration.integrations.hostedFallback];
    const settings = [
      `Use ${configuration.settings.locale} for user-facing language, dates, and number formatting when appropriate.`,
      `Interpret relative dates and times in ${configuration.settings.timezone}.`,
      configuration.settings.explainConfigurationChanges
        ? "When a configuration change is requested, explain its live effect, risk, exact diff, checks, and protected boundaries before approval."
        : "Keep configuration-change explanations brief while still showing the exact diff, risk, checks, and protected boundaries before approval.",
    ];
    return [
      responseStyle,
      hostedBoundary,
      ...settings,
      configuration.behavior.userInstructions.trim(),
      configuration.prompts.systemAddon.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  isConfigurationRequest(message: string): boolean {
    return configurationRequestPattern.test(message);
  }

  filterToolNames(
    availableToolNames: string[],
    personalityToolNames?: string[],
    options: { includeProtectedRecovery?: boolean } = {},
  ): string[] {
    const configuration = this.current();
    const available = new Set(availableToolNames);
    const hasPersonalityScope = personalityToolNames !== undefined;
    const base = hasPersonalityScope
      ? personalityToolNames.filter((name) => available.has(name))
      : availableToolNames;
    const selected = base.filter(
      (name) =>
        configuration.tools.enabled.some((pattern) =>
          patternMatches(pattern, name),
        ) &&
        !configuration.tools.disabled.some((pattern) =>
          patternMatches(pattern, name),
        ),
    );
    const includeProtectedRecovery =
      options.includeProtectedRecovery ?? !hasPersonalityScope;
    if (includeProtectedRecovery) {
      for (const protectedName of PROTECTED_RECOVERY_TOOLS) {
        if (available.has(protectedName) && !selected.includes(protectedName))
          selected.push(protectedName);
      }
    }
    return [...new Set(selected)].sort();
  }

  toolPolicy(toolName: string): {
    denied?: boolean;
    requireApproval?: boolean;
    reason?: string;
  } {
    const configuration = this.current();
    if (
      !configuration.tools.enabled.some((pattern) =>
        patternMatches(pattern, toolName),
      )
    )
      return {
        denied: true,
        reason: `The active chat configuration allowlist does not include ${toolName}.`,
      };
    if (
      configuration.tools.disabled.some((pattern) =>
        patternMatches(pattern, toolName),
      )
    )
      return {
        denied: true,
        reason: `The active chat configuration denies ${toolName}.`,
      };
    if (
      configuration.permissions.additionalApprovalTools.some((pattern) =>
        patternMatches(pattern, toolName),
      )
    )
      return {
        requireApproval: true,
        reason: `The active chat configuration requires a fresh approval for ${toolName}.`,
      };
    return {};
  }

  private initialize(): void {
    const versions = this.database.listValidAgentConfigurationVersions();
    const currentId = this.database.getState<string>(
      "agent.configuration.head",
    );
    if (versions.length === 0) {
      const createdAt = this.now().toISOString();
      const document = canonicalDocument(DEFAULT_AGENT_CONFIGURATION);
      const version = AgentConfigurationVersionSchema.parse({
        id: `config-version-${randomUUID()}`,
        sequence: 1,
        document,
        sha256: documentSha256(document),
        knownGood: true,
        createdBy: "system",
        createdAt,
      });
      const auditEvent = configurationAudit({
        action: "initialized",
        actor: "system",
        versionId: version.id,
        detail:
          "Initialized the protected, versioned chat configuration data plane.",
        evidence: ["default schema valid", "initial version marked known-good"],
        createdAt,
      });
      this.database.commitAgentConfigurationVersion({
        version,
        auditEvent,
      });
      return;
    }
    const current = currentId
      ? versions.find((version) => version.id === currentId)
      : undefined;
    if (
      current &&
      documentSha256(canonicalDocument(current.document)) === current.sha256
    )
      return;
    const knownGood = versions
      .filter(
        (version) =>
          version.knownGood &&
          documentSha256(canonicalDocument(version.document)) ===
            version.sha256,
      )
      .at(-1);
    if (!knownGood)
      throw new Error(
        "Agent configuration history has no valid known-good version. Protected recovery requires manual operator intervention.",
      );
    const createdAt = this.now().toISOString();
    const auditEvent = configurationAudit({
      action: "recovery_fallback",
      actor: "system",
      versionId: knownGood.id,
      detail:
        "Recovered the active configuration pointer to the latest valid known-good version.",
      evidence: [
        currentId
          ? `unavailable or invalid head ${currentId}`
          : "active head pointer was missing",
        `restored ${knownGood.id}`,
      ],
      createdAt,
    });
    this.database.db.transaction(() => {
      this.database.setState("agent.configuration.head", knownGood.id);
      this.database.saveAgentConfigurationAuditEvent(auditEvent);
    })();
  }

  private validateCandidate(
    candidate: AgentConfigurationDocument,
    current: AgentConfigurationDocument,
  ): AgentConfigurationCheck[] {
    const checks = validateBaseCandidate(candidate);
    for (const registration of this.surfaceRegistrations.values()) {
      if (!registration.validate) continue;
      checks.push(
        ...registration
          .validate(structuredClone(candidate), structuredClone(current))
          .map((check) => ({
            ...check,
            id: `${registration.surface.id}.${check.id}`,
          })),
      );
    }
    const parsed = checks.map((check) => ({
      id: check.id,
      status: check.status,
      detail: check.detail,
    }));
    if (new Set(parsed.map((check) => check.id)).size !== parsed.length)
      throw new Error("Configuration validation check IDs must be unique.");
    const failed = parsed.find((check) => check.status === "failed");
    if (failed)
      throw new Error(
        `Isolated configuration check ${failed.id} failed: ${failed.detail}`,
      );
    return parsed;
  }

  private improvementScanDue(
    at: Date,
    configuration: AgentConfigurationDocument,
  ): boolean {
    const last = this.database.getPrivateState<unknown>(
      this.lastImprovementScanKey,
    );
    const lastAt = typeof last === "string" ? Date.parse(last) : Number.NaN;
    return (
      !Number.isFinite(lastAt) ||
      at.getTime() - lastAt >=
        configuration.settings.improvementReviewCadenceHours * 60 * 60 * 1_000
    );
  }
}

const patchJsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: 100,
  items: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["add", "replace", "remove"] },
      path: { type: "string" },
      value: {},
    },
    required: ["op", "path"],
    additionalProperties: false,
  },
};

export function installAgentConfigurationTools(
  runtime: AgentRuntime,
  manager: AgentConfigurationManager,
  sessionId: string,
): void {
  const register = (
    descriptor: RuntimeToolDescriptor,
    inputSchema: Record<string, unknown>,
    execute: Parameters<AgentRuntime["registerExternalTool"]>[0]["execute"],
    verify?: Parameters<AgentRuntime["registerExternalTool"]>[0]["verify"],
  ) => {
    runtime.registerExternalTool({
      descriptor,
      inputSchema,
      execute,
      ...(verify ? { verify } : {}),
    });
    const sessionIds = new Set([
      sessionId,
      ...runtime.listSessions().map((session) => session.id),
    ]);
    for (const currentSessionId of sessionIds)
      runtime.allowTool(currentSessionId, descriptor.name);
  };
  register(
    {
      name: "agent.config.inspect",
      title: "Inspect agent configuration",
      description:
        "Inspect every registered editable surface, its current value, protected boundaries, dedicated chat tools, and the isolated source-change route before proposing a change.",
      category: "configuration",
      riskLevel: "read_only",
      readOnly: true,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["configuration", "settings", "catalog", "protected-core"],
    },
    {
      type: "object",
      properties: { query: { type: "string", maxLength: 500 } },
      additionalProperties: false,
    },
    ({ session }, input) => ({
      inspection: manager.inspect(
        String(input.query ?? ""),
        runtime.discoverTools(session.id),
      ),
    }),
  );
  register(
    {
      name: "agent.config.plan",
      title: "Stage and test a configuration plan",
      description:
        "Translate the user's request into a bounded JSON Patch or stage an evidence-backed improvement. This changes no live behavior: it clones the current version, rejects protected or secret-bearing changes, runs isolated checks, and returns the exact diff for explanation and approval.",
      category: "configuration",
      riskLevel: "low",
      readOnly: false,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["configuration", "plan", "preview", "diff", "sandbox"],
    },
    {
      type: "object",
      properties: {
        requestSummary: { type: "string", minLength: 1, maxLength: 2_000 },
        patch: patchJsonSchema,
        improvementId: { type: "string" },
      },
      required: ["requestSummary"],
      additionalProperties: false,
    },
    ({ session }, input) => ({
      proposal: manager.plan({
        requestSummary: String(input.requestSummary),
        sourceSessionId: session.id,
        ...(Array.isArray(input.patch)
          ? {
              patch:
                AgentConfigurationPatchOperationSchema.array().parse(
                  input.patch,
                ),
            }
          : {}),
        ...(input.improvementId
          ? { improvementId: String(input.improvementId) }
          : {}),
      }),
      liveConfigurationChanged: false,
      next:
        "Explain the diff and isolated checks. Apply only through agent.config.apply so the user receives a fresh one-time approval boundary.",
    }),
    (_context, _input, output) => {
      const proposal = AgentConfigurationProposalSchema.parse(output.proposal);
      const persisted = manager
        .proposals()
        .find((candidate) => candidate.id === proposal.id);
      if (!persisted || persisted.candidateSha256 !== proposal.candidateSha256)
        throw new Error("Configuration plan persistence verification failed.");
      return {
        method: "encrypted-plan-journal-readback",
        evidence: {
          proposalId: proposal.id,
          candidateSha256: proposal.candidateSha256,
        },
      };
    },
  );
  register(
    {
      name: "agent.config.apply",
      title: "Apply an approved configuration plan",
      description:
        "Apply exactly one staged and isolated-tested configuration diff, verify encrypted read-back, append a known-good version and audit event, and return a conversational undo target. A fresh one-time user approval is mandatory and persistent allow rules cannot bypass it.",
      category: "configuration",
      riskLevel: "high_consequence",
      readOnly: false,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["configuration", "apply", "approval", "verify", "undo"],
      approvalMode: "always",
    },
    {
      type: "object",
      properties: {
        proposalId: { type: "string" },
        expectedBaseVersionId: { type: "string" },
        preview: { type: "string", maxLength: 250_000 },
      },
      required: ["proposalId", "expectedBaseVersionId", "preview"],
      additionalProperties: false,
    },
    (_context, input) => ({
      result: manager.apply({
        proposalId: String(input.proposalId),
        expectedBaseVersionId: String(input.expectedBaseVersionId),
        preview: String(input.preview),
      }),
    }),
    (_context, _input, output) => {
      const result = output.result as {
        version?: AgentConfigurationVersion;
      };
      const version = AgentConfigurationVersionSchema.parse(result.version);
      const active = manager.currentVersion();
      if (active.id !== version.id || active.sha256 !== version.sha256)
        throw new Error("Live configuration read-back verification failed.");
      return {
        method: "encrypted-version-and-live-readback",
        evidence: { versionId: version.id, sha256: version.sha256 },
      };
    },
  );
  register(
    {
      name: "agent.config.history",
      title: "View configuration history",
      description:
        "List immutable configuration versions and staged plans without exposing credentials.",
      category: "configuration",
      riskLevel: "read_only",
      readOnly: true,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["configuration", "history", "versions", "rollback"],
    },
    { type: "object", additionalProperties: false },
    () => ({ versions: manager.history(), proposals: manager.proposals() }),
  );
  register(
    {
      name: "agent.config.rollback-preview",
      title: "Preview a configuration restoration",
      description:
        "Build the exact diff for restoring an immutable known-good version without changing the live agent. Use this before agent.config.rollback.",
      category: "configuration",
      riskLevel: "read_only",
      readOnly: true,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["configuration", "rollback", "preview", "diff", "known-good"],
    },
    {
      type: "object",
      properties: { targetVersionId: { type: "string" } },
      required: ["targetVersionId"],
      additionalProperties: false,
    },
    (_context, input) => ({
      targetVersionId: String(input.targetVersionId),
      preview: manager.rollbackPreview(String(input.targetVersionId)),
      liveConfigurationChanged: false,
      next:
        "Explain this restoration diff, then call agent.config.rollback with the exact preview so the user receives a fresh one-time approval.",
    }),
  );
  register(
    {
      name: "agent.config.audit",
      title: "View configuration audit log",
      description:
        "Read the append-only encrypted audit trail for planning, application, rollback, recovery, and improvement detection.",
      category: "configuration",
      riskLevel: "read_only",
      readOnly: true,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["configuration", "audit", "evidence"],
    },
    { type: "object", additionalProperties: false },
    () => ({ events: manager.audit() }),
  );
  register(
    {
      name: "agent.config.improvements",
      title: "View self-improvement proposals",
      description:
        "List evidence-backed, review-only self-improvement proposals. Nothing in this list is self-authorizing.",
      category: "configuration",
      riskLevel: "read_only",
      readOnly: true,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["configuration", "self-improvement", "monitoring", "review"],
    },
    { type: "object", additionalProperties: false },
    () => ({ improvements: manager.improvements() }),
  );
  register(
    {
      name: "agent.config.scan-improvements",
      title: "Scan for repeat failures",
      description:
        "Analyze bounded local execution outcomes without reading message content or tool inputs, deduplicate recurring weaknesses, and stage review-only improvement suggestions.",
      category: "configuration",
      riskLevel: "low",
      readOnly: false,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["configuration", "self-improvement", "failures", "local"],
    },
    { type: "object", additionalProperties: false },
    () => ({ detected: manager.scanImprovements(true) }),
    (_context, _input, output) => ({
      method: "encrypted-improvement-journal-readback",
      evidence: {
        ids: ((output.detected as AgentImprovementProposal[]) ?? []).map(
          (proposal) => proposal.id,
        ),
      },
    }),
  );
  register(
    {
      name: "agent.config.rollback",
      title: "Restore a known-good configuration",
      description:
        "Create a new restoring version from immutable known-good history. The current state remains in history, the exact restoration diff must be previewed, and a fresh one-time user approval is mandatory.",
      category: "configuration",
      riskLevel: "high_consequence",
      readOnly: false,
      requiresWorkspace: false,
      source: "builtin",
      tags: ["configuration", "rollback", "restore", "known-good", "undo"],
      approvalMode: "always",
    },
    {
      type: "object",
      properties: {
        targetVersionId: { type: "string" },
        reason: { type: "string", minLength: 1, maxLength: 2_000 },
        preview: { type: "string", maxLength: 250_000 },
      },
      required: ["targetVersionId", "reason", "preview"],
      additionalProperties: false,
    },
    (_context, input) => ({
      result: manager.rollback({
        targetVersionId: String(input.targetVersionId),
        reason: String(input.reason),
        preview: String(input.preview),
      }),
    }),
    (_context, _input, output) => {
      const result = output.result as {
        version?: AgentConfigurationVersion;
      };
      const version = AgentConfigurationVersionSchema.parse(result.version);
      if (manager.currentVersion().id !== version.id)
        throw new Error("Configuration rollback read-back verification failed.");
      return {
        method: "known-good-version-readback",
        evidence: { versionId: version.id, sha256: version.sha256 },
      };
    },
  );
}
