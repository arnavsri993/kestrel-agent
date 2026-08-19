import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  class Emitter {
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    on(name: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
      return this;
    }
    once(name: string, handler: (...args: unknown[]) => void) {
      const once = (...args: unknown[]) => {
        this.off(name, once);
        handler(...args);
      };
      return this.on(name, once);
    }
    off(name: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(name, (this.handlers.get(name) ?? []).filter((item) => item !== handler));
      return this;
    }
    emit(name: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(name) ?? []) handler(...args);
    }
  }

  let nextWebContentsId = 1;
  class MockWebContents extends Emitter {
    id = nextWebContentsId++;
    destroyed = false;
    url = "";
    title = "";
    loadURL = vi.fn(async (url: string) => { this.url = url; });
    close = vi.fn(() => { this.destroyed = true; });
    reload = vi.fn();
    reloadIgnoringCache = vi.fn();
    zoomLevel = 0;
    getZoomLevel = vi.fn(() => this.zoomLevel);
    setZoomLevel = vi.fn((level: number) => { this.zoomLevel = level; });
    stop = vi.fn();
    focus = vi.fn();
    insertText = vi.fn();
    executeJavaScript = vi.fn();
    setWindowOpenHandler = vi.fn((handler) => { this.windowOpenHandler = handler; });
    windowOpenHandler: ((details: { url: string; disposition: "foreground-tab" | "background-tab" | "new-window" }) => { action: string }) | undefined;
    isDestroyed = () => this.destroyed;
    getURL = () => this.url;
    getTitle = () => this.title;
    findInPage = vi.fn();
    stopFindInPage = vi.fn();
    print = vi.fn();
    openDevTools = vi.fn();
    setAudioMuted = vi.fn();
    navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn(),
      clear: vi.fn(),
    };
    debugger = { isAttached: vi.fn(() => false), attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() };
  }
  class MockView {
    webContents = new MockWebContents();
    bounds: unknown;
    visible = false;
    constructor(public options: unknown) { state.views.push(this); }
    setBackgroundColor = vi.fn();
    setBounds = vi.fn((bounds: unknown) => { this.bounds = bounds; });
    setVisible = vi.fn((visible: boolean) => { this.visible = visible; });
  }
  class MockSession extends Emitter {
    permissionCheckHandler: unknown;
    permissionRequestHandler: unknown;
    setPermissionCheckHandler = vi.fn((handler) => { this.permissionCheckHandler = handler; });
    setPermissionRequestHandler = vi.fn((handler) => { this.permissionRequestHandler = handler; });
    clearCache = vi.fn(async () => undefined);
    clearStorageData = vi.fn(async () => undefined);
    fetch = vi.fn();
  }
  const state: {
    views: MockView[];
    partitions: Array<{ name: string; options: unknown; instance: MockSession }>;
  } = { views: [], partitions: [] };
  const fromPartition = vi.fn((name: string, options: unknown) => {
    const instance = new MockSession();
    state.partitions.push({ name, options, instance });
    return instance;
  });
  return { state, MockView, fromPartition, reset: () => {
    state.views.length = 0;
    state.partitions.length = 0;
    nextWebContentsId = 1;
    fromPartition.mockClear();
  } };
});

vi.mock("electron", () => ({
  BrowserWindow: class {},
  WebContentsView: electron.MockView,
  session: { fromPartition: electron.fromPartition },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  clipboard: { writeText: vi.fn() },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 1 })),
  },
  nativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => true })) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") },
}));

import { UserBrowserService } from "./user-browser-service";

const directories: string[] = [];

afterEach(() => {
  electron.reset();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createService(options: { partitionName?: string; now?: () => Date } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kestrel-user-browser-"));
  directories.push(directory);
  const children: unknown[] = [];
  const window = {
    getContentSize: vi.fn(() => [300, 200]),
    isDestroyed: vi.fn(() => false),
    contentView: {
      children,
      addChildView: vi.fn((view: unknown) => children.push(view)),
      removeChildView: vi.fn((view: unknown) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      }),
    },
  };
  const events: unknown[] = [];
  const commands: string[] = [];
  const service = new UserBrowserService({
    window: window as never,
    statePath: join(directory, "state.json"),
    downloadDirectory: join(directory, "downloads"),
    onEvent: (event) => events.push(event),
    onCommand: (command) => commands.push(command),
    ...options,
  });
  return { service, window, events, commands };
}

async function navigateNewTab(service: UserBrowserService, url: string) {
  const state = await service.createTab(url, false);
  return state.tabs.at(-1)!;
}

describe("UserBrowserService", () => {
  it("creates, selects, and closes tabs with a deterministic fallback and a replacement tab", async () => {
    const { service } = createService();
    const first = service.getState().activeTabId!;
    const second = (await service.createTab()).activeTabId!;
    const third = (await service.createTab()).activeTabId!;

    await service.selectTab(second);
    expect(service.getState().activeTabId).toBe(second);

    await service.closeTab(second);
    expect(service.getState().activeTabId).toBe(third);
    await service.closeTab(third);
    await service.closeTab(first);
    const state = service.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0]?.id);
    expect(state.tabs[0]).toMatchObject({ title: "New Tab", url: "" });
  });

  it("opens kestrel app pages as tabs without creating a web view", async () => {
    const { service } = createService();
    const before = electron.state.views.length;
    const state = await service.createTab("kestrel://settings", true);
    const tab = state.tabs.find((item) => item.id === state.activeTabId)!;
    expect(tab).toMatchObject({
      title: "Settings",
      url: "kestrel://settings",
      loading: false,
    });
    expect(electron.state.views.length).toBe(before);
    await service.setContentBounds(
      { x: 0, y: 80, width: 800, height: 600 },
      true,
    );
    expect(electron.state.views.length).toBe(before);
  });

  it("uses the production persistent partition by default and preserves an explicit custom partition", () => {
    const first = createService();
    expect(electron.state.partitions[0]).toMatchObject({
      name: "persist:kestrel-user-browser-v1",
      options: { cache: true },
    });
    first.service.dispose();

    const second = createService({ partitionName: "persist:customer-profile" });
    expect(electron.state.partitions[1]).toMatchObject({
      name: "persist:customer-profile",
      options: { cache: true },
    });
    expect(electron.state.views).toEqual([]);
    second.service.dispose();
  });

  it("rejects non-persistent or unsafe user profile partitions", () => {
    expect(() => createService({ partitionName: "temporary-profile" })).toThrow(
      "persistent profiles",
    );
    expect(() =>
      createService({ partitionName: "persist:profile/escape" }),
    ).toThrow("persistent profiles");
  });

  it("denies permission checks and requests by default", async () => {
    const { service } = createService();
    const partition = electron.state.partitions[0]!.instance as unknown as {
      permissionCheckHandler: (webContents: unknown, permission: string, requestingOrigin: string) => boolean;
      permissionRequestHandler: (webContents: unknown, permission: string, callback: (isAllowed: boolean) => void) => void;
    };
    expect(partition.permissionCheckHandler({}, "notifications", "https://example.com")).toBe(false);
    const callback = vi.fn();
    partition.permissionRequestHandler({}, "media", callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false));
    service.dispose();
  });

  it("clamps visible content bounds to the BrowserWindow content area", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "example.com");
    const view = electron.state.views[0]!;

    await service.setContentBounds({ x: 10.4, y: -7, width: 1_000, height: 1_000 }, true);
    expect(view.bounds).toEqual({ x: 10, y: 0, width: 290, height: 200 });
    expect(view.visible).toBe(true);

    await service.setContentBounds({ x: 500, y: 500, width: 100, height: 100 }, true);
    expect(view.bounds).toEqual({ x: 10, y: 0, width: 290, height: 200 });
    expect(view.visible).toBe(false);
  });

  it("opens one user-initiated safe popup as a managed tab and denies script popup spam", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "example.com");
    const source = electron.state.views[0]!.webContents;

    expect(source.windowOpenHandler?.({
      url: "https://script.example/path",
      disposition: "new-window",
    })).toEqual({ action: "deny" });
    expect(service.getState().tabs).toHaveLength(1);

    source.emit("before-mouse-event", {}, { type: "mouseDown" });
    source.emit("before-mouse-event", {}, { type: "mouseUp" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.windowOpenHandler?.({
      url: "https://late-script.example/path",
      disposition: "foreground-tab",
    })).toEqual({ action: "deny" });
    expect(service.getState().tabs).toHaveLength(1);

    source.emit("before-mouse-event", {}, { type: "mouseDown" });
    expect(source.windowOpenHandler?.({
      url: "https://open.example/path",
      disposition: "foreground-tab",
    })).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(service.getState().tabs).toHaveLength(2));
    expect(service.getState()).toMatchObject({ activeTabId: expect.any(String) });
    expect(service.getState().tabs.at(-1)).toMatchObject({ url: "https://open.example/path" });

    expect(source.windowOpenHandler?.({
      url: "https://spam.example/path",
      disposition: "foreground-tab",
    })).toEqual({ action: "deny" });
    expect(source.windowOpenHandler?.({
      url: "file:///etc/passwd",
      disposition: "foreground-tab",
    })).toEqual({ action: "deny" });
    expect(service.getState().tabs).toHaveLength(2);
  });

  it("awaits CDP clicks and scopes one popup to the approved action", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.executeJavaScript.mockResolvedValueOnce({ x: 24, y: 36 });
    let popupResult: { action: string } | undefined;
    contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
      if ((params as { type?: string }).type === "mouseReleased")
        setImmediate(() => {
          popupResult = contents.windowOpenHandler?.({
            url: "https://opened.example/path",
            disposition: "foreground-tab",
          });
        });
    });

    await service.act(
      tab.id,
      { type: "click", target: "#continue" },
      new AbortController().signal,
    );

    expect(contents.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(contents.debugger.sendCommand.mock.calls).toEqual([
      ["Input.dispatchMouseEvent", expect.objectContaining({
        type: "mouseMoved",
        x: 24,
        y: 36,
        button: "none",
        buttons: 0,
      })],
      ["Input.dispatchMouseEvent", expect.objectContaining({
        type: "mousePressed",
        x: 24,
        y: 36,
        button: "left",
        buttons: 1,
      })],
      ["Input.dispatchMouseEvent", expect.objectContaining({
        type: "mouseReleased",
        x: 24,
        y: 36,
        button: "left",
        buttons: 0,
      })],
    ]);
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(popupResult).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(service.getState().tabs).toHaveLength(2));
    expect(service.getState().tabs.at(-1)).toMatchObject({
      url: "https://opened.example/path",
    });
    expect(contents.windowOpenHandler?.({
      url: "https://spam.example/path",
      disposition: "foreground-tab",
    })).toEqual({ action: "deny" });
    expect(service.getState().tabs).toHaveLength(2);
  });

  it("settles an approved click after the source document is destroyed", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.executeJavaScript.mockResolvedValueOnce({ x: 12, y: 18 });
    contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
      if ((params as { type?: string }).type === "mouseReleased")
        contents.destroyed = true;
    });

    await expect(service.act(
      tab.id,
      { type: "click", target: "a.navigate" },
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(3);
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it("discards the least-recent inactive live view once more than eight are open", async () => {
    let tick = 0;
    const { service } = createService({ now: () => new Date(`2026-08-11T12:00:${String(tick++).padStart(2, "0")}.000Z`) });
    const initial = service.getState().tabs[0]!;
    await service.navigate(initial.id, "https://first.example");
    const tabs = [initial];
    for (let index = 0; index < 8; index += 1)
      tabs.push(await navigateNewTab(service, `https://${index}.example`));

    await service.selectTab(tabs.at(-1)!.id);
    const state = service.getState();
    expect(state.tabs.find((tab) => tab.id === initial.id)).toMatchObject({
      discarded: false,
    });
    expect(state.tabs.find((tab) => tab.id === tabs[1]!.id)).toMatchObject({
      discarded: true,
    });
    expect(electron.state.views.filter((view) => !view.webContents.destroyed)).toHaveLength(8);
  });

  it("cleans up crashed views and recreates a destroyed view on the next navigation", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const first = electron.state.views[0]!;

    first.webContents.emit("render-process-gone");
    expect(first.webContents.close).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    });
    expect(service.getState().tabs[0]).toMatchObject({ crashed: true, discarded: true });

    await service.navigate(tab.id, "https://again.example");
    const replacement = electron.state.views.at(-1)!;
    expect(replacement).not.toBe(first);
    replacement.webContents.destroyed = true;
    await service.navigate(tab.id, "https://third.example");
    expect(electron.state.views.at(-1)).not.toBe(replacement);
  });

  it("retains recent history, prunes expired visits, and clears history when retention is disabled", async () => {
    let now = new Date("2026-08-11T12:00:00.000Z");
    const { service } = createService({ now: () => now });
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const view = electron.state.views[0]!.webContents;
    view.url = "https://example.com/";
    view.title = "Example";
    view.emit("did-navigate", {}, view.url, 200, "OK");
    expect(service.getState().history).toHaveLength(1);

    now = new Date("2026-08-19T12:00:00.000Z");
    service.updateSettings({ ...service.getState().settings, historyRetentionDays: 7 });
    expect(service.getState().history).toEqual([]);

    service.updateSettings({ ...service.getState().settings, newTabBackground: "meadow" });
    expect(service.getState().settings.newTabBackground).toBe("meadow");

    view.emit("did-navigate", {}, "https://new.example/", 200, "OK");
    expect(service.getState().history).toHaveLength(1);
    service.updateSettings({ ...service.getState().settings, historyRetentionDays: 0 });
    expect(service.getState().history).toEqual([]);
  });

  it("redacts credential-like URL parameters from agent-visible metadata", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(
      tab.id,
      "https://example.com/callback?q=kestrel&code=do-not-share",
    );
    const contents = electron.state.views[0]!.webContents;
    contents.executeJavaScript.mockResolvedValue({
      description: "Fixture",
      selectedText: "",
      visibleText: "Visible reference text",
      headings: ["Fixture"],
      links: [
        {
          text: "Safe result",
          url: "https://linked.example/result?q=kestrel&access_token=hidden-link",
        },
        { text: "Email", url: "mailto:person@example.com" },
      ],
      forms: [],
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
    });

    const tabs = (await service.handleAgentRequest(
      { operation: "visible-tabs" },
      new AbortController().signal,
    )) as Array<{ url: string }>;
    const context = await service.pageContext(tab.id);
    contents.debugger.sendCommand.mockResolvedValue({
      nodes: [{
        nodeId: "1",
        name: {
          value:
            "Open https://named.example/path?q=kestrel&code=hidden-ax-name",
        },
        properties: [{
          name: "url",
          value: {
            type: "string",
            value:
              "https://ax.example/path?q=kestrel&access_token=hidden-ax-link",
          },
        }],
      }],
    });
    const snapshot = await service.snapshot(tab.id);

    expect(service.getState().tabs[0]?.url).toBe(
      "https://example.com/callback?q=kestrel",
    );
    expect(tabs[0]?.url).toBe(
      "https://example.com/callback?q=kestrel",
    );
    expect(context.url).toBe("https://example.com/callback?q=kestrel");
    expect(context.links).toEqual([
      {
        text: "Safe result",
        url: "https://linked.example/result?q=kestrel",
      },
    ]);
    expect(snapshot.url).toBe("https://example.com/callback?q=kestrel");
    expect(snapshot.accessibilityTree).toMatchObject({
      nodes: [{
        name: { value: "Open https://named.example/path?q=kestrel" },
        properties: [{
          name: "url",
          value: {
            value: "https://ax.example/path?q=kestrel",
          },
        }],
      }],
    });
    expect(JSON.stringify({ tabs, context, snapshot })).not.toMatch(
      /do-not-share|hidden-link|hidden-ax-name|hidden-ax-link/,
    );
  });

  it("inserts a selected code only into the active page's matching domain", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com/verify");
    const contents = electron.state.views[0]!.webContents;
    contents.executeJavaScript.mockResolvedValueOnce(true);

    await service.insertLoginCode(
      tab.id,
      "481902",
      "example.com",
      "https://example.com",
    );

    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(contents.focus).toHaveBeenCalledTimes(1);
    expect(contents.insertText).toHaveBeenCalledWith("481902");

    contents.url = "https://other.example/verify";
    await expect(
      service.insertLoginCode(
        tab.id,
        "481902",
        "example.com",
        "https://example.com",
      ),
    ).rejects.toThrow("page changed");
  });

  it("searches bounded history and lists visible downloads as untrusted data", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://robotics.example/article");
    const contents = electron.state.views[0]!.webContents;
    contents.url = "https://robotics.example/article";
    contents.title = "Robotics notes";
    contents.emit("did-navigate", {}, contents.url, 200, "OK");

    await expect(
      service.handleAgentRequest(
        { operation: "visible-history", query: "robotics", limit: 10 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      trust: "untrusted_browser",
      entries: [{ title: "Robotics notes" }],
    });
    await expect(
      service.handleAgentRequest(
        { operation: "visible-downloads" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ downloads: [], trust: "untrusted_browser" });
  });

  it("rejects oversized accessibility snapshots before returning them", async () => {
    const { service } = createService();
    const tab = service.getState().tabs[0]!;
    await service.navigate(tab.id, "https://example.com");
    const contents = electron.state.views[0]!.webContents;
    contents.url = "https://example.com/";
    contents.debugger.sendCommand.mockResolvedValue({
      nodes: [{ name: { value: "x".repeat(1_500_000) } }],
    });

    await expect(service.snapshot(tab.id)).rejects.toThrow("exceeds 1.5 MB");
  });

  it("handles browser shortcuts while native page content has focus", async () => {
    const { service, commands } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://first.example");
    const second = await navigateNewTab(service, "https://second.example");
    await service.selectTab(second.id);
    const inputEvent = { preventDefault: vi.fn() };
    const firstContents = electron.state.views[0]!.webContents;

    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "l",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "n",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: false,
      control: true,
      shift: false,
      type: "keyDown",
      key: "Tab",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "k",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "h",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "j",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: ",",
    });
    firstContents.emit("before-input-event", inputEvent, {
      meta: true,
      control: false,
      shift: false,
      type: "keyDown",
      key: "/",
    });
    await vi.waitFor(() =>
      expect(service.getState().activeTabId).toBe(first.id),
    );

    expect(commands).toEqual([
      "focus-address",
      "new-agent",
      "open-commands",
      "open-history",
      "open-downloads",
      "open-settings",
      "show-shortcuts",
    ]);
    expect(inputEvent.preventDefault).toHaveBeenCalledTimes(8);
  });

  it("supports reopening closed tabs and direct tab index switching", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://first.example");
    const second = (await service.createTab("https://second.example", true)).tabs.at(-1)!;
    const third = (await service.createTab("https://third.example", true)).tabs.at(-1)!;

    expect(service.getState().tabs.length).toBe(3);
    expect(service.getState().activeTabId).toBe(third.id);

    // Switch to tab 1 (index 0)
    await service.selectTabByIndex(0);
    expect(service.getState().activeTabId).toBe(first.id);

    // Switch to last tab (-1)
    await service.selectTabByIndex(-1);
    expect(service.getState().activeTabId).toBe(third.id);

    // Close third tab
    await service.closeTab(third.id);
    expect(service.getState().tabs.length).toBe(2);

    // Reopen closed tab
    const restored = await service.reopenClosedTab();
    expect(restored.tabs.length).toBe(3);
    const lastTab = restored.tabs[restored.tabs.length - 1]!;
    expect(lastTab.url).toBe("https://third.example/");
  });

  it("supports zoom in, zoom out, and zoom reset", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://first.example");

    const contents = electron.state.views[0]!.webContents;
    expect(contents.zoomLevel).toBe(0);

    service.zoomIn(first.id);
    expect(contents.zoomLevel).toBe(0.5);

    service.zoomIn(first.id);
    expect(contents.zoomLevel).toBe(1.0);

    service.zoomOut(first.id);
    expect(contents.zoomLevel).toBe(0.5);

    service.zoomReset(first.id);
    expect(contents.zoomLevel).toBe(0);
  });

  it("bookmarks, pins, and finds in the active page", async () => {
    const { service } = createService();
    const first = service.getState().tabs[0]!;
    await service.navigate(first.id, "https://docs.example/path");
    const bookmarked = service.toggleBookmark();
    expect(bookmarked.bookmarks).toHaveLength(1);
    expect(bookmarked.bookmarks[0]?.url).toBe("https://docs.example/path");
    expect(service.toggleBookmark().bookmarks).toHaveLength(0);

    const pinned = service.pinTab(first.id, true);
    expect(pinned.tabs[0]?.pinned).toBe(true);

    const contents = electron.state.views[0]!.webContents;
    service.findInPage(first.id, "kestrel");
    expect(contents.findInPage).toHaveBeenCalledWith("kestrel", {
      forward: true,
      findNext: false,
    });
    service.openDevTools(first.id);
    expect(contents.openDevTools).toHaveBeenCalled();
    service.printTab(first.id);
    expect(contents.print).toHaveBeenCalled();
  });
});
