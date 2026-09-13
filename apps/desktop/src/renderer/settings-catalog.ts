/**
 * The settings information architecture is deliberately data driven. Keeping
 * the ids, labels, tiers, and search terms in one place prevents the desktop
 * shell, deep links, compact picker, and parity ledger from growing separate
 * lists that drift apart.
 */

export type SettingsScope = "browser" | "agent";
export type SettingsTier = "basic" | "advanced";

export type BrowserSettingsSection =
	| "browser"
	| "browser-startup"
	| "browser-appearance"
	| "browser-search"
	| "browser-privacy"
	| "browser-autofill"
	| "browser-performance"
	| "browser-downloads"
	| "browser-languages"
	| "browser-extensions"
	| "browser-system"
	| "browser-reset";

export type AgentSettingsSection =
	| "agent-general"
	| "agent-connections"
	| "agent-models"
	| "agent-memory"
	| "agent-workspace"
	| "agent-tools"
	| "agent-automations"
	| "agent-permissions"
	| "agent-privacy"
	| "agent-diagnostics"
	| "agent-migration";

export type CanonicalSettingsSection =
	| BrowserSettingsSection
	| AgentSettingsSection;

export type LegacySettingsSection =
	| "general"
	| "connections"
	| "models"
	| "intelligence"
	| "extensions"
	| "privacy"
	| "advanced";

export type SettingsSection = CanonicalSettingsSection | LegacySettingsSection;

export interface SettingsSectionDefinition {
	id: CanonicalSettingsSection;
	legacyIds?: readonly LegacySettingsSection[];
	scope: SettingsScope;
	tier: SettingsTier;
	label: string;
	description: string;
}

export interface SettingSearchEntry {
	id: string;
	section: CanonicalSettingsSection;
	scope: SettingsScope;
	tier: SettingsTier;
	label: string;
	description: string;
	keywords: readonly string[];
	anchor: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
	{
		id: "browser",
		scope: "browser",
		tier: "basic",
		label: "Browser",
		description: "Tabs, search, and privacy",
	},
	{
		id: "browser-startup",
		scope: "browser",
		tier: "basic",
		label: "Startup",
		description: "What opens at launch",
	},
	{
		id: "browser-appearance",
		scope: "browser",
		tier: "basic",
		label: "Appearance & new tab",
		description: "Tabs, theme, bookmarks, and zoom",
	},
	{
		id: "browser-search",
		scope: "browser",
		tier: "basic",
		label: "Search & address bar",
		description: "Search engine and suggestions",
	},
	{
		id: "browser-privacy",
		scope: "browser",
		tier: "basic",
		label: "Privacy & permissions",
		description: "Site access, history, and page sharing",
	},
	{
		id: "browser-autofill",
		scope: "browser",
		tier: "basic",
		label: "Autofill",
		description: "Passwords and payment cards",
	},
	{
		id: "browser-performance",
		scope: "browser",
		tier: "basic",
		label: "Performance",
		description: "Sleeping tabs and memory use",
	},
	{
		id: "browser-downloads",
		scope: "browser",
		tier: "advanced",
		label: "Downloads",
		description: "Download folder and prompts",
	},
	{
		id: "browser-languages",
		scope: "browser",
		tier: "advanced",
		label: "Languages & accessibility",
		description: "Language, spellcheck, and page text",
	},
	{
		id: "browser-extensions",
		scope: "browser",
		tier: "advanced",
		label: "Extensions",
		description: "Installed extensions",
	},
	{
		id: "browser-system",
		scope: "browser",
		tier: "advanced",
		label: "System",
		description: "Default browser and hardware",
	},
	{
		id: "browser-reset",
		scope: "browser",
		tier: "advanced",
		label: "Data & reset",
		description: "Import, export, and reset",
	},
	{
		id: "agent-general",
		legacyIds: ["general"],
		scope: "agent",
		tier: "basic",
		label: "General",
		description: "Startup, communication, and autonomy",
	},
	{
		id: "agent-connections",
		legacyIds: ["connections"],
		scope: "agent",
		tier: "basic",
		label: "Connections",
		description: "Accounts, providers, and project access",
	},
	{
		id: "agent-models",
		legacyIds: ["models"],
		scope: "agent",
		tier: "basic",
		label: "Models & routing",
		description: "Models, routing, and limits",
	},
	{
		id: "agent-memory",
		legacyIds: ["intelligence"],
		scope: "agent",
		tier: "basic",
		label: "Memory & context",
		description: "Memory, context, and skills",
	},
	{
		id: "agent-workspace",
		scope: "agent",
		tier: "advanced",
		label: "Workspace & sessions",
		description: "Projects, agents, and sessions",
	},
	{
		id: "agent-tools",
		legacyIds: ["extensions"],
		scope: "agent",
		tier: "advanced",
		label: "Tools, MCP & skills",
		description: "Plugins, tools, and skills",
	},
	{
		id: "agent-automations",
		scope: "agent",
		tier: "advanced",
		label: "Automations",
		description: "Scheduled work",
	},
	{
		id: "agent-permissions",
		legacyIds: ["privacy"],
		scope: "agent",
		tier: "advanced",
		label: "Permissions & sandbox",
		description: "Approvals and desktop access",
	},
	{
		id: "agent-privacy",
		scope: "agent",
		tier: "advanced",
		label: "Privacy & credentials",
		description: "Credentials and data controls",
	},
	{
		id: "agent-diagnostics",
		legacyIds: ["advanced"],
		scope: "agent",
		tier: "advanced",
		label: "Diagnostics",
		description: "Health, policy, and custom agents",
	},
	{
		id: "agent-migration",
		scope: "agent",
		tier: "advanced",
		label: "Migration",
		description: "Imports from supported tools",
	},
] as const;

export const SETTINGS_CATALOG: readonly SettingSearchEntry[] = [
	{
		id: "browser.startup.behavior",
		section: "browser-startup",
		scope: "browser",
		tier: "basic",
		label: "Startup behavior",
		description: "Choose what opens at launch.",
		keywords: ["startup", "launch", "restore", "homepage", "open"],
		anchor: "setting-browser-startup-behavior",
	},
	{
		id: "browser.startup.homepage",
		section: "browser-startup",
		scope: "browser",
		tier: "basic",
		label: "Homepage",
		description: "Set a page to open at launch.",
		keywords: ["home", "homepage", "start page", "url"],
		anchor: "setting-browser-homepage",
	},
	{
		id: "browser.startup.specific-pages",
		section: "browser-startup",
		scope: "browser",
		tier: "basic",
		label: "Specific startup pages",
		description: "Choose pages to open at launch.",
		keywords: ["startup", "pages", "launch", "open", "restore"],
		anchor: "setting-browser-startup-pages",
	},
	{
		id: "browser.appearance.new-tab",
		section: "browser-appearance",
		scope: "browser",
		tier: "basic",
		label: "New tab background",
		description: "Choose a background.",
		keywords: ["new tab", "background", "theme", "appearance"],
		anchor: "setting-browser-new-tab-background",
	},
	{
		id: "browser.appearance.tab-layout",
		section: "browser-appearance",
		scope: "browser",
		tier: "basic",
		label: "Tab layout",
		description: "Use horizontal or vertical tabs.",
		keywords: ["tabs", "vertical", "horizontal", "layout"],
		anchor: "setting-browser-tab-layout",
	},
	{
		id: "browser.appearance.bookmarks-bar",
		section: "browser-appearance",
		scope: "browser",
		tier: "basic",
		label: "Bookmarks bar",
		description: "Show saved pages below the toolbar.",
		keywords: ["bookmarks", "favorites", "bar", "appearance"],
		anchor: "setting-browser-bookmarks-bar",
	},
	{
		id: "browser.appearance.zoom",
		section: "browser-appearance",
		scope: "browser",
		tier: "basic",
		label: "Default page zoom",
		description: "Set the zoom applied to new pages.",
		keywords: ["zoom", "scale", "size"],
		anchor: "setting-browser-default-zoom",
	},
	{
		id: "browser.search.engine",
		section: "browser-search",
		scope: "browser",
		tier: "basic",
		label: "Default search engine",
		description: "Choose where address-bar searches go.",
		keywords: ["search", "engine", "google", "bing", "duckduckgo"],
		anchor: "setting-browser-search-engine",
	},
	{
		id: "browser.search.suggestions",
		section: "browser-search",
		scope: "browser",
		tier: "basic",
		label: "Address bar suggestions",
		description: "Show history, saved pages, and open tabs.",
		keywords: ["address", "omnibox", "suggestions", "history"],
		anchor: "setting-browser-address-suggestions",
	},
	{
		id: "browser.search.custom",
		section: "browser-search",
		scope: "browser",
		tier: "basic",
		label: "Custom search engine",
		description: "Set a search URL template.",
		keywords: ["search", "custom", "template", "url", "engine"],
		anchor: "setting-browser-search-engine",
	},
	{
		id: "browser.privacy.site-permissions",
		section: "browser-privacy",
		scope: "browser",
		tier: "basic",
		label: "Site permissions",
		description: "Review and revoke remembered site access.",
		keywords: ["privacy", "permission", "camera", "microphone", "site"],
		anchor: "setting-browser-site-permissions",
	},
	{
		id: "browser.privacy.page-context",
		section: "browser-privacy",
		scope: "browser",
		tier: "basic",
		label: "Page context for Agent",
		description: "Let Kestrel use the current page when you ask.",
		keywords: ["privacy", "page", "context", "agent", "sharing"],
		anchor: "setting-browser-page-context",
	},
	{
		id: "browser.privacy.history-retention",
		section: "browser-privacy",
		scope: "browser",
		tier: "basic",
		label: "History retention",
		description: "Choose how long to keep history.",
		keywords: ["privacy", "history", "retention", "clear", "delete"],
		anchor: "setting-browser-history-retention",
	},
	{
		id: "browser.autofill.passwords",
		section: "browser-autofill",
		scope: "browser",
		tier: "basic",
		label: "Passwords and personal info autofill",
		description: "Manage password autofill and save prompts.",
		keywords: ["password", "login", "autofill", "credential", "address", "birthday", "name", "phone", "email"],
		anchor: "setting-browser-password-autofill",
	},
	{
		id: "browser.autofill.payments",
		section: "browser-autofill",
		scope: "browser",
		tier: "basic",
		label: "Payment autofill",
		description: "Use saved cards after you confirm.",
		keywords: ["payment", "card", "autofill", "checkout"],
		anchor: "setting-browser-payment-autofill",
	},
	{
		id: "browser.performance.sleeping-tabs",
		section: "browser-performance",
		scope: "browser",
		tier: "basic",
		label: "Sleeping tabs",
		description: "Put inactive tabs to sleep.",
		keywords: ["performance", "memory", "sleep", "hibernate", "saver"],
		anchor: "setting-browser-sleeping-tabs",
	},
	{
		id: "browser.performance.sleeping-tab-timeout",
		section: "browser-performance",
		scope: "browser",
		tier: "basic",
		label: "Sleeping tab timeout",
		description: "Choose how long an inactive tab stays live.",
		keywords: ["performance", "sleep", "timeout", "inactive", "memory"],
		anchor: "setting-browser-sleeping-timeout",
	},
	{
		id: "browser.performance.memory-saver",
		section: "browser-performance",
		scope: "browser",
		tier: "basic",
		label: "Memory Saver mode",
		description: "Use less memory for inactive tabs.",
		keywords: ["performance", "memory", "saver", "sleep", "hibernate"],
		anchor: "setting-browser-memory-saver",
	},
	{
		id: "browser.downloads.location",
		section: "browser-downloads",
		scope: "browser",
		tier: "advanced",
		label: "Download location",
		description: "Choose the folder or ask before each download.",
		keywords: ["download", "save", "folder", "location"],
		anchor: "setting-browser-download-location",
	},
	{
		id: "browser.languages.spellcheck",
		section: "browser-languages",
		scope: "browser",
		tier: "advanced",
		label: "Spellcheck and language",
		description: "Choose a spellcheck language.",
		keywords: ["language", "spellcheck", "dictionary", "accessibility"],
		anchor: "setting-browser-spellcheck",
	},
	{
		id: "browser.languages.fonts",
		section: "browser-languages",
		scope: "browser",
		tier: "advanced",
		label: "Fonts and minimum size",
		description: "Make page text easier to read.",
		keywords: ["font", "text", "minimum", "read", "accessibility"],
		anchor: "setting-browser-fonts",
	},
	{
		id: "browser.extensions.manage",
		section: "browser-extensions",
		scope: "browser",
		tier: "advanced",
		label: "Extensions",
		description: "Install, enable, or remove extensions.",
		keywords: ["extension", "add-on", "store", "web store"],
		anchor: "setting-browser-extensions",
	},
	{
		id: "browser.system.default",
		section: "browser-system",
		scope: "browser",
		tier: "advanced",
		label: "Default browser",
		description: "Make Kestrel your default browser.",
		keywords: ["system", "default", "browser", "protocol"],
		anchor: "setting-browser-default-browser",
	},
	{
		id: "browser.system.hardware-acceleration",
		section: "browser-system",
		scope: "browser",
		tier: "advanced",
		label: "Hardware acceleration",
		description: "Use your Mac's graphics hardware. Restart to apply.",
		keywords: ["system", "gpu", "hardware", "acceleration", "restart"],
		anchor: "setting-browser-hardware-acceleration",
	},
	{
		id: "browser.data.transfer",
		section: "browser-reset",
		scope: "browser",
		tier: "advanced",
		label: "Import and export browser data",
		description: "Import or export bookmarks, history, permissions, and preferences.",
		keywords: ["import", "export", "backup", "reset", "data"],
		anchor: "setting-browser-data-transfer",
	},
	{
		id: "browser.data.clear-history",
		section: "browser-reset",
		scope: "browser",
		tier: "advanced",
		label: "Clear browsing history",
		description: "Remove history, favicons, and recently closed tabs.",
		keywords: ["reset", "history", "clear", "delete", "data"],
		anchor: "setting-browser-clear-history",
	},
	{
		id: "browser.data.clear-site-data",
		section: "browser-reset",
		scope: "browser",
		tier: "advanced",
		label: "Clear site data",
		description: "Remove cookies, cache, and remembered site permissions.",
		keywords: ["reset", "cookies", "cache", "site", "data", "clear"],
		anchor: "setting-browser-clear-site-data",
	},
	{
		id: "browser.data.reset-settings",
		section: "browser-reset",
		scope: "browser",
		tier: "advanced",
		label: "Reset browser settings",
		description: "Restore preferences without deleting saved content.",
		keywords: ["reset", "defaults", "settings", "restore"],
		anchor: "setting-browser-reset-settings",
	},
	{
		id: "agent.general.behavior",
		section: "agent-general",
		scope: "agent",
		tier: "basic",
		label: "Agent behavior",
		description: "Set autonomy, communication, and startup.",
		keywords: ["agent", "general", "behavior", "autonomy", "login"],
		anchor: "setting-agent-general",
	},
	{
		id: "agent.general.setup",
		section: "agent-general",
		scope: "agent",
		tier: "basic",
		label: "Setup guide",
		description: "Reopen setup without changing credentials.",
		keywords: ["agent", "setup", "onboarding", "guide"],
		anchor: "setting-agent-general",
	},
	{
		id: "agent.connections.providers",
		section: "agent-connections",
		scope: "agent",
		tier: "basic",
		label: "Connections and providers",
		description: "Sign in to providers and grant project access.",
		keywords: ["connection", "provider", "account", "workspace", "oauth"],
		anchor: "setting-agent-connections",
	},
	{
		id: "agent.models.routing",
		section: "agent-models",
		scope: "agent",
		tier: "basic",
		label: "Models and routing",
		description: "Choose routing priorities and limits.",
		keywords: ["model", "routing", "cost", "budget", "provider"],
		anchor: "setting-agent-models",
	},
	{
		id: "agent.models.providers",
		section: "agent-models",
		scope: "agent",
		tier: "basic",
		label: "Provider verification",
		description: "Check provider access without sending a prompt.",
		keywords: ["provider", "verify", "connection", "models", "health"],
		anchor: "setting-agent-models",
	},
	{
		id: "agent.models.usage-policy",
		section: "agent-models",
		scope: "agent",
		tier: "basic",
		label: "Usage policy",
		description: "Set cost and usage limits.",
		keywords: ["usage", "policy", "cost", "budget", "limit"],
		anchor: "setting-agent-models",
	},
	{
		id: "agent.memory.context",
		section: "agent-memory",
		scope: "agent",
		tier: "basic",
		label: "Memory and context",
		description: "Review memory and context.",
		keywords: ["memory", "context", "recall", "learn", "skills"],
		anchor: "setting-agent-memory",
	},
	{
		id: "agent.memory.recall",
		section: "agent-memory",
		scope: "agent",
		tier: "basic",
		label: "Memory recall",
		description: "Review memory status and limits.",
		keywords: ["memory", "recall", "health", "context"],
		anchor: "setting-agent-memory",
	},
	{
		id: "agent.workspace.sessions",
		section: "agent-workspace",
		scope: "agent",
		tier: "advanced",
		label: "Workspace, sessions, and agent planets",
		description: "Manage folder access, agents, and sessions.",
		keywords: ["workspace", "project", "folder", "session", "agent", "planet", "moon"],
		anchor: "setting-agent-workspace",
	},
	{
		id: "agent.tools.plugins",
		section: "agent-tools",
		scope: "agent",
		tier: "advanced",
		label: "Tools, MCP, and skills",
		description: "Review plugins and learned skills.",
		keywords: ["tools", "mcp", "plugin", "skills", "extensions"],
		anchor: "setting-agent-tools",
	},
	{
		id: "agent.tools.skills",
		section: "agent-tools",
		scope: "agent",
		tier: "advanced",
		label: "Learned skills",
		description: "Review skill proposals.",
		keywords: ["skills", "learned", "review", "proposal", "agent"],
		anchor: "setting-agent-tools",
	},
	{
		id: "agent.automations.schedule",
		section: "agent-automations",
		scope: "agent",
		tier: "advanced",
		label: "Automations and orchestration",
		description: "Review scheduled work.",
		keywords: ["automation", "schedule", "cron", "orchestration", "jobs"],
		anchor: "setting-agent-automations",
	},
	{
		id: "agent.permissions.approvals",
		section: "agent-permissions",
		scope: "agent",
		tier: "advanced",
		label: "Permissions and sandbox",
		description: "Manage approval rules and desktop access.",
		keywords: ["permission", "approval", "sandbox", "safety", "recovery"],
		anchor: "setting-agent-permissions",
	},
	{
		id: "agent.permissions.computer-use",
		section: "agent-permissions",
		scope: "agent",
		tier: "advanced",
		label: "Whole-desktop computer use",
		description:
			"Allow access to your screen and desktop.",
		keywords: [
			"computer",
			"computer use",
			"desktop",
			"screen recording",
			"accessibility",
			"control",
		],
		anchor: "setting-agent-computer-use",
	},
	{
		id: "agent.privacy.credentials",
		section: "agent-privacy",
		scope: "agent",
		tier: "advanced",
		label: "Privacy and credentials",
		description: "Review credential status and revoke access.",
		keywords: ["privacy", "credential", "secret", "key", "data"],
		anchor: "setting-agent-privacy",
	},
	{
		id: "agent.privacy.external-secrets",
		section: "agent-privacy",
		scope: "agent",
		tier: "advanced",
		label: "External secrets",
		description: "Check external secret providers.",
		keywords: ["secret", "credential", "keychain", "privacy", "vault"],
		anchor: "setting-agent-privacy",
	},
	{
		id: "agent.diagnostics.health",
		section: "agent-diagnostics",
		scope: "agent",
		tier: "advanced",
		label: "Diagnostics and policy",
		description: "Run diagnostics and inspect policy.",
		keywords: ["diagnostics", "observability", "policy", "health"],
		anchor: "setting-agent-diagnostics",
	},
	{
		id: "agent.migration.review",
		section: "agent-migration",
		scope: "agent",
		tier: "advanced",
		label: "Migration",
		description: "Review imports from other tools.",
		keywords: ["migration", "import", "codex", "hermes", "openclaw"],
		anchor: "setting-agent-migration",
	},
] as const;

export const LEGACY_SETTINGS_SECTION_ALIASES: Readonly<
	Record<LegacySettingsSection, CanonicalSettingsSection>
> = {
	general: "agent-general",
	connections: "agent-connections",
	models: "agent-models",
	intelligence: "agent-memory",
	extensions: "agent-tools",
	privacy: "agent-permissions",
	advanced: "agent-diagnostics",
};

export function normalizeSettingsSection(
	section: SettingsSection | undefined,
): CanonicalSettingsSection {
	if (!section) return "agent-connections";
	return LEGACY_SETTINGS_SECTION_ALIASES[
		section as LegacySettingsSection
	] ?? (section as CanonicalSettingsSection);
}

export function settingsScopeForSection(
	section: SettingsSection | undefined,
): SettingsScope {
	return normalizeSettingsSection(section).startsWith("browser")
		? "browser"
		: "agent";
}

export function sectionDefinition(
	section: SettingsSection | undefined,
): SettingsSectionDefinition {
	const normalized = normalizeSettingsSection(section);
	return (
		SETTINGS_SECTIONS.find((candidate) => candidate.id === normalized) ??
		SETTINGS_SECTIONS[0]!
	);
}

export function settingsSectionMatchesQuery(
	entry: SettingSearchEntry,
	query: string,
): boolean {
	const normalized = query.trim().toLocaleLowerCase();
	if (!normalized) return true;
	return [
		entry.label,
		entry.description,
		entry.id,
		...entry.keywords,
	].some((value) => value.toLocaleLowerCase().includes(normalized));
}
