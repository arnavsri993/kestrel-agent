import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserTabStore,
  freshBrowserState,
  normalizeBrowserAddress,
  sanitizeBrowserUrl,
} from "./browser-tab-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "kestrel-browser-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "browser-state.json");
}

describe("browser address normalization", () => {
  it("navigates hosts and searches ordinary language", () => {
    expect(normalizeBrowserAddress("example.com/docs")).toEqual({
      kind: "url",
      url: "https://example.com/docs",
    });
    expect(normalizeBrowserAddress("localhost:5173")).toEqual({
      kind: "url",
      url: "http://localhost:5173/",
    });
    expect(normalizeBrowserAddress("quiet browser design")).toEqual({
      kind: "search",
      url: "https://duckduckgo.com/?q=quiet%20browser%20design",
    });
  });

  it("respects the selected search engine", () => {
    expect(normalizeBrowserAddress("kestrel", "brave").url).toBe(
      "https://search.brave.com/search?q=kestrel",
    );
  });

  it("blocks privileged protocols and credential-bearing URLs", () => {
    expect(() => normalizeBrowserAddress("file:///etc/passwd")).toThrow(
      "HTTP and HTTPS",
    );
    expect(() =>
      normalizeBrowserAddress("https://person:secret@example.com"),
    ).toThrow("embedded usernames or passwords");
    expect(() => normalizeBrowserAddress("javascript:alert(1)")).toThrow(
      "HTTP and HTTPS",
    );
  });

  it("redacts credential-like URL values without discarding useful searches", () => {
    expect(
      sanitizeBrowserUrl(
        "https://example.com/callback?q=kestrel&code=secret&access_token=hidden&api_key=private#section",
      ),
    ).toBe("https://example.com/callback?q=kestrel#section");
    expect(
      sanitizeBrowserUrl(
        "https://example.com/#access_token=hidden&view=summary",
      ),
    ).toBe("https://example.com/#view=summary");
    expect(sanitizeBrowserUrl("file:///etc/passwd")).toBe("");
  });
});

describe("browser tab persistence", () => {
  it("restores safe tabs as discarded without persisting favicons", () => {
    const path = storePath();
    const store = new BrowserTabStore(path);
    const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
    state.tabs[0] = {
      ...state.tabs[0]!,
      title: "Kestrel",
      url: "https://example.com/",
      faviconDataUrl: "data:image/png;base64,AAAA",
      loading: true,
      canGoBack: true,
      error: "A stale failure",
    };

    store.save(state);

    expect(readFileSync(path, "utf8")).not.toContain("faviconDataUrl");
    expect(store.load().tabs[0]).toMatchObject({
      title: "Kestrel",
      url: "https://example.com/",
      loading: false,
      canGoBack: false,
      discarded: true,
      error: undefined,
    });
  });

  it("does not persist credential-like URL parameters", () => {
    const path = storePath();
    const store = new BrowserTabStore(path);
    const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
    state.tabs[0]!.url =
      "https://example.com/callback?q=browser&code=do-not-store";
    state.history.push({
      id: "visit-00000000-0000-4000-8000-000000000000",
      tabId: state.tabs[0]!.id,
      url: "https://example.com/callback?q=browser&session_token=secret",
      title: "Callback",
      visitedAt: "2026-08-11T12:00:00.000Z",
    });

    store.save(state);

    const persisted = readFileSync(path, "utf8");
    expect(persisted).toContain("q=browser");
    expect(persisted).not.toContain("do-not-store");
    expect(persisted).not.toContain("session_token");
  });

  it("fails closed to a fresh tab when state is corrupt", () => {
    const path = storePath();
    writeFileSync(path, "{not json", "utf8");

    const state = new BrowserTabStore(path).load(() =>
      new Date("2026-08-11T12:00:00.000Z"),
    );

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.title).toBe("New Tab");
    expect(state.history).toEqual([]);
  });

  it("keeps history but starts blank when session restore is disabled", () => {
    const path = storePath();
    const store = new BrowserTabStore(path);
    const state = freshBrowserState(() => new Date("2026-08-11T12:00:00.000Z"));
    state.settings.restoreSession = false;
    state.history.push({
      id: "visit-00000000-0000-4000-8000-000000000000",
      tabId: state.tabs[0]!.id,
      url: "https://example.com/",
      title: "Example",
      visitedAt: "2026-08-11T12:00:00.000Z",
    });
    store.save(state);

    const restored = store.load(() => new Date("2026-08-12T12:00:00.000Z"));

    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0]?.url).toBe("");
    expect(restored.history).toHaveLength(1);
  });
});
