import {
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
	history,
	bookmarks = [],
	downloads = [],
	tabs = [],
	originFavicons = [],
	background,
	backgroundCustomDataUrl,
	agentName,
	sessions = [],
	widgetSettings,
	onUpdateWidgetSettings,
	onNavigate,
	onNewAgent,
	onOpenHistory,
	onOpenDownloads,
	onOpenBookmarks,
	onOpenSession,
}: {
	history: UserBrowserHistoryEntry[];
	bookmarks?: UserBrowserBookmark[] | undefined;
	downloads?: UserBrowserDownload[] | undefined;
	tabs?: Pick<UserBrowserTab, "url" | "faviconDataUrl">[] | undefined;
  originFavicons?:
    | Pick<UserBrowserOriginFavicon, "origin" | "faviconDataUrl">[]
    | undefined;
	background: UserBrowserSettings["newTabBackground"];
	backgroundCustomDataUrl?: UserBrowserSettings["newTabBackgroundCustomDataUrl"];
	agentName: string;
	sessions?: RuntimeSession[] | undefined;
	widgetSettings: UserBrowserSettings["newTabWidgets"];
	onUpdateWidgetSettings(next: UserBrowserSettings["newTabWidgets"]): void;
	onNavigate(input: string): void;
	onNewAgent(prompt?: string): void;
	onOpenHistory(): void;
	onOpenDownloads(): void;
	onOpenBookmarks(): void;
	onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
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
          <h1 id="new-tab-title">Hi there, what should we dive into today?</h1>

          <form className="kestrel-home-composer" onSubmit={submitChat}>
            <details className="kestrel-home-model-selector">
              <summary aria-label="Model selector: Smart" title="Model selector">
                <span>Smart</span>
                <Icon name="chevron" />
              </summary>
              <div className="kestrel-home-model-popover">
                <strong>Smart routing</strong>
                <p>Model and thinking level live in task settings.</p>
                <button type="button" onClick={() => onNewAgent()}>
                  Open task settings
                </button>
              </div>
            </details>

            <label className="sr-only" htmlFor="new-tab-chat-input">
              Message {agentName} or enter a website
            </label>
            <input
              ref={inputRef}
              id="new-tab-chat-input"
              value={input}
              placeholder={`Message ${agentName}, enter a website, or @ mention a tab`}
              autoCapitalize="sentences"
              autoCorrect="on"
              spellCheck
              onChange={(event) => setInput(event.target.value)}
            />
            <button
              type="submit"
              className="kestrel-home-send"
              aria-label={`Open message in ${agentName} composer`}
              title={`Open message in ${agentName} composer`}
              disabled={!input.trim()}
            >
              <Icon name="arrow" />
            </button>
          </form>
        </header>

		<NewTabWidgets
			frequent={frequent}
			bookmarks={bookmarks}
			downloads={downloads}
			sessions={sessions}
			suggestedActions={suggestedActions}
			agentName={agentName}
			onNavigate={onNavigate}
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
