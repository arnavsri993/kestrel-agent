import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
} from "react";
import type {
	MemoryRecord,
	MemoryRecallStatus,
	Project,
	RuntimeSession,
	UserBrowserBookmark,
	UserBrowserDownload,
	UserBrowserHistoryEntry,
	UserBrowserOriginFavicon,
	UserBrowserSettings,
	UserBrowserTab,
} from "@kestrel/shared-types";
import { NewTabComposer } from "./NewTabComposer";
import type { NewTabComposerDraft } from "./new-tab-composer";
import {
	frequentBrowserSites,
	newTabGreetingContext,
	newTabGreetingFallback,
	validateNewTabGreeting,
	originFaviconMap,
	suggestedAgentActions,
} from "./new-tab";
import { NewTabPersonalization } from "./NewTabPersonalization";
import { NewTabWidgets } from "./NewTabWidgets";
import "./new-tab.css";
import "./liquid-glass.css";
import "./new-tab-composer.css";

export function NewTabPage({
	tabId,
	history,
	bookmarks = [],
	downloads = [],
	tabs = [],
	originFavicons = [],
	background,
	backgroundCustomDataUrl,
	agentName,
	greetingName,
	sessions = [],
	greetingActivity,
	widgetSettings,
	memories = [],
	memoryRecall,
	onUpdateWidgetSettings,
	onRecordGreetingVisit,
	onNavigate,
	onOpenTab,
	onNewAgent,
	onOpenLifeMemory,
	onOpenHistory,
	onOpenDownloads,
	onOpenBookmarks,
	onOpenSession,
	projects = [],
	onProjectsChange,
	onSubmitDraft,
	shortcutSettings,
	onUpdateHomeSettings,
}: {
	tabId: string;
	history: UserBrowserHistoryEntry[];
	bookmarks?: UserBrowserBookmark[] | undefined;
	downloads?: UserBrowserDownload[] | undefined;
	tabs?: Pick<
		UserBrowserTab,
		"id" | "title" | "url" | "faviconDataUrl" | "pinned"
	>[] | undefined;
  originFavicons?:
    | Pick<UserBrowserOriginFavicon, "origin" | "faviconDataUrl">[]
    | undefined;
	background: UserBrowserSettings["newTabBackground"];
	backgroundCustomDataUrl?: UserBrowserSettings["newTabBackgroundCustomDataUrl"];
	agentName: string;
	greetingName?: string | undefined;
	sessions?: RuntimeSession[] | undefined;
	greetingActivity: UserBrowserSettings["newTabGreetingActivity"];
	widgetSettings: UserBrowserSettings["newTabWidgets"];
	memories?: MemoryRecord[] | undefined;
	memoryRecall: MemoryRecallStatus;
	onUpdateWidgetSettings(next: UserBrowserSettings["newTabWidgets"]): void;
	onRecordGreetingVisit(now: Date): void;
	onNavigate(input: string): void;
	onOpenTab(tabId: string): void;
	onNewAgent(prompt?: string): void;
	onOpenTaskSettings(): void;
	onOpenLifeMemory?(): void;
	onOpenHistory(): void;
	onOpenDownloads(): void;
	onOpenBookmarks(): void;
	onOpenSession?: ((sessionId: string) => void) | undefined;
	projects?: Project[];
	onProjectsChange(projects: Project[]): void;
	onSubmitDraft(draft: NewTabComposerDraft): boolean;
	shortcutSettings?: UserBrowserSettings["newTabShortcuts"];
	onUpdateHomeSettings(next: Partial<UserBrowserSettings>): Promise<unknown>;
}) {
	const [customizeRequestId, setCustomizeRequestId] = useState(0);
	const greetingSessionRef = useRef<{
		tabId: string;
		now: Date;
		activity: UserBrowserSettings["newTabGreetingActivity"];
	} | null>(null);
	if (greetingSessionRef.current?.tabId !== tabId) {
		greetingSessionRef.current = {
			tabId,
			now: new Date(),
			activity: greetingActivity,
		};
	}
	const greetingSession = greetingSessionRef.current;
	const greetingNow = greetingSession!.now;
	const greetingActivityAtOpen = greetingSession!.activity;
	const greetingContext = useMemo(
		() =>
			newTabGreetingContext(
				greetingActivityAtOpen,
				greetingName,
				greetingNow,
			),
		[greetingActivityAtOpen, greetingName, greetingNow],
	);
	const [greeting, setGreeting] = useState(() =>
		newTabGreetingFallback(greetingName, greetingContext.currentTimeOfDay),
	);
	const recordedGreetingTabRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (recordedGreetingTabRef.current === tabId) return;
		recordedGreetingTabRef.current = tabId;
		onRecordGreetingVisit(greetingNow);
	}, [greetingNow, onRecordGreetingVisit, tabId]);
	useEffect(() => {
		let active = true;
		setGreeting(
			newTabGreetingFallback(greetingName, greetingContext.currentTimeOfDay),
		);
		void window.kestrel
			.request({ type: "new-tab-greeting", ...greetingContext })
			.then((response) => {
				if (!active || !response.ok || !("newTabGreeting" in response)) return;
				const generated = validateNewTabGreeting(response.newTabGreeting);
				if (generated) setGreeting(generated);
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [greetingContext, greetingName]);
	const faviconByOrigin = useMemo(
		() => originFaviconMap(originFavicons, tabs),
		[originFavicons, tabs],
	);
	const frequent = useMemo(
		() => frequentBrowserSites(history, 7, faviconByOrigin),
		[faviconByOrigin, history],
	);
	const suggestedActions = useMemo(
		() => suggestedAgentActions(history, 5, sessions),
		[history, sessions],
	);
  const customBackgroundStyle: CSSProperties | undefined =
    background === "custom" && backgroundCustomDataUrl
      ? { backgroundImage: `url("${backgroundCustomDataUrl}")` }
      : undefined;

  function chooseAction(prompt: string) {
    onNewAgent(prompt);
  }

  return (
    <section
      className={`new-tab-page kestrel-home new-tab-page-${background}`}
      aria-labelledby="new-tab-title"
    >
      <div
        className="kestrel-home-backdrop"
        aria-hidden="true"
        style={customBackgroundStyle}
      />
      <div className="kestrel-home-content">
        <header className="kestrel-home-hero">
          <h1 id="new-tab-title">{greeting}</h1>

          <NewTabComposer agentName={agentName} projects={projects} onProjectsChange={onProjectsChange} onNavigate={onNavigate} onSubmitDraft={onSubmitDraft} />
        </header>

        <NewTabPersonalization frequent={frequent} shortcuts={shortcutSettings ?? []}
          background={background} onUpdate={onUpdateHomeSettings} onNavigate={onNavigate}
          onEditWidgets={() => setCustomizeRequestId((value) => value + 1)} />
		<NewTabWidgets
            customizeRequestId={customizeRequestId}
			frequent={frequent}
			history={history}
			bookmarks={bookmarks}
			originFavicons={originFavicons}
			downloads={downloads}
			tabs={tabs}
			sessions={sessions}
			suggestedActions={suggestedActions}
			memories={memories}
			memoryRecall={memoryRecall}
			agentName={agentName}
			onNavigate={onNavigate}
			onOpenTab={onOpenTab}
			onNewAgent={chooseAction}
			onOpenSession={onOpenSession}
			{...(onOpenLifeMemory ? { onOpenLifeMemory } : {})}
			onOpenHistory={onOpenHistory}
			onOpenDownloads={onOpenDownloads}
			onOpenBookmarks={onOpenBookmarks}
			settings={widgetSettings}
			onSettingsChange={onUpdateWidgetSettings}
		/>
      </div>
    </section>
  );
}
