import type { UserBrowserSettings } from "@kestrel/shared-types";

export interface ConfigurationPromptContext {
	density: "comfortable" | "compact";
	showToolActivity: boolean;
	showConfigurationDiffs?: boolean;
	searchEngine?: UserBrowserSettings["searchEngine"];
	tabLayout?: UserBrowserSettings["tabLayout"];
	contextEnabled?: boolean;
	launchAtLogin?: boolean;
	paused?: boolean;
}

const SEARCH_ENGINE_LABEL: Record<
	UserBrowserSettings["searchEngine"],
	string
> = {
	google: "Google",
	duckduckgo: "DuckDuckGo",
	bing: "Bing",
	brave: "Brave Search",
	ecosia: "Ecosia",
	startpage: "Startpage",
	yahoo: "Yahoo",
	kagi: "Kagi",
	qwant: "Qwant",
	mojeek: "Mojeek",
	baidu: "Baidu",
	yandex: "Yandex",
	custom: "a custom engine",
};

const SEARCH_ENGINE_ALTERNATIVE: Record<
	UserBrowserSettings["searchEngine"],
	Exclude<UserBrowserSettings["searchEngine"], "custom">
> = {
	google: "duckduckgo",
	duckduckgo: "google",
	bing: "google",
	brave: "duckduckgo",
	ecosia: "google",
	startpage: "google",
	yahoo: "google",
	kagi: "google",
	qwant: "duckduckgo",
	mojeek: "duckduckgo",
	baidu: "google",
	yandex: "google",
	custom: "google",
};

/**
 * Build chat-configuration starters from the person's live settings.
 * Each prompt asks to change a current value; none are a fixed sample list.
 */
export function personalizedConfigurationPrompts(
	context: ConfigurationPromptContext,
	limit = 4,
): string[] {
	const count = Math.max(0, limit);
	const prompts: string[] = [];

	if (context.searchEngine) {
		const nextEngine = SEARCH_ENGINE_ALTERNATIVE[context.searchEngine];
		prompts.push(`Set search engine to ${SEARCH_ENGINE_LABEL[nextEngine]}`);
	}

	prompts.push(
		context.density === "compact"
			? "Make chat density comfortable"
			: "Make chat density compact",
	);

	if (context.tabLayout) {
		prompts.push(
			context.tabLayout === "vertical"
				? "Use horizontal tabs"
				: "Use vertical tabs",
		);
	}

	if (typeof context.contextEnabled === "boolean") {
		prompts.push(
			context.contextEnabled
				? "Turn off current page context sharing"
				: "Enable current page context sharing",
		);
	}

	prompts.push(
		context.showToolActivity
			? "Hide routine tool progress"
			: "Show tool activity in chat",
	);

	if (typeof context.showConfigurationDiffs === "boolean") {
		prompts.push(
			context.showConfigurationDiffs
				? "Hide configuration diffs"
				: "Show configuration diffs",
		);
	}

	if (typeof context.launchAtLogin === "boolean") {
		prompts.push(
			context.launchAtLogin
				? "Stop launching Kestrel at login"
				: "Launch Kestrel at login",
		);
	}

	if (typeof context.paused === "boolean") {
		prompts.push(
			context.paused
				? "Resume background work"
				: "Pause background work",
		);
	}

	return uniquePrompts(prompts).slice(0, count);
}

function uniquePrompts(prompts: string[]): string[] {
	return [...new Set(prompts)];
}
