import type {
	ActionReceipt,
	AgentRun,
	AgentState,
	ApprovalRule,
	ArtifactRecordContract,
	BrokeredCredentialSummary,
	ChannelSummary,
	CommunicationSourceStatus,
	CoreResponse,
	ExternalIntake,
	EnterpriseAnalytics,
	GoalRecordContract,
	HumanInputRequest,
	GoogleWorkspaceOAuthStatus,
	LocalBackupResult,
	LocalModelSummary,
	LocalRuntimeProgress,
	LocalRuntimeStatus,
	MemoryRecord,
	MigrationPlanPreviewContract,
	MigrationResultContract,
	ModelProfile,
	ModelProviderSummary,
	ModelRoutingDecision,
	OrganizationMemberContract,
	PluginMutation,
	PluginSummary,
	ProviderVerification,
	ReasoningEffort,
	RendererRequest,
	RoutingPolicy,
	RoutingTrace,
	RuntimeEvent,
	RuntimeMessage,
	TranscriptSearchResult,
	RuntimeSession,
	RuntimeToolExecution,
	ScheduledJobSummary,
	SelectedAttachment,
	SessionUsageSummary,
	SetupSystemProfile,
	UserBrowserBookmark,
	UserBrowserFile,
	UserBrowserTab,
	SkillLearningProposal,
	SubscriptionCliStatus,
	SystemReadiness,
	TeamRecordContract,
	TrustedPluginPublisher,
	UsagePolicy,
	UserBrowserPageContext,
	UserBrowserSettings,
	UserModelFact,
	WebFetchResult,
	WebSearchResultContract,
	WorkspaceGrant,
	WorkspaceSnapshot,
} from "@kestrel/shared-types";
import { parseExplicitMemoryCapture } from "@kestrel/shared-types";
import {
	AnimatePresence,
	LayoutGroup,
	motion,
	useReducedMotion,
} from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type UserBrowserController,
	useUserBrowser,
} from "./browser/useUserBrowser";
import { chatTitleFromPrompt, sessionTitleForDisplay } from "./chat-title";
import { BrandMark } from "./components/BrandMark";
import { RuntimeActivityTrail } from "./components/RuntimeActivityTrail";
import { RuntimeApprovalQueue } from "./components/RuntimeApprovalQueue";
import { RuntimeQuestionCard } from "./components/RuntimeQuestionCard";
import { AgentSidebar } from "./components/browser/AgentSidebar";
import { ActionReceiptList } from "./components/ActionReceiptList";
import {
	sidebarActiveDestination,
	sidebarReviewTarget,
} from "./components/browser/agent-sidebar";
import { KestrelSidebar } from "./components/browser/KestrelSidebar";
import { ProjectsWorkspace } from "./components/browser/ProjectsWorkspace";
import { ModelSelector } from "./components/browser/ModelSelector";
import type { ModelSelectorChoice } from "./components/browser/model-selector";
import { AgentWorkspace } from "./components/browser/AgentWorkspace";
import {
	appendAgentUniverseActivity,
	type AgentUniverseActivity,
} from "./components/browser/agent-universe/agent-universe-model";
import {
	BrowserBookmarks,
	BrowserDownloads,
	BrowserHistory,
} from "./components/browser/BrowserLibrary";
import { ComposerMentionPicker } from "./components/browser/ComposerMentionPicker";
import {
	mentionQuery,
	replaceMention,
} from "./components/browser/composer-mentions";
import { BrowserSettings } from "./components/browser/BrowserSettings";
import { BrowserWorkspace } from "./components/browser/BrowserWorkspace";
import { CommunicationCodeAssistant } from "./components/browser/CommunicationCodeAssistant";
import { DefaultBrowserPrompt } from "./components/browser/DefaultBrowserPrompt";
import { WritingStudio } from "./components/browser/WritingStudio";
import { KeyboardShortcutsModal } from "./components/browser/KeyboardShortcutsModal";
import {
	CommandCenter,
	type CommandDestination,
} from "./components/browser/CommandCenter";
import { ConfigurationMessage } from "./components/ConfigurationMessage";
import { ComputerUseSettings } from "./components/ComputerUseSettings";
import {
	parseUIPresentationMessage,
	PresentationCard,
} from "./components/PresentationCard";
import { DashboardExtensions } from "./components/DashboardExtensions";
import { EventApplications } from "./components/EventApplications";
import { ExternalSecretSettings } from "./components/ExternalSecretSettings";
import { GoalKanban } from "./components/GoalKanban";
import { HonchoMemorySettings } from "./components/HonchoMemorySettings";
import { MemoryRecallReceiptLine } from "./components/MemoryRecallReceiptLine";
import { MemoryRecallStatus } from "./components/MemoryRecallStatus";
import { Icon } from "./components/Icon";
import { LifeContext } from "./components/LifeContext";
import { ObservabilitySettings } from "./components/ObservabilitySettings";
import { PresenceSettings } from "./components/PresenceSettings";
import {
	EmptyState,
	PageFrame as SurfacePageFrame,
	type PageMeasure,
} from "./components/ui";
import { SurfaceBackButton } from "./components/browser/SurfaceBackButton";
import { desktopDeepLinkAction } from "./deep-link-route";
import { userBrowserRouteForRendererLink } from "./renderer-link-routing";
import {
	isKestrelAppPageId,
	isKestrelAppPageUrl,
	kestrelAppPageUrl,
	parseKestrelAppPage,
	type KestrelAppPageId,
} from "../utility/browser-app-pages";
import {
	memoryInGb,
	recommendedLocalModelTiers,
	supportedLocalModels,
} from "./local-model-catalog";
import {
	availableWorkspaceGrants,
	runtimeRunScope,
	runtimeSessionsAfterEvent,
	runtimeTaskWorkspace,
	shouldPreserveActiveRun,
} from "./runtime-session-state";
import {
	FIRST_TASK_PROMPT,
	FIRST_TASK_SLOW_MODEL_NOTICE,
} from "./first-task";
import { canCompleteOnboarding } from "./setup-onboarding";
import {
	loadInitialDesktopState,
	startupFailureMessage,
} from "./startup-state";
import { personalizedConfigurationPrompts } from "./configuration-prompts";
import { userFacingError } from "./error-copy";
import { learnedSkillDisplayName } from "./learned-skill-presentation";
import {
	SETTINGS_CATALOG,
	SETTINGS_SECTIONS,
	normalizeSettingsSection,
	sectionDefinition,
	settingsScopeForSection,
	settingsSectionMatchesQuery,
	type BrowserSettingsSection,
	type SettingsSection,
	type SettingsScope,
} from "./settings-catalog";
import {
	latestRunActionReceipts,
	policyGateCopy,
	runRouteLabel,
	runtimeOutcomeCopy,
	uncertainExecutionsForRun,
	verifiedApprovalEvidenceForRun,
} from "./runtime-evidence";
import { KESTREL_STATE_TRANSITION } from "./motion-contract";

const MAX_RENDERER_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function attachmentForExternalFile(
	file: UserBrowserFile,
): SelectedAttachment | undefined {
	if (file.status !== "available" || file.size > MAX_RENDERER_ATTACHMENT_BYTES)
		return undefined;
	return {
		path: file.path,
		name: file.name,
		mediaType: file.mediaType,
		size: file.size,
		source: "external",
	};
}

function mergeAttachments(
	current: SelectedAttachment[],
	next: SelectedAttachment[],
): SelectedAttachment[] {
	const seen = new Set<string>();
	return [...current, ...next].filter((attachment) => {
		if (seen.has(attachment.path)) return false;
		seen.add(attachment.path);
		return true;
	}).slice(0, 8);
}

function appendExternalText(current: string, incoming?: string): string {
	const text = incoming?.trim() ?? "";
	if (!text) return current;
	return current ? `${current}\n\n${text}` : text;
}

const pages = [
	["browser", "Browser"],
	["agent", "Agent"],
	["projects", "Projects"],
	["history", "History"],
	["bookmarks", "Bookmarks"],
	["downloads", "Downloads"],
	["commands", "Command Center"],
	["writing", "Writing Studio"],
	["readiness", "Readiness"],
	["approvals", "Approvals"],
	["memory", "Life"],
	["research", "Research"],
	["artifacts", "Artifacts"],
	["work", "Work"],
	["events", "Opportunities"],
	["activity", "Activity"],
	["extensions", "Extensions"],
	["settings", "Settings"],
] as const;
type Page = (typeof pages)[number][0];
type SkillReviewRequest = {
	proposalId: string;
	requestId: number;
};
const commandDestinations: CommandDestination[] = [
	{
		id: "browser",
		label: "Browser",
		detail: "Open tabs and browse the web",
		icon: "browser",
		group: "Browse",
	},
	{
		id: "organize-tabs",
		label: "Organize tabs",
		detail: "Group related tabs into folders while keeping their order",
		icon: "folder",
		group: "Browse",
	},
	{
		id: "agent",
		label: "Agent",
		detail: "Start, find, and resume your work",
		icon: "agent",
		group: "Agent",
	},
	{
		id: "projects",
		label: "Projects",
		detail: "Keep related chats and local context together",
		icon: "folder",
		group: "Agent",
	},
	{
		id: "writing",
		label: "Writing Studio",
		detail: "Draft with your context and confirmed voice signals",
		icon: "writing",
		group: "Agent",
	},
	{
		id: "history",
		label: "History",
		detail: "Find pages you visited",
		icon: "history",
		group: "Browse",
	},
	{
		id: "bookmarks",
		label: "Bookmarks",
		detail: "Pages you saved in this profile",
		icon: "star",
		group: "Browse",
	},
	{
		id: "downloads",
		label: "Downloads",
		detail: "Track files from browser tabs",
		icon: "downloads",
		group: "Browse",
	},
	{
		id: "approvals",
		label: "Approvals",
		detail: "Review consequential agent actions",
		icon: "approvals",
		group: "Agent",
	},
	{
		id: "work",
		label: "Work",
		detail: "Goals, delegates, and schedules",
		icon: "work",
		group: "Agent",
	},
	{
		id: "events",
		label: "Opportunities",
		detail: "Review event applications",
		icon: "events",
		group: "Agent",
	},
	{
		id: "memory",
		label: "Life Context",
		detail: "Calendar, people, and memory",
		icon: "memory",
		group: "Context",
	},
	{
		id: "research",
		label: "Research",
		detail: "Saved sources and web findings",
		icon: "research",
		group: "Context",
	},
	{
		id: "artifacts",
		label: "Artifacts",
		detail: "Files and generated results",
		icon: "artifacts",
		group: "Context",
	},
	{
		id: "activity",
		label: "Activity",
		detail: "Runs, evidence, and audit trail",
		icon: "activity",
		group: "Context",
	},
	{
		id: "extensions",
		label: "Extensions",
		detail: "Plugin-provided capabilities",
		icon: "extensions",
		group: "Build",
	},
	{
		id: "readiness",
		label: "Readiness",
		detail: "Runtime and provider health",
		icon: "readiness",
		group: "System",
	},
	{
		id: "settings",
		label: "Settings",
		detail: "Browser, agent, models, and privacy",
		icon: "settings",
		group: "System",
	},
	{
		id: "shortcuts",
		label: "Keyboard Shortcuts",
		detail: "View all default shortcuts and hotkeys",
		icon: "command",
		group: "System",
	},
];
type ExecutionMode = "automatic" | "manual";
const SETUP_ASSISTANT_PROMPT =
	"Help me finish setting up Kestrel. First ask what I want to connect: an API provider, an OAuth-backed vendor CLI, tools or MCP, skills or plugins, a messaging channel, automations, or project access. Never ask me to paste a secret into chat; direct secret entry to protected native fields in Settings, or to provider-owned sign-in. Verify one working route before adding more.";
function setupAssistantState({
	credentials,
	subscriptionClis,
	localRuntime,
	localModels,
	providerChecks,
}: {
	credentials: BrokeredCredentialSummary[];
	subscriptionClis: SubscriptionCliStatus[];
	localRuntime: LocalRuntimeStatus | null;
	localModels: LocalModelSummary[];
	providerChecks: ProviderVerification[];
}): string {
	const configured = credentials
		.filter((credential) => credential.configured)
		.map((credential) => credential.label);
	const subscriptions = subscriptionClis
		.filter((cli) => cli.enabled)
		.map((cli) => `${cli.label}${cli.authenticated ? " (authenticated)" : ""}`);
	const verified = [
		...new Set(
			providerChecks
				.filter((check) => check.ok)
				.map((check) => check.providerId),
		),
	];
	return [
		"Current non-secret setup state:",
		`- Protected API credentials configured: ${configured.length ? configured.join(", ") : "none"}.`,
		`- OAuth or subscription routes enabled: ${subscriptions.length ? subscriptions.join(", ") : "none"}.`,
		`- Local AI: ${localRuntime?.verifiedModel ? `verified ${localRuntime.verifiedModel}` : localModels.length ? `${localModels.length} installed model(s), not live-verified in this setup` : "not configured"}.`,
		`- Live-verified provider routes: ${verified.length ? verified.join(", ") : "none"}.`,
		"- Project access, tools/MCP, skills/plugins, channels, and automations still need confirmation in their dedicated product screens.",
		"- Life context and learned preferences apply when shared memory is enabled in Settings → Memory.",
		"Use this state instead of asking me to repeat completed setup. Ask which unfinished category matters first, give one concrete UI step at a time, and check non-secret status after each step.",
	].join("\n");
}

function modelLabel(model: ModelRoutingDecision["model"]): string {
	return model === "local-rules" ? "Local rules" : model.replaceAll("-", " ");
}

function formatConnectionStatus(status: string): string {
	switch (status) {
		case "development_adapter":
			return "Sample only";
		case "not_connected":
			return "Not connected";
		default:
			return status.replaceAll("_", " ");
	}
}

const setupSteps = [
	{ id: "welcome", label: "Welcome", icon: "welcome" },
	{ id: "before-you-begin", label: "Before you begin", icon: "safety" },
	{ id: "choose-model", label: "Choose a model", icon: "models" },
	{ id: "model-setup", label: "Model setup", icon: "work" },
	{ id: "ready", label: "Ready", icon: "ready" },
] as const;
const finalSetupStep = setupSteps.length - 1;

function readPersistedSetupStep(): number {
	const persisted = localStorage.getItem("kestrel:setup-step");
	const persistedId = setupSteps.findIndex((item) => item.id === persisted);
	if (persistedId >= 0) return persistedId;
	const legacyIndex = Number(persisted);
	return Number.isFinite(legacyIndex)
		? Math.min(finalSetupStep, Math.max(0, legacyIndex))
		: 0;
}

const paidProviderCatalog = [
	{
		id: "openai",
		name: "OpenAI",
		short: "OA",
		category: "Model labs",
		description:
			"GPT models through the API or your own ChatGPT-backed Codex login.",
		methods: [
			{
				id: "openai-api",
				label: "OpenAI API",
				kind: "api",
				note: "Pay-as-you-go API access with an optional backup key.",
				href: "https://platform.openai.com/api-keys",
				credentials: ["openai", "openai-secondary"],
			},
			{
				id: "codex-cli",
				label: "Codex CLI",
				kind: "cli",
				cliId: "codex",
				note: "Uses the active vendor-owned ChatGPT/Codex login on this Mac.",
			},
		],
	},
	{
		id: "anthropic",
		name: "Anthropic",
		short: "AN",
		category: "Model labs",
		description:
			"Claude models through the API or an existing Claude Code login.",
		methods: [
			{
				id: "anthropic-api",
				label: "Anthropic API",
				kind: "api",
				note: "Claude API access with an optional backup account.",
				href: "https://console.anthropic.com/settings/keys",
				credentials: ["anthropic", "anthropic-secondary"],
			},
			{
				id: "claude-cli",
				label: "Claude Code CLI",
				kind: "cli",
				cliId: "claude",
				note: "Uses the active vendor-owned Claude Code login on this Mac.",
			},
		],
	},
	{
		id: "google",
		name: "Google",
		short: "GO",
		category: "Model labs",
		description: "Gemini through AI Studio or enterprise Vertex AI.",
		methods: [
			{
				id: "gemini-api",
				label: "Gemini API",
				kind: "api",
				note: "Google AI Studio API access.",
				href: "https://aistudio.google.com/app/apikey",
				credentials: ["gemini"],
			},
		],
	},
	{
		id: "mistral",
		name: "Mistral AI",
		short: "MI",
		category: "Model labs",
		description: "Mistral and Codestral models through La Plateforme.",
		methods: [
			{
				id: "mistral-api",
				label: "Mistral API",
				kind: "api",
				note: "Direct Mistral API access.",
				href: "https://console.mistral.ai/api-keys",
				credentials: ["mistral"],
			},
		],
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		short: "OR",
		category: "Gateways",
		description: "One account for models from many labs.",
		methods: [
			{
				id: "openrouter-api",
				label: "OpenRouter API",
				kind: "api",
				note: "Connect a paid OpenRouter balance or eligible free routes.",
				href: "https://openrouter.ai/settings/keys",
				credentials: ["openrouter"],
			},
		],
	},
	{
		id: "groq",
		name: "Groq",
		short: "GQ",
		category: "Inference clouds",
		description: "Low-latency hosted inference through GroqCloud.",
		methods: [
			{
				id: "groq-api",
				label: "GroqCloud API",
				kind: "api",
				note: "Direct Groq API access.",
				href: "https://console.groq.com/keys",
				credentials: ["groq"],
			},
		],
	},
	{
		id: "nous",
		name: "Nous Research",
		short: "NR",
		category: "Inference clouds",
		description: "Nous Portal hosted model access.",
		methods: [
			{
				id: "nous-api",
				label: "Nous Portal API",
				kind: "api",
				note: "OpenAI-compatible access through Nous Portal.",
				href: "https://portal.nousresearch.com/",
				credentials: ["nous"],
			},
		],
	},
	{
		id: "xai",
		name: "xAI",
		short: "xAI",
		category: "Model labs",
		description: "Grok models through the xAI API.",
		methods: [
			{
				id: "xai-api",
				label: "xAI API",
				kind: "api",
				note: "Direct xAI API key.",
				href: "https://console.x.ai/",
				credentials: ["xai"],
			},
		],
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		short: "DS",
		category: "Model labs",
		description: "DeepSeek chat and reasoning models.",
		methods: [
			{
				id: "deepseek-api",
				label: "DeepSeek API",
				kind: "api",
				note: "Direct DeepSeek API key.",
				href: "https://platform.deepseek.com/api_keys",
				credentials: ["deepseek"],
			},
		],
	},
	{
		id: "cohere",
		name: "Cohere",
		short: "CO",
		category: "Model labs",
		description: "Command models through Cohere's compatibility API.",
		methods: [
			{
				id: "cohere-api",
				label: "Cohere API",
				kind: "api",
				note: "Direct Cohere API access through its OpenAI-compatible chat endpoint.",
				href: "https://dashboard.cohere.com/api-keys",
				credentials: ["cohere"],
			},
		],
	},
	{
		id: "together",
		name: "Together AI",
		short: "TO",
		category: "Inference clouds",
		description: "Hosted open models and dedicated endpoints.",
		methods: [
			{
				id: "together-api",
				label: "Together API",
				kind: "api",
				note: "OpenAI-compatible Together API key.",
				href: "https://api.together.ai/settings/api-keys",
				credentials: ["together"],
			},
		],
	},
	{
		id: "fireworks",
		name: "Fireworks AI",
		short: "FW",
		category: "Inference clouds",
		description: "Serverless and dedicated model inference.",
		methods: [
			{
				id: "fireworks-api",
				label: "Fireworks API",
				kind: "api",
				note: "OpenAI-compatible Fireworks API key.",
				href: "https://app.fireworks.ai/users?tab=account",
				credentials: ["fireworks"],
			},
		],
	},
	{
		id: "nvidia",
		name: "NVIDIA",
		short: "NV",
		category: "Inference clouds",
		description: "NIM inference endpoints and build.nvidia.com models.",
		methods: [
			{
				id: "nvidia-api",
				label: "NVIDIA NIM API",
				kind: "api",
				note: "NVIDIA-hosted NIM API key.",
				href: "https://build.nvidia.com/",
				credentials: ["nvidia"],
			},
		],
	},
	{
		id: "huggingface",
		name: "Hugging Face",
		short: "HF",
		category: "Gateways",
		description: "Inference Providers and dedicated endpoints.",
		methods: [
			{
				id: "hf-token",
				label: "Hugging Face token",
				kind: "api",
				note: "User access token for routed inference.",
				href: "https://huggingface.co/settings/tokens",
				credentials: ["huggingface"],
			},
		],
	},
	{
		id: "perplexity",
		name: "Perplexity",
		short: "PX",
		category: "Model labs",
		description: "Search-grounded Sonar models through the API.",
		methods: [
			{
				id: "perplexity-api",
				label: "Perplexity API",
				kind: "api",
				note: "Direct Perplexity API key.",
				href: "https://www.perplexity.ai/account/api/keys",
				credentials: ["perplexity"],
			},
		],
	},
	{
		id: "github-models",
		name: "GitHub Models",
		short: "GH",
		category: "Gateways",
		description: "Model access governed by your GitHub account.",
		methods: [
			{
				id: "github-token",
				label: "GitHub token",
				kind: "api",
				note: "Fine-grained GitHub token with Models access.",
				href: "https://github.com/settings/tokens",
				credentials: ["github-models"],
			},
		],
	},
] as const;

const paidProviderCredentialIds = new Set<string>(
	paidProviderCatalog.flatMap((provider) =>
		provider.methods.flatMap((method) =>
			"credentials" in method ? [...method.credentials] : [],
		),
	),
);

const freeCredentialGroups = [
	{
		name: "TokenRouter",
		short: "TR",
		note: "OpenAI-compatible access to its currently available free models.",
		href: "https://www.tokenrouter.com/models",
		access: "free",
		credentials: ["tokenrouter"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "B.AI",
		short: "BA",
		note: "OpenAI-compatible hosted inference with a free route when available.",
		href: "https://chat.b.ai/key",
		access: "free",
		credentials: ["bai"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "InferX",
		short: "IX",
		note: "OpenAI-compatible model endpoints with account-specific free offers.",
		href: "https://inferx.net/models",
		access: "free",
		credentials: ["inferx"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "ZenMux",
		short: "ZM",
		note: "Model routing with selected free or promotional models.",
		href: "https://zenmux.ai/models",
		access: "free",
		credentials: ["zenmux"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "OpenCode Zen",
		short: "OZ",
		note: "Curated OpenAI-compatible coding models, including free model IDs.",
		href: "https://opencode.ai/zen",
		access: "free",
		credentials: ["opencode-zen"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "SenseNova",
		short: "SN",
		note: "OpenAI-compatible SenseNova access; plan and quota terms apply.",
		href: "https://sensenova.ai/token-plan",
		access: "free",
		credentials: ["sensenova"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "GMI Cloud",
		short: "GM",
		note: "OpenAI-compatible MaaS inference; account pricing and credits apply.",
		href: "https://console.gmicloud.ai",
		access: "account",
		credentials: ["gmicloud"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "Token Harbor",
		short: "TH",
		note: "OpenAI-compatible gateway with selected free model IDs.",
		href: "https://tokenharbor.ai/models",
		access: "free",
		credentials: ["tokenharbor"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "Cline",
		short: "CL",
		note: "OpenAI-compatible Cline API; account and plan terms apply.",
		href: "https://app.cline.bot",
		access: "account",
		credentials: ["cline"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "OpenRouter",
		short: "OR",
		note: "One key for its currently available free-model router.",
		href: "https://openrouter.ai/settings/keys",
		access: "free",
		credentials: ["openrouter"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "Groq Cloud",
		short: "GQ",
		note: "Fast free-tier inference. Automatically joins the fallback route.",
		href: "https://console.groq.com/keys",
		access: "free",
		credentials: ["groq"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "Google Gemini",
		short: "GO",
		note: "Google AI Studio free-tier access. Automatically joins the fallback route.",
		href: "https://aistudio.google.com/app/apikey",
		access: "free",
		credentials: ["gemini"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "Mistral",
		short: "MI",
		note: "Mistral API access. Current account limits and terms apply.",
		href: "https://console.mistral.ai/api-keys",
		access: "account",
		credentials: ["mistral"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "Command Code",
		short: "CC",
		note: "OpenAI-compatible coding models with free credits or offers that can change.",
		href: "https://commandcode.ai",
		access: "free",
		credentials: ["command-code"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "Kilo",
		short: "KI",
		note: "OpenAI-compatible Kilo Auto Free routing with upstream privacy terms.",
		href: "https://kilo.ai",
		access: "free",
		credentials: ["kilo"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "OrcaRouter",
		short: "OR",
		note: "OpenAI-compatible zero-markup gateway with a free route when available.",
		href: "https://orcarouter.ai",
		access: "free",
		credentials: ["orcarouter"] as BrokeredCredentialSummary["id"][],
	},
	{
		name: "AIHubMix",
		short: "AH",
		note: "OpenAI-compatible gateway with a broad catalog of free model IDs.",
		href: "https://aihubmix.com",
		access: "free",
		credentials: ["aihubmix"] as BrokeredCredentialSummary["id"][],
	},
] as const;

const modelCredentialIds = new Set<string>([
	...paidProviderCredentialIds,
	...freeCredentialGroups.flatMap((group) => group.credentials),
]);

const openAccessDirectory = [
	{
		name: "Hugging Face Inference Providers",
		href: "https://huggingface.co/docs/inference-providers/index",
		detail:
			"Official provider directory with a limited free tier for eligible accounts and models.",
	},
	{
		name: "Ollama model library",
		href: "https://ollama.com/library",
		detail:
			"Free model downloads for a local Ollama runtime; inference stays on this Mac.",
	},
	{
		name: "OpenCode AI",
		href: "https://opencode.ai",
		detail:
			"Local and multi-provider agent CLI and ACP runtime; connects your existing models and ACP workflows.",
	},
	{
		name: "AutoClaw",
		href: "https://autoclaw.z.ai",
		detail:
			"Official hosted and desktop agent. It is not exposed here as a public Kestrel API endpoint.",
	},
	{
		name: "WorkBuddy",
		href: "https://workbuddy.ai",
		detail:
			"Official provider-owned agent; its login/session route is not a public API-key connection.",
	},
	{
		name: "Antigravity",
		href: "https://antigravity.google",
		detail:
			"Google agent platform with provider-owned authentication and protocol, not a direct API-key route.",
	},
] as const;

function compactBytes(value: number): string {
	if (value >= 1024 ** 3)
		return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
	return `${Math.max(1, Math.round(value / 1024 ** 2))} MB`;
}

function Onboarding({ onDone }: { onDone(): void }) {
	const reduced = useReducedMotion();
	const [step, setStep] = useState(() => readPersistedSetupStep());
	const setupStageRef = useRef<HTMLElement | null>(null);
	const focusSetupHeadingRef = useRef(false);
	const [warningAccepted, setWarningAccepted] = useState(
		() => localStorage.getItem("kestrel:setup-warning") === "yes",
	);
	const [modelView, setModelView] = useState<"accounts" | "local" | "open">(
		"accounts",
	);
	const [providerQuery, setProviderQuery] = useState("");
	const [selectedPaidProviderId, setSelectedPaidProviderId] =
		useState<(typeof paidProviderCatalog)[number]["id"]>("openai");
	const [credentials, setCredentials] = useState<BrokeredCredentialSummary[]>(
		[],
	);
	const [credentialValues, setCredentialValues] = useState<
		Record<string, string>
	>({});
	const [credentialBusy, setCredentialBusy] = useState("");
	const [credentialError, setCredentialError] = useState("");
	const [systemProfile, setSystemProfile] = useState<SetupSystemProfile | null>(
		null,
	);
	const [ollamaAvailable, setOllamaAvailable] = useState(false);
	const [localModels, setLocalModels] = useState<LocalModelSummary[]>([]);
	const [localRuntime, setLocalRuntime] = useState<LocalRuntimeStatus | null>(
		null,
	);
	const [localProgress, setLocalProgress] =
		useState<LocalRuntimeProgress | null>(null);
	const [automaticBusy, setAutomaticBusy] = useState(false);
	const [automaticModel, setAutomaticModel] = useState("");
	const [manualSetupOpen, setManualSetupOpen] = useState(false);
	const [localError, setLocalError] = useState("");
	const [downloading, setDownloading] = useState("");
	const [customModel, setCustomModel] = useState("");
	const [providerChecks, setProviderChecks] = useState<ProviderVerification[]>(
		[],
	);
	const [providerCheckBusy, setProviderCheckBusy] = useState(false);
	const [providerCheckError, setProviderCheckError] = useState("");
	const [subscriptionClis, setSubscriptionClis] = useState<
		SubscriptionCliStatus[]
	>([]);
	const [subscriptionBusy, setSubscriptionBusy] = useState("");

	async function loadCredentials() {
		const response = await window.kestrel.request({ type: "credential-list" });
		if (!response.ok)
			throw new Error(
				"error" in response ? response.error : "Credential status failed.",
			);
		if ("credentials" in response) setCredentials(response.credentials);
	}

	async function loadLocalModels() {
		const response = await window.kestrel.request({
			type: "local-model-status",
		});
		if (!response.ok)
			throw new Error(
				"error" in response ? response.error : "Local model check failed.",
			);
		if ("systemProfile" in response) {
			setSystemProfile(response.systemProfile);
			setOllamaAvailable(response.ollamaAvailable);
			setLocalModels(response.localModels);
			setLocalRuntime(response.localRuntime);
			setLocalError(
				response.localModelError
					? userFacingError(
							response.localModelError,
							"Could not check the local model service right now.",
						)
					: "",
			);
		}
	}

	async function loadSubscriptionClis() {
		const response = await window.kestrel.request({
			type: "subscription-cli-status",
		});
		if (!response.ok)
			throw new Error(
				"error" in response ? response.error : "Subscription CLI check failed.",
			);
		if ("subscriptionClis" in response)
			setSubscriptionClis(response.subscriptionClis);
	}

	useEffect(() => {
		void loadCredentials().catch((cause) =>
			setCredentialError(
				userFacingError(cause, "Could not check saved accounts right now."),
			),
		);
		void loadLocalModels().catch((cause) =>
			setLocalError(
				userFacingError(cause, "Could not check local models right now."),
			),
		);
		void loadSubscriptionClis().catch((cause) =>
			setCredentialError(
				userFacingError(cause, "Could not check local sign-in tools right now."),
			),
		);
		return window.kestrel.onLocalRuntimeProgress(setLocalProgress);
	}, []);

	useLayoutEffect(() => {
		const stage = setupStageRef.current;
		stage?.scrollTo({ top: 0, left: 0, behavior: "auto" });
		stage
			?.closest<HTMLElement>(".setup-onboarding")
			?.scrollTo({ top: 0, left: 0, behavior: "auto" });
		if (focusSetupHeadingRef.current) {
			stage
				?.querySelector<HTMLElement>("h1")
				?.focus({ preventScroll: true });
			focusSetupHeadingRef.current = false;
		}
	}, [modelView, step]);

	function go(next: number) {
		const bounded = Math.min(finalSetupStep, Math.max(0, next));
		focusSetupHeadingRef.current = bounded !== step;
		localStorage.setItem("kestrel:setup-step", setupSteps[bounded]!.id);
		setStep(bounded);
	}

	function chooseModelAccess(view: "accounts" | "local" | "open") {
		setModelView(view);
		go(3);
	}

	async function saveCredential(credentialId: BrokeredCredentialSummary["id"]) {
		const value = credentialValues[credentialId]?.trim() ?? "";
		if (value.length < 8) {
			setCredentialError("Paste the complete key before saving.");
			return;
		}
		setCredentialBusy(credentialId);
		setCredentialError("");
		try {
			const response = await window.kestrel.request({
				type: "credential-set",
				credentialId,
				value,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Credential save failed.",
				);
			if ("credentials" in response) setCredentials(response.credentials);
			setCredentialValues((current) => ({ ...current, [credentialId]: "" }));
		} catch (cause) {
			setCredentialError(
				userFacingError(cause, "Could not save that account. Try again."),
			);
		} finally {
			setCredentialBusy("");
		}
	}

	async function downloadModel(model: string) {
		const clean = model.trim();
		if (!/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]*)?$/i.test(clean)) {
			setLocalError("Enter an exact Ollama model name, such as qwen3.5:4b.");
			return;
		}
		setDownloading(clean);
		setLocalError("");
		try {
			const response = await window.kestrel.request({
				type: "local-model-pull",
				model: clean,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Model download failed.",
				);
			if ("localModels" in response) {
				setLocalModels(response.localModels);
				setOllamaAvailable(true);
				setCustomModel("");
			}
		} catch (cause) {
			setLocalError(
				userFacingError(
					cause,
					"Could not download that model. Make sure Ollama is installed and open.",
				),
			);
		} finally {
			setDownloading("");
		}
	}

	async function bootstrapLocal(model: string) {
		setAutomaticBusy(true);
		setAutomaticModel(model);
		setLocalError("");
		setLocalProgress(null);
		try {
			const response = await window.kestrel.request({
				type: "local-runtime-bootstrap",
				model,
				consent: true,
			});
			if (!response.ok)
				throw new Error(
					"error" in response
						? response.error
						: "Automatic local setup failed.",
				);
			if ("localRuntime" in response) {
				setLocalRuntime(response.localRuntime);
				setOllamaAvailable(response.localRuntime.ollamaAvailable);
				setLocalModels(response.localRuntime.localModels);
			}
		} catch (cause) {
			setLocalError(
				userFacingError(cause, "Could not finish local setup. Try again."),
			);
		} finally {
			setAutomaticBusy(false);
			setAutomaticModel("");
		}
	}

	async function cancelLocalSetup() {
		await window.kestrel.request({ type: "local-runtime-cancel" });
	}

	async function checkModelRoutes() {
		setProviderCheckBusy(true);
		setProviderCheckError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-list-providers",
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			const providerIds = (response.providers ?? [])
				.filter((provider) => provider.id !== "auto")
				.map((provider) => provider.id);
			const checked: ProviderVerification[] = [];
			for (const providerId of providerIds) {
				const result = (await window.kestrel.request({
					type: "runtime-verify-provider",
					providerId,
				})) as CoreResponse;
				if (!result.ok) throw new Error(result.error);
				checked.push(...(result.providerVerifications ?? []));
			}
			setProviderChecks(checked);
			if (checked.length > 0 && !checked.some((check) => check.ok))
				setProviderCheckError(
					"No configured model route passed its live account check.",
				);
		} catch (cause) {
			setProviderCheckError(
				userFacingError(cause, "Could not check the model route right now."),
			);
		} finally {
			setProviderCheckBusy(false);
		}
	}

	async function toggleSubscription(
		id: SubscriptionCliStatus["id"],
		enabled: boolean,
	) {
		setSubscriptionBusy(id);
		setCredentialError("");
		setProviderChecks([]);
		setProviderCheckError("");
		try {
			const response = await window.kestrel.request({
				type: "subscription-cli-set",
				id,
				enabled,
			});
			if (!response.ok)
				throw new Error(
					"error" in response
						? response.error
						: "Subscription route update failed.",
				);
			if ("subscriptionClis" in response)
				setSubscriptionClis(response.subscriptionClis);
		} catch (cause) {
			setCredentialError(
				userFacingError(cause, "Could not update that sign-in route. Try again."),
			);
		} finally {
			setSubscriptionBusy("");
		}
	}

	async function connectChatGpt() {
		if (subscriptionBusy === "chatgpt-oauth") {
			await window.kestrel.request({ type: "oauth-chatgpt-cancel" });
			return;
		}
		setSubscriptionBusy("chatgpt-oauth");
		setCredentialError("");
		setProviderChecks([]);
		setProviderCheckError("");
		try {
			const response = await window.kestrel.request({
				type: "oauth-chatgpt-connect",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "ChatGPT sign-in failed.",
				);
			if ("subscriptionClis" in response)
				setSubscriptionClis(response.subscriptionClis);
		} catch (cause) {
			setCredentialError(
				userFacingError(cause, "ChatGPT sign-in could not finish. Try again."),
			);
		} finally {
			setSubscriptionBusy("");
		}
	}

	const configuredCredentials = credentials.filter(
		(credential) => credential.configured,
	);
	const modelReady =
		configuredCredentials.some((credential) =>
			modelCredentialIds.has(credential.id),
		) ||
		localModels.length > 0 ||
		subscriptionClis.some((cli) => cli.enabled);
	const verifiedModelReady =
		Boolean(localRuntime?.verifiedModel) ||
		providerChecks.some((check) => check.ok);
	const recommendedTiers = recommendedLocalModelTiers(systemProfile);
	const compatibleLocalModels = supportedLocalModels(systemProfile);
	const matchingPaidProviders = paidProviderCatalog.filter((provider) => {
		const query = providerQuery.trim().toLocaleLowerCase();
		return (
			!query ||
			provider.name.toLocaleLowerCase().includes(query) ||
			provider.category.toLocaleLowerCase().includes(query) ||
			provider.description.toLocaleLowerCase().includes(query)
		);
	});
	const selectedPaidProvider =
		paidProviderCatalog.find(
			(provider) => provider.id === selectedPaidProviderId,
		) ?? paidProviderCatalog[0];

	useEffect(() => {
		if (
			step === finalSetupStep &&
			modelReady &&
			!verifiedModelReady &&
			providerChecks.length === 0 &&
			!providerCheckBusy &&
			!providerCheckError
		)
			void checkModelRoutes();
	}, [step, modelReady, verifiedModelReady]);

	const finishHeading = verifiedModelReady
		? "Ready for a first task"
		: "You're set.";
	const finishDescription = verifiedModelReady
		? "A real model route responded. Try one guided task now, or open Kestrel and explore."
		: modelReady
			? "The route is saved but not live-verified yet."
			: "Explore now. Connect a model when you need live work.";
	const finishPrimaryLabel = verifiedModelReady ? "Try a first task" : "Open Kestrel";
	const onboardingCompleteAllowed = canCompleteOnboarding(
		modelReady,
		verifiedModelReady,
	);

	return (
		<motion.main
			className="onboarding setup-onboarding"
			initial={false}
			animate={{ opacity: 1 }}
			exit={{ opacity: reduced ? 1 : 0, pointerEvents: "none" }}
			transition={{ duration: reduced ? 0 : 0.14 }}
		>
			<header className="onboarding-bar">
				<div
					className="window-controls-clearance no-drag"
					aria-hidden="true"
				/>
				<nav className="setup-rail" aria-label="Setup progress">
					<span className="setup-stage-name" aria-live="polite">
						{setupSteps[step]!.label}
					</span>
					<ol>
						{setupSteps.map((item, index) => (
							<li
								key={item.id}
								className={`${index === step ? "current" : ""} ${index < step ? "complete" : ""}`}
							>
								<button
									onClick={() => index < step && go(index)}
									disabled={index >= step}
									aria-current={index === step ? "step" : undefined}
									aria-label={`${item.label}${index < step ? ", completed" : index === step ? ", current step" : ", upcoming"}`}
								>
									<span>
										<Icon name={index < step ? "check" : item.icon} />
									</span>
									<span>
										<strong>{item.label}</strong>
									</span>
								</button>
							</li>
						))}
					</ol>
				</nav>
			</header>
			<div className="setup-body">
				<AnimatePresence mode="sync" initial={false}>
					<motion.section
						ref={setupStageRef}
						key={step}
						className={`setup-stage setup-stage-${step}`}
						initial={reduced ? false : { opacity: 0, y: 6 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{
							opacity: reduced ? 1 : 0,
							y: reduced ? 0 : -6,
							pointerEvents: "none",
						}}
						transition={{ duration: reduced ? 0 : 0.14 }}
					>
						{step === 0 && (
							<div className="setup-welcome">
								<div className="setup-welcome-mark" aria-hidden="true">
									<BrandMark />
								</div>
								<h1 tabIndex={-1}>
									Your AI answers.
									<br />
									Kestrel gets it done.
								</h1>
								<p>
									Kestrel is a local agent for your Mac. It browses the web,
									drafts work, and takes action with your approval.
								</p>
							</div>
						)}

						{step === 1 && (
							<div className="setup-warning">
								<h1 tabIndex={-1}>Know what leaves this Mac.</h1>
								<div className="warning-panel">
									<details>
										<summary>
											<span>01</span>
											<span>
												<strong>Cloud models receive what you send</strong>
												<small>
													Prompts and tool results may leave this Mac.
												</small>
											</span>
											<Icon name="chevron" />
										</summary>
										<p>
											Prompts, selected file excerpts, and tool results may go
											to the provider under its retention and training terms.
										</p>
									</details>
									<details>
										<summary>
											<span>02</span>
											<span>
												<strong>Connected services may charge you</strong>
												<small>
													API, media, and storage can bill their own accounts.
												</small>
											</span>
											<Icon name="chevron" />
										</summary>
										<p>
											API calls, media generation, search, and storage can bill
											their own accounts. Kestrel budgets do not replace
											provider controls.
										</p>
									</details>
									<details>
										<summary>
											<span>03</span>
											<span>
												<strong>Approval is a pause, not a guarantee</strong>
												<small>
													Review still matters for consequential work.
												</small>
											</span>
											<Icon name="chevron" />
										</summary>
										<p>
											Sending, publishing, deleting, purchasing, and permission
											changes pause for review. Factual, legal, financial, and
											safety-critical work still needs your judgment.
										</p>
									</details>
									<details>
										<summary>
											<span>04</span>
											<span>
												<strong>Connections widen access</strong>
												<small>
													Approved tools use the folders and accounts you grant.
												</small>
											</span>
											<Icon name="chevron" />
										</summary>
										<p>
											Approved tools can act through the folders, accounts,
											microphone, browser, and screen access you grant.
											Credentials remain protected.
										</p>
									</details>
								</div>
								<label className="warning-check">
									<input
										type="checkbox"
										checked={warningAccepted}
										onChange={(event) => {
											setWarningAccepted(event.target.checked);
											localStorage.setItem(
												"kestrel:setup-warning",
												event.target.checked ? "yes" : "no",
											);
										}}
									/>
									<span>
										<strong>I understand these boundaries</strong>
									</span>
								</label>
								<small>
									You can change providers and permissions later in Settings.
								</small>
							</div>
						)}

						{(step === 2 || step === 3) && (
							<div className="setup-models">
								<header>
									<h1 tabIndex={-1}>
										{step === 2
											? "Where should answers come from?"
											: modelView === "accounts"
												? "Connect an account."
												: modelView === "local"
													? "Set up a local model."
													: "Set up free provider accounts."}
									</h1>
									<p>
										{step === 2
											? "Pick one to start — you can change it later."
											: modelView === "accounts"
												? "Sign in with the provider, or add a protected API key."
												: modelView === "local"
													? "Balanced is recommended for this Mac."
													: "Terms and free limits vary by provider."}
									</p>
								</header>
								{step === 2 && (
									<div
										className="model-source-picker"
										aria-label="Model access choices"
									>
										<button
											type="button"
											onClick={() => chooseModelAccess("accounts")}
										>
											<span className="source-glyph" aria-hidden="true">
												<Icon name="models" />
											</span>
											<strong>Use an account</strong>
											<small>Sign in or add an API key.</small>
											<span className="source-action">
												<b>
													{configuredCredentials.length
														? `${configuredCredentials.length} connected`
														: "Choose a provider"}
												</b>
												<Icon name="arrow" />
											</span>
										</button>
										<button
											type="button"
											className="model-source-option model-source-option-recommended"
											onClick={() => chooseModelAccess("local")}
										>
											<span className="source-glyph" aria-hidden="true">
												<Icon name="local" />
											</span>
											<strong>Run on this Mac</strong>
											<small>Private and offline-capable.</small>
											<span className="route-badge">Recommended</span>
											<span className="source-action">
												<b>
													{localModels.length
														? `${localModels.length} installed`
														: "No account needed"}
												</b>
												<Icon name="arrow" />
											</span>
											</button>
										<button
											type="button"
											onClick={() => chooseModelAccess("open")}
										>
											<span className="source-glyph" aria-hidden="true">
												<Icon name="free" />
											</span>
											<strong>Try free providers</strong>
											<small>Current terms and limits apply.</small>
											<span className="source-action">
												<b>
													{freeCredentialGroups.length} supported options
												</b>
												<Icon name="arrow" />
											</span>
										</button>
									</div>
								)}

								{step === 3 && modelView === "accounts" && (
									<div
										className="account-setup"
										role="tabpanel"
										aria-label="External providers"
									>
										<div className="provider-parity">
											<div>
												<span>
													<strong>Choose a paid provider</strong>
													<small>
														Then choose how your own account connects.
													</small>
												</span>
												<span className="honest-status">
													Private by default
												</span>
											</div>
										</div>
										<div className="paid-provider-browser">
											<aside className="paid-provider-directory">
												<label htmlFor="paid-provider-search">
													Find a provider
												</label>
												<input
													id="paid-provider-search"
													type="search"
													value={providerQuery}
													placeholder="Search OpenAI, Anthropic, Groq…"
													onChange={(event) =>
														setProviderQuery(event.target.value)
													}
												/>
												<div role="group" aria-label="Paid AI providers">
													{matchingPaidProviders.map((provider) => {
														const configured = provider.methods.some(
															(method) =>
																"credentials" in method &&
																method.credentials.some((id) =>
																	credentials.some(
																		(credential) =>
																			credential.id === id &&
																			credential.configured,
																	),
																),
														);
														return (
															<button
																key={provider.id}
																aria-pressed={
																	provider.id === selectedPaidProvider.id
																}
																onClick={() =>
																	setSelectedPaidProviderId(provider.id)
																}
															>
																<span className="provider-monogram">
																	{provider.short}
																</span>
																<span>
																	<strong>{provider.name}</strong>
																	<small>{provider.category}</small>
																</span>
																{configured && <b>Connected</b>}
															</button>
														);
													})}
													{matchingPaidProviders.length === 0 && (
														<p>No providers match “{providerQuery}”.</p>
													)}
												</div>
											</aside>
											<section
												className="paid-provider-methods"
												aria-labelledby="selected-provider-name"
											>
												<header>
													<span className="provider-monogram">
														{selectedPaidProvider.short}
													</span>
													<span>
														<strong id="selected-provider-name">
															{selectedPaidProvider.name}
														</strong>
														{selectedPaidProvider.description && (
															<small>{selectedPaidProvider.description}</small>
														)}
													</span>
												</header>
												<div className="connection-method-list">
													{selectedPaidProvider.methods.map((method) => {
														if (method.kind === "cli") {
															const cli = subscriptionClis.find(
																(item) => item.id === method.cliId,
															);
															return (
																<article
																	className="connection-method"
																	key={method.id}
																>
																	<div>
																		<strong>{method.label}</strong>
																		<p>
																			{method.note} Kestrel never copies the
																			vendor login token.
																		</p>
																	</div>
																	{!cli ? (
																		<span className="honest-status">
																			Checking
																		</span>
																	) : cli.detected ? (
																		cli.id === "codex" && !cli.authenticated ? (
																			<button
																				className="button primary"
																				disabled={
																					Boolean(subscriptionBusy) &&
																					subscriptionBusy !== "chatgpt-oauth"
																				}
																				onClick={() => void connectChatGpt()}
																			>
																				{subscriptionBusy === "chatgpt-oauth"
																					? "Cancel sign-in"
																					: "Sign in with ChatGPT"}
																			</button>
																		) : (
																			<button
																				className={
																					cli.enabled
																						? "button secondary"
																						: "button primary"
																				}
																				disabled={Boolean(subscriptionBusy)}
																				onClick={() =>
																					void toggleSubscription(
																						cli.id,
																						!cli.enabled,
							)
						}
				>
																				{subscriptionBusy === cli.id
																					? "Updating…"
																					: cli.enabled
																						? "Disable"
																						: "Use this login"}
																			</button>
																		)
																	) : (
																		<span className="honest-status">
																			CLI not found
																		</span>
																	)}
																</article>
															);
														}
														return (
															<article
																className="connection-method api-method"
																key={method.id}
															>
																<div className="method-heading">
																	<div>
																		<strong>{method.label}</strong>
																		<p>{method.note}</p>
																	</div>
																	<a
																		href={method.href}
																		target="_blank"
																		rel="noreferrer"
																	>
																		Get API key ↗
																	</a>
																</div>
																{method.credentials.map(
																	(rawId, accountIndex) => {
																		const credentialId =
																			rawId as BrokeredCredentialSummary["id"];
																		const credential = credentials.find(
																			(item) => item.id === credentialId,
																		);
																		return (
																			<div
																				className="account-slot"
																				key={credentialId}
																			>
																				<label
																					htmlFor={`setup-${credentialId}`}
																				>
																					<span>
																						{method.credentials.length > 1
																							? `Account ${accountIndex + 1}`
																							: "API key"}
																					</span>
																					<small>
																						{credential?.configured
																							? "Protected and ready"
																							: accountIndex === 0
																								? "Not connected"
																								: "Optional backup"}
																					</small>
																				</label>
																				{credential?.configured ? (
																					<span className="configured-account">
																						<span className="agent-dot idle" />
																						Connected
																					</span>
																				) : (
																					<>
																						<input
																							id={`setup-${credentialId}`}
																							type="password"
																							autoComplete="off"
																							spellCheck={false}
																							value={
																								credentialValues[
																									credentialId
																								] ?? ""
																							}
																							placeholder="Paste API key"
																							onChange={(event) =>
																								setCredentialValues(
																									(current) => ({
																										...current,
																										[credentialId]:
																											event.target.value,
																									}),
																								)
																							}
																						/>
																						<button
																							className="button secondary"
																							disabled={Boolean(credentialBusy)}
																							onClick={() =>
																								void saveCredential(
																									credentialId,
																								)
																							}
																						>
																							{credentialBusy === credentialId
																								? "Saving…"
																								: "Save"}
																						</button>
																					</>
																				)}
																			</div>
																		);
																	},
																)}
															</article>
														);
													})}
												</div>
											</section>
										</div>
										{credentialError && (
											<p className="setup-error" role="alert">
												{credentialError}
											</p>
										)}
									</div>
								)}

								{step === 3 && modelView === "local" && (
									<div className="local-model-setup" role="tabpanel">
										<div className="device-fit">
											<div>
												<span className="provider-monogram">M</span>
												<span>
													<strong>
														{systemProfile
															? `${memoryInGb(systemProfile)} GB ${systemProfile.architecture === "arm64" ? "Apple Silicon Mac" : `${systemProfile.architecture} Mac`}`
															: "Checking this Mac…"}
													</strong>
												</span>
											</div>
										</div>
										{recommendedTiers.length > 0 && (
											<section
												className="recommended-model-tiers"
												aria-label="Local model sizes"
											>
												<div className="model-tier-grid">
													{recommendedTiers.map((model, index) => {
														const installed = localModels.some(
															(item) =>
																item.name === model.name ||
																item.name === `${model.name}:latest`,
														);
														const tier =
															index === 0
																? { name: "Light" }
																: index === recommendedTiers.length - 1
																	? { name: "Power" }
																	: { name: "Balanced" };
														return (
															<article
																key={model.name}
																className={
																	tier.name === "Balanced" ? "preferred" : ""
																}
															>
																<div className="model-tier-name">
																	<strong>{tier.name}</strong>
																	{tier.name === "Balanced" && (
																		<span>Recommended</span>
																	)}
																</div>
																<small>{model.bestFor}</small>
																<details className="model-tier-details">
																	<summary>Details</summary>
																	<dl>
																		<div>
																			<dt>Model</dt>
																			<dd>{model.title}</dd>
																		</div>
																		<div>
																			<dt>Requirements</dt>
																			<dd>
																				{model.speed} · {model.minimumMemory}{" "}
																				GB+ usable memory
																			</dd>
																		</div>
																		<div>
																			<dt>Download</dt>
																			<dd>
																				{model.size} · {model.contextLength}{" "}
																				context
																			</dd>
																		</div>
																	</dl>
																</details>
																{installed ? (
																	<span className="installed-model">
																		<span className="agent-dot idle" />
																		Installed
																	</span>
																) : (
																	<button
																		className={`button ${tier.name === "Balanced" ? "primary" : "secondary"}`}
																		disabled={
																			automaticBusy ||
																			Boolean(downloading) ||
																			(!ollamaAvailable &&
																				localRuntime?.automaticSupported ===
																					false)
																		}
																		onClick={() =>
																			ollamaAvailable
																				? void downloadModel(model.name)
																				: void bootstrapLocal(model.name)
																		}
																	>
																		{automaticBusy &&
																		automaticModel === model.name
																			? "Setting up…"
																			: downloading === model.name
																				? "Downloading…"
																				: tier.name === "Balanced"
																					? `Install recommended · ${model.size}`
																					: `Install ${tier.name.toLowerCase()} · ${model.size}`}
																	</button>
																)}
															</article>
														);
													})}
												</div>
											</section>
										)}
										{localProgress && automaticBusy && (
											<div
												className="local-bootstrap-progress"
												role="status"
												aria-live="polite"
											>
												<div>
													<strong>{localProgress.message}</strong>
													<span>
														{localProgress.percent !== undefined
															? `${Math.round(localProgress.percent)}%`
															: "Working"}
													</span>
												</div>
												<progress
													max="100"
													value={localProgress.percent ?? undefined}
												/>
												{localProgress.downloadedBytes !== undefined && (
													<small>
														{compactBytes(localProgress.downloadedBytes)}
														{localProgress.totalBytes
															? ` of ${compactBytes(localProgress.totalBytes)}`
															: ""}
													</small>
												)}
												<button
													className="button secondary"
													onClick={() => void cancelLocalSetup()}
												>
													Cancel
												</button>
											</div>
										)}
										{!ollamaAvailable &&
											localRuntime?.automaticSupported === false && (
												<p className="setup-error" role="status">
													One-click installation is not available on this device
													yet. Manual setup below works with any reachable
													Ollama service.
												</p>
											)}
										{ollamaAvailable && (
											<div className="local-runtime-ready" role="status">
												<span className="agent-dot idle" />
												<span>
													<strong>
														{localRuntime?.verifiedModel
															? `${localRuntime.verifiedModel} verified locally`
															: localRuntime?.managedRuntime
																? "Managed local runtime ready"
																: "Existing local runtime found"}
													</strong>
													<small>
														{localRuntime?.verifiedModel
															? `A real response completed ${localRuntime.verifiedAt ? new Date(localRuntime.verifiedAt).toLocaleString() : "during setup"}.`
															: localRuntime?.managedRuntime
																? `Ollama ${localRuntime.runtimeVersion ?? ""} is contained inside Kestrel data.`
																: "Kestrel will use this service without changing its installation."}
													</small>
												</span>
											</div>
										)}
										{systemProfile && compatibleLocalModels.length === 0 && (
											<div className="model-library-empty" role="status">
												<strong>No curated local model fits this Mac.</strong>
												<p>
													Kestrel keeps memory available for macOS and the app.
													Use an external provider, or open manual setup if you
													accept the stability tradeoff.
												</p>
											</div>
										)}
										{compatibleLocalModels.some(
											(model) => model.reducedSafeguards,
										) && (
											<p className="reduced-safeguards-note">
												These models use reduced filtering. Review important
												results before acting.
											</p>
										)}
										{localError && (
											<p className="setup-error" role="alert">
												{localError}
											</p>
										)}
										<section className="manual-model-options">
											<button
												className="manual-model-toggle"
												aria-expanded={manualSetupOpen}
												onClick={() =>
													setManualSetupOpen((current) => !current)
												}
											>
												<span>
													<strong>Manual setup</strong>
												</span>
												<span aria-hidden="true">
													{manualSetupOpen ? "−" : "+"}
												</span>
											</button>
											{manualSetupOpen && (
												<div className="manual-local-setup">
													<ol>
														<li>
															<a
																href="https://ollama.com/download"
																target="_blank"
																rel="noreferrer"
															>
																Install Ollama from its official download
															</a>{" "}
															or start an existing service on{" "}
															<code>127.0.0.1:11434</code>.
														</li>
														<li>
															Return here and choose <b>Check again</b>. Kestrel
															never runs a shell installer copied from the web.
														</li>
													</ol>
													<button
														className="button secondary"
														onClick={() => void loadLocalModels()}
													>
														Check again
													</button>
													<form
														className="custom-model-download"
														onSubmit={(event) => {
															event.preventDefault();
															void downloadModel(customModel);
														}}
													>
														<label htmlFor="custom-ollama-model">
															<span>Any other Ollama model</span>
														</label>
														<input
															id="custom-ollama-model"
															value={customModel}
															onChange={(event) =>
																setCustomModel(event.target.value)
															}
															placeholder="Example: llama3.2:3b"
														/>
														<button
															className="button secondary"
															disabled={
																!ollamaAvailable ||
																Boolean(downloading) ||
																!customModel.trim()
															}
														>
															{downloading === customModel.trim()
																? "Downloading…"
																: "Download"}
														</button>
													</form>
													<p className="model-library-note">
														<a
															href="https://ollama.com/library"
															target="_blank"
															rel="noreferrer"
														>
															Browse the complete Ollama library
														</a>{" "}
														and paste any exact model name here.
													</p>
												</div>
											)}
										</section>
									</div>
								)}

								{step === 3 && modelView === "open" && (
									<div
										className="more-provider-setup"
										role="tabpanel"
										aria-label="Open access"
									>
										<div className="more-provider-lead">
											<strong>Add a provider account or API key.</strong>
										</div>
										<div className="provider-groups">
											{freeCredentialGroups.map((group) => {
												const credentialId = group.credentials[0]!;
												const credential = credentials.find(
													(item) => item.id === credentialId,
												);
												return (
													<section key={group.name} className="provider-group">
														<div className="provider-heading">
															<span className="provider-monogram">
																{group.short}
															</span>
															<div>
																<strong>{group.name}</strong>
																<p>{group.note}</p>
																<a
																	href={group.href}
																	target="_blank"
																	rel="noreferrer"
																>
																	{group.access === "free"
																		? "Open free route ↗"
																		: "Open account setup ↗"}
																</a>
															</div>
														</div>
														<div className="account-slot">
															<label htmlFor={`setup-${credentialId}`}>
																<span>API key</span>
																<small>
																	{credential?.configured
																		? "Protected and ready"
																		: "Not connected"}
																</small>
															</label>
															{credential?.configured ? (
																<span className="configured-account">
																	<span className="agent-dot idle" />
																	Connected
																</span>
															) : (
																<>
																	<input
																		id={`setup-${credentialId}`}
																		type="password"
																		autoComplete="off"
																		spellCheck={false}
																		value={credentialValues[credentialId] ?? ""}
																		placeholder="Paste API key"
																		onChange={(event) =>
																			setCredentialValues((current) => ({
																				...current,
																				[credentialId]: event.target.value,
																			}))
																		}
																	/>
																	<button
																		className="button secondary"
																		disabled={Boolean(credentialBusy)}
																		onClick={() =>
																			void saveCredential(credentialId)
																		}
																	>
																		{credentialBusy === credentialId
																			? "Saving…"
																			: "Save"}
																	</button>
																</>
															)}
														</div>
													</section>
												);
											})}
										</div>
										{credentialError && (
											<p className="setup-error" role="alert">
												{credentialError}
											</p>
										)}
										<div className="more-provider-lead">
											<strong>More ways to run models</strong>
										</div>
										<div className="open-access-list">
											{openAccessDirectory.map((source, index) => (
												<a
													href={source.href}
													target="_blank"
													rel="noreferrer"
													key={source.name}
												>
													<span>{String(index + 1).padStart(2, "0")}</span>
													<span>
														<strong>{source.name}</strong>
														<small>{source.detail}</small>
													</span>
													<b>Open official source ↗</b>
												</a>
											))}
										</div>
										<p className="provider-footnote">
											“Free” availability, quotas, privacy terms, and model
											lists change. Review the source before sending data. A
											listing here is not a connection or a Kestrel endorsement.
										</p>
									</div>
								)}
							</div>
						)}

						{step === finalSetupStep && (
							<div className="setup-finish">
								<div className="setup-finish-mark" aria-hidden="true">
									<BrandMark />
								</div>
								<h1 tabIndex={-1}>{finishHeading}</h1>
								<p>{finishDescription}</p>
								<div className="finish-checks">
								<div className={verifiedModelReady ? "done" : "attention"}>
									<span>
										<Icon
											name={
												verifiedModelReady
													? "check-circle-filled"
													: providerCheckBusy
														? "loader"
														: "info-filled"
											}
										/>
									</span>
										<span>
											<strong>
												{verifiedModelReady
													? "Live model route"
													: "Model route"}
											</strong>
											<small>
												{verifiedModelReady
													? providerChecks.filter((check) => check.ok).length >
														0
														? `${providerChecks.filter((check) => check.ok).length} route${providerChecks.filter((check) => check.ok).length === 1 ? "" : "s"} responded to an account check`
														: `${localRuntime?.verifiedModel ?? "A local model"} returned a real response during setup`
													: providerCheckBusy
														? "Checking the configured route now…"
														: modelReady
															? "Configured; check it before live work"
															: "Not connected yet; add one later in Settings"}
											</small>
										</span>
										{modelReady &&
											!providerCheckBusy &&
											!verifiedModelReady && (
												<button
													className="quiet-link"
													onClick={() => void checkModelRoutes()}
												>
													Check again
												</button>
											)}
									</div>
								<div className="done">
									<span><Icon name="check-circle-filled" /></span>
										<span>
											<strong>Approval boundary</strong>
											<small>Sensitive actions pause for review</small>
										</span>
									</div>
								<div className="done">
									<span><Icon name="check-circle-filled" /></span>
										<span>
											<strong>Private storage</strong>
											<small>
												Secrets and memory stay protected on this Mac
											</small>
										</span>
									</div>
								<div>
									<span><Icon name="info-filled" /></span>
										<span>
											<strong>Project access</strong>
											<small>
												Choose a folder only when your first task needs one
											</small>
										</span>
									</div>
								</div>
								{providerCheckError && (
									<p className="setup-error" role="alert">
										{providerCheckError}
									</p>
								)}
								<details className="finish-disclosure">
									<summary>How setup stays private</summary>
									<p>
										The setup assistant never asks for secrets in chat. API keys
										stay in protected native fields, while OAuth remains in the
										provider&apos;s browser or official CLI. Nothing here is
										permanent.
									</p>
								</details>
							</div>
						)}
					</motion.section>
				</AnimatePresence>
			</div>
			<footer className="onboarding-actions">
				{step === 2 && (
					<small className="setup-continue-hint">
						Choose an option above to continue.
					</small>
				)}
				{step === finalSetupStep && modelReady && !verifiedModelReady && (
					<small className="setup-continue-hint">
						Verify one model route before opening Kestrel.
					</small>
				)}
				<div className="button-row">
					{step > 0 && (
						<button
							className="button quiet setup-back-button"
							onClick={() => go(step - 1)}
						>
							Back
						</button>
					)}
					{step === 3 && !modelReady && !automaticBusy && !downloading && (
						<button className="button quiet" onClick={() => go(finalSetupStep)}>
							Do this later
						</button>
					)}
					{step === finalSetupStep && (
						<button
							className="button secondary"
							disabled={!onboardingCompleteAllowed}
							onClick={() => {
								localStorage.setItem("kestrel:setup-coach", "yes");
								localStorage.setItem(
									"kestrel:setup-coach-context",
									setupAssistantState({
										credentials,
										subscriptionClis,
										localRuntime,
										localModels,
										providerChecks,
									}),
								);
								localStorage.removeItem("kestrel:setup-step");
								onDone();
							}}
						>
							Finish with setup help
						</button>
					)}
					<button
						className="button primary"
						disabled={
							(step === 1 && !warningAccepted) ||
							step === 2 ||
							(step === finalSetupStep && !onboardingCompleteAllowed)
						}
						onClick={() => {
							if (step === finalSetupStep) {
								if (verifiedModelReady) {
									localStorage.setItem("kestrel:first-task", "yes");
								}
								localStorage.removeItem("kestrel:setup-step");
								onDone();
							} else go(step + 1);
						}}
					>
						{step === finalSetupStep
							? finishPrimaryLabel
							: step === 0
								? "Get started"
								: "Continue"}
						<Icon name="arrow" />
					</button>
				</div>
			</footer>
		</motion.main>
	);
}

function ProductAnchor({
	className = "",
	detail,
}: {
	className?: string;
	detail?: string;
}) {
	const reduced = useReducedMotion();
	return (
		<motion.div
			className={`product-anchor ${className}`.trim()}
			{...(reduced ? {} : { layoutId: "kestrel-product-anchor" })}
			transition={{
				layout: {
					duration: 0.14,
					ease: [0.22, 1, 0.36, 1],
				},
			}}
		>
			<span className="product-anchor-mark">
				<BrandMark />
			</span>
			<span>
				<strong>Kestrel</strong>
				{detail ? <small>{detail}</small> : null}
			</span>
		</motion.div>
	);
}

function ProductShellTransition({ children }: { children: ReactNode }) {
	return (
		<LayoutGroup id="kestrel-shell">
			<AnimatePresence initial={false} mode="sync">
				{children}
			</AnimatePresence>
		</LayoutGroup>
	);
}

function Loading() {
	const reduced = useReducedMotion();
	return (
		<motion.main
			className="loading-screen"
			initial={reduced ? false : { opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: reduced ? 1 : 0, pointerEvents: "none" }}
			transition={{ duration: reduced ? 0 : 0.14 }}
		>
			<ProductAnchor detail="Starting on this Mac…" />
		</motion.main>
	);
}

export type ArtifactPreviewState = {
	mediaType: string;
	dataUrl?: string;
	text?: string;
	truncated: boolean;
};

const MAX_ARTIFACT_PREVIEW_BYTES = 5_000_000;
const MAX_WIDGET_EXPORT_BYTES = 10_000_000;

function decodeArtifactBase64(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function isTextArtifact(artifact: ArtifactRecordContract): boolean {
	return (
		(artifact.mediaType.startsWith("text/") && artifact.mediaType !== "text/html") ||
		["application/json", "application/xml"].includes(artifact.mediaType)
	);
}

export function supportsArtifactPreview(artifact: ArtifactRecordContract): boolean {
	return (
		artifact.mediaType.startsWith("image/") ||
		artifact.mediaType.startsWith("audio/") ||
		artifact.mediaType.startsWith("video/") ||
		artifact.mediaType === "application/pdf" ||
		isTextArtifact(artifact) ||
		(artifact.mediaType === "text/html" && artifact.artifactKind === "widget")
	);
}

export function artifactPreviewState(
	artifact: ArtifactRecordContract,
	preview: {
		mediaType: string;
		dataBase64: string;
		truncated: boolean;
	},
): ArtifactPreviewState {
	if (isTextArtifact(artifact))
		return {
			mediaType: preview.mediaType,
			text: new TextDecoder().decode(decodeArtifactBase64(preview.dataBase64)),
			truncated: preview.truncated,
		};
	return {
		mediaType: preview.mediaType,
		...(preview.truncated
			? {}
			: {
					dataUrl: `data:${preview.mediaType};base64,${preview.dataBase64}`,
				}),
		truncated: preview.truncated,
	};
}

function triggerArtifactDownload(download: {
	filename: string;
	mediaType: string;
	dataBase64: string;
}): void {
	const bytes = decodeArtifactBase64(download.dataBase64);
	const url = URL.createObjectURL(
		new Blob([bytes.slice().buffer as ArrayBuffer], { type: download.mediaType }),
	);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = download.filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Artifacts() {
	const [artifacts, setArtifacts] = useState<ArtifactRecordContract[]>([]);
	const [previews, setPreviews] = useState<Record<string, ArtifactPreviewState>>({});
	const [artifactErrors, setArtifactErrors] = useState<Record<string, string>>({});
	const [artifactNotices, setArtifactNotices] = useState<Record<string, string>>({});
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [busyArtifactId, setBusyArtifactId] = useState<string | null>(null);
	const loadSequenceRef = useRef(0);

	const load = useCallback(async () => {
		const sequence = ++loadSequenceRef.current;
		setLoading(true);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "media-list-artifacts",
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			const next = response.artifacts ?? [];
			const previewOutcomes = await Promise.all(
				next.map(async (artifact) => {
					if (artifact.integrity !== "verified")
						return {
							artifact,
							error:
								artifact.integrity === "missing"
									? "The stored file is missing."
									: "The stored file failed integrity or containment verification.",
						};
					if (artifact.bytes > MAX_ARTIFACT_PREVIEW_BYTES)
						return {
							artifact,
							notice: "Preview skipped at 5 MB; download the verified file instead.",
						};
					if (!supportsArtifactPreview(artifact))
						return {
							artifact,
							notice: "Preview is unavailable for this media type; the file can still be downloaded.",
						};
					try {
						const result = (await window.kestrel.request({
							type: "media-preview-artifact",
							artifactId: artifact.id,
							maximumBytes: MAX_ARTIFACT_PREVIEW_BYTES,
						})) as CoreResponse;
						if (!result.ok) throw new Error(result.error);
						if (!result.artifactPreview)
							throw new Error("The artifact returned no preview data.");
						return {
							artifact,
							preview: artifactPreviewState(artifact, result.artifactPreview),
						};
					} catch (cause) {
						return {
							artifact,
							error:
								cause instanceof Error
									? cause.message
									: "Could not prepare the artifact preview.",
						};
					}
				}),
			);
			if (sequence !== loadSequenceRef.current) return;
			setArtifacts(next);
			setPreviews(
				Object.fromEntries(
					previewOutcomes.flatMap((outcome) =>
						outcome.preview ? [[outcome.artifact.id, outcome.preview]] : [],
					),
				),
			);
			setArtifactErrors(
				Object.fromEntries(
					previewOutcomes.flatMap((outcome) =>
						outcome.error ? [[outcome.artifact.id, outcome.error]] : [],
					),
				),
			);
			setArtifactNotices(
				Object.fromEntries(
					previewOutcomes.flatMap((outcome) =>
						outcome.notice ? [[outcome.artifact.id, outcome.notice]] : [],
					),
				),
			);
		} catch (cause) {
			if (sequence === loadSequenceRef.current)
				setError(
					cause instanceof Error ? cause.message : "Could not load artifacts.",
				);
		} finally {
			if (sequence === loadSequenceRef.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function setPinned(artifact: ArtifactRecordContract): Promise<void> {
		if (artifact.integrity !== "verified") return;
		setBusyArtifactId(artifact.id);
		setArtifactErrors((current) => {
			const next = { ...current };
			delete next[artifact.id];
			return next;
		});
		try {
			const response = (await window.kestrel.request({
				type: "media-pin-artifact",
				artifactId: artifact.id,
				pinned: artifact.pinned !== true,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			const updated = response.artifacts?.[0];
			if (!updated) throw new Error("Pin state was not returned.");
			setArtifacts((current) =>
				current.map((item) => (item.id === updated.id ? updated : item)),
			);
		} catch (cause) {
			setArtifactErrors((current) => ({
				...current,
				[artifact.id]:
					cause instanceof Error ? cause.message : "Could not update pin state.",
			}));
		} finally {
			setBusyArtifactId(null);
		}
	}

	async function downloadArtifact(artifact: ArtifactRecordContract): Promise<void> {
		if (artifact.integrity !== "verified") return;
		setBusyArtifactId(artifact.id);
		setArtifactErrors((current) => {
			const next = { ...current };
			delete next[artifact.id];
			return next;
		});
		try {
			const response = (await window.kestrel.request({
				type: "media-download-artifact",
				artifactId: artifact.id,
				maximumBytes: 32_000_000,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			if (!response.artifactDownload)
				throw new Error("The artifact returned no download data.");
			triggerArtifactDownload(response.artifactDownload);
			setArtifactNotices((current) => ({
				...current,
				[artifact.id]: "Download started.",
			}));
		} catch (cause) {
			setArtifactErrors((current) => ({
				...current,
				[artifact.id]:
					cause instanceof Error ? cause.message : "Could not download this artifact.",
			}));
		} finally {
			setBusyArtifactId(null);
		}
	}

	async function exportWidget(artifact: ArtifactRecordContract): Promise<void> {
		if (artifact.integrity !== "verified" || artifact.artifactKind !== "widget") return;
		setBusyArtifactId(artifact.id);
		setArtifactErrors((current) => {
			const next = { ...current };
			delete next[artifact.id];
			return next;
		});
		try {
			const response = (await window.kestrel.request({
				type: "media-export-artifact",
				artifactId: artifact.id,
				maximumBytes: MAX_WIDGET_EXPORT_BYTES,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			if (!response.exportedArtifact || !response.artifactPreview)
				throw new Error("The widget export returned no bounded file.");
			const exported = response.exportedArtifact;
			setArtifacts((current) => [
				...current.filter((item) => item.id !== exported.id),
				exported,
			]);
			setPreviews((current) => ({
				...current,
				[exported.id]: artifactPreviewState(exported, response.artifactPreview!),
			}));
			if (response.artifactPreview.truncated)
				throw new Error("The widget export exceeded the bounded download preview.");
			triggerArtifactDownload({
				filename: exported.filename,
				mediaType: exported.mediaType,
				dataBase64: response.artifactPreview.dataBase64,
			});
			setArtifactNotices((current) => ({
				...current,
				[artifact.id]: `Exported ${exported.filename} and started the download.`,
				[exported.id]: "Exported from this widget.",
			}));
		} catch (cause) {
			setArtifactErrors((current) => ({
				...current,
				[artifact.id]:
					cause instanceof Error ? cause.message : "Could not export this widget.",
			}));
		} finally {
			setBusyArtifactId(null);
		}
	}

	const verifiedCount = artifacts.filter((artifact) => artifact.integrity === "verified").length;
	return (
		<PageFrame
			eyebrow="Verified results"
			title="Artifacts"
			text="Inspect locally stored outputs together with their source, model, session, and verification hash."
			measure="wide"
		>
			<div className="artifact-toolbar">
				<span>
					{verifiedCount} verified · {artifacts.length} retained
				</span>
				<button
					className="button secondary"
					disabled={loading}
					onClick={() => void load()}
				>
					{loading ? "Refreshing…" : "Refresh"}
				</button>
			</div>
			{error && <p className="connection-error" role="alert">{error}</p>}
			{artifacts.length === 0 && !loading ? (
				<Empty
					title="Nothing saved yet"
					text="Verified files and interactive results will appear here."
				/>
			) : (
				<section className="artifact-grid" aria-live="polite">
					{artifacts
						.slice()
						.reverse()
						.map((artifact) => {
							const preview = previews[artifact.id];
							const busy = busyArtifactId === artifact.id;
							const intact = artifact.integrity === "verified";
							return (
								<article
									className={`artifact-card artifact-card-${artifact.integrity ?? "unknown"}`}
									key={artifact.id}
									data-artifact-id={artifact.id}
								>
									{preview?.dataUrl && artifact.mediaType.startsWith("image/") ? (
										<img
											src={preview.dataUrl}
											alt={`Generated artifact ${artifact.filename}`}
										/>
									) : preview?.dataUrl &&
										artifact.mediaType === "text/html" &&
										artifact.artifactKind === "widget" ? (
										<div className="artifact-widget">
											<iframe
												title={artifact.title ?? artifact.filename}
												sandbox="allow-scripts"
												referrerPolicy="no-referrer"
												src={preview.dataUrl}
											/>
											<span>Interactive · isolated · network off</span>
										</div>
									) : preview?.dataUrl && artifact.mediaType === "application/pdf" ? (
										<div className="artifact-document-pdf">
											<iframe
												title={`Preview of ${artifact.filename}`}
												src={preview.dataUrl}
											/>
										</div>
									) : preview?.text !== undefined ? (
										<div className="artifact-document-preview">
											<pre>{preview.text || "(empty document)"}</pre>
											{preview.truncated && <span>Preview truncated at 5 MB</span>}
										</div>
									) : preview?.dataUrl && artifact.mediaType.startsWith("audio/") ? (
										<div className="artifact-audio">
											<span>
												{artifact.providerId === "fal-music"
													? "AI-generated music"
													: "AI-generated voice"}
											</span>
											<audio controls preload="metadata" src={preview.dataUrl} />
										</div>
									) : preview?.dataUrl && artifact.mediaType.startsWith("video/") ? (
										<div className="artifact-video">
											<span>Generated video</span>
											<video controls preload="metadata" src={preview.dataUrl} />
										</div>
									) : (
										<div className="artifact-file">
											<Icon name="artifacts" />
											<span>{artifact.mediaType}</span>
										</div>
									)}
									<div className="artifact-card-details">
										<div className="artifact-card-heading">
											<strong>{artifact.title ?? artifact.filename}</strong>
											<button
												type="button"
												className={`artifact-pin ${artifact.pinned ? "is-pinned" : ""}`}
												disabled={!intact || busy}
												aria-label={artifact.pinned ? "Unpin artifact" : "Pin artifact"}
												aria-pressed={artifact.pinned === true}
												onClick={() => void setPinned(artifact)}
											>
												<Icon name="pin" />
												<span>{artifact.pinned ? "Pinned" : "Pin"}</span>
											</button>
										</div>
										<p>
											{(artifact.bytes / 1024).toFixed(1)} KB
											{artifact.width && artifact.height
												? ` · ${artifact.width}×${artifact.height}`
												: ""}
										</p>
										<dl className="artifact-provenance">
											<div><dt>Source</dt><dd>{artifact.providerId ?? "local"}</dd></div>
											<div><dt>Model</dt><dd>{artifact.model ?? "verified import"}</dd></div>
											<div><dt>Session</dt><dd>{artifact.sessionId ?? "unbound"}</dd></div>
											<div><dt>Integrity</dt><dd>{artifact.integrity ?? "unknown"}</dd></div>
										</dl>
										{artifact.exportedFromArtifactId ? (
											<small className="artifact-lineage" title={artifact.exportedFromArtifactId}>
												Exported from {artifact.exportedFromArtifactId.slice(0, 20)}…
											</small>
										) : null}
										<small>{new Date(artifact.createdAt).toLocaleString()}</small>
										<code title={artifact.sha256}>SHA-256 {artifact.sha256.slice(0, 16)}…</code>
										{artifactErrors[artifact.id] ? (
											<p className="artifact-integrity-warning" role="alert">
												{artifactErrors[artifact.id]}
											</p>
										) : null}
										{artifactNotices[artifact.id] ? (
											<p className="artifact-card-notice" role="status">
												{artifactNotices[artifact.id]}
											</p>
										) : null}
										<div className="artifact-card-actions">
											{artifact.artifactKind === "widget" && (
												<button
													type="button"
													className="button secondary"
													disabled={!intact || busy}
													onClick={() => void exportWidget(artifact)}
												>
													{busy ? "Working…" : "Export widget"}
												</button>
											)}
											<button
												type="button"
												className="button secondary"
												disabled={!intact || busy}
												onClick={() => void downloadArtifact(artifact)}
											>
												{busy ? "Working…" : "Download"}
											</button>
										</div>
									</div>
								</article>
							);
						})}
				</section>
			)}
		</PageFrame>
	);
}

function RuntimeConversation({
	visible,
	activeSessionId,
	sessions,
	onActiveSession,
	onSessions,
	onSnapshot,
	onRuntimeAgentState,
	configurationUi,
	browserContext,
	activeFileAttachment,
	externalIntake,
	externalIntakeRequestId,
	mentionTabs = [],
	mentionBookmarks = [],
	newAgentRequestId,
	newAgentPrompt,
	newAgentWorkspace,
	newAgentFocusTarget,
	refreshRevision,
	transcriptTarget,
	onTranscriptTargetHandled,
	onOpenActivity,
	onReviewLearnedSkill,
}: {
	visible: boolean;
	activeSessionId: string | null;
	sessions: RuntimeSession[];
	onActiveSession(sessionId: string | null): void;
	onSessions(sessions: RuntimeSession[]): void;
	onSnapshot(snapshot: WorkspaceSnapshot): void;
	onRuntimeAgentState(state: AgentState | null): void;
	configurationUi: WorkspaceSnapshot["configuration"]["ui"];
	browserContext?(): Promise<UserBrowserPageContext | undefined>;
	activeFileAttachment?: SelectedAttachment;
	externalIntake: ExternalIntake | null;
	externalIntakeRequestId: number;
	mentionTabs?: UserBrowserTab[];
	mentionBookmarks?: UserBrowserBookmark[];
	newAgentRequestId: number;
	newAgentPrompt: string;
	newAgentWorkspace: string | null;
	newAgentFocusTarget: "prompt" | "task-settings";
	refreshRevision: number;
	transcriptTarget?: { sessionId: string; messageId: string } | null;
	onTranscriptTargetHandled?(): void;
	onOpenActivity?(executionId: string): void;
	onReviewLearnedSkill(proposalId: string): void;
}) {
	const [messages, setMessages] = useState<RuntimeMessage[]>([]);
	const [hasEarlierMessages, setHasEarlierMessages] = useState(false);
	const [loadingEarlierMessages, setLoadingEarlierMessages] = useState(false);
	const [providers, setProviders] = useState<ModelProviderSummary[]>([]);
	const [localModels, setLocalModels] = useState<LocalModelSummary[]>([]);
	const [providerId, setProviderId] = useState(
		() => localStorage.getItem("kestrel:provider-id") ?? "",
	);
	const [model, setModel] = useState(
		() => localStorage.getItem("kestrel:model") ?? "",
	);
	const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
		() => {
			const stored = localStorage.getItem("kestrel:reasoning-effort");
			return stored === "low" ||
				stored === "medium" ||
				stored === "high" ||
				stored === "xhigh" ||
				stored === "max" ||
				stored === "none"
				? stored
				: "none";
		},
	);
	const [executionMode, setExecutionMode] = useState<ExecutionMode>(() =>
		localStorage.getItem("kestrel:execution-mode") === "manual"
			? "manual"
			: "automatic",
	);
	const [grants, setGrants] = useState<WorkspaceGrant[]>([]);
	const [workspace, setWorkspace] = useState("");
	const [attachments, setAttachments] = useState<SelectedAttachment[]>([]);
	const [mentionFiles, setMentionFiles] = useState<SelectedAttachment[]>([]);
	const shouldAutoSubmitFirstTaskRef = useRef(false);
	const [guidedFirstTaskActive, setGuidedFirstTaskActive] = useState(false);
	const [input, setInput] = useState(() => {
		if (localStorage.getItem("kestrel:first-task") === "yes") {
			localStorage.removeItem("kestrel:first-task");
			shouldAutoSubmitFirstTaskRef.current = true;
			return FIRST_TASK_PROMPT;
		}
		if (localStorage.getItem("kestrel:setup-coach") !== "yes") return "";
		localStorage.removeItem("kestrel:setup-coach");
		const context = localStorage.getItem("kestrel:setup-coach-context");
		localStorage.removeItem("kestrel:setup-coach-context");
		return context
			? `${SETUP_ASSISTANT_PROMPT}\n\n${context}`
			: SETUP_ASSISTANT_PROMPT;
	});
	const [busy, setBusy] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	const [streamText, setStreamText] = useState("");
	const [optimisticUser, setOptimisticUser] = useState("");
	const [optimisticSteering, setOptimisticSteering] = useState<string[]>([]);
	const [toolActivity, setToolActivity] = useState<RuntimeEvent[]>([]);
	const [usage, setUsage] = useState<SessionUsageSummary | null>(null);
	const [latestRun, setLatestRun] = useState<AgentRun | null>(null);
	const [actionReceipts, setActionReceipts] = useState<ActionReceipt[]>([]);
	const [humanInputRequests, setHumanInputRequests] = useState<HumanInputRequest[]>([]);
	const [executions, setExecutions] = useState<RuntimeToolExecution[]>([]);
	const [skillBusy, setSkillBusy] = useState(false);
	const [skillNotice, setSkillNotice] =
		useState<SkillLearningProposal | null>(null);
	const [checkpointSummary, setCheckpointSummary] = useState("");
	const [pending, setPending] = useState<{
		run: AgentRun;
		execution: RuntimeToolExecution;
	} | null>(null);
	const [error, setError] = useState("");
	const streamIdRef = useRef<string | null>(null);
	const streamSessionIdRef = useRef<string | null>(null);
	const activeSessionIdRef = useRef(activeSessionId);
	const previousNewAgentRequestIdRef = useRef(newAgentRequestId);
	const taskSettingsRef = useRef<HTMLDetailsElement>(null);
	const externalIntakeRequestIdRef = useRef(0);
	const sessionLoadSequenceRef = useRef(0);
	const transcriptLoadKeyRef = useRef<string | null>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const microphoneStreamRef = useRef<MediaStream | null>(null);
	const reduced = useReducedMotion();

	useEffect(() => {
		onRuntimeAgentState(pending ? "waiting_approval" : busy ? "working" : null);
		return () => onRuntimeAgentState(null);
	}, [busy, onRuntimeAgentState, pending]);
	const promptRef = useRef<HTMLTextAreaElement | null>(null);
	const [voiceState, setVoiceState] = useState<
		"idle" | "recording" | "transcribing"
	>("idle");
	const activeSession = sessions.find(
		(session) => session.id === activeSessionId,
	);
	const activeGrants = availableWorkspaceGrants(grants);
	const taskWorkspace = runtimeTaskWorkspace({
		activeSessionId,
		sessionWorkspaceRoot: activeSession?.workspaceRoot,
		draftWorkspaceRoot: workspace,
	});
	const selectedGrant = grants.find((grant) => grant.path === taskWorkspace);
	const activeMention = mentionQuery(input);
	useEffect(() => {
		if (activeMention === null || !taskWorkspace) {
			setMentionFiles([]);
			return;
		}
		let cancelled = false;
		void window.kestrel
			.request({
				type: "list-workspace-files",
				workspaceRoot: taskWorkspace,
				query: activeMention,
			})
			.then((response) => {
				if (
					!cancelled &&
					response.ok &&
					"workspaceFiles" in response
				)
					setMentionFiles(response.workspaceFiles);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [activeMention, taskWorkspace]);
	const manualRoutingReady = Boolean(providerId && model.trim());
	const executionReady = executionMode === "automatic" || manualRoutingReady;
	activeSessionIdRef.current = activeSessionId;
	const modelChoice: ModelSelectorChoice = {
		executionMode,
		providerId,
		model,
		reasoningEffort,
	};

	function applyModelChoice(next: ModelSelectorChoice) {
		setExecutionMode(next.executionMode);
		setProviderId(next.providerId);
		setModel(next.model);
		setReasoningEffort(next.reasoningEffort);
		localStorage.setItem("kestrel:execution-mode", next.executionMode);
		if (next.providerId)
			localStorage.setItem("kestrel:provider-id", next.providerId);
		if (next.model.trim())
			localStorage.setItem("kestrel:model", next.model.trim());
		localStorage.setItem("kestrel:reasoning-effort", next.reasoningEffort);
	}

	useEffect(() => {
		const prompt = promptRef.current;
		if (!prompt) return;
		prompt.style.height = "auto";
		const nextHeight = Math.min(prompt.scrollHeight, 180);
		prompt.style.height = `${nextHeight}px`;
		prompt.style.overflowY = prompt.scrollHeight > 180 ? "auto" : "hidden";
	}, [input]);

	useEffect(() => {
		if (previousNewAgentRequestIdRef.current === newAgentRequestId) return;
		previousNewAgentRequestIdRef.current = newAgentRequestId;
		if (busy) {
			setError("Finish or cancel the active task before starting a new one.");
			window.setTimeout(() => promptRef.current?.focus(), 0);
			return;
		}
		activeSessionIdRef.current = null;
		onActiveSession(null);
		setInput(newAgentPrompt);
		if (newAgentWorkspace) setWorkspace(newAgentWorkspace);
		setAttachments([]);
		setCheckpointSummary("");
		setError("");
		window.setTimeout(() => {
			if (newAgentFocusTarget === "task-settings") {
				const details = taskSettingsRef.current;
				if (details) {
					details.open = true;
					details.querySelector<HTMLElement>("summary")?.focus();
					return;
				}
			}
			promptRef.current?.focus();
		}, 0);
		if (newAgentPrompt.trim()) void submit(newAgentPrompt);
	}, [
		busy,
		newAgentFocusTarget,
		newAgentPrompt,
		newAgentRequestId,
		newAgentWorkspace,
		onActiveSession,
	]);

	useEffect(() => {
		if (
			!externalIntake ||
			externalIntakeRequestIdRef.current === externalIntakeRequestId
		)
			return;
		externalIntakeRequestIdRef.current = externalIntakeRequestId;
		setInput((current) => appendExternalText(current, externalIntake.text));
		if (externalIntake.attachments.length > 0)
			setAttachments((current) =>
				mergeAttachments(current, externalIntake.attachments),
			);
		setError("");
		window.setTimeout(() => promptRef.current?.focus(), 0);
	}, [externalIntake, externalIntakeRequestId]);

	async function refreshSessions() {
		const response = (await window.kestrel.request({
			type: "runtime-list-sessions",
		})) as CoreResponse;
		if (!response.ok) throw new Error(response.error);
		onSessions(response.sessions ?? []);
	}

	async function loadHumanInputRequests(sessionId: string): Promise<boolean> {
		const response = (await window.kestrel.request({
			type: "runtime-list-human-input",
			sessionId,
		})) as CoreResponse;
		if (!response.ok) throw new Error(response.error);
		if (activeSessionIdRef.current !== sessionId) return false;
		setHumanInputRequests(response.humanInputRequests ?? []);
		return true;
	}

	async function loadSession(sessionId: string): Promise<boolean> {
		if (activeSessionIdRef.current !== sessionId) return false;
		const loadSequence = ++sessionLoadSequenceRef.current;
		const responses = await Promise.all([
				window.kestrel.request({
					type: "runtime-list-messages",
					sessionId,
					limit: 100,
				}) as Promise<CoreResponse>,
				window.kestrel.request({
					type: "runtime-list-runs",
					sessionId,
				}) as Promise<CoreResponse>,
				window.kestrel.request({
					type: "runtime-list-executions",
					sessionId,
				}) as Promise<CoreResponse>,
				window.kestrel.request({
					type: "runtime-list-action-receipts",
					sessionId,
					limit: 500,
				}) as Promise<CoreResponse>,
				window.kestrel.request({
					type: "runtime-session-usage",
					sessionId,
				}) as Promise<CoreResponse>,
				window.kestrel.request({
					type: "runtime-list-human-input",
					sessionId,
				}) as Promise<CoreResponse>,
			]);
		const [
			messageResponse,
			runResponse,
			executionResponse,
			receiptResponse,
			usageResponse,
			humanInputResponse,
		] = responses;
		if (!messageResponse.ok) throw new Error(messageResponse.error);
		if (!runResponse.ok) throw new Error(runResponse.error);
		if (!executionResponse.ok) throw new Error(executionResponse.error);
		if (!receiptResponse.ok) throw new Error(receiptResponse.error);
		if (!usageResponse.ok) throw new Error(usageResponse.error);
		if (!humanInputResponse.ok) throw new Error(humanInputResponse.error);
		if (
			activeSessionIdRef.current !== sessionId ||
			sessionLoadSequenceRef.current !== loadSequence
		)
			return false;
		setMessages(messageResponse.messages ?? []);
		setHasEarlierMessages(messageResponse.hasMoreMessages === true);
		setUsage(usageResponse.usage ?? null);
		setActionReceipts(receiptResponse.receipts ?? []);
		setHumanInputRequests(humanInputResponse.humanInputRequests ?? []);
		const runs = runResponse.runs ?? [];
		const loadedExecutions = executionResponse.executions ?? [];
		setLatestRun(runs[runs.length - 1] ?? null);
		setExecutions(loadedExecutions);
		const waiting = [...runs]
			.reverse()
			.find(
				(run) =>
					run.status === "waiting_approval" && run.pendingToolExecutionId,
			);
		const execution = waiting
			? loadedExecutions.find(
					(item) => item.id === waiting.pendingToolExecutionId,
				)
			: undefined;
		setPending(waiting && execution ? { run: waiting, execution } : null);
		return true;
	}

	async function loadEarlierMessages() {
		if (
			!activeSessionId ||
			!hasEarlierMessages ||
			loadingEarlierMessages ||
			busy ||
			!messages[0]
		)
			return;
		const sessionId = activeSessionId;
		const loadSequence = sessionLoadSequenceRef.current;
		setLoadingEarlierMessages(true);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-list-messages",
				sessionId,
				beforeMessageId: messages[0].id,
				limit: 100,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			if (
				activeSessionIdRef.current !== sessionId ||
				sessionLoadSequenceRef.current !== loadSequence
			)
				return;
			const earlier = response.messages ?? [];
			setMessages((current) => {
				const existing = new Set(current.map((message) => message.id));
				return [
					...earlier.filter((message) => !existing.has(message.id)),
					...current,
				];
			});
			setHasEarlierMessages(response.hasMoreMessages === true);
		} catch (cause) {
			if (activeSessionIdRef.current === sessionId)
				setError(
					cause instanceof Error
						? cause.message
						: "Could not load earlier messages.",
				);
		} finally {
			setLoadingEarlierMessages(false);
		}
	}

	useEffect(() => {
		if (!visible) return;
		let cancelled = false;
		void Promise.all([
			window.kestrel.request({ type: "runtime-list-providers" }),
			window.kestrel.request({ type: "get-workspace-grants" }),
			window.kestrel.request({ type: "local-model-status" }),
			window.kestrel.request({ type: "runtime-list-sessions" }),
		])
			.then(
				async ([
					providerResponse,
					grantResponse,
					localModelResponse,
					sessionResponse,
				]) => {
					if (cancelled) return;
					if (providerResponse.ok && "providers" in providerResponse) {
						const available = providerResponse.providers ?? [];
						setProviders(available);
						setProviderId((current) =>
							available.some((provider) => provider.id === current)
								? current
								: available[0]?.id || "",
						);
					}
					if (grantResponse.ok && "workspaceGrants" in grantResponse) {
						setGrants(grantResponse.workspaceGrants);
						const availableGrants = availableWorkspaceGrants(
							grantResponse.workspaceGrants,
						);
						setWorkspace(
							(current) =>
								(current &&
								availableGrants.some((grant) => grant.path === current)
									? current
									: availableGrants[0]?.path) ?? "",
						);
					}
					if (localModelResponse.ok && "localModels" in localModelResponse)
						setLocalModels(localModelResponse.localModels);
					if (sessionResponse.ok && "sessions" in sessionResponse)
						onSessions(sessionResponse.sessions ?? []);
					const visibleSessionId = activeSessionIdRef.current;
					if (visibleSessionId) await loadSession(visibleSessionId);
				},
			)
			.catch((cause) => {
				if (!cancelled)
					setError(
						cause instanceof Error
							? cause.message
							: "Could not load task options.",
					);
			});
		return () => {
			cancelled = true;
		};
	}, [visible, onSessions]);

	useEffect(() => {
		if (!transcriptTarget || transcriptTarget.sessionId !== activeSessionId) return;
		if (messages.some((message) => message.id === transcriptTarget.messageId)) return;
		if (!messages[0]) return;
		const loadKey = `${transcriptTarget.sessionId}:${transcriptTarget.messageId}`;
		if (transcriptLoadKeyRef.current === loadKey) return;
		transcriptLoadKeyRef.current = loadKey;
		let cancelled = false;
		const sessionId = transcriptTarget.sessionId;
		const loadSequence = sessionLoadSequenceRef.current;
		void (async () => {
			setLoadingEarlierMessages(true);
			try {
				let cursor: string | undefined = messages[0]?.id;
				for (let pageNumber = 0; pageNumber < 100 && cursor; pageNumber += 1) {
					const response = (await window.kestrel.request({
						type: "runtime-list-messages",
						sessionId,
						beforeMessageId: cursor,
						limit: 100,
					})) as CoreResponse;
					if (!response.ok) throw new Error(response.error);
					if (
						cancelled ||
						activeSessionIdRef.current !== sessionId ||
						sessionLoadSequenceRef.current !== loadSequence
					)
						return;
					const earlier = response.messages ?? [];
					if (earlier.length > 0)
						setMessages((current) => {
							const existing = new Set(current.map((message) => message.id));
							return [
								...earlier.filter((message) => !existing.has(message.id)),
								...current,
							];
						});
					if (earlier.some((message) => message.id === transcriptTarget.messageId)) return;
					if (!response.hasMoreMessages || !earlier[0]) return;
					cursor = earlier[0].id;
				}
			} catch (cause) {
				if (!cancelled && activeSessionIdRef.current === sessionId)
					setError(
						cause instanceof Error
							? cause.message
							: "Could not load the matching transcript message.",
					);
			} finally {
				if (!cancelled) setLoadingEarlierMessages(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [activeSessionId, messages, transcriptTarget]);

	useEffect(() => {
		if (
			!transcriptTarget ||
			transcriptTarget.sessionId !== activeSessionId ||
			!messages.some((message) => message.id === transcriptTarget.messageId)
		)
			return;
		const frame = window.requestAnimationFrame(() => {
			const target = document.querySelector<HTMLElement>(
				`[data-runtime-message-id="${CSS.escape(transcriptTarget.messageId)}"]`,
			);
			if (!target) return;
			target.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
			target.focus({ preventScroll: true });
			onTranscriptTargetHandled?.();
		});
		return () => window.cancelAnimationFrame(frame);
	}, [activeSessionId, messages, onTranscriptTargetHandled, reduced, transcriptTarget]);

	const previousRefreshRevisionRef = useRef(refreshRevision);
	useEffect(() => {
		if (previousRefreshRevisionRef.current === refreshRevision) return;
		previousRefreshRevisionRef.current = refreshRevision;
		if (!visible) return;
		const sessionId = activeSessionIdRef.current;
		void Promise.all([
			refreshSessions(),
			sessionId ? loadSession(sessionId) : Promise.resolve(false),
		])
			.then(([, loaded]) => {
				if (loaded && activeSessionIdRef.current === sessionId) setError("");
			})
			.catch((cause) => {
				if (activeSessionIdRef.current === sessionId)
					setError(
						cause instanceof Error
							? cause.message
							: "Could not refresh the recovered task.",
					);
			});
	}, [refreshRevision, visible]);

	useEffect(() => {
		if (providerId === "auto") {
			setModel("auto");
			return;
		}
		if (providerId !== "ollama") return;
		setModel((current) =>
			localModels.some((item) => item.name === current)
				? current
				: (localModels[0]?.name ?? ""),
		);
	}, [providerId, localModels]);

	useEffect(() => {
		const preserveActiveRun = shouldPreserveActiveRun({
			streamId: streamIdRef.current,
			streamSessionId: streamSessionIdRef.current,
			activeSessionId,
		});
		sessionLoadSequenceRef.current += 1;
		setMessages([]);
		setHasEarlierMessages(false);
		setLoadingEarlierMessages(false);
		setAttachments([]);
		setStreamText("");
		if (!preserveActiveRun) {
			setOptimisticUser("");
			setOptimisticSteering([]);
		}
		setToolActivity([]);
		setPending(null);
		setUsage(null);
		setLatestRun(null);
		setActionReceipts([]);
		setExecutions([]);
		setHumanInputRequests([]);
		setError("");
		setSkillNotice(null);
		if (!activeSessionId) {
			return;
		}
		const sessionId = activeSessionId;
		void loadSession(sessionId).catch((cause) => {
			if (activeSessionIdRef.current !== sessionId) return;
			setError(
				cause instanceof Error ? cause.message : "Could not load this session.",
			);
		});
	}, [activeSessionId]);

	useEffect(
		() =>
			window.kestrel.onAgentStream((event) => {
				if (
					event.streamId === streamIdRef.current &&
					event.sessionId === streamSessionIdRef.current &&
					event.sessionId === activeSessionIdRef.current
				)
					setStreamText((current) => current + event.delta);
			}),
		[],
	);

	useEffect(
		() =>
			window.kestrel.onRuntimeEvent((event) => {
				if (event.sessionId !== activeSessionIdRef.current) return;
				if (event.type.startsWith("tool."))
					setToolActivity((current) => [...current, event].slice(-12));
				if (event.type === "question.created" || event.type === "question.updated")
					void loadHumanInputRequests(event.sessionId).catch(() => undefined);
			}),
		[activeSessionId],
	);

	useEffect(
		() => () => {
			if (recorderRef.current?.state === "recording")
				recorderRef.current.stop();
			microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
		},
		[],
	);

	async function startVoice() {
		if (busy || voiceState !== "idle") return;
		setError("");
		try {
			if (
				!navigator.mediaDevices?.getUserMedia ||
				typeof MediaRecorder === "undefined"
			)
				throw new Error("Voice capture is unavailable on this device.");
			const permission = await window.kestrel.request({
				type: "request-microphone-access",
			});
			if (!("microphoneAccess" in permission) || !permission.microphoneAccess)
				throw new Error(
					"Microphone access was not granted. You can enable it in System Settings → Privacy & Security → Microphone.",
				);
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: true,
				video: false,
			});
			microphoneStreamRef.current = stream;
			const preferred = [
				"audio/webm;codecs=opus",
				"audio/webm",
				"audio/mp4",
			].find((kind) => MediaRecorder.isTypeSupported(kind));
			const recorder = new MediaRecorder(
				stream,
				preferred ? { mimeType: preferred } : undefined,
			);
			const chunks: Blob[] = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size) chunks.push(event.data);
			};
			recorder.onerror = () => {
				setError("Voice recording failed.");
				setVoiceState("idle");
				stream.getTracks().forEach((track) => track.stop());
			};
			recorder.onstop = () => {
				stream.getTracks().forEach((track) => track.stop());
				microphoneStreamRef.current = null;
				recorderRef.current = null;
				const blob = new Blob(chunks, {
					type: recorder.mimeType || "audio/webm",
				});
				if (blob.size === 0 || blob.size > 25 * 1024 * 1024) {
					setError("Voice recording is empty or exceeds 25 MB.");
					setVoiceState("idle");
					return;
				}
				setVoiceState("transcribing");
				const reader = new FileReader();
				reader.onerror = () => {
					setError("Could not read the voice recording.");
					setVoiceState("idle");
				};
				reader.onload = () => {
					const encoded = String(reader.result).split(",")[1] ?? "";
					void window.kestrel
						.request({
							type: "media-transcribe",
							dataBase64: encoded,
							mediaType: blob.type.split(";")[0] || "audio/webm",
						})
						.then((response) => {
							if (!response.ok) throw new Error(response.error);
							if (!("transcription" in response) || !response.transcription)
								throw new Error("Transcription returned no text.");
							setInput((current) =>
								current
									? `${current.trimEnd()} ${response.transcription!.text}`
									: response.transcription!.text,
							);
						})
						.catch((cause) =>
							setError(
								cause instanceof Error
									? cause.message
									: "Voice transcription failed.",
							),
						)
						.finally(() => setVoiceState("idle"));
				};
				reader.readAsDataURL(blob);
			};
			recorderRef.current = recorder;
			recorder.start(1_000);
			setVoiceState("recording");
		} catch (cause) {
			microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
			microphoneStreamRef.current = null;
			recorderRef.current = null;
			setVoiceState("idle");
			setError(
				cause instanceof Error
					? cause.message
					: "Could not start voice capture.",
			);
		}
	}

	function stopVoice() {
		if (recorderRef.current?.state === "recording") recorderRef.current.stop();
	}

	async function addContext() {
		if (!taskWorkspace) return;
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "select-context-files",
				workspaceRoot: taskWorkspace,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Could not add context.",
				);
			if ("selectedAttachments" in response)
				setAttachments((current) =>
					[...current, ...response.selectedAttachments].slice(0, 8),
				);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not add context.",
			);
		}
	}

	function addComposerContext() {
		if (taskWorkspace && selectedGrant?.available !== false) {
			void addContext();
			return;
		}
		if (!activeSessionId) {
			void addProject();
			return;
		}
		setError(
			"This conversation has no project folder. Start a new task to add files.",
		);
	}

	async function addProject() {
		if (activeSessionId || busy) return;
		setError("");
		const previousPaths = new Set(grants.map((grant) => grant.path));
		try {
			const response = await window.kestrel.request({
				type: "select-workspace-folder",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Could not add the project.",
				);
			if (!("workspaceGrants" in response)) return;
			setGrants(response.workspaceGrants);
			if (response.cancelled) return;
			const availableGrants = availableWorkspaceGrants(
				response.workspaceGrants,
			);
			const selectedWorkspacePath =
				response.selectedWorkspacePath &&
				availableGrants.some(
					(grant) => grant.path === response.selectedWorkspacePath,
				)
					? response.selectedWorkspacePath
					: undefined;
			const added = response.workspaceGrants.find(
				(grant) => grant.available !== false && !previousPaths.has(grant.path),
			);
			setWorkspace(
				selectedWorkspacePath ??
					added?.path ??
					(activeGrants.some((grant) => grant.path === workspace)
						? workspace
						: undefined) ??
					availableGrants[0]?.path ??
					"",
			);
			setAttachments([]);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not add the project.",
			);
		}
	}

	async function submit(promptOverride?: string) {
		const prompt = (promptOverride ?? input).trim();
		if (!prompt) return;
		if (busy) {
			const streamId = streamIdRef.current;
			if (
				!streamId ||
				!activeSessionId ||
				streamSessionIdRef.current !== activeSessionId
			) {
				setError(
					"Kestrel is still working in another chat. Return to that chat to send an update or cancel the run.",
				);
				return;
			}
			setError("");
			setInput("");
			const response = (await window.kestrel.request({
				type: "runtime-steer-agent",
				streamId,
				sessionId: activeSessionId,
				message: prompt,
			})) as CoreResponse;
			if (!response.ok) {
				setInput(prompt);
				setError(response.error);
				return;
			}
			setOptimisticSteering((current) => [...current, prompt]);
			return;
		}
		if (executionMode === "manual" && !providerId) {
			setError(
				"Choose a configured provider or switch execution back to Automatic.",
			);
			return;
		}
		if (executionMode === "manual" && !model.trim()) {
			setError("Enter a model ID or switch execution back to Automatic.");
			return;
		}
		setBusy(true);
		setError("");
		setSkillNotice(null);
		setStreamText("");
		setToolActivity([]);
		setPending(null);
		setOptimisticUser(prompt);
		setInput("");
		let sessionId = activeSessionId;
		let streamId: string | null = null;
		try {
			if (!sessionId) {
				const sessionBeforeCreation = activeSessionIdRef.current;
				const created = (await window.kestrel.request({
					type: "runtime-create-session",
					title: chatTitleFromPrompt(prompt),
					...(workspace ? { workspaceRoot: workspace } : {}),
				})) as CoreResponse;
				if (!created.ok || !created.session)
					throw new Error(
						created.ok ? "Session creation failed." : created.error,
					);
				sessionId = created.session.id;
				streamId = crypto.randomUUID();
				streamIdRef.current = streamId;
				streamSessionIdRef.current = sessionId;
				if (activeSessionIdRef.current === sessionBeforeCreation) {
					activeSessionIdRef.current = sessionId;
					sessionLoadSequenceRef.current += 1;
					onActiveSession(sessionId);
				}
				await refreshSessions();
			}
			if (!streamId) {
				streamId = crypto.randomUUID();
				streamIdRef.current = streamId;
				streamSessionIdRef.current = sessionId;
			}
			localStorage.setItem("kestrel:execution-mode", executionMode);
			if (executionMode === "manual") {
				localStorage.setItem("kestrel:model", model.trim());
				if (providerId) localStorage.setItem("kestrel:provider-id", providerId);
				localStorage.setItem("kestrel:reasoning-effort", reasoningEffort);
			}
			const activeBrowserContext = await browserContext?.();
			const response = (await window.kestrel.request({
				type: "runtime-run-agent",
				sessionId,
				message: prompt,
				model: executionMode === "automatic" ? "auto" : model.trim(),
				providerIds: executionMode === "automatic" ? ["auto"] : [providerId],
				streamId,
					attachments: promptAttachments,
				...(executionMode === "manual" && reasoningEffort !== "none"
					? { reasoningEffort }
					: {}),
				...(activeBrowserContext
					? { browserContext: activeBrowserContext }
					: {}),
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			if (activeSessionIdRef.current === sessionId) {
				setPending(
					response.run?.status === "waiting_approval" && response.execution
						? { run: response.run, execution: response.execution }
						: null,
				);
				await loadSession(sessionId);
				setAttachments([]);
			}
		} catch (cause) {
			if (activeSessionIdRef.current === sessionId)
				setError(
					cause instanceof Error ? cause.message : "The agent run failed.",
				);
		} finally {
			if (!streamId || streamIdRef.current === streamId) {
				streamIdRef.current = null;
				streamSessionIdRef.current = null;
			}
			setBusy(false);
			setStreamText("");
			setOptimisticUser("");
			setOptimisticSteering([]);
		}
	}

	useEffect(() => {
		if (!shouldAutoSubmitFirstTaskRef.current) return;
		shouldAutoSubmitFirstTaskRef.current = false;
		setGuidedFirstTaskActive(true);
		void submit(FIRST_TASK_PROMPT);
	}, []);

	useEffect(() => {
		if (!guidedFirstTaskActive || busy || pending) return;
		if (
			latestRun?.status === "completed" ||
			latestRun?.status === "failed" ||
			latestRun?.status === "cancelled"
		)
			setGuidedFirstTaskActive(false);
	}, [guidedFirstTaskActive, busy, pending, latestRun?.status]);

	async function decide(approvalDecision: "approved" | "rejected") {
		if (!pending || busy) return;
		const sessionId = pending.run.sessionId;
		let streamId: string | null = null;
		setBusy(true);
		setError("");
		setStreamText("");
		try {
			streamId = crypto.randomUUID();
			streamIdRef.current = streamId;
			streamSessionIdRef.current = sessionId;
			const response = (await window.kestrel.request({
				type: "runtime-resume-agent",
				runId: pending.run.id,
				approvalDecision,
				streamId,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			if (activeSessionIdRef.current === sessionId) {
				setPending(
					response.run?.status === "waiting_approval" && response.execution
						? { run: response.run, execution: response.execution }
						: null,
				);
				await loadSession(sessionId);
			}
			const snapshotResponse = await window.kestrel.request({
				type: "snapshot",
			});
			if (
				snapshotResponse.ok &&
				"snapshot" in snapshotResponse &&
				snapshotResponse.snapshot
			)
				onSnapshot(snapshotResponse.snapshot);
		} catch (cause) {
			if (activeSessionIdRef.current === sessionId)
				setError(
					cause instanceof Error
						? cause.message
						: "Could not resolve the approval.",
				);
		} finally {
			if (!streamId || streamIdRef.current === streamId) {
				streamIdRef.current = null;
				streamSessionIdRef.current = null;
			}
			setBusy(false);
			setStreamText("");
		}
	}

	async function decidePersistently(decision: "allow" | "deny") {
		if (!pending || busy) return;
		setError("");
		const response = (await window.kestrel.request({
			type: "runtime-set-approval-rule",
			toolName: pending.execution.toolName,
			decision,
			scope: "session",
			sessionId: pending.run.sessionId,
		})) as CoreResponse;
		if (!response.ok) {
			setError(response.error);
			return;
		}
		await decide(decision === "allow" ? "approved" : "rejected");
	}

	async function cancel() {
		const streamId = streamIdRef.current;
		if (!streamId || !busy || cancelling) return;
		setCancelling(true);
		try {
			await window.kestrel.request({ type: "runtime-cancel-stream", streamId });
		} finally {
			setCancelling(false);
		}
	}

	async function createCheckpoint() {
		const summary = checkpointSummary.trim();
		if (!activeSessionId || !summary || busy) return;
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-checkpoint-session",
				sessionId: activeSessionId,
				summary,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			setCheckpointSummary("");
			await refreshSessions();
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not create the checkpoint.",
			);
		}
	}

	async function restoreCheckpoint(checkpointId: string) {
		if (!activeSessionId || busy) return;
		const sessionId = activeSessionId;
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-restore-checkpoint",
				sessionId,
				checkpointId,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			await Promise.all([refreshSessions(), loadSession(sessionId)]);
		} catch (cause) {
			if (activeSessionIdRef.current === sessionId)
				setError(
					cause instanceof Error
						? cause.message
						: "Could not restore the checkpoint.",
				);
		}
	}

	async function retryLastTurn() {
		if (!activeSessionId || !executionReady || busy) return;
		const sessionId = activeSessionId;
		let streamId: string | null = null;
		setBusy(true);
		setError("");
		setSkillNotice(null);
		setStreamText("");
		setToolActivity([]);
		setOptimisticSteering([]);
		try {
			streamId = crypto.randomUUID();
			streamIdRef.current = streamId;
			streamSessionIdRef.current = sessionId;
			const response = (await window.kestrel.request({
				type: "runtime-retry-agent",
				sessionId,
				model: executionMode === "automatic" ? "auto" : model.trim(),
				providerIds: executionMode === "automatic" ? ["auto"] : [providerId],
				streamId,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			if (activeSessionIdRef.current === sessionId) {
				setPending(
					response.run?.status === "waiting_approval" && response.execution
						? { run: response.run, execution: response.execution }
						: null,
				);
				await loadSession(sessionId);
			}
		} catch (cause) {
			if (activeSessionIdRef.current === sessionId)
				setError(
					cause instanceof Error
						? cause.message
						: "Could not retry the last turn.",
				);
		} finally {
			if (!streamId || streamIdRef.current === streamId) {
				streamIdRef.current = null;
				streamSessionIdRef.current = null;
			}
			setBusy(false);
			setStreamText("");
		}
	}

	async function saveWorkflowAsSkill() {
		if (
			!activeSessionId ||
			busy ||
			skillBusy ||
			latestRun?.status !== "completed"
		)
			return;
		setSkillBusy(true);
		setSkillNotice(null);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "skill-learning-suggest",
				sessionId: activeSessionId,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			const proposal = response.skillProposals?.[0];
			if (!proposal)
				throw new Error("Kestrel did not return a learned skill proposal.");
			setSkillNotice(proposal);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not save this workflow as a skill.",
			);
		} finally {
			setSkillBusy(false);
		}
	}

	const visibleMessages = messages.filter(
		(message) => message.role !== "system",
	);
	const taskControls = (
		<div className="runtime-task-controls">
			{executionMode === "automatic" && (
				<p>
					Auto routes model, thinking level, and service tier from the task,
					risk, provider health, and your budget.
				</p>
			)}
		</div>
	);
	const voiceButton = (
		<button
			type="button"
			className={`voice-button ${voiceState}`}
			aria-label={
				voiceState === "recording"
					? "Stop and transcribe voice"
					: "Record voice"
			}
			disabled={busy || voiceState === "transcribing"}
			onClick={() =>
				voiceState === "recording" ? stopVoice() : void startVoice()
			}
		>
			{voiceState === "recording" ? (
				<>
					<Icon name="pause" />
					<span className="sr-only">Stop recording</span>
				</>
			) : voiceState === "transcribing" ? (
				<>
					<Icon name="loader" />
					<span className="sr-only">Transcribing</span>
				</>
			) : (
				<Icon name="voice" />
			)}
		</button>
	);
	const canAddContextFiles =
		Boolean(taskWorkspace) && selectedGrant?.available !== false;
	const projectFilesUnavailable =
		Boolean(taskWorkspace) && selectedGrant?.available === false;
	const needsNewTaskForFiles = !canAddContextFiles && Boolean(activeSessionId);
	const composerFilesLabel = canAddContextFiles
		? "Add context files"
		: projectFilesUnavailable
			? "Project files unavailable"
		: needsNewTaskForFiles
			? "Files unavailable in this conversation"
			: "Add files or choose folder";
	const composerFilesTitle = canAddContextFiles
		? "Add files to this task"
		: projectFilesUnavailable
			? "Reconnect or remove this project in Settings"
		: needsNewTaskForFiles
			? "Start a new task to add files"
			: "Choose a project before adding files";
	const promptAttachments = mergeAttachments(
		attachments,
		activeFileAttachment ? [activeFileAttachment] : [],
	);
	const runScope = runtimeRunScope({
		busy,
		streamSessionId: streamSessionIdRef.current,
		activeSessionId,
		hasOptimisticNewTask: Boolean(optimisticUser),
	});
	const backgroundRunSessionId =
		runScope === "background" ? streamSessionIdRef.current : null;
	const latestRunHasConfigurationMessage = Boolean(
		latestRun &&
			messages.some(
				(message) =>
					message.createdAt >= latestRun.createdAt &&
					message.toolName?.startsWith("agent.config."),
			),
	);
	const activeSessionBusy = runScope === "active";
	const backgroundSessionBusy = runScope === "background";
	const visibleToolActivity = configurationUi.showToolActivity
		? toolActivity.filter(
				(event) =>
					!String(event.payload.toolName ?? "").startsWith("agent.config."),
			  )
		: [];
	const latestToolEvent = toolActivity.at(-1);
	const currentAction = latestToolEvent
		? String(
				latestToolEvent.payload.toolName ??
					latestToolEvent.executionId ??
					"Tool activity",
		  )
		: streamText
			? "Drafting a response"
			: "Starting the task";
	const currentActionDetail = latestToolEvent
		? latestToolEvent.type === "tool.progress"
			? "Progress update received"
			: latestToolEvent.type === "tool.completed"
				? "Tool result received"
				: "Tool started"
		: latestRun
			? `Isolated core · ${runRouteLabel(latestRun)}`
			: "Kestrel is working in this chat.";
	const latestOutcome =
		!busy &&
		!pending &&
		(latestRun?.status === "completed" ||
			latestRun?.status === "cancelled" ||
			latestRun?.status === "failed")
			? latestRun.status
			: null;
	const latestReceipts = latestRunActionReceipts(actionReceipts, latestRun);
	const outcomeCopy =
		latestOutcome && latestRun ? runtimeOutcomeCopy(latestRun, error) : null;
	const uncertainExecutions = latestRun
		? uncertainExecutionsForRun(latestRun, executions)
		: [];
	const verifiedApprovalEvidence =
		latestRun && !pending
			? verifiedApprovalEvidenceForRun(
					latestRun,
					executions,
					actionReceipts,
				)
			: null;
	const emptySession = Boolean(
		activeSessionId &&
			visibleMessages.length === 0 &&
			!optimisticUser &&
			!optimisticSteering.length &&
			!activeSessionBusy &&
			!pending &&
			!error,
	);
	const assistiveStatus = cancelling
		? "Stopping Kestrel…"
		: activeSessionBusy
			? streamText
				? "Kestrel is responding in this chat."
				: "Kestrel is working on this chat."
			: backgroundSessionBusy
				? "Kestrel is working in another chat."
				: pending
					? `Kestrel needs your approval for ${pending.execution.toolName}.`
					: latestRun?.status === "completed"
						? "Kestrel finished the latest response."
						: humanInputRequests.some((request) => request.status === "waiting")
							? "Kestrel is waiting for your answer."
							: "";
	const hasQuestionSurface = humanInputRequests.length > 0;
	return (
		<section
			className={`conversation-view ${activeSessionId ? "" : "new-task-view"} ${emptySession ? "session-empty-view" : ""}`}
			aria-label={
				activeSession ? sessionTitleForDisplay(activeSession.title) : "New task"
			}
		>
			<p
				className="sr-only"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{assistiveStatus}
			</p>
			{backgroundRunSessionId ? (
				<div className="background-run-banner">
					<p>Kestrel is still working in another chat.</p>
					<button
						type="button"
						className="quiet-link"
						onClick={() => onActiveSession(backgroundRunSessionId)}
					>
						Return to active task
					</button>
				</div>
			) : null}
			{((!activeSessionId && visibleMessages.length === 0) || emptySession) &&
				!hasQuestionSurface ? (
				<div className="chat-welcome" aria-hidden="true">
					<h1>{emptySession ? "Pick up where you left off." : "How can I help?"}</h1>
					<p>
						{emptySession
							? "Send a message to continue this chat."
							: "Ask for a plan, a change, or the next useful step."}
					</p>
				</div>
			) : (
				<div className="message-list">
					{hasEarlierMessages && (
						<button
							type="button"
							className="quiet-link load-earlier-messages"
							disabled={busy || loadingEarlierMessages}
							onClick={() => void loadEarlierMessages()}
						>
							{loadingEarlierMessages
								? "Loading earlier messages…"
								: "Load earlier messages"}
						</button>
					)}
					{visibleMessages.map((message) => {
						const presentation =
							message.role === "tool"
								? parseUIPresentationMessage(message)
								: undefined;
						return message.role === "user" ? (
							<div
								className="user-message"
								key={message.id}
								data-runtime-message-id={message.id}
								tabIndex={-1}
							>
								<p>{message.content}</p>
								{parseExplicitMemoryCapture(message.content) && (
									<p className="memory-capture-confirmation" role="status">
										Saved to Life → Memory. Future chats can use this when shared
										context is on.
									</p>
								)}
							</div>
						) : message.role === "assistant" ? (
							<div
								className="assistant-message"
								key={message.id}
								data-runtime-message-id={message.id}
								tabIndex={-1}
							>
								<span className="assistant-avatar">K</span>
								<div>
									<p>{message.content}</p>
									{message.memoryRecallReceipt && (
										<MemoryRecallReceiptLine
											receipt={message.memoryRecallReceipt}
										/>
									)}
								</div>
							</div>
						) : message.toolName?.startsWith("agent.config.") ? (
							<div
								key={message.id}
								data-runtime-message-id={message.id}
								tabIndex={-1}
							>
								<ConfigurationMessage
									message={message}
									showDiffs={configurationUi.showConfigurationDiffs}
									announceVerification={configurationUi.announceVerification}
									onPrepareUndo={(prompt) => {
										setInput(prompt);
										window.setTimeout(() => promptRef.current?.focus(), 0);
									}}
								/>
							</div>
						) : presentation ? (
							<div
								key={message.id}
								data-runtime-message-id={message.id}
								tabIndex={-1}
							>
								<PresentationCard presentation={presentation} />
							</div>
						) : (
							<div
								className="work-summary"
								key={message.id}
								data-runtime-message-id={message.id}
								tabIndex={-1}
							>
								<Icon name="check" />
								<span>
									{message.toolName ?? "Tool result"}: {message.content}
								</span>
							</div>
						);
					})}
					{humanInputRequests.map((request) => (
						<RuntimeQuestionCard
							key={request.id}
							request={request}
							onResolved={(resolved) => {
								setHumanInputRequests((current) =>
									current.map((item) =>
										item.id === resolved.id ? resolved : item,
									),
								);
								if (resolved.status !== "waiting")
									window.setTimeout(() => promptRef.current?.focus(), 0);
							}}
						/>
					))}
					{optimisticUser && (
						<div className="user-message">
							<p>{optimisticUser}</p>
						</div>
					)}
					{optimisticSteering.map((message, index) => (
						<div className="user-message" key={`steering-${index}`}>
							<p>{message}</p>
							<small>Queued update</small>
						</div>
					))}
					{activeSessionBusy && (
						<div
							className="runtime-current-action"
							role="status"
							aria-live="polite"
						>
							<div className="runtime-current-action-header">
								<span className="assistant-avatar">K</span>
								<div className="runtime-current-action-copy">
									<span className="runtime-section-label">Current action</span>
									<strong>{currentAction}</strong>
									<small>{currentActionDetail}</small>
								</div>
							</div>
							{streamText && (
								<p className="runtime-stream-preview">{streamText}</p>
							)}
							{guidedFirstTaskActive && (
								<p className="runtime-first-task-notice">
									{FIRST_TASK_SLOW_MODEL_NOTICE}
								</p>
							)}
						</div>
					)}
					{visibleToolActivity.length > 0 && (
						<details className="runtime-activity">
							<summary>
								<span>Recent activity</span>
								<small>{visibleToolActivity.length} updates</small>
							</summary>
							<div className="runtime-activity-list">
								{visibleToolActivity.map((event) => (
									<div className="work-summary" key={event.id}>
										<Icon
											name={event.type === "tool.completed" ? "check" : "arrow"}
										/>
										<span>
											{event.type.replace("tool.", "Tool ")} ·{" "}
											{String(
												event.payload.toolName ??
													event.executionId ??
												"execution",
											)}
											{event.type === "tool.progress"
												? ` · ${JSON.stringify(event.payload)}`
												: ""}
										</span>
									</div>
								))}
							</div>
						</details>
					)}
					{verifiedApprovalEvidence && onOpenActivity && (
						<div className="runtime-activity-handoff" role="status">
							<Icon name="check" />
							<span>
								{verifiedApprovalEvidence.toolName} verified.{" "}
								<button
									type="button"
									className="quiet-link"
									onClick={() =>
										onOpenActivity(verifiedApprovalEvidence.executionId)
									}
								>
									View evidence in Activity
								</button>
							</span>
						</div>
					)}
					{pending && !busy && (
						<div className="assistant-message approval-message">
							<span className="assistant-avatar">!</span>
							<div>
								<strong>
									{pending.execution.toolName.startsWith("agent.config.")
										? "Review configuration change"
										: "Approval required"}{" "}
									· {pending.execution.riskLevel.replaceAll("_", " ")}
								</strong>
								<small className="runtime-approval-owner">
									Policy level {policyGateCopy(pending.execution).level} paused
									this run. The pause is restart-safe in encrypted local state
									until you allow or reject it.
								</small>
								<p>{pending.execution.toolName}</p>
								<small>
									Route {runRouteLabel(pending.run)}
									{pending.execution.idempotencyKey
										? ` · ${pending.execution.idempotencyKey}`
										: ""}
								</small>
								<p>{policyGateCopy(pending.execution).reason}</p>
								{typeof pending.execution.output?.preview === "string" && (
									<pre className="approval-preview">
										{pending.execution.output.preview}
									</pre>
								)}
								<details>
									<summary>
										{pending.execution.toolName.startsWith("agent.config.")
											? "Plan identifiers and exact input"
											: "Raw tool input"}
									</summary>
									<pre>{JSON.stringify(pending.execution.input, null, 2)}</pre>
								</details>
								<div
									className="button-row"
									style={{ display: "flex", flexDirection: "column" }}
								>
									<button
										className="button primary"
										onClick={() => void decide("approved")}
									>
										{pending.execution.toolName.startsWith("agent.config.")
											? "Apply this version"
											: "Allow once"}
									</button>
									{pending.execution.output?.persistentApprovalAllowed !==
										false && (
										<button
											className="button secondary"
											onClick={() => void decidePersistently("allow")}
										>
											Always allow here
										</button>
									)}
									<button
										className="button secondary"
										onClick={() => void decide("rejected")}
									>
										Reject once
									</button>
									<button
										className="button secondary"
										onClick={() => void decidePersistently("deny")}
									>
										Always deny here
									</button>
								</div>
							</div>
						</div>
					)}
					{latestOutcome && (
						<section
							className={`runtime-outcome runtime-outcome-${latestOutcome}`}
							aria-label="Latest task outcome"
						>
							<div className="runtime-outcome-icon">
								<Icon
									name={
										latestOutcome === "completed"
											? "check"
											: latestOutcome === "failed"
												? "warning"
												: "pause"
										}
								/>
							</div>
							<div className="runtime-outcome-copy">
								<strong>{outcomeCopy?.title}</strong>
								<p>{outcomeCopy?.detail}</p>
							</div>
							{uncertainExecutions.length > 0 && (
								<details className="runtime-outcome-evidence">
									<summary>
										{uncertainExecutions.length === 1
											? "1 action has an uncertain outcome"
											: `${uncertainExecutions.length} actions have uncertain outcomes`}
									</summary>
									<p>
										Kestrel will not repeat these actions automatically. Check the
										destination before retrying, especially for consequential changes.
									</p>
									<ul>
										{uncertainExecutions.map((execution) => (
											<li key={execution.id}>
												<strong>{execution.toolName}</strong>
												<span>
													{execution.error ||
														"Kestrel could not confirm whether this action completed."}
												</span>
											</li>
										))}
									</ul>
								</details>
							)}
							{latestOutcome === "failed" && (
								<button
									type="button"
									className="button secondary"
									disabled={
										!executionReady ||
										visibleMessages.every((message) => message.role !== "user")
									}
									onClick={() => void retryLastTurn()}
								>
									Retry last turn
								</button>
							)}
							<ActionReceiptList receipts={latestReceipts} />
						</section>
					)}
					{latestRun?.status === "completed" &&
						!busy &&
						!pending &&
						!skillNotice &&
						!latestRunHasConfigurationMessage && (
							<div className="workflow-memory-action">
								<div>
									<strong>Keep this workflow</strong>
									<small>Save the approved sequence as a reusable skill.</small>
								</div>
								<button
									type="button"
									className="button secondary"
									disabled={skillBusy}
									onClick={() => void saveWorkflowAsSkill()}
								>
									{skillBusy ? "Saving…" : "Save as skill"}
								</button>
							</div>
						)}
					{skillNotice && (
						<div
							className="skill-notice"
							data-skill-proposal-id={skillNotice.id}
						>
							<span role="status">
								<strong title={skillNotice.name}>
									{learnedSkillDisplayName(skillNotice.name)}
								</strong>
								<small>Ready to review before Kestrel installs it.</small>
							</span>
							<button
								type="button"
								className="quiet-link"
								onClick={() => onReviewLearnedSkill(skillNotice.id)}
							>
								Review skill
							</button>
						</div>
					)}
				</div>
			)}
			<div
				className={
					activeSessionId
						? "thread-composer runtime-composer"
						: "runtime-new-composer"
				}
			>
				{(attachments.length > 0 || activeFileAttachment) && (
					<div className="attachment-chips">
						{attachments.map((attachment) => (
							<button
								type="button"
								key={attachment.path}
								aria-label={`Remove ${attachment.name}`}
								title={`Remove ${attachment.name}`}
								onClick={() =>
									setAttachments((current) =>
										current.filter((item) => item.path !== attachment.path),
									)
								}
							>
								<span>{attachment.name}</span>
									<Icon name="close" />
								</button>
							))}
						{activeFileAttachment &&
							!attachments.some(
								(item) => item.path === activeFileAttachment.path,
							) && (
							<span
								className="attachment-context-chip"
								title="The active file tab is included with the next prompt"
							>
								Current tab · {activeFileAttachment.name}
							</span>
						)}
					</div>
				)}
				<form
					className="composer compact"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<label className="sr-only" htmlFor="runtime-prompt">
						Message Kestrel
					</label>
					<textarea
						ref={promptRef}
						id="runtime-prompt"
						rows={2}
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							if (activeMention !== null && ["ArrowDown", "ArrowUp", "Tab"].includes(event.key))
								return;
							if (event.key !== "Enter" || event.shiftKey) return;
							if (activeMention !== null) return;
							event.preventDefault();
							void submit();
						}}
						placeholder={
							activeSessionId
								? "Message Kestrel. @ for context."
								: "Describe the outcome. @ for context."
						}
					/>
					<ComposerMentionPicker
							query={activeMention}
							tabs={mentionTabs}
							bookmarks={mentionBookmarks}
							files={mentionFiles}
							onSelect={(mention) => {
								setInput((current) =>
									replaceMention(current, mention.insert),
								);
								if (mention.attachment)
									setAttachments((current) =>
										[...current, mention.attachment!].slice(0, 8),
									);
							}}
							onDismiss={() => setInput((current) => `${current} `)}
						/>
					<div className="composer-footer">
						<div className="button-row composer-context-actions">
							<button
								type="button"
								className="composer-icon composer-add-files"
								aria-label={composerFilesLabel}
								title={composerFilesTitle}
								disabled={
									busy || voiceState !== "idle" || needsNewTaskForFiles
								}
								onClick={addComposerContext}
							>
								<Icon name="plus" />
							</button>
							<ModelSelector
								providers={providers}
								localModels={localModels}
								choice={modelChoice}
								onChange={applyModelChoice}
							/>
							<details className="task-settings" ref={taskSettingsRef}>
								<summary
									className="task-settings-trigger"
									aria-label="Task settings"
									title="Task settings"
								>
									<Icon name="sliders" />
								</summary>
								<div className="task-settings-panel">
									<header>
										<strong>Task settings</strong>
										<small>
											{executionMode === "automatic"
												? "Automatic"
												: manualRoutingReady
													? "Manual · ready"
													: "Manual · incomplete"}
										</small>
									</header>
									{!activeSessionId ? (
										<div className="runtime-project-picker">
											<label>
												Project
												<select
													value={workspace}
													onChange={(event) => {
														setWorkspace(event.target.value);
														setAttachments([]);
													}}
												>
													<option value="">Conversation only</option>
													{activeGrants.map((grant) => (
														<option value={grant.path} key={grant.path}>
															{grant.name}
														</option>
													))}
												</select>
											</label>
											<button
												type="button"
												className="button secondary"
												disabled={busy}
												onClick={() => void addProject()}
											>
												Choose folder
											</button>
										</div>
									) : (
										<div className="runtime-project-context">
											<span>Project</span>
											<strong>
												{selectedGrant?.name ??
													(activeSession?.workspaceRoot
														? activeSession.workspaceRoot
																.split("/")
																.filter(Boolean)
																.at(-1)
														: "Conversation only")}
												{selectedGrant?.available === false
													? " · unavailable"
													: ""}
											</strong>
										</div>
									)}
									{taskControls}
									{activeSessionId && (
										<div
											className="runtime-lifecycle-controls"
											aria-label="Task restore and retry controls"
										>
											<label>
												Checkpoint
												<input
													value={checkpointSummary}
													onChange={(event) =>
														setCheckpointSummary(event.target.value)
													}
													placeholder="What is safe to return to?"
													maxLength={20_000}
												/>
											</label>
											<button
												type="button"
												className="button secondary"
												disabled={busy || !checkpointSummary.trim()}
												onClick={() => void createCheckpoint()}
											>
												Save checkpoint
											</button>
											<button
												type="button"
												className="button secondary"
												disabled={
													busy ||
													visibleMessages.every(
														(message) => message.role !== "user",
													) ||
													!executionReady
												}
												onClick={() => void retryLastTurn()}
											>
												Retry last turn
											</button>
											{activeSession?.checkpoints.map((checkpoint) => (
												<button
													type="button"
													className="quiet-link"
													disabled={busy}
													key={checkpoint.id}
													title={checkpoint.summary}
													onClick={() => void restoreCheckpoint(checkpoint.id)}
												>
													Restore #{checkpoint.sequence} · {checkpoint.summary}
												</button>
											))}
											{usage && (
												<span
													className="runtime-usage"
													title={`${usage.cachedInputTokens} cached input tokens · ${usage.reasoningTokens} reasoning tokens`}
												>
													{usage.modelCalls} calls ·{" "}
													{usage.inputTokens.toLocaleString()} in /{" "}
													{usage.outputTokens.toLocaleString()} out · $
													{usage.estimatedCostUsd.toFixed(4)}
												</span>
											)}
										</div>
									)}
								</div>
							</details>
						</div>
						<span className="composer-status">
							{voiceState === "recording"
								? "Microphone live · tap Stop to transcribe"
								: activeSessionBusy
									? "Send an update at the next safe turn boundary"
									: backgroundSessionBusy
										? "Another chat is running · return there to update or cancel"
										: selectedGrant?.available === false
											? `${selectedGrant.name} · unavailable; reconnect or remove it in Settings`
											: taskWorkspace
												? `${selectedGrant?.name ?? "Project"} · files and tools stay scoped`
												: activeSessionId
													? "Conversation only · start a new chat to add a project"
													: "Conversation only"}
						</span>
						{activeSessionBusy || backgroundSessionBusy ? (
							<div className="button-row composer-send-actions">
								{voiceButton}
								{activeSessionBusy ? (
									<button
										className="send-button"
										aria-label="Send steering update"
										disabled={!input.trim() || cancelling}
									>
										<Icon name="arrow" />
									</button>
								) : null}
								<button
									type="button"
									className="button secondary"
									disabled={cancelling}
									onClick={() => void cancel()}
								>
									{cancelling ? "Stopping…" : "Stop"}
								</button>
							</div>
						) : (
							<div className="button-row composer-send-actions">
								{voiceButton}
								<button
									className="send-button"
									aria-label="Send message"
									disabled={
										backgroundSessionBusy ||
										!input.trim() ||
										!executionReady ||
										voiceState !== "idle"
									}
								>
									<Icon name="arrow" />
								</button>
							</div>
						)}
					</div>
				</form>
				{error && !latestOutcome && (
					<p className="chat-error" role="alert">
						{error}
					</p>
				)}
			</div>
		</section>
	);
}


function Memory({
	snapshot,
	update,
}: {
	snapshot: WorkspaceSnapshot;
	update(next: WorkspaceSnapshot): void;
}) {
	const [filter, setFilter] = useState<MemoryRecord["type"] | "all">("all");
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [facts, setFacts] = useState<UserModelFact[]>([]);
	const [newContent, setNewContent] = useState("");
	const [newType, setNewType] = useState<MemoryRecord["type"]>("semantic");
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<RuntimeMessage[]>([]);
	const [busy, setBusy] = useState(false);
	const [memoryError, setMemoryError] = useState("");
	const grouped = useMemo(
		() =>
			snapshot.memories.reduce<Record<string, MemoryRecord[]>>(
				(groups, item) => {
					(groups[item.type] ??= []).push(item);
					return groups;
				},
				{},
			),
		[snapshot.memories],
	);
	const visible =
		filter === "all" ? snapshot.memories : (grouped[filter] ?? []);

	useEffect(() => {
		setDrafts(
			Object.fromEntries(
				snapshot.memories.map((memory) => [memory.id, memory.content]),
			),
		);
	}, [snapshot.memories]);

	async function loadFacts() {
		const response = (await window.kestrel.request({
			type: "memory-user-model-list",
		})) as CoreResponse;
		if (!response.ok) throw new Error(response.error);
		setFacts(response.userModelFacts ?? []);
	}

	useEffect(() => {
		void loadFacts().catch((cause) =>
			setMemoryError(
				cause instanceof Error
					? cause.message
					: "Could not load the user model.",
			),
		);
	}, []);

	async function refreshSnapshot() {
		const response = (await window.kestrel.request({
			type: "snapshot",
		})) as CoreResponse;
		if (!response.ok || !response.snapshot)
			throw new Error(response.ok ? "Memory refresh failed." : response.error);
		update(response.snapshot);
	}

	async function mutate(request: RendererRequest) {
		setBusy(true);
		setMemoryError("");
		try {
			const response = (await window.kestrel.request(request)) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			await refreshSnapshot();
		} catch (cause) {
			setMemoryError(
				cause instanceof Error ? cause.message : "Memory update failed.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function reviewFact(id: string, decision: "confirm" | "reject") {
		setBusy(true);
		setMemoryError("");
		try {
			const response = (await window.kestrel.request({
				type: "memory-user-model-review",
				id,
				decision,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			await loadFacts();
		} catch (cause) {
			setMemoryError(
				cause instanceof Error ? cause.message : "User-model review failed.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function searchTranscripts() {
		const query = searchQuery.trim();
		if (!query) {
			setSearchResults([]);
			return;
		}
		setBusy(true);
		setMemoryError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-search-messages",
				query,
				limit: 30,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			setSearchResults(response.messages ?? []);
		} catch (cause) {
			setMemoryError(
				cause instanceof Error ? cause.message : "Transcript search failed.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<PageFrame
			title="Memory"
			text="Review confirmed facts, provenance, and transcript matches before they shape future work."
			measure="wide"
		>
			<form
				className="memory-create"
				onSubmit={(event) => {
					event.preventDefault();
					const content = newContent.trim();
					if (!content) return;
					void mutate({
						type: "memory-remember",
						memoryType: newType,
						content,
						sensitivity: "personal",
						sourceId: "desktop-user",
					}).then(() => setNewContent(""));
				}}
			>
				<label>
					New confirmed memory
					<textarea
						value={newContent}
						onChange={(event) => setNewContent(event.target.value)}
						rows={2}
						placeholder="Store something with explicit provenance…"
					/>
				</label>
				<select
					aria-label="Memory type"
					value={newType}
					onChange={(event) =>
						setNewType(event.target.value as MemoryRecord["type"])
					}
				>
					{[
						"semantic",
						"episodic",
						"procedural",
						"project",
						"relationship",
					].map((type) => (
						<option key={type}>{type}</option>
					))}
				</select>
				<button
					className="button primary"
					disabled={busy || !newContent.trim()}
				>
					Remember
				</button>
			</form>
			<form
				className="memory-search"
				onSubmit={(event) => {
					event.preventDefault();
					void searchTranscripts();
				}}
			>
				<input
					aria-label="Search task history"
					value={searchQuery}
					onChange={(event) => setSearchQuery(event.target.value)}
					placeholder="Search across encrypted task history"
				/>
				<button
					className="button secondary"
					disabled={busy || !searchQuery.trim()}
				>
					Search history
				</button>
			</form>
			{searchResults.length > 0 && (
				<section
					className="memory-search-results"
					aria-label="Task history results"
				>
					{searchResults.map((message) => (
						<article key={message.id}>
							<span className="eyebrow">
								{message.role} · session {message.sessionId.slice(-8)}
							</span>
							<p>{message.content}</p>
						</article>
					))}
				</section>
			)}
			<div className="memory-layout">
				<aside className="memory-filters">
					<button
						className={filter === "all" ? "active" : ""}
						onClick={() => setFilter("all")}
					>
						<span>All</span>
						<strong>{snapshot.memories.length}</strong>
					</button>
					{Object.entries(grouped).map(([key, items]) => (
						<button
							className={filter === key ? "active" : ""}
							onClick={() => setFilter(key as MemoryRecord["type"])}
							key={key}
						>
							<span>{key}</span>
							<strong>{items.length}</strong>
						</button>
					))}
				</aside>
				<section className="memory-list">
					{visible.map((item) => (
						<article key={item.id}>
							<div>
								<span className="eyebrow">
									{item.type} · {item.userConfirmed ? "confirmed" : "inferred"}{" "}
									· {item.sensitivity}
								</span>
								<textarea
									aria-label={`Edit ${item.type} memory`}
									value={drafts[item.id] ?? item.content}
									onChange={(event) =>
										setDrafts((current) => ({
											...current,
											[item.id]: event.target.value,
										}))
									}
									rows={2}
								/>
								<details>
									<summary>Provenance</summary>
									<small>
										{item.sourceType} · {item.sourceIds.join(" · ")}
									</small>
								</details>
							</div>
							<div className="memory-actions">
								<button
									className="button secondary"
									disabled={
										busy ||
										!(drafts[item.id] ?? "").trim() ||
										drafts[item.id] === item.content
									}
									onClick={() =>
										void mutate({
											type: "memory-correct",
											id: item.id,
											content: drafts[item.id]!,
											memoryType: item.type,
											sensitivity: item.sensitivity,
										})
									}
								>
									Save correction
								</button>
								<button
									className="quiet-link"
									disabled={busy}
									onClick={() =>
										void mutate({ type: "memory-forget", id: item.id })
									}
								>
									Forget
								</button>
							</div>
						</article>
					))}
				</section>
			</div>
			<section className="user-model-review">
				<h2>Proposed user model</h2>
				{facts.filter((fact) => fact.status === "proposed").length === 0 ? (
					<p>No facts are waiting for review.</p>
				) : (
					facts
						.filter((fact) => fact.status === "proposed")
						.map((fact) => (
							<article key={fact.id}>
								<div>
									<span className="eyebrow">
										{fact.kind}.{fact.key} · {fact.sensitivity}
									</span>
									<p>{fact.value}</p>
									<small>Sources · {fact.sourceIds.join(" · ")}</small>
								</div>
								<div className="button-row">
									<button
										className="button primary"
										disabled={busy}
										onClick={() => void reviewFact(fact.id, "confirm")}
									>
										Confirm
									</button>
									<button
										className="button secondary"
										disabled={busy}
										onClick={() => void reviewFact(fact.id, "reject")}
									>
										Reject
									</button>
								</div>
							</article>
						))
				)}
			</section>
			{memoryError && (
				<p className="connection-error" role="alert">
					{memoryError}
				</p>
			)}
		</PageFrame>
	);
}


function Readiness() {
	const [readiness, setReadiness] = useState<SystemReadiness | null>(null);
	const [providerChecks, setProviderChecks] = useState<ProviderVerification[]>(
		[],
	);
	const [backup, setBackup] = useState<LocalBackupResult | null>(null);
	const [busy, setBusy] = useState<
		"refresh" | "models" | "backup" | "workspace" | "diagnostic" | ""
	>("");
	const [error, setError] = useState("");

	async function refresh() {
		setBusy("refresh");
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "system-readiness",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Readiness check failed.",
				);
			if ("systemReadiness" in response) setReadiness(response.systemReadiness);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Readiness check failed.",
			);
		} finally {
			setBusy("");
		}
	}

	async function verifyModels() {
		setBusy("models");
		setError("");
		setProviderChecks([]);
		try {
			const response = (await window.kestrel.request({
				type: "runtime-list-providers",
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			const checked: ProviderVerification[] = [];
			for (const provider of (response.providers ?? []).filter(
				(item) => item.id !== "auto",
			)) {
				const result = (await window.kestrel.request({
					type: "runtime-verify-provider",
					providerId: provider.id,
				})) as CoreResponse;
				if (!result.ok) throw new Error(result.error);
				checked.push(...(result.providerVerifications ?? []));
			}
			setProviderChecks(checked);
			if (checked.length === 0)
				setError(
					"Add a cloud account or local Ollama model before running the live check.",
				);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Model verification failed.",
			);
		} finally {
			setBusy("");
		}
	}

	async function createBackup() {
		setBusy("backup");
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "create-local-backup",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Backup failed.",
				);
			if ("localBackup" in response && response.localBackup) {
				setBackup(response.localBackup);
				await refresh();
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Backup failed.");
		} finally {
			setBusy("");
		}
	}

	async function exportDiagnostic() {
		setBusy("diagnostic");
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "export-diagnostic-report",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Diagnostic export failed.",
				);
			if ("diagnosticReportPath" in response && response.diagnosticReportPath) {
				await window.kestrel.request({
					type: "reveal-local-backup",
					path: response.diagnosticReportPath,
				});
			}
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Diagnostic export failed.",
			);
		} finally {
			setBusy("");
		}
	}

	async function addWorkspace() {
		setBusy("workspace");
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "select-workspace-folder",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Folder access failed.",
				);
			await refresh();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Folder access failed.",
			);
		} finally {
			setBusy("");
		}
	}

	useEffect(() => {
		void refresh();
	}, []);
	const failed =
		readiness?.checks.filter((check) => check.status === "fail").length ?? 0;
	const warnings =
		readiness?.checks.filter((check) => check.status === "warning").length ?? 0;
	const liveVerified =
		providerChecks.length > 0 && providerChecks.some((check) => check.ok);

	return (
		<PageFrame
			eyebrow={readiness?.readyForLiveWork ? "Ready for work" : "Needs attention"}
			title="Readiness"
			text="Check what is configured, what is reachable, and which recovery boundaries are available on this Mac."
			measure="wide"
			actions={
				<button
					className="button secondary"
					disabled={Boolean(busy)}
					onClick={() => void refresh()}
				>
					{busy === "refresh" ? "Checking…" : "Run checks"}
				</button>
			}
		>
			<section
				className={`readiness-hero ${readiness?.readyForLiveWork ? "ready" : "attention"}`}
			>
				<div className="readiness-pulse" aria-hidden="true">
					<span />
				</div>
				<div>
					<strong>
						{readiness
							? readiness.readyForLiveWork
								? "Ready for a first task"
								: `${failed} blocking check${failed === 1 ? "" : "s"}`
							: "Checking this Mac…"}
					</strong>
					<p>
						{readiness
							? `${warnings} optional item${warnings === 1 ? "" : "s"} can be completed when a task needs them. Last checked ${new Date(readiness.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
							: "Reading local status without sending project data anywhere."}
					</p>
				</div>
			</section>

			<div className="readiness-grid">
				<section className="readiness-panel">
					<header>
						<div>
							<span>System doctor</span>
							<h2>What can work right now</h2>
						</div>
						<small>
							{readiness?.checks.filter((check) => check.status === "pass")
								.length ?? 0}
							/{readiness?.checks.length ?? 0} clear
						</small>
					</header>
					<ol className="readiness-checks">
						{(readiness?.checks ?? []).map((check) => (
							<li key={check.id} className={`check-${check.status}`}>
								<span>
									{check.status === "pass"
										? "✓"
										: check.status === "warning"
											? "!"
											: "×"}
								</span>
								<div>
									<strong>{check.label}</strong>
									<p>{check.detail}</p>
								</div>
								{check.id === "workspace" && check.status !== "pass" && (
									<button
										className="quiet-link"
										disabled={Boolean(busy)}
										onClick={() => void addWorkspace()}
									>
										{busy === "workspace" ? "Adding…" : "Add folder"}
									</button>
								)}
							</li>
						))}
					</ol>
				</section>

				<aside className="readiness-side">
					<section className="readiness-panel model-check-panel">
						<header>
							<div>
								<span>Live account check</span>
								<h2>Verify account access</h2>
							</div>
						{liveVerified && (
							<small className="verified-label">Verified</small>
						)}
					</header>
					<p>
						This contacts only the configured provider or local model service.
						It does not send a project prompt.
					</p>
					{providerChecks.length > 0 && (
							<ul>
								{providerChecks.map((check) => (
									<li key={check.providerId}>
										<span
											className={`agent-dot ${check.ok ? "idle" : "paused"}`}
										/>
										<span>
											<strong>{check.providerId}</strong>
											<small>
												{check.ok
													? `${check.latencyMs} ms · account reachable`
													: (check.error ?? "Check failed")}
											</small>
										</span>
									</li>
								))}
							</ul>
						)}
						<button
							className="button primary"
							disabled={Boolean(busy)}
							onClick={() => void verifyModels()}
						>
							{busy === "models"
								? "Contacting providers…"
								: providerChecks.length
									? "Check again"
									: "Verify model access"}
						</button>
					</section>

					<section className="readiness-panel backup-panel">
						<header>
							<div>
								<span>Recovery</span>
								<h2>Create a verified backup</h2>
							</div>
						</header>
						<p>
							Copies encrypted conversations, settings, protected credentials,
							installed plugins, and artifacts after safely stopping the local
							core. Project folders are not duplicated. The snapshot can unlock
							your local state, so store it like a password.
						</p>
						{backup && (
							<div className="backup-result">
								<strong>
									{backup.files} files ·{" "}
									{(backup.bytes / 1024 / 1024).toFixed(1)} MB
								</strong>
								<small>
									{backup.verified
										? "Hashes verified"
										: "Verification incomplete"}{" "}
									· {new Date(backup.createdAt).toLocaleString()}
								</small>
								<button
									className="quiet-link"
									onClick={() =>
										void window.kestrel.request({
											type: "reveal-local-backup",
											path: backup.path,
										})
									}
								>
									Reveal in Finder
								</button>
							</div>
						)}
						<button
							className="button secondary"
							disabled={Boolean(busy)}
							onClick={() => void createBackup()}
						>
							{busy === "backup"
								? "Stopping core and verifying…"
								: "Choose backup folder"}
						</button>
					</section>

					<section className="readiness-panel diagnostic-panel">
						<header>
							<div>
								<span>Support</span>
								<h2>Export a local diagnostic report</h2>
							</div>
						</header>
						<p>
							Saves a content-free JSON envelope with version, platform, readiness
							counts, and failure class only. No prompts, page content,
							credentials, or personal memory are included. Review before sharing.
						</p>
						<button
							className="button secondary"
							disabled={Boolean(busy)}
							onClick={() => void exportDiagnostic()}
						>
							{busy === "diagnostic" ? "Saving…" : "Save diagnostic report"}
						</button>
					</section>
				</aside>
			</div>
			{error && (
				<p className="readiness-error" role="alert">
					{error}
				</p>
			)}
		</PageFrame>
	);
}

function Research() {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<WebSearchResultContract[]>([]);
	const [page, setPage] = useState<WebFetchResult | null>(null);
	const [cached, setCached] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function search() {
		const value = query.trim();
		if (!value) return;
		setBusy(true);
		setError("");
		setPage(null);
		try {
			const response = (await window.kestrel.request({
				type: "web-search-direct",
				query: value,
				maximumResults: 8,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			setResults(response.webResults ?? []);
			setCached(response.cached ?? false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Web search failed.");
		} finally {
			setBusy(false);
		}
	}
	async function fetchPage(url: string) {
		setBusy(true);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "web-fetch-direct",
				url,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			setPage(response.webPage ?? null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Web fetch failed.");
		} finally {
			setBusy(false);
		}
	}
	return (
		<PageFrame
			eyebrow="Search with sources"
			title="Research"
			text="Search the web directly, open a result in a bounded reader, and retain its retrieval evidence."
			measure="wide"
		>
			<form
				className="research-search"
				onSubmit={(event) => {
					event.preventDefault();
					void search();
				}}
			>
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search the web"
					aria-label="Search the web"
				/>
				<button className="button primary" disabled={busy || !query.trim()}>
					Search
				</button>
			</form>
			{cached && (
				<p className="research-cache">
					Results served from the encrypted local cache.
				</p>
			)}
			{error && (
				<p className="connection-error" role="alert">
					{error}
				</p>
			)}
			{!query.trim() && results.length === 0 && !page && !busy && (
				<Empty
					title="Start with a question"
					text="Enter a query to find web results Kestrel can cite in answers."
				/>
			)}
			{query.trim() && results.length === 0 && !page && !busy && !error && (
				<Empty
					title="No results found"
					text={`Nothing matched "${query.trim()}". Try different keywords or a shorter phrase.`}
				/>
			)}
			<div className="research-layout">
				<section className="research-results">
					{results.map((result) => (
						<article key={result.url}>
							<button
								onClick={() => void fetchPage(result.url)}
								disabled={busy}
							>
								<strong>{result.title}</strong>
								<span>{result.url}</span>
								<p>{result.snippet}</p>
								<small>
									{result.citation
										? `Retrieved ${new Date(result.citation.retrievedAt).toLocaleString()}`
										: "Source citation available"}
								</small>
							</button>
						</article>
					))}
				</section>
				{page && (
					<article className="research-reader">
						<span className="eyebrow">
							Untrusted external · {page.cached ? "cached" : "live"}
						</span>
						<h2>{page.citation.title}</h2>
						<a href={page.citation.url} target="_blank" rel="noreferrer">
							{page.citation.url}
						</a>
						<p>{page.content}</p>
						<small>
							Retrieved {new Date(page.citation.retrievedAt).toLocaleString()} ·
							HTTP {page.status} · {page.contentType}
						</small>
					</article>
				)}
			</div>
		</PageFrame>
	);
}

function Work({
	sessions,
	onSessions,
}: {
	sessions: RuntimeSession[];
	onSessions(sessions: RuntimeSession[]): void;
}) {
	const [goals, setGoals] = useState<GoalRecordContract[]>([]);
	const [teams, setTeams] = useState<TeamRecordContract[]>([]);
	const [jobs, setJobs] = useState<ScheduledJobSummary[]>([]);
	const [routingTraces, setRoutingTraces] = useState<RoutingTrace[]>([]);
	const [providers, setProviders] = useState<ModelProviderSummary[]>([]);
	const [localModels, setLocalModels] = useState<LocalModelSummary[]>([]);
	const [parentSessionId, setParentSessionId] = useState(sessions[0]?.id ?? "");
	const [providerId, setProviderId] = useState("auto");
	const [model, setModel] = useState(
		() => localStorage.getItem("kestrel:model") ?? "auto",
	);
	const [delegationEvidence, setDelegationEvidence] = useState("");
	const [delegateTitle, setDelegateTitle] = useState("");
	const [delegatePrompt, setDelegatePrompt] = useState("");
	const [isolateWorktree, setIsolateWorktree] = useState(false);
	const [goalTitle, setGoalTitle] = useState("");
	const [goalObjective, setGoalObjective] = useState("");
	const [scheduleTitle, setScheduleTitle] = useState("");
	const [schedulePrompt, setSchedulePrompt] = useState("");
	const [scheduleExpression, setScheduleExpression] = useState("");
	const [teamTitle, setTeamTitle] = useState("");
	const [teamMembers, setTeamMembers] = useState<string[]>([]);
	const [teamPlan, setTeamPlan] = useState("");
	const [handoffChild, setHandoffChild] = useState("");
	const [handoffSummary, setHandoffSummary] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const createGoalFormRef = useRef<HTMLFormElement>(null);
	const children = sessions.filter(
		(session) => session.parentSessionId === parentSessionId,
	);

	useEffect(() => {
		if (sessions.length === 0) {
			if (parentSessionId) setParentSessionId("");
			return;
		}
		if (
			!parentSessionId ||
			!sessions.some((session) => session.id === parentSessionId)
		) {
			setParentSessionId(sessions[0]!.id);
		}
	}, [parentSessionId, sessions]);

	async function load() {
		const [state, providerState, sessionState, localModelState, traceState] =
			await Promise.all([
				window.kestrel.request({
					type: "orchestration-list",
				}) as Promise<CoreResponse>,
				window.kestrel.request({
					type: "runtime-list-providers",
				}) as Promise<CoreResponse>,
				window.kestrel.request({
					type: "runtime-list-sessions",
				}) as Promise<CoreResponse>,
				window.kestrel.request({
					type: "local-model-status",
				}),
				window.kestrel.request({
					type: "orchestration-routing-traces",
				}) as Promise<CoreResponse>,
			]);
		if (!state.ok) throw new Error(state.error);
		setGoals(state.goals ?? []);
		setTeams(state.teams ?? []);
		setJobs(state.jobs ?? []);
		if (providerState.ok) {
			setProviders(providerState.providers ?? []);
			setProviderId((current) =>
				providerState.providers?.some((provider) => provider.id === current)
					? current
					: providerState.providers?.some((provider) => provider.id === "auto")
						? "auto"
						: providerState.providers?.[0]?.id || "",
			);
		}
		if (localModelState.ok && "localModels" in localModelState)
			setLocalModels(localModelState.localModels);
		if (traceState.ok) setRoutingTraces(traceState.routingTraces ?? []);
		if (sessionState.ok) onSessions(sessionState.sessions ?? []);
	}
	useEffect(() => {
		void load().catch((cause) =>
			setError(
				cause instanceof Error
					? cause.message
					: "Could not load orchestration state.",
			),
		);
	}, []);

	useEffect(() => {
		const timer = window.setInterval(() => {
			void window.kestrel
				.request({ type: "orchestration-routing-traces" })
				.then((raw) => {
					const response = raw as CoreResponse;
					if (response.ok) setRoutingTraces(response.routingTraces ?? []);
				});
		}, 4_000);
		return () => window.clearInterval(timer);
	}, []);

	useEffect(() => {
		if (providerId !== "ollama") return;
		setModel((current) =>
			localModels.some((item) => item.name === current)
				? current
				: (localModels[0]?.name ?? ""),
		);
	}, [providerId, localModels]);

	async function mutate(
		request: RendererRequest,
		after?: () => void,
	): Promise<boolean> {
		setBusy(true);
		setError("");
		try {
			const response = (await window.kestrel.request(request)) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			if (response.delegationRouting) {
				const route = response.delegationRouting;
				setDelegationEvidence(
					`${route.local ? "Local" : "Connected"} worker: ${route.model} via ${route.providerId} · ${route.reasoningEffort} reasoning · verified in ${route.verificationLatencyMs} ms`,
				);
			}
			after?.();
			await load();
			return true;
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Orchestration action failed.",
			);
			await load().catch(() => undefined);
			return false;
		} finally {
			setBusy(false);
		}
	}

	const routedTask =
		[...routingTraces]
			.reverse()
			.find((item) => item.status === "planned" || item.status === "running") ??
		routingTraces.at(-1);
	const routedProgress =
		routedTask?.status === "planned"
			? 12
			: routedTask?.status === "running"
				? 58
				: 100;

	return (
		<PageFrame
			eyebrow="Plan and track"
			title="Work"
			text="Coordinate goals, delegates, schedules, and handoffs while keeping routing and approval evidence visible."
			measure="wide"
		>
			{routedTask && (
				<section
					className={`orchestration-status status-${routedTask.status}`}
					aria-label="Current routed task"
				>
					<div>
						<small>Current task</small>
						<strong>{routedTask.summary}</strong>
						<span>
							{routedTask.decisions
								.map((decision) => decision.role)
								.join(" · ")}{" "}
							· {routedTask.status.replaceAll("_", " ")}
						</span>
					</div>
					<progress
						value={routedProgress}
						max="100"
						aria-label={`Approximate progress: ${routedProgress}%`}
					/>
					{(routedTask.escalationCount > 0 ||
						routedTask.status === "failed" ||
						routedTask.status === "cancelled") && (
						<p role={routedTask.status === "failed" ? "alert" : "status"}>
							{routedTask.status === "failed"
								? "The routed task failed. Open details to inspect the route."
								: routedTask.status === "cancelled"
									? "The routed task was cancelled."
									: `Kestrel escalated ${routedTask.escalationCount} time${routedTask.escalationCount === 1 ? "" : "s"} to protect result quality.`}
						</p>
					)}
					<details>
						<summary>Model and cost details</summary>
						{routedTask.decisions.map((decision) => (
							<div key={decision.id} className="orchestration-route-detail">
								<strong>{decision.role}</strong>
								<span>
									{decision.model} via {decision.providerId} ·{" "}
									{decision.reasoningLevel} reasoning · Fast{" "}
									{decision.fastMode ? "on" : "off"}
								</span>
								<small>
									{Math.round(decision.confidence * 100)}% routing confidence
									{decision.estimatedCost === undefined
										? ""
										: ` · about $${decision.estimatedCost.toFixed(3)}`}
								</small>
							</div>
						))}
					</details>
				</section>
			)}
			<header className="kanban-header work-board-tools">
				<div>
					<small>From the active session</small>
				</div>
				<button
					className="button secondary"
					disabled={busy || !parentSessionId}
					onClick={() =>
						void mutate({
							type: "orchestration-opportunity-to-goal",
							sessionId: parentSessionId,
						})
					}
				>
					Convert current opportunity
				</button>
			</header>
			<GoalKanban
				goals={goals}
				sessions={sessions}
				busy={busy}
				onCreateGoal={() => {
					createGoalFormRef.current?.scrollIntoView({
						behavior: "smooth",
						block: "nearest",
					});
					createGoalFormRef.current
						?.querySelector<HTMLInputElement>("input")
						?.focus();
				}}
				onTaskUpdate={({ goalId, taskId, taskStatus, assigneeSessionId }) =>
					mutate({
						type: "orchestration-goal-update",
						goalId,
						taskId,
						...(taskStatus ? { taskStatus } : {}),
						...(assigneeSessionId !== undefined ? { assigneeSessionId } : {}),
					})
				}
				onCompleteGoal={(goalId) =>
					mutate({
						type: "orchestration-goal-update",
						goalId,
						status: "completed",
					})
				}
			/>
			<section className="work-grid">
				<form
					className="work-card"
					onSubmit={(event) => {
						event.preventDefault();
						if (!parentSessionId || !providerId || !model.trim()) return;
						void mutate(
							{
								type: "orchestration-delegate",
								parentSessionId,
								title: delegateTitle,
								prompt: delegatePrompt,
								model: model.trim(),
								providerIds: [providerId],
								isolateWorktree,
							},
							() => {
								setDelegateTitle("");
								setDelegatePrompt("");
							},
						);
					}}
				>
				<h2>Delegate a task</h2>
				<p className="work-card-note">
					Kestrel picks a verified worker by capability, cost, privacy, and
					your routing preference.
				</p>
				<label>
					Parent task
						<select
							value={parentSessionId}
							onChange={(event) => {
								setParentSessionId(event.target.value);
								setTeamMembers([]);
							}}
						>
							{sessions.map((session) => (
								<option key={session.id} value={session.id}>
									{sessionTitleForDisplay(session.title)}
								</option>
							))}
						</select>
					</label>
					<label>
						Title
						<input
							value={delegateTitle}
							onChange={(event) => setDelegateTitle(event.target.value)}
						/>
					</label>
					<label>
						Prompt
						<textarea
							rows={3}
							value={delegatePrompt}
							onChange={(event) => setDelegatePrompt(event.target.value)}
						/>
					</label>
					<details className="work-routing-override">
						<summary>Override automatic routing</summary>
						<div className="work-inline">
							<select
								aria-label="Provider"
								value={providerId}
								onChange={(event) => setProviderId(event.target.value)}
							>
								{providers.map((provider) => (
									<option key={provider.id}>{provider.id}</option>
								))}
							</select>
							{providerId === "ollama" ? (
								<select
									aria-label="Installed Ollama model"
									value={model}
									onChange={(event) => setModel(event.target.value)}
									disabled={localModels.length === 0}
								>
									{localModels.length === 0 ? (
										<option value="">No installed Ollama models found</option>
									) : (
										localModels.map((localModel) => (
											<option value={localModel.name} key={localModel.name}>
												{localModel.name} · {compactBytes(localModel.size)}
											</option>
										))
									)}
								</select>
							) : (
								<input
									aria-label="Model"
									placeholder={
										providerId === "auto" ? "Automatically selected" : "Model"
									}
									value={model}
									onChange={(event) => setModel(event.target.value)}
									readOnly={providerId === "auto"}
								/>
							)}
						</div>
					</details>
					{delegationEvidence && (
						<small role="status">{delegationEvidence}</small>
					)}
					<label className="work-check">
						<input
							type="checkbox"
							checked={isolateWorktree}
							onChange={(event) => setIsolateWorktree(event.target.checked)}
						/>
						Create an isolated Git worktree
					</label>
					<button
						className="button primary"
						disabled={
							busy ||
							!delegateTitle.trim() ||
							!delegatePrompt.trim() ||
							!providerId ||
							!model.trim()
						}
					>
						Run delegate
					</button>
				</form>
				<form
					ref={createGoalFormRef}
					className="work-card"
					onSubmit={(event) => {
						event.preventDefault();
						if (!parentSessionId) return;
						void mutate(
							{
								type: "orchestration-goal-create",
								sessionId: parentSessionId,
								title: goalTitle,
								objective: goalObjective,
								tasks: goalObjective.split(/\n+/).filter(Boolean),
							},
							() => {
								setGoalTitle("");
								setGoalObjective("");
							},
						);
					}}
				>
					<h2>Create a goal</h2>
					<label>
						Title
						<input
							value={goalTitle}
							onChange={(event) => setGoalTitle(event.target.value)}
						/>
					</label>
					<label>
						Objective and task lines
						<textarea
							rows={5}
							value={goalObjective}
							onChange={(event) => setGoalObjective(event.target.value)}
						/>
					</label>
					<button
						className="button primary"
						disabled={busy || !goalTitle.trim() || !goalObjective.trim()}
					>
						Create goal
					</button>
				</form>
			</section>
			<section className="work-grid">
				<form
					className="work-card"
					onSubmit={(event) => {
						event.preventDefault();
						if (!parentSessionId || !providerId || !model.trim()) return;
						void mutate(
							{
								type: "orchestration-schedule",
								sessionId: parentSessionId,
								title: scheduleTitle,
								prompt: schedulePrompt,
								model: model.trim(),
								providerIds: [providerId],
								expression: scheduleExpression,
							},
							() => {
								setScheduleTitle("");
								setSchedulePrompt("");
								setScheduleExpression("");
							},
						);
					}}
				>
					<h2>Schedule background work</h2>
					<label>
						Title
						<input
							value={scheduleTitle}
							onChange={(event) => setScheduleTitle(event.target.value)}
						/>
					</label>
					<label>
						Prompt
						<textarea
							rows={3}
							value={schedulePrompt}
							onChange={(event) => setSchedulePrompt(event.target.value)}
						/>
					</label>
				<label>
					When
					<input
						value={scheduleExpression}
						onChange={(event) => setScheduleExpression(event.target.value)}
						placeholder="tomorrow at 9 am · every 30 minutes · */15 * * * *"
					/>
				</label>
				<small>
					Natural-language times are interpreted in UTC. Five-field cron is
					supported.
				</small>
				<button
					className="button primary"
					disabled={
						busy ||
						!scheduleTitle.trim() ||
						!schedulePrompt.trim() ||
						!scheduleExpression.trim() ||
						!providerId ||
						!model.trim()
					}
				>
					Schedule
				</button>
				</form>
				<article className="work-card">
					<h2>Automation boundary</h2>
					<p>
						Scheduled runs stay local and encrypted. Sensitive actions stop in
						the review queue for approval, and recurring work advances only
						after a completed run.
					</p>
				</article>
			</section>
			<section className="work-grid">
				<form
					className="work-card"
					onSubmit={(event) => {
						event.preventDefault();
						void mutate(
							{
								type: "orchestration-team-create",
								parentSessionId,
								title: teamTitle,
								memberSessionIds: teamMembers,
								sharedPlan: teamPlan.split(/\n+/).filter(Boolean),
							},
							() => {
								setTeamTitle("");
								setTeamPlan("");
								setTeamMembers([]);
							},
						);
					}}
				>
					<h2>Create a team</h2>
					<label>
						Title
						<input
							value={teamTitle}
							onChange={(event) => setTeamTitle(event.target.value)}
						/>
					</label>
					<fieldset>
						<legend>Child agents</legend>
						{children.map((child) => (
							<label className="work-check" key={child.id}>
								<input
									type="checkbox"
									checked={teamMembers.includes(child.id)}
									onChange={(event) =>
										setTeamMembers((current) =>
											event.target.checked
												? [...current, child.id]
												: current.filter((id) => id !== child.id),
										)
									}
								/>
								{sessionTitleForDisplay(child.title)}
							</label>
						))}
					</fieldset>
					<label>
						Shared plan
						<textarea
							rows={3}
							value={teamPlan}
							onChange={(event) => setTeamPlan(event.target.value)}
						/>
					</label>
					<button
						className="button primary"
						disabled={busy || !teamTitle.trim() || teamMembers.length === 0}
					>
						Create team
					</button>
				</form>
				<form
					className="work-card"
					onSubmit={(event) => {
						event.preventDefault();
						void mutate(
							{
								type: "orchestration-handoff",
								childSessionId: handoffChild,
								summary: handoffSummary,
							},
							() => {
								setHandoffSummary("");
							},
						);
					}}
				>
					<h2>Hand work back</h2>
					<label>
						Child agent
						<select
							value={handoffChild}
							onChange={(event) => setHandoffChild(event.target.value)}
						>
							<option value="">Choose child</option>
							{sessions
								.filter((session) => session.parentSessionId)
								.map((session) => (
									<option key={session.id} value={session.id}>
										{sessionTitleForDisplay(session.title)}
									</option>
								))}
						</select>
					</label>
					<label>
						Evidence-backed summary
						<textarea
							rows={5}
							value={handoffSummary}
							onChange={(event) => setHandoffSummary(event.target.value)}
						/>
					</label>
					<button
						className="button primary"
						disabled={busy || !handoffChild || !handoffSummary.trim()}
					>
						Send handoff
					</button>
				</form>
			</section>
			<section className="work-section">
				<h2>Teams</h2>
				{teams.map((team) => (
					<article className="work-row" key={team.id}>
						<div>
							<strong>{team.title}</strong>
							<p>{team.sharedPlan.join(" → ") || "No shared plan"}</p>
							<small>
								{team.memberSessionIds.length} members · {team.messages.length}{" "}
								peer messages · {team.usage?.runs ?? 0} runs ·{" "}
								{team.usage?.inputTokens ?? 0} in /{" "}
								{team.usage?.outputTokens ?? 0} out
							</small>
						</div>
						<span className="status">Active</span>
					</article>
				))}
			</section>
			<section className="work-section">
				<h2>Background review queue</h2>
				{jobs.length === 0 ? (
					<p>No scheduled jobs yet.</p>
				) : (
					jobs.map((job) => (
						<article className="work-row" key={job.id}>
							<div>
								<strong>{job.title}</strong>
								<p>
									{job.status} · next{" "}
									{new Date(job.schedule.nextRunAt).toLocaleString()}
								</p>
								{job.error && <small>{job.error}</small>}
							</div>
							<div className="button-row">
								{job.status === "waiting_approval" && (
									<button
										className="button primary"
										disabled={busy}
										onClick={() =>
											void mutate({
												type: "orchestration-job-resume",
												jobId: job.id,
											})
										}
									>
										Approve & resume
									</button>
								)}
								{job.status === "pending" && (
									<button
										className="button secondary"
										disabled={busy}
										onClick={() =>
											void mutate({
												type: "orchestration-job-cancel",
												jobId: job.id,
											})
										}
									>
										Cancel
									</button>
								)}
							</div>
						</article>
					))
				)}
			</section>
			{error && (
				<p className="connection-error" role="alert">
					{error}
				</p>
			)}
		</PageFrame>
	);
}

function Connections({ snapshot }: { snapshot: WorkspaceSnapshot }) {
	const [grants, setGrants] = useState<WorkspaceGrant[]>([]);
	const [channels, setChannels] = useState<ChannelSummary[]>([]);
	const [communicationSources, setCommunicationSources] = useState<
		CommunicationSourceStatus[]
	>([]);
	const [busy, setBusy] = useState(false);
	const [grantError, setGrantError] = useState("");
	const [googleStatus, setGoogleStatus] = useState<GoogleWorkspaceOAuthStatus>({
		connected: false,
		scopes: [],
		bundledClientAvailable: false,
	});
	const [googleClientId, setGoogleClientId] = useState("");
	const [googleBusy, setGoogleBusy] = useState(false);
	const [googleError, setGoogleError] = useState("");
	const [subscriptionClis, setSubscriptionClis] = useState<
		SubscriptionCliStatus[]
	>([]);
	const [chatGptBusy, setChatGptBusy] = useState(false);
	const [chatGptError, setChatGptError] = useState("");
	useEffect(() => {
		void window.kestrel
			.request({ type: "get-workspace-grants" })
			.then((response) => {
				if (response.ok && "workspaceGrants" in response)
					setGrants(response.workspaceGrants);
			});
		void window.kestrel.request({ type: "channel-list" }).then((response) => {
			if (response.ok && "channels" in response)
				setChannels(response.channels ?? []);
		});
		void window.kestrel
			.request({ type: "oauth-google-status" })
			.then((response) => {
				if (response.ok && "googleWorkspaceOAuth" in response)
					setGoogleStatus(response.googleWorkspaceOAuth);
			});
		void window.kestrel
			.request({ type: "communication-sources" })
			.then((response) => {
				if (response.ok && "communicationSources" in response)
					setCommunicationSources(response.communicationSources);
			});
		void window.kestrel
			.request({ type: "subscription-cli-status" })
			.then((response) => {
				if (response.ok && "subscriptionClis" in response)
					setSubscriptionClis(response.subscriptionClis);
			});
	}, []);
	async function refreshCommunicationSources() {
		const response = await window.kestrel.request({
			type: "communication-sources",
		});
		if (response.ok && "communicationSources" in response)
			setCommunicationSources(response.communicationSources);
	}
	const codexSubscription = subscriptionClis.find(
		(subscription) => subscription.id === "codex",
	);
	const messagesSource = communicationSources.find(
		(source) => source.id === "mac-messages",
	);
	const gmailSource = communicationSources.find((source) => source.id === "gmail");
	async function connectChatGpt() {
		if (chatGptBusy) {
			await window.kestrel.request({ type: "oauth-chatgpt-cancel" });
			return;
		}
		setChatGptBusy(true);
		setChatGptError("");
		try {
			const response = await window.kestrel.request({
				type: "oauth-chatgpt-connect",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "ChatGPT sign-in failed.",
				);
			if ("subscriptionClis" in response)
				setSubscriptionClis(response.subscriptionClis);
		} catch (error) {
			setChatGptError(
				error instanceof Error ? error.message : "ChatGPT sign-in failed.",
			);
		} finally {
			setChatGptBusy(false);
		}
	}
	async function toggleCodexRoute() {
		if (!codexSubscription) return;
		setChatGptBusy(true);
		setChatGptError("");
		try {
			const response = await window.kestrel.request({
				type: "subscription-cli-set",
				id: "codex",
				enabled: !codexSubscription.enabled,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "ChatGPT route update failed.",
				);
			if ("subscriptionClis" in response)
				setSubscriptionClis(response.subscriptionClis);
		} catch (error) {
			setChatGptError(
				error instanceof Error ? error.message : "ChatGPT route update failed.",
			);
		} finally {
			setChatGptBusy(false);
		}
	}
	async function connectGoogle() {
		setGoogleBusy(true);
		setGoogleError("");
		try {
			const trimmedClientId = googleClientId.trim();
			const response = await window.kestrel.request({
				type: "oauth-google-connect",
				...(trimmedClientId ? { clientId: trimmedClientId } : {}),
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Google sign-in failed.",
				);
			if ("googleWorkspaceOAuth" in response)
				setGoogleStatus(response.googleWorkspaceOAuth);
			await refreshCommunicationSources();
			setGoogleClientId("");
		} catch (error) {
			setGoogleError(
				error instanceof Error ? error.message : "Google sign-in failed.",
			);
		} finally {
			setGoogleBusy(false);
		}
	}
	async function cancelGoogle() {
		await window.kestrel.request({ type: "oauth-google-cancel" });
	}
	async function disconnectGoogle() {
		setGoogleBusy(true);
		setGoogleError("");
		try {
			const response = await window.kestrel.request({
				type: "oauth-google-disconnect",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Google disconnect failed.",
				);
			if ("googleWorkspaceOAuth" in response)
				setGoogleStatus(response.googleWorkspaceOAuth);
			await refreshCommunicationSources();
		} catch (error) {
			setGoogleError(
				error instanceof Error ? error.message : "Google disconnect failed.",
			);
		} finally {
			setGoogleBusy(false);
		}
	}
	async function addFolder() {
		setBusy(true);
		setGrantError("");
		try {
			const response = await window.kestrel.request({
				type: "select-workspace-folder",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Folder grant failed.",
				);
			if ("workspaceGrants" in response) setGrants(response.workspaceGrants);
		} catch (error) {
			setGrantError(
				error instanceof Error ? error.message : "Folder grant failed.",
			);
		} finally {
			setBusy(false);
		}
	}
	async function removeFolder(path: string) {
		setBusy(true);
		setGrantError("");
		try {
			const response = await window.kestrel.request({
				type: "remove-workspace-folder",
				path,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Folder removal failed.",
				);
			if ("workspaceGrants" in response) setGrants(response.workspaceGrants);
		} catch (error) {
			setGrantError(
				error instanceof Error ? error.message : "Folder removal failed.",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<section
			className="settings-panel"
			id="setting-agent-connections"
			aria-labelledby="settings-connections-title"
		>
			<header className="settings-panel-header">
				<h2 id="settings-connections-title">Accounts and access</h2>
				<p>
					Sign-ins stay with their providers. Project folders and external
					access remain explicit and revocable.
				</p>
			</header>
			<div className="connection-list">
				<article className="oauth-connection">
					<div className="connection-monogram">CG</div>
					<div>
						<strong>ChatGPT</strong>
						<p>
							{codexSubscription?.detail ??
								"Checking for the official Codex runtime on this Mac."}
						</p>
						<small>
							Codex owns the browser callback, credential storage, and token
							refresh. Kestrel receives account status only.
						</small>
					</div>
					<span
						className={`connection-status ${
							codexSubscription?.authenticated ? "connected" : "not_connected"
						}`}
					>
						{codexSubscription?.authenticated ? "connected" : "not connected"}
					</span>
					<div className="connection-actions">
						{!codexSubscription?.detected ? (
							<button className="button secondary" disabled>
								Codex not found
							</button>
						) : !codexSubscription.authenticated ? (
							<button
								className="button primary"
								onClick={() => void connectChatGpt()}
							>
								{chatGptBusy ? "Cancel sign-in" : "Sign in with ChatGPT"}
							</button>
						) : (
							<button
								className="button secondary"
								disabled={chatGptBusy}
								onClick={() => void toggleCodexRoute()}
							>
								{chatGptBusy
									? "Updating…"
									: codexSubscription.enabled
										? "Disable model route"
										: "Enable model route"}
							</button>
						)}
					</div>
				</article>
				<article className="oauth-connection">
					<div className="connection-monogram">GW</div>
					<div>
						<strong>Google Workspace</strong>
						<p>
							{googleStatus.connected
								? `${googleStatus.email} · Gmail, Calendar events and availability, and login-code lookup`
								: googleStatus.bundledClientAvailable
									? "Connect Gmail and Calendar with Kestrel's verified Google sign-in."
									: "Bring your own Google Desktop OAuth client. Kestrel requests Gmail send, read-only recent-message lookup, and Calendar event and availability access."}
						</p>
						{!googleStatus.connected && !googleStatus.bundledClientAvailable && (
							<>
								<label>
									Desktop OAuth client ID
									<input
										value={googleClientId}
										autoComplete="off"
										spellCheck={false}
										placeholder="…apps.googleusercontent.com"
										onChange={(event) => setGoogleClientId(event.target.value)}
									/>
								</label>
								<small>
									Create a Desktop app credential in{" "}
									<a
										href="https://console.cloud.google.com/apis/credentials"
										target="_blank"
										rel="noreferrer"
									>
										Google Cloud Console
									</a>
									, enable Gmail and Calendar APIs, then sign in in Google's
									browser.
								</small>
							</>
						)}
						{!googleStatus.connected && googleStatus.bundledClientAvailable && (
							<small>
								Kestrel uses its bundled Desktop OAuth client. Sign in in
								Google&apos;s browser; no Cloud Console setup is required.
							</small>
						)}
						{!googleStatus.connected && googleStatus.bundledClientAvailable && (
							<details className="connection-advanced">
								<summary>Use your own OAuth client instead</summary>
								<label>
									Desktop OAuth client ID
									<input
										value={googleClientId}
										autoComplete="off"
										spellCheck={false}
										placeholder="…apps.googleusercontent.com"
										onChange={(event) => setGoogleClientId(event.target.value)}
									/>
								</label>
							</details>
						)}
						{googleStatus.connected && gmailSource?.state === "needs_reconnect" && (
							<small role="status">
								This connection predates code lookup. Disconnect, then connect again
								to grant the new read-only Gmail permission.
							</small>
						)}
						{googleError && <small role="alert">{googleError}</small>}
					</div>
					<span
						className={`connection-status ${gmailSource?.state === "connected" ? "connected" : "not_connected"}`}
					>
						{gmailSource?.state === "needs_reconnect"
							? "reconnect for code lookup"
							: googleStatus.connected
								? "connected"
								: "not connected"}
					</span>
					<div className="connection-actions">
						{googleStatus.connected ? (
							<button
								className="button secondary"
								disabled={googleBusy}
								onClick={() => void disconnectGoogle()}
							>
								{googleBusy ? "Disconnecting…" : "Disconnect & revoke"}
							</button>
						) : googleBusy ? (
							<>
								<button
									className="button secondary"
									onClick={() => void cancelGoogle()}
								>
									Cancel sign-in
								</button>
								<small>Finish in your browser</small>
							</>
						) : (
							<button
								className="button secondary"
								disabled={
									!googleStatus.bundledClientAvailable &&
									!googleClientId.trim()
								}
								onClick={() => void connectGoogle()}
							>
								Connect with Google
							</button>
						)}
					</div>
				</article>
				<article className="oauth-connection communication-source-connection">
					<div className="connection-monogram">MS</div>
					<div>
						<strong>Messages on this Mac</strong>
						<p>
							{messagesSource?.detail ??
								"Checking whether Kestrel can read the local Messages database."}
						</p>
						<small>
							Read-only and on demand. Kestrel extracts a short code, never the
							message body, and never sends a message.
						</small>
					</div>
					<span
						className={`connection-status ${messagesSource?.state === "connected" ? "connected" : "not_connected"}`}
					>
						{messagesSource?.state === "connected"
							? "connected"
							: messagesSource?.state === "needs_permission"
								? "permission needed"
								: messagesSource?.state === "unavailable"
									? "unavailable"
									: "not connected"}
					</span>
					<div className="connection-actions">
						{messagesSource?.state === "needs_permission" ? (
							<button
								className="button secondary"
								onClick={() =>
									void window.kestrel.request({
										type: "communication-messages-open-settings",
									})
								}
							>
								Open System Settings
							</button>
						) : (
							<button
								className="button secondary"
								onClick={() => void refreshCommunicationSources()}
							>
								Check access
							</button>
						)}
					</div>
				</article>
				{channels.map((channel) => (
					<article key={`channel-${channel.id}`}>
						<div className="connection-monogram">
							{channel.kind.slice(0, 2).toUpperCase()}
						</div>
						<div>
							<strong>{channel.id}</strong>
							<p>
								{channel.kind} delivery ·{" "}
								{channel.inbound
									? "signed inbound routing enabled"
									: "outbound only"}{" "}
								· attachments follow workspace limits
							</p>
						</div>
						<span className="connection-status connected">connected</span>
						<span className="honest-status">Owner-configured</span>
					</article>
				))}
				{snapshot.connections
					.filter(
						(connection) =>
							(!googleStatus.connected ||
								!["gmail", "calendar"].includes(connection.id)) &&
							(connection.id === "files" ||
								connection.status === "development_adapter"),
					)
					.map((connection) => (
						<article key={connection.id}>
							<div className="connection-monogram">
								{connection.name.slice(0, 2).toUpperCase()}
							</div>
							<div>
								<strong>{connection.name}</strong>
								<p>{connection.detail}</p>
								{connection.id === "files" && grants.length > 0 && (
									<ul className="workspace-grants">
										{grants.map((grant) => (
											<li key={grant.path}>
												<span title={grant.path}>
													{grant.name}
													{grant.available === false ? " · unavailable" : ""}
												</span>
												<button
													className="quiet-link"
													disabled={busy}
													onClick={() => void removeFolder(grant.path)}
												>
													Remove
												</button>
											</li>
										))}
									</ul>
								)}
							</div>
							<span className={`connection-status ${connection.status}`}>
								{formatConnectionStatus(connection.status)}
							</span>
							{connection.id === "files" ? (
								<button
									className="button secondary"
									disabled={busy}
									onClick={() => void addFolder()}
								>
									{busy ? "Updating…" : "Add folder"}
								</button>
							) : (
								<span className="honest-status">
									Connect Google in Settings for live data
								</span>
							)}
						</article>
					))}
			</div>
			{(grantError || googleError || chatGptError) && (
				<p className="connection-error" role="alert">
					{grantError || googleError || chatGptError}
				</p>
			)}
		</section>
	);
}

function LearnedSkillsSettings({
	focusRequest,
}: {
	focusRequest?: SkillReviewRequest;
}) {
	const [proposals, setProposals] = useState<SkillLearningProposal[]>([]);
	const [feedbackCount, setFeedbackCount] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const proposalRefs = useRef(new Map<string, HTMLDetailsElement>());
	async function load() {
		const response = (await window.kestrel.request({
			type: "skill-learning-list",
		})) as CoreResponse;
		if (!response.ok) throw new Error(response.error);
		setProposals(response.skillProposals ?? []);
		setFeedbackCount(response.skillFeedback?.length ?? 0);
	}
	useEffect(() => {
		void load().catch((cause) =>
			setError(
				cause instanceof Error
					? cause.message
					: "Could not load learned skills.",
			),
		);
	}, []);
	useEffect(() => {
		if (!focusRequest) return;
		const proposal = proposals.find(
			(item) =>
				item.id === focusRequest.proposalId && item.status === "proposed",
		);
		const details = proposal
			? proposalRefs.current.get(proposal.id)
			: undefined;
		if (!details) return;
		details.open = true;
		const frame = window.requestAnimationFrame(() => {
			details.scrollIntoView({ block: "center" });
			details.querySelector<HTMLElement>("summary")?.focus();
		});
		return () => window.cancelAnimationFrame(frame);
	}, [focusRequest, proposals]);
	async function review(id: string, decision: "install" | "reject") {
		setBusy(true);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "skill-learning-review",
				id,
				decision,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Learned skill review failed.",
			);
		} finally {
			setBusy(false);
		}
	}
	const waiting = proposals.filter(
		(proposal) => proposal.status === "proposed",
	);
	const installed = proposals.filter(
		(proposal) => proposal.status === "installed",
	);
	return (
		<article className="setting-row learned-skills-setting">
			<div>
				<strong>Experience-to-skill learning</strong>
				<p>
					Proposals are credential-scanned and parsed in isolation. Nothing
					installs without your review.
				</p>
				<small>
					{installed.length} installed · {waiting.length} waiting ·{" "}
					{feedbackCount} outcome records
				</small>
				{error && <small role="alert">{error}</small>}
				{waiting.map((proposal) => (
					<details
						key={proposal.id}
						data-skill-proposal-id={proposal.id}
						ref={(node) => {
							if (node) proposalRefs.current.set(proposal.id, node);
							else proposalRefs.current.delete(proposal.id);
						}}
					>
						<summary title={proposal.name}>
							{learnedSkillDisplayName(proposal.name)} · review proposal
						</summary>
						<p>{proposal.description}</p>
						<pre>{proposal.instructions}</pre>
						<small>
							Sources · {proposal.sourceMessageIds.join(" · ")} ·{" "}
							{proposal.evaluation.checks.join(" · ")}
						</small>
						<div className="button-row">
							<button
								className="button primary"
								disabled={busy}
								onClick={() => void review(proposal.id, "install")}
							>
								Install learned skill
							</button>
							<button
								className="button secondary"
								disabled={busy}
								onClick={() => void review(proposal.id, "reject")}
							>
								Reject
							</button>
						</div>
					</details>
				))}
			</div>
			<span className="status">
				{waiting.length ? `${waiting.length} to review` : "Reviewed"}
			</span>
		</article>
	);
}

function CredentialSettings({
	hideCodexDuplicate = false,
}: {
	hideCodexDuplicate?: boolean;
}) {
	const [credentials, setCredentials] = useState<BrokeredCredentialSummary[]>(
		[],
	);
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	async function load() {
		const response = await window.kestrel.request({ type: "credential-list" });
		if (!response.ok)
			throw new Error(
				"error" in response ? response.error : "Credential status failed.",
			);
		if ("credentials" in response) setCredentials(response.credentials);
	}
	useEffect(() => {
		void load().catch((cause) =>
			setError(
				cause instanceof Error ? cause.message : "Credential status failed.",
			),
		);
	}, []);
	async function save(credentialId: BrokeredCredentialSummary["id"]) {
		const value = values[credentialId] ?? "";
		if (value.trim().length < 8) {
			setError("Enter the complete credential before saving.");
			return;
		}
		setBusy(credentialId);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "credential-set",
				credentialId,
				value,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Credential save failed.",
				);
			if ("credentials" in response) setCredentials(response.credentials);
			setValues((current) => ({ ...current, [credentialId]: "" }));
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Credential save failed.",
			);
		} finally {
			setBusy("");
		}
	}
	async function remove(credentialId: BrokeredCredentialSummary["id"]) {
		setBusy(credentialId);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "credential-remove",
				credentialId,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Credential removal failed.",
				);
			if ("credentials" in response) setCredentials(response.credentials);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Credential removal failed.",
			);
		} finally {
			setBusy("");
		}
	}
	return (
		<>
		<article className="setting-row credential-setting">
			<div>
				<strong>Protected provider credentials</strong>
				<p>
					Encrypted with macOS secure storage, sent only to the isolated core,
					and never displayed again.
				</p>
				<div className="credential-list">
						{credentials.map((credential) => (
							<div className="credential-entry" key={credential.id}>
								<label>
									<span>
										{credential.label} ·{" "}
										<span
											className={`connection-status ${credential.configured ? "connected" : "not_connected"}`}
										>
											{credential.configured
												? "configured"
												: "not configured"}
										</span>
									</span>
									<input
										type="password"
										autoComplete="off"
										spellCheck={false}
										value={values[credential.id] ?? ""}
										placeholder={
											credential.configured
												? "Enter replacement"
												: "Enter credential"
										}
										onChange={(event) =>
											setValues((current) => ({
												...current,
												[credential.id]: event.target.value,
											}))
										}
									/>
								</label>
								<button
									className="button secondary"
									disabled={Boolean(busy)}
									onClick={() => void save(credential.id)}
								>
									{credential.configured ? "Replace" : "Save"}
								</button>
								{credential.configured && (
									<button
										className="quiet-link"
										disabled={Boolean(busy)}
										onClick={() => void remove(credential.id)}
									>
										Remove
									</button>
								)}
							</div>
						))}
					</div>
					{error && <small role="alert">{error}</small>}
				</div>
				<span className="status">
					{credentials.filter((credential) => credential.configured).length}{" "}
					protected
				</span>
			</article>
			<ExternalSecretSettings />
			<SubscriptionCliSettings hideCodexDuplicate={hideCodexDuplicate} />
		</>
	);
}

function SubscriptionCliSettings({
	hideCodexDuplicate = false,
}: {
	hideCodexDuplicate?: boolean;
}) {
	const [items, setItems] = useState<SubscriptionCliStatus[]>([]);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	async function load() {
		const response = await window.kestrel.request({
			type: "subscription-cli-status",
		});
		if (!response.ok)
			throw new Error(
				"error" in response ? response.error : "Subscription CLI check failed.",
			);
		if ("subscriptionClis" in response) setItems(response.subscriptionClis);
	}
	useEffect(() => {
		void load().catch((cause) =>
			setError(
				cause instanceof Error
					? cause.message
					: "Subscription CLI check failed.",
			),
		);
	}, []);
	async function toggle(item: SubscriptionCliStatus) {
		setBusy(item.id);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "subscription-cli-set",
				id: item.id,
				enabled: !item.enabled,
			});
			if (!response.ok)
				throw new Error(
					"error" in response
						? response.error
						: "Subscription route update failed.",
				);
			if ("subscriptionClis" in response) setItems(response.subscriptionClis);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Subscription route update failed.",
			);
		} finally {
			setBusy("");
		}
	}
	async function connectChatGpt() {
		if (busy === "chatgpt-oauth") {
			await window.kestrel.request({ type: "oauth-chatgpt-cancel" });
			return;
		}
		setBusy("chatgpt-oauth");
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "oauth-chatgpt-connect",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "ChatGPT sign-in failed.",
				);
			if ("subscriptionClis" in response) setItems(response.subscriptionClis);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "ChatGPT sign-in failed.",
			);
		} finally {
			setBusy("");
		}
	}
	return (
		<article className="setting-row subscription-setting">
			<div>
				<strong>Existing vendor subscriptions</strong>
				<p>
					Use the Codex, Claude Code, or OpenCode sign-in already on this
					Mac. Kestrel never copies vendor OAuth tokens.
				</p>
				<ul className="subscription-setting-list">
					{items
						.filter(
							(item) => !(hideCodexDuplicate && item.id === "codex"),
						)
						.map((item) => (
						<li key={item.id}>
							<span>
								<strong>{item.label}</strong>
								<small>{item.detail}</small>
							</span>
							{item.id === "codex" && item.detected && !item.authenticated ? (
								<button
									className="button primary"
									disabled={Boolean(busy) && busy !== "chatgpt-oauth"}
									onClick={() => void connectChatGpt()}
								>
									{busy === "chatgpt-oauth"
										? "Cancel sign-in"
										: "Sign in with ChatGPT"}
								</button>
							) : (
								<button
									className="button secondary"
									disabled={Boolean(busy) || !item.detected}
									onClick={() => void toggle(item)}
								>
									{busy === item.id
										? "Updating…"
										: !item.detected
											? "Not found"
											: item.enabled
												? "Disable"
												: "Enable"}
								</button>
							)}
						</li>
					))}
				</ul>
				{error && <small role="alert">{error}</small>}
			</div>
			<span className="status">
				{items.filter((item) => item.enabled).length} enabled
			</span>
		</article>
	);
}

function ProviderVerificationSettings() {
	const [providers, setProviders] = useState<ModelProviderSummary[]>([]);
	const [results, setResults] = useState<
		Record<string, ProviderVerification[]>
	>({});
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	useEffect(() => {
		void window.kestrel
			.request({ type: "runtime-list-providers" })
			.then((raw) => {
				const response = raw as CoreResponse;
				if (response.ok)
					setProviders(
						(response.providers ?? []).filter(
							(provider) => provider.id !== "auto",
						),
					);
				else setError(response.error);
			});
	}, []);
	async function verify(providerId: string) {
		setBusy(providerId);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-verify-provider",
				providerId,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			setResults((current) => ({
				...current,
				[providerId]: response.providerVerifications ?? [],
			}));
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Provider verification failed.",
			);
		} finally {
			setBusy("");
		}
	}
	return (
		<article className="setting-row">
			<div>
				<strong>Live provider verification</strong>
				<p>
					Probe configured accounts from the isolated core — no credentials
					exposed, no model prompt sent.
				</p>
				{providers.length === 0 ? (
					<small>No model providers are configured.</small>
				) : (
					<ul className="workspace-grants">
						{providers.map((provider) => {
							const checks = results[provider.id];
							const valid = checks?.every((check) => check.ok);
							return (
								<li key={provider.id}>
									<span>
										{provider.id} ·{" "}
										{checks
											? valid
												? `${checks.length} credential${checks.length === 1 ? "" : "s"} verified`
												: checks
														.map((check) =>
															check.ok
																? `${check.providerId} verified`
																: `${check.providerId} failed`,
														)
														.join(" · ")
											: "not verified this session"}
									</span>
									<button
										className="quiet-link"
										disabled={Boolean(busy)}
										onClick={() => void verify(provider.id)}
									>
										{busy === provider.id ? "Checking…" : "Verify"}
									</button>
								</li>
							);
						})}
					</ul>
				)}
				{error && <small role="alert">{error}</small>}
			</div>
			<span className="status">Live check</span>
		</article>
	);
}

function migrationReviewLabel(
	kind: MigrationPlanPreviewContract["reviewItems"][number]["kind"],
) {
	switch (kind) {
		case "automation":
			return "automation";
		case "channel-binding":
			return "channel binding";
		case "acp-binding":
			return "ACP binding";
		case "plugin":
			return "plugin decision";
		case "plugin-load-path":
			return "plugin load path";
	}
}

function MigrationSettings() {
	const [product, setProduct] = useState<
		"openclaw" | "hermes" | "codex" | "claude-code"
	>("codex");
	const [plan, setPlan] = useState<MigrationPlanPreviewContract | null>(null);
	const [planId, setPlanId] = useState<string | null>(null);
	const [result, setResult] = useState<MigrationResultContract | null>(null);
	const [confirmation, setConfirmation] = useState("");
	const [overwrite, setOverwrite] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function inspect() {
		setBusy(true);
		setError("");
		setResult(null);
		setPlan(null);
		setPlanId(null);
		setConfirmation("");
		try {
			const response = await window.kestrel.request({
				type: "migration-select-plan",
				product,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Migration inspection failed.",
				);
			if ("migrationPlan" in response && !response.cancelled) {
				setPlan(response.migrationPlan);
				setPlanId(response.migrationPlanId ?? null);
			}
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Migration inspection failed.",
			);
		} finally {
			setBusy(false);
		}
	}
	async function apply() {
		if (!plan || !planId || confirmation !== "IMPORT") return;
		setBusy(true);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "migration-apply-plan",
				planId,
				confirmation: "IMPORT",
				overwrite,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Migration failed.",
				);
			if ("migrationResult" in response) setResult(response.migrationResult);
			setPlan(null);
			setPlanId(null);
			setConfirmation("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Migration failed.");
		} finally {
			setBusy(false);
		}
	}
	return (
		<article className="setting-row">
			<div>
				<strong>Reference-product migration</strong>
				<p>
					Dry-run an import from OpenClaw, Hermes, Codex, or Claude Code.
					Source files stay untouched; settings become checksum-checked,
					non-secret translations.
				</p>
				<div className="button-row">
					<select
						value={product}
						onChange={(event) =>
							setProduct(event.target.value as typeof product)
						}
					>
						<option value="openclaw">OpenClaw</option>
						<option value="hermes">Hermes</option>
						<option value="codex">Codex</option>
						<option value="claude-code">Claude Code</option>
					</select>
					<button
						className="button secondary"
						disabled={busy}
						onClick={() => void inspect()}
					>
						Choose folders and inspect
					</button>
				</div>
				{plan && (
					<details open>
						<summary>
							{plan.items.length} transferable source files ·{" "}
							{plan.translatedSettings} sanitized settings ·{" "}
							{plan.items.filter((item) => item.status === "conflict").length}{" "}
							conflicts
						</summary>
						<small>Destination · {plan.targetRoot}</small>
						<ul className="workspace-grants">
							{plan.items.slice(0, 12).map((item) => (
								<li key={`${item.category}:${item.sourcePath}`}>
									<span>
										{item.category} · {item.sourcePath}
									</span>
									<span>{item.status}</span>
								</li>
							))}
						</ul>
						{plan.reviewItems.length > 0 && (
							<>
								<strong>Manual review required</strong>
								<ul className="workspace-grants">
									{plan.reviewItems.map((item) => (
										<li key={`${item.sourcePath}:${item.kind}`}>
											<span>
												{item.count} {migrationReviewLabel(item.kind)}
												{item.count === 1 ? "" : "s"} · {item.sourcePath}
											</span>
											<span>{item.status}</span>
										</li>
									))}
								</ul>
								<small>
									Schedules, bindings, plugins, and plugin paths are never copied.
									Recreate only the ones you want through Kestrel's own approvals
									and protected credential fields.
								</small>
							</>
						)}
						{plan.warnings.map((warning) => (
							<small key={warning}>{warning}</small>
						))}
						<label className="checkbox-label">
							<input
								type="checkbox"
								checked={overwrite}
								onChange={(event) => setOverwrite(event.target.checked)}
							/>
							Overwrite conflicts after checksum verification
						</label>
						<label>
							Type IMPORT to approve
							<input
								value={confirmation}
								onChange={(event) => setConfirmation(event.target.value)}
							/>
						</label>
						<button
							className="button primary"
							disabled={
								busy ||
								confirmation !== "IMPORT" ||
								!planId ||
								plan.items.length + plan.translatedSettings === 0
							}
							onClick={() => void apply()}
						>
							Apply verified import
						</button>
					</details>
				)}
				{result && (
					<small role="status">
						Imported {result.imported.length}; skipped {result.skipped.length}.
					</small>
				)}
				{error && <small role="alert">{error}</small>}
			</div>
			<span className="status">Dry-run first</span>
		</article>
	);
}

function EnterpriseSettings() {
	const [policy, setPolicy] = useState<{
		organizationId: string;
		version: number;
		maximumWorkers: number;
		retentionDays?: number | undefined;
		analyticsEnabled?: boolean | undefined;
		ssoConfigured: boolean;
		updatedAt: string;
	} | null>(null);
	const [analytics, setAnalytics] = useState<EnterpriseAnalytics | null>(null);
	const [members, setMembers] = useState<OrganizationMemberContract[]>([]);
	const [email, setEmail] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [role, setRole] = useState<"member" | "admin">("member");
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	async function load() {
		const response = (await window.kestrel.request({
			type: "enterprise-summary",
		})) as CoreResponse;
		if (!response.ok) throw new Error(response.error);
		setPolicy(response.enterprisePolicy ?? null);
		setAnalytics(response.enterpriseAnalytics ?? null);
		setMembers(response.organizationMembers ?? []);
	}
	useEffect(() => {
		void load().catch((cause) =>
			setError(
				cause instanceof Error ? cause.message : "Enterprise summary failed.",
			),
		);
	}, []);
	async function retention() {
		setBusy(true);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "enterprise-enforce-retention",
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			setNotice(
				`Retention enforced through ${response.retentionResult?.cutoff ?? "the configured cutoff"}.`,
			);
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Retention failed.");
		} finally {
			setBusy(false);
		}
	}
	async function provision() {
		if (!email || !displayName) return;
		setBusy(true);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "enterprise-member-upsert",
				member: { externalId: email.toLowerCase(), email, displayName, role },
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			setEmail("");
			setDisplayName("");
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Member provisioning failed.",
			);
		} finally {
			setBusy(false);
		}
	}
	if (!policy)
		return (
			<article className="setting-row">
				<div>
					<strong>Organization controls</strong>
					<p>
						No signed managed policy is loaded. Configure an owner-only policy
						envelope and public key in the launch environment to enable SSO,
						member provisioning, analytics, and retention.
					</p>
					{error && <small role="alert">{error}</small>}
				</div>
				<span className="status">Unmanaged</span>
			</article>
		);
	return (
		<article className="setting-row">
			<div>
				<strong>{policy.organizationId} organization controls</strong>
				<p>
					Signed policy v{policy.version} · {policy.maximumWorkers} workers ·{" "}
					{policy.ssoConfigured ? "SSO configured" : "SSO not configured"} ·
					retention{" "}
					{policy.retentionDays
						? `${policy.retentionDays} days`
						: "not configured"}
				</p>
				{analytics && (
					<small>
						{analytics.sessions} tasks · {analytics.runs} runs ·{" "}
						{analytics.modelCalls} model calls · $
						{analytics.estimatedCostUsd.toFixed(4)} estimated spend · no prompt
						content collected
					</small>
				)}
				<div className="custom-agent-grid">
					<label>
						Member email
						<input
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</label>
					<label>
						Display name
						<input
							value={displayName}
							onChange={(event) => setDisplayName(event.target.value)}
						/>
					</label>
					<label>
						Role
						<select
							value={role}
							onChange={(event) => setRole(event.target.value as typeof role)}
						>
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</select>
					</label>
				</div>
				<div className="button-row">
					<button
						className="button secondary"
						disabled={busy || !email || !displayName}
						onClick={() => void provision()}
					>
						Provision member
					</button>
					<button
						className="button secondary"
						disabled={busy || !policy.retentionDays}
						onClick={() => void retention()}
					>
						Enforce retention now
					</button>
				</div>
				<ul className="workspace-grants">
					{members.map((member) => (
						<li key={member.externalId}>
							<span>
								{member.displayName} · {member.email} · {member.role}
							</span>
							<span>{member.active ? "active" : "inactive"}</span>
						</li>
					))}
				</ul>
				{notice && <small role="status">{notice}</small>}
				{error && <small role="alert">{error}</small>}
			</div>
			<span className="status">Managed</span>
		</article>
	);
}

function CustomAgentsSettings({
	snapshot,
	update,
}: {
	snapshot: WorkspaceSnapshot;
	update(next: WorkspaceSnapshot): void;
}) {
	const [id, setId] = useState("");
	const [name, setName] = useState("");
	const [instructions, setInstructions] = useState("");
	const [model, setModel] = useState("");
	const [providers, setProviders] = useState("");
	const [tools, setTools] = useState("");
	const [isolated, setIsolated] = useState(false);
	const [error, setError] = useState("");
	const custom = snapshot.personality.available.filter(
		(personality) => !personality.builtin,
	);
	async function create() {
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "create-personality",
				personality: {
					id,
					name,
					description: `${name} custom agent`,
					instructions,
					memoryScope: isolated ? "isolated" : "shared",
					...(model.trim() ? { preferredModel: model.trim() } : {}),
					...(providers.trim()
						? {
								providerIds: providers
									.split(",")
									.map((value) => value.trim())
									.filter(Boolean),
							}
						: {}),
					...(tools.trim()
						? {
								toolNames: tools
									.split(",")
									.map((value) => value.trim())
									.filter(Boolean),
							}
						: {}),
				},
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			if (response.snapshot) update(response.snapshot);
			setId("");
			setName("");
			setInstructions("");
			setModel("");
			setProviders("");
			setTools("");
			setIsolated(false);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Custom agent creation failed.",
			);
		}
	}
	async function remove(personalityId: string) {
		const response = (await window.kestrel.request({
			type: "remove-personality",
			personalityId,
		})) as CoreResponse;
		if (response.ok && response.snapshot) update(response.snapshot);
		else if (!response.ok) setError(response.error);
	}
	return (
		<article className="setting-row custom-agent-setting">
			<div>
				<strong>Custom agents</strong>
				<p>
					Encrypted profiles with a fixed route, least-privilege tools, and
					optional isolation from shared memory.
				</p>
				<div className="custom-agent-grid">
					<label>
						Agent ID
						<input
							value={id}
							placeholder="release-reviewer"
							onChange={(event) => setId(event.target.value)}
						/>
					</label>
					<label>
						Name
						<input
							value={name}
							placeholder="Release reviewer"
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<label>
						Preferred model
						<input
							value={model}
							placeholder="optional"
							onChange={(event) => setModel(event.target.value)}
						/>
					</label>
					<label>
						Provider IDs
						<input
							value={providers}
							placeholder="comma separated"
							onChange={(event) => setProviders(event.target.value)}
						/>
					</label>
					<label>
						Allowed tools
						<input
							value={tools}
							placeholder="workspace.read, git.diff"
							onChange={(event) => setTools(event.target.value)}
						/>
					</label>
					<label>
						Instructions
						<textarea
							value={instructions}
							placeholder="Review changes and cite exact evidence."
							onChange={(event) => setInstructions(event.target.value)}
						/>
					</label>
					<label className="checkbox-label">
						<input
							type="checkbox"
							checked={isolated}
							onChange={(event) => setIsolated(event.target.checked)}
						/>{" "}
						Isolate from shared user memory
					</label>
				</div>
				{custom.length > 0 && (
					<ul className="workspace-grants">
						{custom.map((personality) => (
							<li key={personality.id}>
								<span>
									{personality.name} · {personality.memoryScope} memory ·{" "}
									{personality.toolNames?.length ?? "all"} tools
								</span>
								<button
									className="quiet-link"
									onClick={() => void remove(personality.id)}
								>
									Remove
								</button>
							</li>
						))}
					</ul>
				)}
				{error && <small role="alert">{error}</small>}
			</div>
			<button
				className="button secondary"
				disabled={!id || !name || !instructions}
				onClick={() => void create()}
			>
				Create agent
			</button>
		</article>
	);
}

const routingModeOptions: ReadonlyArray<{
	id: RoutingPolicy["mode"];
	label: string;
	description: string;
	icon: string;
}> = [
	{
		id: "balanced",
		label: "Balanced",
		description: "Strong results without unnecessary premium-model use.",
		icon: "models",
	},
	{
		id: "fastest",
		label: "Fastest",
		description: "Prefer responsive endpoints when quality remains adequate.",
		icon: "reload",
	},
	{
		id: "cheapest",
		label: "Cheapest",
		description: "Use the lowest-cost model expected to pass validation.",
		icon: "free",
	},
	{
		id: "best_quality",
		label: "Best quality",
		description: "Favor capability and reliability over cost and latency.",
		icon: "ready",
	},
	{
		id: "local_first",
		label: "Local first",
		description: "Start on this Mac, then use cloud models only when needed.",
		icon: "local",
	},
	{
		id: "privacy_first",
		label: "Privacy first",
		description: "Keep model work on configured local endpoints.",
		icon: "safety",
	},
];

function RoutingPolicySettings() {
	const [policy, setPolicy] = useState<RoutingPolicy | null>(null);
	const [profiles, setProfiles] = useState<ModelProfile[]>([]);
	const [traces, setTraces] = useState<RoutingTrace[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function load() {
		const [policyRaw, profilesRaw, tracesRaw] = await Promise.all([
			window.kestrel.request({ type: "orchestration-routing-policy-get" }),
			window.kestrel.request({ type: "orchestration-model-registry" }),
			window.kestrel.request({ type: "orchestration-routing-traces" }),
		]);
		const policyResponse = policyRaw as CoreResponse;
		const profilesResponse = profilesRaw as CoreResponse;
		const tracesResponse = tracesRaw as CoreResponse;
		if (!policyResponse.ok) throw new Error(policyResponse.error);
		if (!profilesResponse.ok) throw new Error(profilesResponse.error);
		if (!tracesResponse.ok) throw new Error(tracesResponse.error);
		setPolicy(policyResponse.routingPolicy ?? null);
		setProfiles(profilesResponse.modelProfiles ?? []);
		setTraces(tracesResponse.routingTraces ?? []);
	}

	useEffect(() => {
		void load().catch((cause) =>
			setError(
				cause instanceof Error
					? cause.message
					: "Routing policy could not be loaded.",
			),
		);
	}, []);

	async function save(next: RoutingPolicy) {
		setBusy(true);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "orchestration-routing-policy-set",
				policy: next,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			setPolicy(response.routingPolicy ?? next);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Routing policy could not be saved.",
			);
		} finally {
			setBusy(false);
		}
	}

	if (!policy)
		return (
			<article className="setting-row">
				<div>
					<strong>How Kestrel chooses models</strong>
					<p>Loading the encrypted routing policy…</p>
					{error && <small role="alert">{error}</small>}
				</div>
			</article>
		);

	const latest = traces.at(-1);
	return (
		<article className="setting-row routing-policy-setting">
			<div>
				<strong>How Kestrel chooses models</strong>
				<p>
					Choose an outcome. Kestrel still selects the model, provider,
					reasoning, and review for each task.
				</p>
				<div
					className="routing-mode-grid"
					role="radiogroup"
					aria-label="Model routing preference"
				>
					{routingModeOptions.map((option) => (
						<button
							key={option.id}
							type="button"
							role="radio"
							aria-checked={policy.mode === option.id}
							className={policy.mode === option.id ? "selected" : ""}
							disabled={busy}
							onClick={() =>
								void save({
									...policy,
									mode: option.id,
									preferLocal:
										option.id === "local_first" ||
										option.id === "privacy_first",
									allowExternal: option.id !== "privacy_first",
								})
							}
						>
							<span className="routing-mode-icon" aria-hidden="true">
								<Icon name={option.icon} />
							</span>
							<strong>{option.label}</strong>
							<span>{option.description}</span>
						</button>
					))}
				</div>
				<small className="routing-registry-summary">
					{profiles.length} configured model endpoint
					{profiles.length === 1 ? "" : "s"} ·{" "}
					{profiles.filter((profile) => profile.local).length} local · learning
					from{" "}
					{profiles.reduce((sum, profile) => sum + profile.observations, 0)}{" "}
					observed outcome
					{profiles.reduce((sum, profile) => sum + profile.observations, 0) ===
					1
						? ""
						: "s"}
				</small>
				<details className="routing-advanced">
					<summary>Advanced routing and latest trace</summary>
					<div className="routing-advanced-grid">
						<label>
							Maximum parallel agents
							<input
								type="number"
								min="1"
								max="64"
								value={policy.maximumParallelism}
								onChange={(event) =>
									setPolicy({
										...policy,
										maximumParallelism: Number(event.target.value),
									})
								}
							/>
						</label>
						<label>
							Fallback attempts
							<input
								type="number"
								min="0"
								max="8"
								value={policy.maximumRetries}
								onChange={(event) =>
									setPolicy({
										...policy,
										maximumRetries: Number(event.target.value),
									})
								}
							/>
						</label>
						<label>
							Delegation depth
							<input
								type="number"
								min="0"
								max="8"
								value={policy.maximumDelegationDepth}
								onChange={(event) =>
									setPolicy({
										...policy,
										maximumDelegationDepth: Number(event.target.value),
									})
								}
							/>
						</label>
						<label>
							Task time limit, minutes
							<input
								type="number"
								min="1"
								max="1440"
								value={Math.round(policy.maximumTaskDurationMs / 60_000)}
								onChange={(event) =>
									setPolicy({
										...policy,
										maximumTaskDurationMs: Number(event.target.value) * 60_000,
									})
								}
							/>
						</label>
					</div>
					<button
						className="button secondary"
						type="button"
						disabled={busy}
						onClick={() => void save(policy)}
					>
						{busy ? "Saving…" : "Save advanced limits"}
					</button>
					{latest ? (
						<div className="routing-trace-summary">
							<strong>{latest.summary}</strong>
							<span>
								{latest.status.replaceAll("_", " ")} ·{" "}
								{latest.decisions.map((decision) => decision.role).join(", ")}
							</span>
							<small>
								{latest.decisions[0]?.model} via{" "}
								{latest.decisions[0]?.providerId} · about $
								{latest.estimatedCostUsd.toFixed(3)}
								{latest.escalationCount
									? ` · ${latest.escalationCount} escalation${latest.escalationCount === 1 ? "" : "s"}`
									: ""}
							</small>
						</div>
					) : (
						<small>No routed task trace yet.</small>
					)}
				</details>
				{error && <small role="alert">{error}</small>}
			</div>
		</article>
	);
}

function UsagePolicySettings() {
	const [policy, setPolicy] = useState<UsagePolicy | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		void window.kestrel
			.request({ type: "runtime-get-usage-policy" })
			.then((raw) => {
				const response = raw as CoreResponse;
				if (response.ok) setPolicy(response.usagePolicy ?? null);
				else setError(response.error);
			});
	}, []);
	if (!policy)
		return (
			<article className="setting-row">
				<div>
					<strong>Usage and cost guardrails</strong>
					<p>Loading encrypted budget policy…</p>
					{error && <small role="alert">{error}</small>}
				</div>
			</article>
		);
	const updateNumber = (
		field:
			| "dailyBudgetUsd"
			| "monthlyBudgetUsd"
			| "perCallReservationUsd"
			| "maximumConcurrentCalls",
		value: string,
	) => setPolicy({ ...policy, [field]: Number(value) });
	const updateRate = (field: keyof UsagePolicy["defaultRate"], value: string) =>
		setPolicy({
			...policy,
			defaultRate: { ...policy.defaultRate, [field]: Number(value) },
		});
	async function save() {
		if (!policy) return;
		setBusy(true);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-set-usage-policy",
				policy,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			setPolicy(response.usagePolicy ?? policy);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Usage policy save failed.",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<article className="setting-row usage-policy-setting">
			<div>
				<strong>Usage and cost guardrails</strong>
				<p>
					Budgets and concurrency are enforced before every provider call.
					Rates are estimates per million tokens.
				</p>
				<div className="usage-policy-grid">
					<label>
						Daily budget, USD
						<input
							type="number"
							min="0.01"
							step="0.01"
							value={policy.dailyBudgetUsd}
							onChange={(event) =>
								updateNumber("dailyBudgetUsd", event.target.value)
							}
						/>
					</label>
					<label>
						Monthly budget, USD
						<input
							type="number"
							min="0.01"
							step="0.01"
							value={policy.monthlyBudgetUsd}
							onChange={(event) =>
								updateNumber("monthlyBudgetUsd", event.target.value)
							}
						/>
					</label>
					<label>
						Per-call reserve, USD
						<input
							type="number"
							min="0.01"
							step="0.01"
							value={policy.perCallReservationUsd}
							onChange={(event) =>
								updateNumber("perCallReservationUsd", event.target.value)
							}
						/>
					</label>
					<label>
						Concurrent calls
						<input
							type="number"
							min="1"
							max="64"
							step="1"
							value={policy.maximumConcurrentCalls}
							onChange={(event) =>
								updateNumber("maximumConcurrentCalls", event.target.value)
							}
						/>
					</label>
					<label>
						Input / 1M
						<input
							type="number"
							min="0"
							step="0.01"
							value={policy.defaultRate.inputPerMillionUsd}
							onChange={(event) =>
								updateRate("inputPerMillionUsd", event.target.value)
							}
						/>
					</label>
					<label>
						Output / 1M
						<input
							type="number"
							min="0"
							step="0.01"
							value={policy.defaultRate.outputPerMillionUsd}
							onChange={(event) =>
								updateRate("outputPerMillionUsd", event.target.value)
							}
						/>
					</label>
					<label>
						Cached input / 1M
						<input
							type="number"
							min="0"
							step="0.01"
							value={policy.defaultRate.cachedInputPerMillionUsd}
							onChange={(event) =>
								updateRate("cachedInputPerMillionUsd", event.target.value)
							}
						/>
					</label>
					<label>
						Reasoning / 1M
						<input
							type="number"
							min="0"
							step="0.01"
							value={policy.defaultRate.reasoningPerMillionUsd}
							onChange={(event) =>
								updateRate("reasoningPerMillionUsd", event.target.value)
							}
						/>
					</label>
				</div>
				{error && <small role="alert">{error}</small>}
			</div>
			<button
				className="button secondary"
				disabled={busy}
				onClick={() => void save()}
			>
				{busy ? "Saving…" : "Save guardrails"}
			</button>
		</article>
	);
}

function ApprovalRulesSettings() {
	const [rules, setRules] = useState<ApprovalRule[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	async function load() {
		const response = (await window.kestrel.request({
			type: "runtime-list-approval-rules",
		})) as CoreResponse;
		if (!response.ok) throw new Error(response.error);
		setRules(response.approvalRules ?? []);
	}
	useEffect(() => {
		void load().catch((cause) =>
			setError(
				cause instanceof Error
					? cause.message
					: "Could not load approval rules.",
			),
		);
	}, []);
	async function remove(id: string) {
		setBusy(true);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type: "runtime-remove-approval-rule",
				id,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not remove approval rule.",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<article className="setting-row">
			<div>
				<strong>Persistent tool approval rules</strong>
				<p>
					Rules from approval boundaries are encrypted, session-scoped by
					default, and revocable here.
				</p>
				{rules.length === 0 ? (
					<small>No persistent tool rules.</small>
				) : (
					<ul className="workspace-grants">
						{rules.map((rule) => (
							<li key={rule.id}>
								<span>
									{rule.decision} · {rule.toolName} · {rule.scope}
									{rule.sessionId ? ` ${rule.sessionId.slice(-8)}` : ""}
								</span>
								<button
									className="quiet-link"
									disabled={busy}
									onClick={() => void remove(rule.id)}
								>
									Remove
								</button>
							</li>
						))}
					</ul>
				)}
				{error && <small role="alert">{error}</small>}
			</div>
			<span className="status">{rules.length} rules</span>
		</article>
	);
}

function AgentWorkspaceSettings() {
	const [grants, setGrants] = useState<WorkspaceGrant[]>([]);
	const [sessions, setSessions] = useState<RuntimeSession[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const load = useCallback(async () => {
		const [grantResponse, sessionResponse] = await Promise.all([
			window.kestrel.request({ type: "get-workspace-grants" }),
			window.kestrel.request({ type: "runtime-list-sessions" }),
		]);
		if (!grantResponse.ok)
			throw new Error(
				"error" in grantResponse
					? grantResponse.error
					: "Workspace access could not be loaded.",
			);
		if (!sessionResponse.ok)
			throw new Error(
				"error" in sessionResponse
					? sessionResponse.error
					: "Agent sessions could not be loaded.",
			);
		if ("workspaceGrants" in grantResponse)
			setGrants(grantResponse.workspaceGrants);
		if ("sessions" in sessionResponse) setSessions(sessionResponse.sessions ?? []);
	}, []);

	useEffect(() => {
		void load().catch((cause) =>
			setError(
				cause instanceof Error
					? cause.message
					: "Workspace and session settings could not be loaded.",
			),
		);
	}, [load]);

	async function addFolder() {
		setBusy(true);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "select-workspace-folder",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Folder access could not be added.",
				);
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Folder access could not be added.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function removeFolder(path: string) {
		setBusy(true);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "remove-workspace-folder",
				path,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Folder access could not be removed.",
				);
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Folder access could not be removed.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<section
			className="settings-panel"
			id="setting-agent-workspace"
			aria-labelledby="settings-workspace-title"
		>
			<header className="settings-panel-header">
				<h2 id="settings-workspace-title">Workspace and sessions</h2>
				<p>
					Keep local folder access explicit and review the durable sessions that
					can use it. Removing a folder does not delete files or transcripts.
				</p>
			</header>
			<section className="settings-stack" aria-label="Workspace and session settings">
				<article className="setting-row" id="setting-agent-workspace-grants">
					<div>
						<strong>Project folder access</strong>
						<p>
							Only approved folders are available to workspace tools. Access is
							revocable and unavailable folders remain visible for recovery.
						</p>
						{grants.length === 0 ? (
							<small>No project folders are connected.</small>
						) : (
							<ul className="workspace-grants">
								{grants.map((grant) => (
									<li key={grant.path}>
										<span title={grant.path}>
											{grant.name}
											{grant.available === false ? " · unavailable" : ""}
										</span>
										<button
											type="button"
											className="quiet-link"
											disabled={busy}
											onClick={() => void removeFolder(grant.path)}
										>
											Remove
										</button>
									</li>
								))}
							</ul>
						)}
						{error && <small role="alert">{error}</small>}
					</div>
					<button
						type="button"
						className="button secondary"
						disabled={busy}
						onClick={() => void addFolder()}
					>
						{busy ? "Updating…" : "Add folder"}
					</button>
				</article>
				<article className="setting-row" id="setting-agent-sessions">
					<div>
						<strong>Durable sessions</strong>
						<p>
							Sessions, checkpoints, and approval boundaries persist locally so
							work can be resumed without replaying side effects.
						</p>
						{sessions.length === 0 ? (
							<small>No agent sessions yet.</small>
						) : (
							<ul className="workspace-grants">
								{sessions.map((session) => (
									<li key={session.id}>
										<span>
											{session.title} · {session.status} · {session.checkpoints.length} checkpoint
											{session.checkpoints.length === 1 ? "" : "s"}
											{session.workspaceRoot ? ` · ${session.workspaceRoot}` : ""}
										</span>
									</li>
								))}
							</ul>
						)}
					</div>
					<span className="status">{sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
				</article>
			</section>
		</section>
	);
}

function automationScheduleLabel(job: ScheduledJobSummary): string {
	const schedule = job.schedule;
	if (schedule.kind === "cron") return `Cron ${schedule.expression}`;
	if (schedule.kind === "interval")
		return `Every ${Math.round(schedule.intervalMs / 60_000)} minutes`;
	return "One time";
}

function AgentAutomationsSettings() {
	const [jobs, setJobs] = useState<ScheduledJobSummary[]>([]);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");

	const load = useCallback(async () => {
		const response = (await window.kestrel.request({
			type: "orchestration-list",
		})) as CoreResponse;
		if (!response.ok) throw new Error(response.error);
		setJobs(response.jobs ?? []);
	}, []);

	useEffect(() => {
		void load().catch((cause) =>
			setError(
				cause instanceof Error ? cause.message : "Automations could not be loaded.",
			),
		);
	}, [load]);

	async function mutate(job: ScheduledJobSummary, action: "cancel" | "resume") {
		setBusy(job.id);
		setError("");
		try {
			const response = (await window.kestrel.request({
				type:
					action === "cancel"
						? "orchestration-job-cancel"
						: "orchestration-job-resume",
				jobId: job.id,
			})) as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			await load();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Automation could not be updated.",
			);
		} finally {
			setBusy("");
		}
	}

	return (
		<section
			className="settings-panel"
			id="setting-agent-automations-panel"
			aria-labelledby="settings-automations-title"
		>
			<header className="settings-panel-header">
				<h2 id="settings-automations-title">Automations</h2>
				<p>
					Review scheduled work and its next run. Automation execution still
					passes through the same provider, workspace, and approval boundaries as
					an interactive task.
				</p>
			</header>
			<section className="settings-stack" aria-label="Automation settings">
				<article className="setting-row" id="setting-agent-automations">
					<div>
						<strong>Scheduled work</strong>
						{jobs.length === 0 ? (
							<p>No scheduled jobs are configured. Create one from the Work surface.</p>
						) : (
							<ul className="workspace-grants automation-settings-list">
								{jobs.map((job) => (
									<li key={job.id}>
										<span>
											<strong>{job.title}</strong>
											<small>
												{job.status} · {automationScheduleLabel(job)} · next {new Date(job.schedule.nextRunAt).toLocaleString()}
												{job.error ? ` · ${job.error}` : ""}
											</small>
										</span>
										<span className="button-row">
											{job.status === "waiting_approval" && (
												<button
													type="button"
													className="quiet-link"
													disabled={Boolean(busy)}
													onClick={() => void mutate(job, "resume")}
												>
													Approve & resume
												</button>
											)}
											{["pending", "running", "waiting_approval"].includes(job.status) && (
												<button
													type="button"
													className="quiet-link"
													disabled={Boolean(busy)}
													onClick={() => void mutate(job, "cancel")}
												>
													Cancel
												</button>
											)}
										</span>
									</li>
								))}
							</ul>
						)}
						{error && <small role="alert">{error}</small>}
					</div>
					<span className="status">{jobs.length} job{jobs.length === 1 ? "" : "s"}</span>
				</article>
			</section>
		</section>
	);
}

function AgentDiagnosticsSettings() {
	const [readiness, setReadiness] = useState<SystemReadiness | null>(null);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	async function checkReadiness() {
		setBusy("readiness");
		setError("");
		setNotice("");
		try {
			const response = await window.kestrel.request({ type: "system-readiness" });
			if (!response.ok || !("systemReadiness" in response))
				throw new Error(
					"error" in response ? response.error : "Readiness check failed.",
				);
			setReadiness(response.systemReadiness);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Readiness check failed.");
		} finally {
			setBusy("");
		}
	}

	async function exportReport() {
		setBusy("report");
		setError("");
		setNotice("");
		try {
			const response = await window.kestrel.request({ type: "export-diagnostic-report" });
			if (!response.ok || !("diagnosticReportPath" in response))
				throw new Error(
					"error" in response ? response.error : "Diagnostic report export failed.",
				);
			setNotice(`Diagnostic report exported to ${response.diagnosticReportPath}.`);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Diagnostic report export failed.",
			);
		} finally {
			setBusy("");
		}
	}

	return (
		<article className="setting-row" id="setting-agent-diagnostics">
			<div>
				<strong>Health and diagnostic reports</strong>
				<p>
					Run a content-free readiness check or export a bounded report for local
					recovery. Reports do not include prompts, credentials, or page contents.
				</p>
				<div className="button-row">
					<button
						type="button"
						className="button secondary"
						disabled={Boolean(busy)}
						onClick={() => void checkReadiness()}
					>
						{busy === "readiness" ? "Checking…" : "Check readiness"}
					</button>
					<button
						type="button"
						className="button secondary"
						disabled={Boolean(busy)}
						onClick={() => void exportReport()}
					>
						{busy === "report" ? "Exporting…" : "Export report"}
					</button>
				</div>
				{readiness && (
					<div className="diagnostics-readiness" role="status">
						<strong>{readiness.readyForLiveWork ? "Ready for live work" : "Needs attention"}</strong>
						<ul className="workspace-grants">
							{readiness.checks.map((check) => (
								<li key={check.id}>
									<span>{check.label} · {check.detail}</span>
									<span className={`status ${check.status}`}>{check.status}</span>
								</li>
							))}
						</ul>
					</div>
				)}
				{notice && <small role="status">{notice}</small>}
				{error && <small role="alert">{error}</small>}
			</div>
		</article>
	);
}

function Settings({
	snapshot,
	update,
	initialSection,
	sectionRequestId,
	focusSkillReview,
	browser,
	browserContextEnabled,
	onToggleBrowserContext,
	onBack,
}: {
	snapshot: WorkspaceSnapshot;
	update(next: WorkspaceSnapshot): void;
	initialSection?: SettingsSection;
	sectionRequestId?: number;
	focusSkillReview?: SkillReviewRequest;
	browser: UserBrowserController;
	browserContextEnabled: boolean;
	onToggleBrowserContext(): void;
	onBack?(): void;
}) {
	const reduced = useReducedMotion();
	const [login, setLogin] = useState<{
		enabled: boolean;
		status: string;
	} | null>(null);
	const [confirmation, setConfirmation] = useState("");
	const [resetError, setResetError] = useState("");
	const [section, setSection] = useState<SettingsSection>(
		normalizeSettingsSection(initialSection),
	);
	const [scope, setScope] = useState<SettingsScope>(
		settingsScopeForSection(initialSection),
	);
	const [settingsQuery, setSettingsQuery] = useState("");
	const [focusAnchor, setFocusAnchor] = useState("");
	const settingsSearchRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!initialSection) return;
		const normalized = normalizeSettingsSection(initialSection);
		setSection(normalized);
		setScope(settingsScopeForSection(normalized));
	}, [initialSection, sectionRequestId]);
	const chooseSection = useCallback(
		(next: SettingsSection, anchor = "") => {
			const normalized = normalizeSettingsSection(next);
			setScope(settingsScopeForSection(normalized));
			setSection(normalized);
			if (anchor) setFocusAnchor(anchor);
		},
		[],
	);
	const visibleSections = useMemo(
		() => SETTINGS_SECTIONS.filter((candidate) => candidate.scope === scope),
		[scope],
	);
	const searchResults = useMemo(
		() =>
			SETTINGS_CATALOG.filter((entry) =>
				settingsSectionMatchesQuery(entry, settingsQuery),
			),
		[settingsQuery],
	);
	useEffect(() => {
		if (!focusAnchor) return;
		const frame = window.requestAnimationFrame(() => {
			const target = document.getElementById(focusAnchor);
			const control =
				target?.matches("input,select,textarea,button")
					? target
					: target?.querySelector<HTMLElement>(
							"input,select,textarea,button,[tabindex]:not([tabindex='-1'])",
						);
			target?.scrollIntoView({
				block: "center",
				behavior: reduced ? "auto" : "smooth",
			});
			control?.focus({ preventScroll: true });
			setFocusAnchor("");
		});
		return () => window.cancelAnimationFrame(frame);
	}, [focusAnchor, reduced]);
	useEffect(() => {
		void window.kestrel
			.request({ type: "get-system-state" })
			.then((response) => {
				if ("launchAtLogin" in response)
					setLogin({
						enabled: response.launchAtLogin,
						status: response.launchStatus,
					});
			});
	}, []);
	async function toggleLogin() {
		const response = await window.kestrel.request({
			type: "set-launch-at-login",
			enabled: !login?.enabled,
		});
		if ("launchAtLogin" in response)
			setLogin({
				enabled: response.launchAtLogin,
				status: response.launchStatus,
			});
	}
	async function togglePause() {
		const response = (await window.kestrel.request({
			type: "set-paused",
			paused: snapshot.agentState !== "paused",
		})) as CoreResponse;
		if (response.ok && response.snapshot) update(response.snapshot);
	}
	async function selectPersonality(personalityId: string) {
		const response = (await window.kestrel.request({
			type: "set-personality",
			personalityId,
		})) as CoreResponse;
		if (response.ok && response.snapshot) update(response.snapshot);
	}
	const [plugins, setPlugins] = useState<PluginSummary[]>([]);
	const [publishers, setPublishers] = useState<TrustedPluginPublisher[]>([]);
	const [pluginError, setPluginError] = useState("");
	const [pluginNotice, setPluginNotice] = useState("");
	const [pluginRecoveryPath, setPluginRecoveryPath] = useState("");
	const [pluginBusy, setPluginBusy] = useState(false);
	useEffect(() => {
		void window.kestrel.request({ type: "plugin-list" }).then((raw) => {
			const response = raw as CoreResponse;
			if (response.ok) setPlugins(response.plugins ?? []);
			else setPluginError(response.error);
		});
		void window.kestrel
			.request({ type: "plugin-get-publishers" })
			.then((response) => {
				if (response.ok && "pluginPublishers" in response)
					setPublishers(response.pluginPublishers);
			});
	}, []);
	async function togglePlugin(plugin: PluginSummary) {
		setPluginError("");
		const response = (await window.kestrel.request({
			type: "plugin-set-enabled",
			name: plugin.name,
			enabled: !plugin.enabled,
		})) as CoreResponse;
		if (response.ok) setPlugins(response.plugins ?? []);
		else setPluginError(response.error);
	}
	async function togglePluginMcp(plugin: PluginSummary) {
		setPluginError("");
		const response = (await window.kestrel.request({
			type: plugin.mcpConnected
				? "plugin-disconnect-mcp"
				: "plugin-connect-mcp",
			name: plugin.name,
		})) as CoreResponse;
		if (response.ok) setPlugins(response.plugins ?? []);
		else setPluginError(response.error);
	}
	async function importPublisher() {
		setPluginBusy(true);
		setPluginError("");
		setPluginNotice("");
		try {
			const response = await window.kestrel.request({
				type: "plugin-import-publisher",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Publisher import failed.",
				);
			if ("pluginPublishers" in response)
				setPublishers(response.pluginPublishers);
		} catch (error) {
			setPluginError(
				error instanceof Error ? error.message : "Publisher import failed.",
			);
		} finally {
			setPluginBusy(false);
		}
	}
	async function removePublisher(keyId: string) {
		setPluginBusy(true);
		setPluginError("");
		setPluginNotice("");
		try {
			const response = await window.kestrel.request({
				type: "plugin-remove-publisher",
				keyId,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Publisher removal failed.",
				);
			if ("pluginPublishers" in response)
				setPublishers(response.pluginPublishers);
		} catch (error) {
			setPluginError(
				error instanceof Error ? error.message : "Publisher removal failed.",
			);
		} finally {
			setPluginBusy(false);
		}
	}
	async function mutatePlugin(
		request: Extract<
			RendererRequest,
			{
				type:
					| "plugin-install-bundle"
					| "plugin-update-bundle"
					| "plugin-remove-installed"
					| "plugin-restore-removed";
			}
		>,
	) {
		setPluginBusy(true);
		setPluginError("");
		setPluginNotice("");
		try {
			const response = await window.kestrel.request(request);
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Plugin operation failed.",
				);
			if ("plugins" in response) setPlugins(response.plugins ?? []);
			if ("pluginMutation" in response) {
				const mutation: PluginMutation = response.pluginMutation;
				setPluginNotice(
					`${mutation.name} ${mutation.version}: ${mutation.action} complete.`,
				);
				setPluginRecoveryPath(mutation.recoveryPath ?? "");
			}
		} catch (error) {
			setPluginError(
				error instanceof Error ? error.message : "Plugin operation failed.",
			);
		} finally {
			setPluginBusy(false);
		}
	}
	async function reset() {
		const response = await window.kestrel.request({
			type: "reset-local-data",
			confirmation,
		});
		if (!response.ok)
			setResetError("error" in response ? response.error : "Reset failed");
	}
	function reopenSetup() {
		localStorage.removeItem("kestrel:onboarded");
		localStorage.setItem("kestrel:setup-step", setupSteps[0]!.id);
		location.reload();
	}
	const configurationPrompts = personalizedConfigurationPrompts({
		density: snapshot.configuration.ui.density,
		showToolActivity: snapshot.configuration.ui.showToolActivity,
		showConfigurationDiffs: snapshot.configuration.ui.showConfigurationDiffs,
		...(browser.state?.settings.searchEngine
			? { searchEngine: browser.state.settings.searchEngine }
			: {}),
		...(browser.state?.settings.tabLayout
			? { tabLayout: browser.state.settings.tabLayout }
			: {}),
		contextEnabled: browserContextEnabled,
		...(typeof login?.enabled === "boolean"
			? { launchAtLogin: login.enabled }
			: {}),
		paused: snapshot.agentState === "paused",
	});
	const route = snapshot.modelRouting.currentDecision;
	const basicSections = visibleSections.filter(
		(candidate) => candidate.tier === "basic",
	);
	const advancedSections = visibleSections.filter(
		(candidate) => candidate.tier === "advanced",
	);
	const activeSection = sectionDefinition(section);
	return (
		<PageFrame
			title="Settings"
			text="Configure Browser and Agent behavior without weakening current approval, privacy, or recovery boundaries."
			measure="wide"
			className="settings-page-frame"
			{...(onBack ? { onBack } : {})}
		>
			<div
				className="settings-scope-switcher"
				role="tablist"
				aria-label="Settings category"
			>
				<button
					type="button"
					role="tab"
					aria-selected={scope === "browser"}
					className={scope === "browser" ? "active" : ""}
					onClick={() => chooseSection("browser")}
				>
					<Icon name="browser" />
					<span>
						<strong>Browser</strong>
						<small>Tabs, search, and new tab</small>
					</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={scope === "agent"}
					className={scope === "agent" ? "active" : ""}
					onClick={() => chooseSection("agent-general")}
				>
					<Icon name="agent" />
					<span>
						<strong>Agent</strong>
						<small>Models, memory, and behavior</small>
					</span>
				</button>
			</div>
			<label className="settings-section-picker">
				<span>Settings section</span>
				<select
					value={section}
					onChange={(event) => {
						const next = event.target.value as SettingsSection;
						chooseSection(next);
					}}
				>
					<optgroup label="Browser">
						{SETTINGS_SECTIONS.filter(
							(candidate) => candidate.scope === "browser",
						).map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.label}
							</option>
						))}
					</optgroup>
					<optgroup label="Agent">
						{SETTINGS_SECTIONS.filter(
							(candidate) => candidate.scope === "agent",
						).map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.label}
							</option>
						))}
					</optgroup>
				</select>
			</label>
			<div className="settings-search" role="search">
				<label className="settings-search-field">
					<Icon name="search" />
					<span className="sr-only">Search settings</span>
					<input
						ref={settingsSearchRef}
						value={settingsQuery}
						onChange={(event) => setSettingsQuery(event.target.value)}
						placeholder="Search Browser and Agent settings"
						aria-label="Search Browser and Agent settings"
						aria-controls="settings-search-results"
					/>
					{settingsQuery && (
						<button
							type="button"
							className="settings-search-clear"
							aria-label="Clear settings search"
							onClick={() => {
								setSettingsQuery("");
								settingsSearchRef.current?.focus();
							}}
						>
							<Icon name="close" />
						</button>
					)}
				</label>
				{settingsQuery && (
					<div
						id="settings-search-results"
						className="settings-search-results"
						aria-live="polite"
					>
						{searchResults.length === 0 ? (
							<p className="settings-search-empty">
								No settings match “{settingsQuery}”.
							</p>
						) : (
							<>
								<p className="settings-search-count">
									{searchResults.length} matching setting
									{searchResults.length === 1 ? "" : "s"}
								</p>
								{searchResults.map((entry) => (
									<button
										key={entry.id}
										type="button"
										className="settings-search-result"
										onClick={() => chooseSection(entry.section, entry.anchor)}
									>
										<span className="settings-search-result-copy">
											<strong>{entry.label}</strong>
											<small>{entry.description}</small>
										</span>
										<span className="settings-search-result-category">
											{sectionDefinition(entry.section).label} · {entry.tier}
										</span>
									</button>
								))}
							</>
						)}
					</div>
				)}
			</div>
			<div className="settings-layout">
				<nav className="settings-nav" aria-label="Settings sections">
					<div className="settings-nav-heading">
						<strong>{scope === "browser" ? "Browser" : "Agent"}</strong>
						<small>{activeSection.description}</small>
					</div>
					{(["basic", "advanced"] as const).map((tier) => {
						const tierSections = tier === "basic" ? basicSections : advancedSections;
						return (
							<div className="settings-nav-group" key={tier}>
								<h3>{tier === "basic" ? "Basic" : "Advanced"}</h3>
								{tierSections.map((candidate) => (
									<button
										key={candidate.id}
										type="button"
										className={section === candidate.id ? "active" : ""}
										aria-current={section === candidate.id ? "page" : undefined}
										title={candidate.description}
										onClick={() => chooseSection(candidate.id)}
									>
										<span>{candidate.label}</span>
									</button>
								))}
							</div>
						);
					})}
				</nav>
					<div className="settings-content-stage">
					<AnimatePresence initial={false} mode="popLayout">
					<motion.div
						key={section}
						className="settings-content"
						initial={reduced ? false : { opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: reduced ? 1 : 0, pointerEvents: "none" }}
						transition={reduced ? { duration: 0 } : KESTREL_STATE_TRANSITION}
					>
					{section === "agent-general" && (
						<div className="agent-config-banner" role="region" aria-label="Agent configuration">
							<div className="agent-config-banner-header">
								<span className="agent-config-badge">
									<Icon name="agent" />
									<span>Ask in chat</span>
								</span>
								<strong>Ask Kestrel to change supported settings</strong>
							</div>
							<div className="agent-config-chips" aria-label="Personalized configuration requests">
								<span className="chips-label">Try asking:</span>
								{configurationPrompts.map((prompt) => (
									<button
										key={prompt}
										type="button"
										className="agent-config-chip"
										onClick={() => {
											const textarea = document.querySelector<HTMLTextAreaElement>(
												".agent-conversation-host textarea",
											);
											if (textarea) {
												textarea.value = prompt;
												textarea.dispatchEvent(new Event("input", { bubbles: true }));
												textarea.focus();
											}
										}}
									>
										<span>{prompt}</span>
									</button>
								))}
							</div>
						</div>
						)}
						{(section === "browser" || section.startsWith("browser-")) && (
							<BrowserSettings
								browser={browser}
								contextEnabled={browserContextEnabled}
								onToggleContext={onToggleBrowserContext}
								section={section as BrowserSettingsSection}
							/>
						)}
					{section === "agent-connections" && (
						<>
							<Connections snapshot={snapshot} />
							<section className="settings-stack" aria-label="Subscription connections">
								<SubscriptionCliSettings hideCodexDuplicate />
							</section>
						</>
					)}
				{section === "agent-general" && (
					<section
						className="settings-panel"
						id="setting-agent-general"
						aria-labelledby="settings-general-title"
					>
						<header className="settings-panel-header">
							<h2 id="settings-general-title">Autonomy and behavior</h2>
							<p>
								Startup, communication style, and how much initiative Kestrel
								takes.
							</p>
						</header>
						<section className="settings-stack" aria-label="General settings">
						<article className="setting-row">
							<div>
								<strong>Setup guide</strong>
								<p>Reopen the walkthrough. Protected credentials stay in place.</p>
							</div>
							<button className="button secondary" onClick={reopenSetup}>
								Open setup guide
							</button>
						</article>
						<article className="setting-row">
							<div>
								<strong>Background work</strong>
								<p>Pause proactive work without closing Kestrel.</p>
							</div>
							<button
								className="button secondary"
								onClick={() => void togglePause()}
							>
								{snapshot.agentState === "paused"
									? "Resume background work"
									: "Pause background work"}
							</button>
						</article>
						<article className="setting-row routing-setting">
							<div>
								<strong>Communication style</strong>
								<p>
									How Kestrel explains work. Safety and capability rules do not
									change.
								</p>
							</div>
								<div
									className="segmented"
									role="group"
									aria-label="Communication style"
								>
									{snapshot.personality.available.map((personality) => (
										<button
											key={personality.id}
											title={personality.description}
											aria-pressed={
												snapshot.personality.selectedId === personality.id
											}
											className={
												snapshot.personality.selectedId === personality.id
													? "selected"
													: ""
											}
											onClick={() => void selectPersonality(personality.id)}
										>
											{personality.name}
										</button>
									))}
								</div>
							</article>
							<article className="setting-row">
								<div>
									<strong>Run at login</strong>
									{login && <small>System status: {login.status}</small>}
								</div>
								<button
									className={`switch ${login?.enabled ? "on" : ""}`}
									role="switch"
									aria-label="Run Kestrel at login"
									aria-checked={login?.enabled ?? false}
									onClick={() => void toggleLogin()}
								>
									<span />
								</button>
							</article>
						</section>
					</section>
				)}
				{section === "agent-models" && (
					<section
						className="settings-panel"
						id="setting-agent-models"
						aria-labelledby="settings-models-title"
					>
						<header className="settings-panel-header">
							<h2 id="settings-models-title">Routing and providers</h2>
							<p>
								Model routing, live provider checks, and cost guardrails.
							</p>
						</header>
					<section
						className="settings-stack"
						aria-label="Model and routing settings"
					>
						<RoutingPolicySettings />
							<details className="settings-routing-details">
								<summary>Current routing details</summary>
								<article className="setting-row routing-setting">
									<div>
										<strong>Execution routing</strong>
										<small>
											{route.execution === "local"
												? "No provider request was needed for the current task."
												: "Live runs can use measured provider health, configured rates, and account pools."}
										</small>
									</div>
									<div
										className="routing-grid"
										aria-label="Automatic execution routing"
									>
										<div>
											<span>Model</span>
											<strong>{modelLabel(route.model)}</strong>
											<small>Auto</small>
										</div>
										<div>
											<span>Reasoning</span>
											<strong>{route.reasoningEffort}</strong>
											<small>Auto</small>
										</div>
										<div>
											<span>Fast mode</span>
											<strong>{route.fastMode ? "On" : "Off"}</strong>
											<small>Auto</small>
										</div>
									</div>
									</article>
							</details>
						<ProviderVerificationSettings />
						<UsagePolicySettings />
					</section>
					</section>
				)}
				{section === "agent-tools" && (
					<section
						className="settings-panel"
						id="setting-agent-tools"
						aria-labelledby="settings-extensions-title"
					>
						<header className="settings-panel-header">
							<h2 id="settings-extensions-title">Plugins and publishers</h2>
							<p>
								Signed bundles from publishers you explicitly trust — nothing
								else installs.
							</p>
						</header>
					<section className="settings-stack" aria-label="Extension settings">
						<article className="setting-row plugin-supply-setting">
								<div>
									<strong>Plugin supply chain</strong>
									<p>
										Only Ed25519-signed bundles from publishers you explicitly
										trust can be installed or updated.
									</p>
									{publishers.length > 0 ? (
										<ul className="workspace-grants">
											{publishers.map((publisher) => (
												<li key={publisher.keyId}>
													<span title={publisher.fingerprint}>
														{publisher.keyId} ·{" "}
														{publisher.fingerprint.slice(0, 12)}…
													</span>
													<button
														className="quiet-link"
														disabled={pluginBusy}
														onClick={() =>
															void removePublisher(publisher.keyId)
														}
													>
														Untrust
													</button>
												</li>
											))}
										</ul>
									) : (
										<small>No plugin publishers are trusted yet.</small>
									)}
									{pluginNotice && <small role="status">{pluginNotice}</small>}
									{pluginError && <small role="alert">{pluginError}</small>}
								</div>
								<div className="button-row">
									<button
										className="button secondary"
										disabled={pluginBusy}
										onClick={() => void importPublisher()}
									>
										Trust publisher key
									</button>
									<button
										className="button secondary"
										disabled={pluginBusy || publishers.length === 0}
										onClick={() =>
											void mutatePlugin({ type: "plugin-install-bundle" })
										}
									>
										Install signed plugin
									</button>
									<button
										className="button secondary"
										disabled={pluginBusy || publishers.length === 0}
										onClick={() =>
											void mutatePlugin({ type: "plugin-update-bundle" })
										}
									>
										Update plugin
									</button>
									{pluginRecoveryPath && (
										<button
											className="button secondary"
											disabled={pluginBusy}
											onClick={() =>
												void mutatePlugin({
													type: "plugin-restore-removed",
													recoveryPath: pluginRecoveryPath,
												})
											}
										>
											Restore removed plugin
										</button>
									)}
								</div>
							</article>
							{plugins.map((plugin) => (
								<article className="setting-row" key={plugin.name}>
									<div>
										<strong>
											{plugin.interface?.displayName ?? plugin.name}{" "}
											<small>v{plugin.version}</small>
										</strong>
										<p>
											{plugin.interface?.shortDescription ?? plugin.description}
										</p>
										<small>
											{plugin.managed
												? "Managed signed bundle"
												: "External discovered bundle"}{" "}
											· {plugin.hasSkills ? "Skills" : "No skills"} ·{" "}
											{plugin.hasMcpServers
												? plugin.mcpConnected
													? "MCP connected"
													: "MCP available"
												: "No MCP"}{" "}
											·{" "}
											{plugin.hasDashboard
												? plugin.enabled
													? "Dashboard panels active"
													: "Dashboard panels available"
												: "No dashboard"}{" "}
											· permissions:{" "}
											{plugin.interface?.capabilities.join(", ") ||
												"none declared"}
										</small>
									</div>
									<div>
										<button
											className="button secondary"
											aria-pressed={plugin.enabled}
											onClick={() => void togglePlugin(plugin)}
										>
											{plugin.enabled ? "Disable" : "Enable"}
										</button>
										{plugin.enabled && plugin.hasMcpServers && (
											<button
												className="button secondary"
												aria-pressed={plugin.mcpConnected}
												onClick={() => void togglePluginMcp(plugin)}
											>
												{plugin.mcpConnected ? "Disconnect MCP" : "Connect MCP"}
											</button>
										)}
										{plugin.managed && (
											<button
												className="button secondary"
												disabled={pluginBusy}
												onClick={() =>
													void mutatePlugin({
														type: "plugin-remove-installed",
														name: plugin.name,
													})
												}
											>
												Remove
											</button>
										)}
									</div>
								</article>
							))}
						</section>
						<section className="settings-stack" aria-label="Learned skill settings">
							<LearnedSkillsSettings
								{...(focusSkillReview
									? { focusRequest: focusSkillReview }
									: {})}
							/>
						</section>
					</section>
					)}
					{section === "agent-memory" && (
						<section
							className="settings-panel"
							id="setting-agent-memory"
							aria-labelledby="settings-intelligence-title"
						>
							<header className="settings-panel-header">
								<h2 id="settings-intelligence-title">Memory and learning</h2>
								<p>
									What Kestrel remembers, senses, and learns stays reviewable
									here.
								</p>
							</header>
						<section
							className="settings-stack"
							aria-label="Memory and behavior settings"
						>
							<MemoryRecallStatus snapshot={snapshot} />
							<HonchoMemorySettings />
							<PresenceSettings />
						</section>
						</section>
					)}
					{section === "agent-workspace" && (
						<AgentWorkspaceSettings />
					)}
					{section === "agent-automations" && (
						<AgentAutomationsSettings />
					)}
					{section === "agent-permissions" && (
						<section
							className="settings-panel"
							id="setting-agent-permissions"
							aria-labelledby="settings-privacy-title"
						>
							<header className="settings-panel-header">
								<h2 id="settings-privacy-title">Permissions and sandbox</h2>
								<p>
									Persistent approval rules and recovery boundaries stay explicit,
									revocable, and separate from credentials.
								</p>
							</header>
						<section
							className="settings-stack"
							aria-label="Privacy and safety settings"
						>
							<ComputerUseSettings />
							<ApprovalRulesSettings />
						</section>
						</section>
					)}
					{section === "agent-privacy" && (
						<section
							className="settings-panel"
							id="setting-agent-privacy"
							aria-labelledby="settings-agent-privacy-title"
						>
							<header className="settings-panel-header">
								<h2 id="settings-agent-privacy-title">Privacy and credentials</h2>
								<p>
									Provider secrets stay in protected native storage. Kestrel only
									shows status and offers explicit revocation.
								</p>
							</header>
							<section className="settings-stack" aria-label="Protected credential settings">
								<CredentialSettings hideCodexDuplicate />
								<article className="setting-row danger">
									<div>
										<strong>Reset local agent data</strong>
										<p>
											Deletes the local database and secure key after explicit
											confirmation, then relaunches Kestrel.
										</p>
										<label>
											Type Kestrel to confirm
											<input
											value={confirmation}
											onChange={(event) => setConfirmation(event.target.value)}
										/>
										</label>
										{resetError && <small role="alert">{resetError}</small>}
									</div>
									<button
										className="button danger-button"
										disabled={confirmation !== "Kestrel"}
										onClick={() => void reset()}
									>
										Reset local data
									</button>
								</article>
							</section>
						</section>
					)}
					{section === "agent-migration" && (
						<section
							className="settings-panel"
							id="setting-agent-migration"
							aria-labelledby="settings-agent-migration-title"
						>
							<header className="settings-panel-header">
								<h2 id="settings-agent-migration-title">Migration</h2>
								<p>
									Review bounded, checksum-verified imports from supported agent tools
									without copying source credentials or overwriting files by default.
								</p>
							</header>
							<section className="settings-stack" aria-label="Migration settings">
								<MigrationSettings />
							</section>
						</section>
					)}
					{section === "agent-diagnostics" && (
						<section
							className="settings-panel"
							id="setting-agent-diagnostics-panel"
							aria-labelledby="settings-advanced-title"
						>
							<header className="settings-panel-header">
								<h2 id="settings-advanced-title">Diagnostics and organization</h2>
								<p>
									Content-free diagnostics and local agent organization.
								</p>
							</header>
						<section className="settings-stack" aria-label="Advanced settings">
							<ObservabilitySettings />
							<AgentDiagnosticsSettings />
								<CustomAgentsSettings snapshot={snapshot} update={update} />
							</section>
							</section>
						)}
						</motion.div>
					</AnimatePresence>
				</div>
			</div>
			</PageFrame>
	);
}

function PageFrame({
	eyebrow,
	title,
	text,
	onBack,
	actions,
	measure = "standard",
	className,
	children,
}: {
	eyebrow?: string;
	title: string;
	text?: string;
	onBack?(): void;
	actions?: ReactNode;
	measure?: PageMeasure;
	className?: string;
	children: ReactNode;
}) {
	return (
		<SurfacePageFrame
			as="div"
			eyebrow={eyebrow}
			title={title}
			description={text}
			actions={actions}
			measure={measure}
			className={className}
			navigation={onBack ? <SurfaceBackButton onBack={onBack} /> : undefined}
		>
			{children}
		</SurfacePageFrame>
	);
}

function Empty({ title, text }: { title: string; text?: string }) {
	return text ? <EmptyState title={title} detail={text} /> : <EmptyState title={title} />;
}

export function App() {
	const browser = useUserBrowser();
	const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
	const [runtimeRefreshRevision, setRuntimeRefreshRevision] = useState(0);
	const [agentSidebarOpen, setAgentSidebarOpen] = useState(
		() => localStorage.getItem("kestrel:agent-sidebar") !== "collapsed",
	);
	const [agentUniverseRailOpen, setAgentUniverseRailOpen] = useState(
		() => localStorage.getItem("kestrel:agent-universe-rail") === "open",
	);
	const [settingsSectionRequest, setSettingsSectionRequest] = useState<{
		section: SettingsSection | null;
		requestId: number;
	}>({ section: null, requestId: 0 });
	const [skillReviewRequest, setSkillReviewRequest] =
		useState<SkillReviewRequest | null>(null);
	const [activityFocusExecutionId, setActivityFocusExecutionId] = useState<
		string | null
	>(null);
	const [browserContextEnabled, setBrowserContextEnabled] = useState(
		() => localStorage.getItem("kestrel:browser-context") !== "off",
	);
	const pendingToolRouteFocusRef = useRef<KestrelAppPageId | null>(null);
	const routeFocusFrameRef = useRef<number | null>(null);
	const [runtimeSessions, setRuntimeSessions] = useState<RuntimeSession[]>([]);
	const [runtimeSessionsLoadState, setRuntimeSessionsLoadState] = useState<
		"loading" | "ready" | "error"
	>("loading");
	const [agentUniverseActivities, setAgentUniverseActivities] = useState<
		AgentUniverseActivity[]
	>([]);
	const [transcriptTarget, setTranscriptTarget] = useState<{
		sessionId: string;
		messageId: string;
	} | null>(null);
	const [workspaceGrants, setWorkspaceGrants] = useState<WorkspaceGrant[]>([]);
	const [runtimeAgentState, setRuntimeAgentState] = useState<AgentState | null>(
		null,
	);
	const [activeRuntimeSessionId, setActiveRuntimeSessionId] = useState<
		string | null
	>(null);
	const [activeProjectPath, setActiveProjectPath] = useState<string | null>(
		() => localStorage.getItem("kestrel:active-project"),
	);
	const [newAgentRequestId, setNewAgentRequestId] = useState(0);
	const [newAgentPrompt, setNewAgentPrompt] = useState("");
	const [newAgentFocusTarget, setNewAgentFocusTarget] = useState<
		"prompt" | "task-settings"
	>("prompt");
	const [externalIntake, setExternalIntake] = useState<ExternalIntake | null>(
		null,
	);
	const [externalIntakeRequestId, setExternalIntakeRequestId] = useState(0);
	const [newAgentWorkspace, setNewAgentWorkspace] = useState<string | null>(
		null,
	);
	const lastPromptedNewAgentAtRef = useRef(0);
	const [error, setError] = useState<string | null>(null);
	const [deepLinkNotice, setDeepLinkNotice] = useState("");
	const [onboarded, setOnboarded] = useState(
		() =>
			localStorage.getItem("kestrel:onboarded") === "yes" ||
			new URLSearchParams(location.search).has("preview"),
	);
	const [showDefaultBrowserPrompt, setShowDefaultBrowserPrompt] = useState(false);
	const [showShortcuts, setShowShortcuts] = useState(false);
	const [organizeTabsRequestId, setOrganizeTabsRequestId] = useState(0);
	const [greetingName, setGreetingName] = useState<string | undefined>();
	const reduced = useReducedMotion();
	const refreshRuntimeSessions = useCallback(async () => {
		setRuntimeSessionsLoadState("loading");
		try {
			const raw = await window.kestrel.request({
				type: "runtime-list-sessions",
			});
			const response = raw as CoreResponse;
			if (!response.ok) throw new Error(response.error);
			setRuntimeSessions(response.sessions ?? []);
			setRuntimeSessionsLoadState("ready");
		} catch (cause) {
			setRuntimeSessionsLoadState("error");
			throw cause;
		}
	}, []);

	useEffect(() => {
		// Setup links keep their provider-owned/system-browser handoff. A managed
		// tab would otherwise open behind onboarding with no visible way to reach it.
		if (!onboarded) return;
		const openRendererLinkInUserBrowser = (event: MouseEvent) => {
			if (!(event.target instanceof Element)) return;
			const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
			if (!anchor) return;
			const route = userBrowserRouteForRendererLink(event, {
				href: anchor.href,
				hasDownload: anchor.hasAttribute("download"),
				target: anchor.target,
				// Provider-owned OAuth and native/system flows can retain their
				// external owner with this explicit opt-out.
				openExternally: anchor.hasAttribute("data-kestrel-external"),
			});
			if (!route) return;

			event.preventDefault();
			void browser.createTab(route.url, route.active).catch(() => undefined);
		};
		document.addEventListener("click", openRendererLinkInUserBrowser);
		document.addEventListener("auxclick", openRendererLinkInUserBrowser);
		return () => {
			document.removeEventListener("click", openRendererLinkInUserBrowser);
			document.removeEventListener("auxclick", openRendererLinkInUserBrowser);
		};
	}, [browser.createTab, onboarded]);

	useEffect(() => {
		if (!onboarded) return;
		const prompted =
			localStorage.getItem("kestrel:default-browser-prompted") === "yes";
		if (prompted) return;

		let active = true;
		void window.kestrel
			.request({ type: "get-default-browser-status" })
			.then((response) => {
				if (
					active &&
					response.ok &&
					"isDefault" in response &&
					"canSetAsDefault" in response &&
					response.canSetAsDefault &&
					!response.isDefault
				) {
					setShowDefaultBrowserPrompt(true);
				}
			})
			.catch(() => undefined);

		return () => {
			active = false;
		};
	}, [onboarded]);
	useEffect(() => {
		if (!onboarded) return;
		let active = true;
		void window.kestrel
			.request({ type: "get-system-state" })
			.then((response) => {
				if (!active || !response.ok || !("userName" in response)) return;
				setGreetingName(
					typeof response.userName === "string" ? response.userName : undefined,
				);
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [onboarded]);
	useEffect(() => {
		if (!onboarded) return;
		let active = true;
		void window.kestrel
			.request({ type: "get-workspace-grants" })
			.then((response) => {
				if (
					active &&
					response.ok &&
					"workspaceGrants" in response
				) {
					setWorkspaceGrants(response.workspaceGrants);
				}
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [onboarded]);
	const selectionRequestRef = useRef(0);
	const openRuntimeSession = useCallback((sessionId: string | null) => {
		setActiveRuntimeSessionId(sessionId);
		const requestId = ++selectionRequestRef.current;
		void window.kestrel
			.request({ type: "runtime-select-session", sessionId })
			.then((response) => {
				if (requestId !== selectionRequestRef.current) return;
				if (!response.ok) setError(response.error);
			})
			.catch((cause) => {
				if (requestId !== selectionRequestRef.current) return;
				setError(
					cause instanceof Error
						? cause.message
						: "Could not persist the selected conversation.",
				);
			});
	}, []);
	const selectProject = useCallback((projectPath: string) => {
		setActiveProjectPath(projectPath);
		localStorage.setItem("kestrel:active-project", projectPath);
	}, []);
	const revealAgentSidebar = useCallback(() => {
		setAgentSidebarOpen(true);
		localStorage.setItem("kestrel:agent-sidebar", "open");
		const activeTab = browser.state?.tabs.find(
			(tab) => tab.id === browser.state?.activeTabId,
		);
		if (parseKestrelAppPage(activeTab?.url ?? "")?.id === "agent") {
			setAgentUniverseRailOpen(true);
			localStorage.setItem("kestrel:agent-universe-rail", "open");
		}
	}, [browser]);
	const acceptExternalIntake = useCallback(
		(intake: ExternalIntake) => {
			setExternalIntake(intake);
			setExternalIntakeRequestId((current) => current + 1);
			revealAgentSidebar();
		},
		[revealAgentSidebar],
	);
	useEffect(
		() => window.kestrel.onExternalIntake(acceptExternalIntake),
		[acceptExternalIntake],
	);
	const askFileFromTab = useCallback(
		(file: UserBrowserFile) => {
			const attachment = attachmentForExternalFile(file);
			if (!attachment) return;
			acceptExternalIntake({ kind: "ask", attachments: [attachment] });
		},
		[acceptExternalIntake],
	);
	const startNewAgent = useCallback((
		prompt = "",
		workspaceRoot?: string,
		focusTarget: "prompt" | "task-settings" = "prompt",
	) => {
		const trimmed = prompt.trim();
		if (
			focusTarget === "prompt" &&
			!trimmed &&
			Date.now() - lastPromptedNewAgentAtRef.current < 500
		) {
			return;
		}
		if (trimmed) lastPromptedNewAgentAtRef.current = Date.now();
		setNewAgentPrompt(prompt);
		setNewAgentWorkspace(workspaceRoot ?? null);
		setNewAgentFocusTarget(focusTarget);
		setNewAgentRequestId((current) => current + 1);
		revealAgentSidebar();
	}, [revealAgentSidebar]);
	const openTaskSettings = useCallback(() => {
		startNewAgent("", undefined, "task-settings");
	}, [startNewAgent]);
	const focusRuntimeApproval = useCallback(() => {
		revealAgentSidebar();
		window.requestAnimationFrame(() => {
			const card = document.querySelector(
				".agent-conversation-host .approval-message",
			);
			card?.scrollIntoView({ block: "nearest" });
			card
				?.querySelector<HTMLButtonElement>(".button.primary")
				?.focus();
		});
	}, [revealAgentSidebar]);
	const openSidebarSession = useCallback(
		(sessionId: string) => {
			revealAgentSidebar();
			const session = runtimeSessions.find((item) => item.id === sessionId);
			if (session?.workspaceRoot) selectProject(session.workspaceRoot);
			openRuntimeSession(sessionId);
			window.requestAnimationFrame(() => {
				document.getElementById("runtime-prompt")?.focus();
			});
		},
		[openRuntimeSession, runtimeSessions, revealAgentSidebar, selectProject],
	);
	const snapshotPendingCount =
		snapshot?.approvals.filter((approval) => approval.status === "pending")
			.length ?? 0;
	const runtimeWaiting = runtimeAgentState === "waiting_approval";
	const openAppPage = useCallback(
		async (id: KestrelAppPageId, section?: SettingsSection) => {
			if (id === "settings")
				setSettingsSectionRequest((current) => ({
					section: section ?? null,
					requestId: current.requestId + 1,
				}));
			pendingToolRouteFocusRef.current = id;
			const tabs = browser.state?.tabs ?? [];
			const existing = tabs.find(
				(tab) => parseKestrelAppPage(tab.url)?.id === id,
			);
			if (existing) {
				if (existing.id !== browser.state?.activeTabId)
					await browser.selectTab(existing.id);
				return;
			}
			await browser.createTab(kestrelAppPageUrl(id));
		},
		[browser],
	);
	const openTranscriptResult = useCallback(
		(result: TranscriptSearchResult) => {
			setTranscriptTarget({
				sessionId: result.sessionId,
				messageId: result.messageId,
			});
			openSidebarSession(result.sessionId);
			void openAppPage("agent");
		},
		[openAppPage, openSidebarSession],
	);
	const openProject = useCallback(
		(project: WorkspaceGrant) => {
			selectProject(project.path);
			void openAppPage("projects");
		},
		[openAppPage, selectProject],
	);
	const startProjectChat = useCallback(
		(project: WorkspaceGrant) => {
			if (project.available === false) return;
			selectProject(project.path);
			startNewAgent("", project.path);
			void openAppPage("agent");
		},
		[openAppPage, selectProject, startNewAgent],
	);
	const openProjectSession = useCallback(
		(sessionId: string) => {
			openSidebarSession(sessionId);
			void openAppPage("agent");
		},
		[openAppPage, openSidebarSession],
	);
	const openBrowserWorkspace = useCallback(async () => {
		const tabs = browser.state?.tabs ?? [];
		const webTab = tabs.find((tab) => !parseKestrelAppPage(tab.url));
		if (webTab) {
			if (webTab.id !== browser.state?.activeTabId)
				await browser.selectTab(webTab.id);
			return;
		}
		await browser.createTab();
	}, [browser]);
	const reviewApprovals = useCallback(() => {
		if (
			sidebarReviewTarget({
				runtimeWaiting,
				snapshotPendingCount,
			}) === "thread"
		) {
			focusRuntimeApproval();
			return;
		}
		void openAppPage("approvals");
	}, [focusRuntimeApproval, openAppPage, runtimeWaiting, snapshotPendingCount]);
	const toggleAgentSidebar = useCallback(() => {
		const activeTab = browser.state?.tabs.find(
			(tab) => tab.id === browser.state?.activeTabId,
		);
		const onAgentUniverse = parseKestrelAppPage(activeTab?.url ?? "")?.id === "agent";
		if (onAgentUniverse) {
			setAgentUniverseRailOpen((current) => {
				const next = !current;
				localStorage.setItem(
					"kestrel:agent-universe-rail",
					next ? "open" : "collapsed",
				);
				window.requestAnimationFrame(() => {
					document
						.getElementById(next ? "runtime-prompt" : "browser-agent-toggle")
						?.focus();
				});
				return next;
			});
			return;
		}
		setAgentSidebarOpen((current) => {
			const next = !current;
			localStorage.setItem(
				"kestrel:agent-sidebar",
				next ? "open" : "collapsed",
			);
			window.requestAnimationFrame(() => {
				document
					.getElementById(next ? "runtime-prompt" : "browser-agent-toggle")
					?.focus();
			});
			return next;
		});
	}, [browser]);
	const openBrowser = useCallback(() => {
		void openBrowserWorkspace();
	}, [openBrowserWorkspace]);
	const openAgent = useCallback(() => {
		void openAppPage("agent");
	}, [openAppPage]);
	const openWritingStudio = useCallback(() => {
		void openAppPage("writing");
	}, [openAppPage]);
	const openBrowserHistory = useCallback(() => {
		void openAppPage("history");
	}, [openAppPage]);
	const openBrowserDownloads = useCallback(() => {
		void openAppPage("downloads");
	}, [openAppPage]);
	const openBrowserBookmarks = useCallback(() => {
		void openAppPage("bookmarks");
	}, [openAppPage]);
	const openCommandCenter = useCallback(() => {
		void openAppPage("commands");
	}, [openAppPage]);
	const openSettings = useCallback(
		(section?: SettingsSection) => {
			void openAppPage("settings", section);
		},
		[openAppPage],
	);
	const reviewLearnedSkill = useCallback(
		(proposalId: string) => {
			setSkillReviewRequest((current) => ({
				proposalId,
				requestId: (current?.requestId ?? 0) + 1,
			}));
			void openAppPage("settings", "agent-tools");
		},
		[openAppPage],
	);
	const closeCommandCenter = useCallback(() => {
		const active = browser.state?.tabs.find(
			(tab) => tab.id === browser.state?.activeTabId,
		);
		if (active && parseKestrelAppPage(active.url)?.id === "commands") {
			void browser.closeTab(active.id);
			return;
		}
		void openBrowserWorkspace();
	}, [browser, openBrowserWorkspace]);
	useEffect(
		() =>
			window.kestrel.onDeepLink((deepLink) => {
				const action = desktopDeepLinkAction(deepLink);
				if (action === "new-chat") {
					setDeepLinkNotice("");
					startNewAgent();
					return;
				}
				if (action === "settings") {
					setDeepLinkNotice("");
					void openAppPage("settings");
					return;
				}
				setDeepLinkNotice(
					"This Kestrel link is not supported. Open New task or Settings from the sidebar.",
				);
			}),
		[openAppPage, openRuntimeSession, startNewAgent],
	);
	useEffect(() => {
		if (!deepLinkNotice) return;
		const timer = window.setTimeout(() => setDeepLinkNotice(""), 8_000);
		return () => window.clearTimeout(timer);
	}, [deepLinkNotice]);
	useEffect(() => {
		let active = true;
		const unsubscribe = window.kestrel.onSnapshot((next) => {
			if (active) {
				setError(null);
				setSnapshot(next);
				setRuntimeRefreshRevision((current) => current + 1);
			}
		});
		void loadInitialDesktopState((request) => window.kestrel.request(request))
			.then((initial) => {
				if (!active) return;
				setSnapshot(initial.snapshot);
				setRuntimeSessions(initial.sessions);
				setRuntimeSessionsLoadState(
					initial.sessionsLoadError ? "error" : "ready",
				);
				setActiveRuntimeSessionId(initial.selectedSessionId);
			})
			.catch((cause) => {
				if (active) setError(startupFailureMessage(cause));
			});
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);
	useEffect(
		() =>
			window.kestrel.onRuntimeEvent((event) => {
				setAgentUniverseActivities((current) =>
					appendAgentUniverseActivity(current, event),
				);
				if (event.type === "session.created" || event.type === "session.updated")
					void refreshRuntimeSessions().catch(() => undefined);
				else if (event.type === "message.appended")
					setRuntimeSessions((current) =>
						runtimeSessionsAfterEvent(current, event),
					);
				if (event.type === "tool.completed") {
					const status = String(event.payload.status ?? "");
					const toolName = String(event.payload.toolName ?? "");
					if (toolName.startsWith("agent.config.") && status === "verified")
						void window.kestrel
							.request({ type: "snapshot" })
							.then((response) => {
								if (response.ok && "snapshot" in response && response.snapshot)
									setSnapshot(response.snapshot);
							})
							.catch(() => undefined);
				}
			}),
		[refreshRuntimeSessions],
	);
	useEffect(() => {
		if (!snapshot?.configuration) return;
		const config = snapshot.configuration as Record<string, unknown>;
		const browserConfig = config.browser as
			| (Partial<UserBrowserSettings> & { contextEnabled?: boolean })
			| undefined;
		if (browserConfig && browser.state?.settings) {
			const current = browser.state.settings;
			const isDiff =
				(browserConfig.searchEngine &&
					current.searchEngine !== browserConfig.searchEngine) ||
				(browserConfig.tabLayout &&
					current.tabLayout !== browserConfig.tabLayout) ||
				(typeof browserConfig.restoreSession === "boolean" &&
					current.restoreSession !== browserConfig.restoreSession) ||
				(typeof browserConfig.historyRetentionDays === "number" &&
					current.historyRetentionDays !==
						browserConfig.historyRetentionDays);
			if (isDiff) {
				void browser.updateSettings({
					...(browserConfig.searchEngine
						? { searchEngine: browserConfig.searchEngine }
						: {}),
					...(browserConfig.tabLayout
						? { tabLayout: browserConfig.tabLayout }
						: {}),
					...(typeof browserConfig.restoreSession === "boolean"
						? { restoreSession: browserConfig.restoreSession }
						: {}),
					...(typeof browserConfig.historyRetentionDays === "number"
						? { historyRetentionDays: browserConfig.historyRetentionDays }
						: {}),
				});
			}
			if (typeof browserConfig.contextEnabled === "boolean") {
				if (browserConfig.contextEnabled !== browserContextEnabled) {
					setBrowserContextEnabled(browserConfig.contextEnabled);
				}
			}
		}
	}, [snapshot?.configuration, browser, browserContextEnabled]);
	useEffect(() => {
		const storageKey = "kestrel:presence-instance";
		const legacyKey = "workstrand:presence-instance";
		const legacyInstanceId = localStorage.getItem(legacyKey);
		if (legacyInstanceId && !localStorage.getItem(storageKey)) {
			localStorage.setItem(storageKey, legacyInstanceId);
		}
		localStorage.removeItem(legacyKey);
		const instanceId =
			localStorage.getItem(storageKey) ?? `ui-${crypto.randomUUID()}`;
		localStorage.setItem(storageKey, instanceId);
		const beacon = () => {
			void window.kestrel.request({
				type: "presence-beacon",
				instanceId,
				mode: "ui",
				reason: "desktop window",
			});
		};
		beacon();
		const timer = window.setInterval(beacon, 45_000);
		return () => window.clearInterval(timer);
	}, []);
	const focusToolRoute = useCallback((node: HTMLDivElement | null) => {
		const expected = pendingToolRouteFocusRef.current;
		if (!node || !expected) return;
		if (routeFocusFrameRef.current !== null)
			window.cancelAnimationFrame(routeFocusFrameRef.current);
		routeFocusFrameRef.current = window.requestAnimationFrame(() => {
			routeFocusFrameRef.current = null;
			if (pendingToolRouteFocusRef.current !== expected || !node.isConnected)
				return;
			const target =
				expected === "commands"
					? node.querySelector<HTMLElement>(".command-search input")
					: expected === "agent"
						? document.getElementById("agent-workspace-title")
						: node.querySelector<HTMLElement>("h1, h2");
			if (!target) return;
			pendingToolRouteFocusRef.current = null;
			if (target.matches("input, button, select, textarea, [tabindex]")) {
				target.focus();
				return;
			}
			const previousTabIndex = target.getAttribute("tabindex");
			target.tabIndex = -1;
			target.focus();
			target.addEventListener(
				"blur",
				() => {
					if (previousTabIndex === null) target.removeAttribute("tabindex");
					else target.setAttribute("tabindex", previousTabIndex);
				},
				{ once: true },
			);
		});
	}, []);
	useEffect(
		() => () => {
			if (routeFocusFrameRef.current !== null)
				window.cancelAnimationFrame(routeFocusFrameRef.current);
		},
		[],
	);
	useEffect(
		() =>
			window.kestrel.onBrowserCommand((command) => {
				if (command === "show-shortcuts") setShowShortcuts((prev) => !prev);
			}),
		[],
	);
	useEffect(() => {
		if (!onboarded) return;
		const workspaceShortcuts = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;

			if (event.key === "Escape") {
				if (showShortcuts) {
					event.preventDefault();
					setShowShortcuts(false);
				}
				return;
			}

			if (event.key === "F1") {
				event.preventDefault();
				setShowShortcuts((prev) => !prev);
				return;
			}

			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			const key = event.key.toLowerCase();

			if (key === "n" && !event.shiftKey) {
				event.preventDefault();
				startNewAgent();
			} else if (key === "/" || key === "?") {
				event.preventDefault();
				setShowShortcuts((prev) => !prev);
			}
		};
		document.addEventListener("keydown", workspaceShortcuts);
		return () => document.removeEventListener("keydown", workspaceShortcuts);
	}, [onboarded, showShortcuts, startNewAgent]);
	if (!onboarded)
		return (
			<ProductShellTransition>
				<Onboarding
					key="setup"
					onDone={() => {
						localStorage.setItem("kestrel:onboarded", "yes");
						setOnboarded(true);
					}}
				/>
			</ProductShellTransition>
		);
	if (error)
		return (
			<ProductShellTransition>
				<motion.main
					key="error"
					className="loading-screen error-screen"
					initial={reduced ? false : { opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: reduced ? 1 : 0, pointerEvents: "none" }}
				>
					<span className="error-mark">!</span>
					<h1>Kestrel could not start.</h1>
					<p>{error}</p>
					<p>
						If this keeps happening, quit Kestrel completely and reopen it. Your
						profile, tabs, and agent history are preserved.
					</p>
					<button
						className="button secondary"
						onClick={() => location.reload()}
					>
						Try again
					</button>
				</motion.main>
			</ProductShellTransition>
		);
	if (!snapshot)
		return (
			<ProductShellTransition>
				<Loading key="loading" />
			</ProductShellTransition>
		);
	const activeBrowserTab = browser.state?.tabs.find(
		(tab) => tab.id === browser.state?.activeTabId,
	);
	const currentAppPage = parseKestrelAppPage(activeBrowserTab?.url ?? "");
	const showKestrelSidebar =
		currentAppPage?.id !== "agent" &&
		(!activeBrowserTab?.url || isKestrelAppPageUrl(activeBrowserTab.url));
	const activeFileAttachment = activeBrowserTab?.file
		? attachmentForExternalFile(activeBrowserTab.file)
		: undefined;
	const activeAgentName =
		snapshot.personality.available.find(
			(personality) => personality.id === snapshot.personality.selectedId,
		)?.name ?? "Kestrel";
	const effectiveAgentState = runtimeAgentState ?? snapshot.agentState;
	const pendingApprovalCount =
		snapshot.approvals.filter((approval) => approval.status === "pending")
			.length + (runtimeAgentState === "waiting_approval" ? 1 : 0);
	const activeSidebarDestination = sidebarActiveDestination(
		activeBrowserTab?.url ?? "",
	);
	function navigate(destination: string) {
		if (destination === "shortcuts") {
			setShowShortcuts(true);
			return;
		}
		if (destination === "browser") {
			void openBrowserWorkspace();
			return;
		}
		if (destination === "organize-tabs") {
			void openBrowserWorkspace().then(() =>
				setOrganizeTabsRequestId((current) => current + 1),
			);
			return;
		}
		if (destination === "connections") {
			void openAppPage("settings", "connections");
			return;
		}
		if (!isKestrelAppPageId(destination)) return;
		void openAppPage(destination);
	}
	function toggleBrowserContext() {
		const enabled = !browserContextEnabled;
		setBrowserContextEnabled(enabled);
		localStorage.setItem("kestrel:browser-context", enabled ? "on" : "off");
	}
	const appPageId = currentAppPage?.id;
	const presentedAgentSidebarOpen =
		appPageId === "agent" ? agentUniverseRailOpen : agentSidebarOpen;
	const appPage = appPageId ? (
		<motion.div
			key={appPageId}
			ref={focusToolRoute}
			className={`browser-app-page${
				appPageId === "settings" ||
				appPageId === "readiness" ||
				appPageId === "approvals" ||
				appPageId === "memory" ||
				appPageId === "research" ||
				appPageId === "artifacts" ||
				appPageId === "work" ||
				appPageId === "events" ||
				appPageId === "activity" ||
				appPageId === "extensions" ||
				appPageId === "agent" ||
				appPageId === "projects" ||
				appPageId === "writing"
					? " browser-secondary-surface"
					: ""
			}${appPageId === "memory" ? " life-product-surface" : ""}`}
			data-app-page={appPageId}
			initial={reduced ? false : { opacity: 0, y: 3 }}
			animate={{ opacity: 1, y: 0 }}
			exit={
				reduced
					? { opacity: 1, y: 0, pointerEvents: "none" }
					: { opacity: 0, y: -3, pointerEvents: "none" }
			}
			transition={reduced ? { duration: 0 } : KESTREL_STATE_TRANSITION}
		>
			{appPageId === "history" && (
				<BrowserHistory browser={browser} onOpenBrowser={openBrowser} />
			)}
			{appPageId === "bookmarks" && (
				<BrowserBookmarks browser={browser} onOpenBrowser={openBrowser} />
			)}
			{appPageId === "downloads" && <BrowserDownloads browser={browser} />}
			{appPageId === "commands" && (
				<CommandCenter
					destinations={commandDestinations}
					onSelect={navigate}
					onClose={closeCommandCenter}
					onNewTask={() => {
						startNewAgent();
						openAgent();
					}}
					pendingApprovals={pendingApprovalCount}
				/>
			)}
			{appPageId === "writing" && <WritingStudio />}
			{appPageId === "agent" && (
				<AgentWorkspace
					sessions={runtimeSessions}
					sessionLoadState={runtimeSessionsLoadState}
					activities={agentUniverseActivities}
					agentState={effectiveAgentState}
					pendingApprovals={pendingApprovalCount}
					onNewTask={() => startNewAgent()}
					onOpenSession={openSidebarSession}
					onOpenApprovals={() => navigate("approvals")}
					onOpenWork={() => navigate("work")}
					onToggleAgentSidebar={toggleAgentSidebar}
					onRetrySessions={() => void refreshRuntimeSessions().catch(() => undefined)}
					onBack={() => void openBrowserWorkspace()}
				/>
			)}
			{appPageId === "projects" && (
				<ProjectsWorkspace
					projects={workspaceGrants}
					sessions={runtimeSessions}
					activeProjectPath={activeProjectPath}
					onSelectProject={selectProject}
					onNewChat={startProjectChat}
					onOpenSession={openProjectSession}
					onOpenSettings={() => openSettings("connections")}
				/>
			)}
			{appPageId === "settings" && (
				<Settings
					snapshot={snapshot}
					update={setSnapshot}
					{...(settingsSectionRequest.section
						? { initialSection: settingsSectionRequest.section }
						: {})}
					sectionRequestId={settingsSectionRequest.requestId}
					{...(skillReviewRequest
						? { focusSkillReview: skillReviewRequest }
						: {})}
					browser={browser}
					browserContextEnabled={browserContextEnabled}
					onToggleBrowserContext={toggleBrowserContext}
				/>
			)}
			{appPageId === "readiness" && <Readiness />}
			{appPageId === "approvals" && (
				<RuntimeApprovalQueue
					snapshot={snapshot}
					update={setSnapshot}
					onOpenSession={openSidebarSession}
				/>
			)}
			{appPageId === "memory" && (
				<LifeContext
					snapshot={snapshot}
					update={setSnapshot}
					onOpenTranscriptResult={openTranscriptResult}
				/>
			)}
			{appPageId === "research" && <Research />}
			{appPageId === "artifacts" && <Artifacts />}
			{appPageId === "work" && (
				<Work sessions={runtimeSessions} onSessions={setRuntimeSessions} />
			)}
			{appPageId === "events" && (
				<EventApplications onOpenSession={openRuntimeSession} />
			)}
			{appPageId === "activity" && (
				<RuntimeActivityTrail
					snapshot={snapshot}
					highlightExecutionId={activityFocusExecutionId}
				/>
			)}
			{appPageId === "extensions" && (
				<DashboardExtensions
					snapshot={snapshot}
					sessions={runtimeSessions}
					onNavigate={navigate}
				/>
			)}
		</motion.div>
	) : undefined;
	const kestrelNavigation = showKestrelSidebar ? (
		<KestrelSidebar
			activeDestination={
				activeSidebarDestination === "browser" ||
				activeSidebarDestination === "scheduled" ||
				activeSidebarDestination === "agent" ||
				activeSidebarDestination === "projects" ||
				activeSidebarDestination === "writing" ||
				activeSidebarDestination === "approvals" ||
				activeSidebarDestination === "settings"
					? activeSidebarDestination
					: "capabilities"
			}
			activeSessionId={activeRuntimeSessionId}
			activeProjectPath={activeProjectPath}
			agentName={activeAgentName}
			pendingApprovals={pendingApprovalCount}
			sessions={runtimeSessions}
			projects={workspaceGrants}
			onNewTask={() => startNewAgent()}
			onOpenBrowser={openBrowser}
			onOpenAgent={openAgent}
			onOpenWriting={openWritingStudio}
			onReviewApprovals={reviewApprovals}
			onOpenCapabilities={openCommandCenter}
			onOpenProjects={() => void openAppPage("projects")}
			onOpenSettings={() => openSettings("browser")}
			onOpenProject={openProject}
			onOpenProjectChat={startProjectChat}
			onOpenSession={openSidebarSession}
			onOpenChats={() => void openAppPage("agent")}
			onOpenScheduled={() => void openAppPage("work")}
		/>
	) : undefined;
	return (
		<ProductShellTransition>
			<motion.div
				key="workspace"
				className={`ai-browser-app ${presentedAgentSidebarOpen ? "" : "agent-sidebar-collapsed"}${showKestrelSidebar ? " kestrel-sidebar-visible" : ""} unified-ui configuration-density-${snapshot.configuration.ui.density}`}
				initial={reduced ? false : { opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: reduced ? 1 : 0, pointerEvents: "none" }}
				transition={{ duration: reduced ? 0 : 0.14 }}
			>
					<section className="browser-main-plane">
						<AnimatePresence initial={false}>
							{deepLinkNotice && (
								<motion.small
									key="deep-link-notice"
									className="browser-notice"
									role="status"
									initial={reduced ? false : { opacity: 0, x: "-50%", y: 8 }}
									animate={{ opacity: 1, x: "-50%", y: 0 }}
									exit={
										reduced
											? { opacity: 1, x: "-50%", y: 0, pointerEvents: "none" }
											: { opacity: 0, x: "-50%", y: 8, pointerEvents: "none" }
									}
									transition={reduced ? { duration: 0 } : KESTREL_STATE_TRANSITION}
								>
									{deepLinkNotice}
								</motion.small>
							)}
						</AnimatePresence>
					<BrowserWorkspace
						browser={browser}
						agentName={activeAgentName}
						greetingName={greetingName}
						navigationSidebar={kestrelNavigation}
						agentOpen={presentedAgentSidebarOpen}
						onToggleAgent={toggleAgentSidebar}
						onNewAgent={startNewAgent}
						onOpenTaskSettings={openTaskSettings}
						onOpenSettings={() => openSettings("browser")}
						onOpenWorkspaces={() => openSettings("connections")}
						onOpenHistory={openBrowserHistory}
						onOpenDownloads={openBrowserDownloads}
						onOpenBookmarks={openBrowserBookmarks}
						onOpenMenu={openCommandCenter}
						onShowShortcuts={() => setShowShortcuts(true)}
						onAskFile={askFileFromTab}
						sessions={runtimeSessions}
						onOpenSession={openSidebarSession}
						organizeTabsRequestId={organizeTabsRequestId}
						memories={snapshot?.memories ?? []}
						memoryRecall={
							snapshot?.memoryRecall ?? {
								chatInjection: "off",
								activeMemories: 0,
								confirmedPreferences: 0,
								explicitCapture: true,
								personalityScope: "shared",
								personalityName: activeAgentName,
								useSharedContext: true,
								offReason: "Loading memory status…",
							}
						}
						onOpenLifeMemory={() => void openAppPage("memory")}
						{...(appPage ? { appPage } : {})}
					/>
				</section>
				<AgentSidebar
					communicationAssistant={
						<CommunicationCodeAssistant
							browser={browser}
							enabled={!currentAppPage}
							onOpenConnections={() => openSettings("connections")}
						/>
					}
					sessions={runtimeSessions}
					activeSessionId={activeRuntimeSessionId}
					agentName={activeAgentName}
					collapsed={!presentedAgentSidebarOpen}
					onNewAgent={startNewAgent}
					onToggleAgent={toggleAgentSidebar}
					onExpandChat={openAgent}
				>
					{/* Conversation state stays mounted across browser and settings routes so
            streams, steering, cancellation, and approval boundaries remain intact. */}
					<RuntimeConversation
						visible
						activeSessionId={activeRuntimeSessionId}
						sessions={runtimeSessions}
						onActiveSession={openRuntimeSession}
						onSessions={setRuntimeSessions}
						onSnapshot={setSnapshot}
						onRuntimeAgentState={setRuntimeAgentState}
						configurationUi={snapshot.configuration.ui}
						{...(activeFileAttachment ? { activeFileAttachment } : {})}
						externalIntake={externalIntake}
						externalIntakeRequestId={externalIntakeRequestId}
						newAgentRequestId={newAgentRequestId}
						newAgentPrompt={newAgentPrompt}
						newAgentWorkspace={newAgentWorkspace}
						newAgentFocusTarget={newAgentFocusTarget}
						refreshRevision={runtimeRefreshRevision}
						mentionTabs={browser.state?.tabs ?? []}
						mentionBookmarks={browser.state?.bookmarks ?? []}
						{...(browserContextEnabled
							? { browserContext: () => browser.pageContext() }
							: {})}
						transcriptTarget={transcriptTarget}
						onTranscriptTargetHandled={() => setTranscriptTarget(null)}
						onOpenActivity={(executionId) => {
							setActivityFocusExecutionId(executionId);
							navigate("activity");
						}}
						onReviewLearnedSkill={reviewLearnedSkill}
					/>
				</AgentSidebar>
				<DefaultBrowserPrompt
					isOpen={showDefaultBrowserPrompt}
					onClose={() => {
						localStorage.setItem("kestrel:default-browser-prompted", "yes");
						setShowDefaultBrowserPrompt(false);
					}}
					onSetDefault={() => {
						localStorage.setItem("kestrel:default-browser-prompted", "yes");
						setShowDefaultBrowserPrompt(false);
					}}
				/>
				<AnimatePresence initial={false}>
				{showShortcuts && (
					<KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />
				)}
				</AnimatePresence>
			</motion.div>
		</ProductShellTransition>
	);
}
