import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type FormEvent,
} from "react";
import type {
	RuntimeSession,
	UserBrowserBookmark,
	UserBrowserDownload,
	UserBrowserHistoryEntry,
	UserBrowserOriginFavicon,
	UserBrowserSettings,
	UserBrowserTab,
} from "@kestrel/shared-types";
import { Icon } from "../Icon";
import {
	frequentBrowserSites,
	newTabGreetingContext,
	newTabGreetingFallback,
	validateNewTabGreeting,
	originFaviconMap,
	suggestedAgentActions,
} from "./new-tab";
import { NewTabWidgets } from "./NewTabWidgets";
import "./new-tab.css";

function homeInputLooksLikeBrowse(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^(https?:\/\/|localhost(:\d+)?(\/|$))/i.test(trimmed)) return true;
  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    return (
      ["http:", "https:"].includes(parsed.protocol) && parsed.hostname.includes(".")
    );
  } catch {
    return false;
  }
}

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
	onUpdateWidgetSettings,
	onRecordGreetingVisit,
	onNavigate,
	onOpenTab,
	onNewAgent,
	onOpenTaskSettings,
	onOpenHistory,
	onOpenDownloads,
	onOpenBookmarks,
	onOpenSession,
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
	onUpdateWidgetSettings(next: UserBrowserSettings["newTabWidgets"]): void;
	onRecordGreetingVisit(now: Date): void;
	onNavigate(input: string): void;
	onOpenTab(tabId: string): void;
	onNewAgent(prompt?: string): void;
	onOpenTaskSettings(): void;
	onOpenHistory(): void;
	onOpenDownloads(): void;
	onOpenBookmarks(): void;
	onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
	const [input, setInput] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
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
		newTabGreetingFallback(greetingName),
	);
	const recordedGreetingTabRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (recordedGreetingTabRef.current === tabId) return;
		recordedGreetingTabRef.current = tabId;
		onRecordGreetingVisit(greetingNow);
	}, [greetingNow, onRecordGreetingVisit, tabId]);
	useEffect(() => {
		let active = true;
		setGreeting(newTabGreetingFallback(greetingName));
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
		() => suggestedAgentActions(history, 5),
		[history],
	);
  const customBackgroundStyle: CSSProperties | undefined =
    background === "custom" && backgroundCustomDataUrl
      ? { backgroundImage: `url("${backgroundCustomDataUrl}")` }
      : undefined;

  function submitChat(event: FormEvent) {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt) return;
    setInput("");
    if (homeInputLooksLikeBrowse(prompt)) {
      onNavigate(prompt);
      return;
    }
    onNewAgent(prompt);
  }

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

          <form className="kestrel-home-composer" onSubmit={submitChat}>
            <details className="kestrel-home-model-selector">
              <summary aria-label="Model selector: Smart" title="Model selector">
                <span>Smart</span>
                <Icon name="chevron" />
              </summary>
              <div className="kestrel-home-model-popover">
                <strong>Model routing</strong>
                <p>Choose provider and thinking level in task settings.</p>
				<button
					type="button"
					onClick={(event) => {
						event.currentTarget.closest("details")?.removeAttribute("open");
						onOpenTaskSettings();
					}}
				>
				  Open task settings
				</button>
              </div>
            </details>

            <label className="sr-only" htmlFor="new-tab-chat-input">
              Message {agentName} or enter a URL
            </label>
            <input
              ref={inputRef}
              id="new-tab-chat-input"
              value={input}
              placeholder={`Ask ${agentName} or enter a URL`}
              autoCapitalize="sentences"
              autoCorrect="on"
              spellCheck
              onChange={(event) => setInput(event.target.value)}
            />
            <button
              type="submit"
              className="kestrel-home-send"
              aria-label={`Send message to ${agentName}`}
              title={`Send message to ${agentName}`}
              disabled={!input.trim()}
            >
              <Icon name="arrow" />
            </button>
          </form>
        </header>

		<NewTabWidgets
			frequent={frequent}
			history={history}
			bookmarks={bookmarks}
			downloads={downloads}
			tabs={tabs}
			sessions={sessions}
			suggestedActions={suggestedActions}
			agentName={agentName}
			onNavigate={onNavigate}
			onOpenTab={onOpenTab}
			onNewAgent={chooseAction}
			onOpenSession={onOpenSession}
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
