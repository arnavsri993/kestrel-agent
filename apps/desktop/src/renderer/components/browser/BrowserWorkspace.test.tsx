import { UserBrowserStateSchema } from "@kestrel/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useUserBrowser } from "../../browser/useUserBrowser";
import { BrowserWorkspace } from "./BrowserWorkspace";

const surface = vi.hoisted(() => ({ current: "electron" }));
vi.mock("../../native-extension-transport", () => ({
  get nativeChromiumSurface() { return surface.current !== "electron"; },
  get nativeChromiumFrameShell() { return surface.current === "frame"; },
  nativeChromiumPanel: false,
  useNativeDocumentTabId: () => "tab-00000000-0000-4000-a000-000000000001",
}));

const tabId = "tab-00000000-0000-4000-a000-000000000001";
const state = UserBrowserStateSchema.parse({
  activeTabId: tabId, settings: {}, history: [], downloads: [],
  tabs: [{
    id: tabId, title: "Example", url: "https://example.org/", loading: false,
    canGoBack: false, canGoForward: false, discarded: false, crashed: false,
    createdAt: "2026-01-01T00:00:00Z", lastActiveAt: "2026-01-01T00:00:00Z",
  }],
});

function Workspace() {
  const controller = useUserBrowser();
  const noop = () => {};
  return <BrowserWorkspace
    browser={{ ...controller, state }} agentName="Kestrel" agentOpen={false}
    onToggleAgent={noop} onNewAgent={noop} onOpenTaskSettings={noop} onOpenSettings={noop}
    onOpenHistory={noop} onOpenDownloads={noop} onOpenBookmarks={noop} onOpenMenu={noop}
    onAskFile={noop} onProjectsChange={noop} onSubmitNewTabDraft={() => false}
    memoryRecall={{ chatInjection: "off", activeMemories: 0, confirmedPreferences: 0,
      explicitCapture: false, personalityScope: "shared", personalityName: "Kestrel", useSharedContext: false }}
  />;
}

describe("extension controls in the browser workspace", () => {
  it.each([
    { runtime: "electron", toolbar: true, rendererExtensions: true },
    { runtime: "frame", toolbar: true, rendererExtensions: false },
    { runtime: "home", toolbar: false, rendererExtensions: false },
  ])("renders the expected toolbar on $runtime", ({ runtime, toolbar, rendererExtensions }) => {
    surface.current = runtime;
    const markup = renderToStaticMarkup(<Workspace />);
    expect(markup.includes('aria-label="Browser toolbar"')).toBe(toolbar);
    expect(markup.includes('aria-label="Extensions"')).toBe(rendererExtensions);
    expect(markup.includes("browser-extension-cluster")).toBe(rendererExtensions);
  });
});
