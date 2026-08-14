import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  UserBrowserStateSchema,
  type UserBrowserSettings,
  type UserBrowserState,
} from "@kestrel/shared-types";

export const DEFAULT_BROWSER_SETTINGS: UserBrowserSettings = {
  searchEngine: "duckduckgo",
  tabLayout: "horizontal",
  showBookmarksBar: true,
  restoreSession: true,
  historyRetentionDays: 90,
};

const SEARCH_ENGINES: Record<UserBrowserSettings["searchEngine"], string> = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  brave: "https://search.brave.com/search?q=",
  ecosia: "https://www.ecosia.org/search?q=",
  startpage: "https://www.startpage.com/sp/search?query=",
  yahoo: "https://search.yahoo.com/search?p=",
  kagi: "https://kagi.com/search?q=",
  qwant: "https://www.qwant.com/?q=",
  mojeek: "https://www.mojeek.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
  yandex: "https://yandex.com/search/?text=",
};

const EXPLICIT_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i;
const HOST_LIKE = /^(?:[A-Za-z\d](?:[A-Za-z\d-]{0,62}[A-Za-z\d])?\.)+[A-Za-z]{2,63}(?::\d{1,5})?(?:[/?#]|$)/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#]|$)/;
const SENSITIVE_URL_KEY = /^(?:access_?token|api_?key|assertion|auth(?:entication|orization)?(?:_?token|_?code)?|client_?secret|code|credential|id_?token|jwt|key|oauth(?:_?token|_?code)?|password|refresh_?token|samlresponse|secret|session(?:_?id|_?token)?|sig(?:nature)?|sso(?:_?token)?|ticket|token|x-amz-(?:credential|security-token|signature))$/i;

export interface NormalizedBrowserAddress {
  kind: "url" | "search";
  url: string;
}

/**
 * Keep navigationally useful URLs while excluding credential-like values from
 * durable history, session restore, downloads, and model-visible metadata.
 */
export function sanitizeBrowserUrl(value: string): string {
  if (!value || value.length > 8_192) return "";
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_KEY.test(key)) url.searchParams.delete(key);
    }
    if (url.hash.length > 1) {
      const fragment = url.hash.slice(1);
      if (fragment.includes("=")) {
        const parameters = new URLSearchParams(fragment);
        for (const key of [...parameters.keys()]) {
          if (SENSITIVE_URL_KEY.test(key)) parameters.delete(key);
        }
        const next = parameters.toString();
        url.hash = next ? `#${next}` : "";
      } else if (fragment.length > 512) {
        url.hash = "";
      }
    }
    const sanitized = url.toString();
    return sanitized.length <= 8_192 ? sanitized : "";
  } catch {
    return "";
  }
}

export function normalizeBrowserAddress(
  value: string,
  searchEngine: UserBrowserSettings["searchEngine"] = "duckduckgo",
): NormalizedBrowserAddress {
  const input = value.trim();
  if (!input || input.length > 8_192 || /[\u0000-\u001f\u007f]/.test(input))
    throw new Error("Enter a valid address or search.");

  // A loopback host with a port (for example localhost:5173) resembles a URL
  // scheme to the generic parser, but is intentionally supported for local
  // development and test pages.
  const loopback = LOOPBACK.test(input);
  const explicitScheme = EXPLICIT_SCHEME.test(input) && !loopback;
  if (explicitScheme && !/^https?:/i.test(input))
    throw new Error("Kestrel tabs support HTTP and HTTPS pages only.");

  const looksLikeHost = loopback || HOST_LIKE.test(input) || IPV4.test(input);
  if (!explicitScheme && !looksLikeHost) {
    return {
      kind: "search",
      url: `${SEARCH_ENGINES[searchEngine]}${encodeURIComponent(input)}`,
    };
  }

  const candidate = explicitScheme
    ? input
    : `${loopback ? "http" : "https"}://${input}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid address or search.");
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Kestrel tabs support HTTP and HTTPS pages only.");
  if (parsed.username || parsed.password)
    throw new Error("Addresses with embedded usernames or passwords are blocked.");
  if (!parsed.hostname || parsed.port && Number(parsed.port) > 65_535)
    throw new Error("Enter a valid address or search.");
  return { kind: "url", url: parsed.toString() };
}

export function freshBrowserState(
  now: () => Date = () => new Date(),
): UserBrowserState {
  const timestamp = now().toISOString();
  const id = `tab-${randomUUID()}`;
  return {
    tabs: [
      {
        id,
        mode: "standard",
        title: "New Tab",
        url: "",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        discarded: false,
        crashed: false,
        createdAt: timestamp,
        lastActiveAt: timestamp,
      },
    ],
    activeTabId: id,
    history: [],
    downloads: [],
    bookmarks: [],
    permissions: [],
    extensions: [],
    settings: { ...DEFAULT_BROWSER_SETTINGS },
  };
}

export class BrowserTabStore {
  constructor(private readonly path: string) {}

  load(now: () => Date = () => new Date()): UserBrowserState {
    if (!existsSync(this.path)) return freshBrowserState(now);
    try {
      const state = UserBrowserStateSchema.parse(
        JSON.parse(readFileSync(this.path, "utf8")),
      );
      const tabs = state.settings.restoreSession
        ? state.tabs
            .filter((tab) => tab.mode !== "private")
            .filter((tab) => !tab.url || /^https?:\/\//.test(tab.url))
            .map((tab) => ({
              ...tab,
              faviconDataUrl: undefined,
              loading: false,
              canGoBack: false,
              canGoForward: false,
              discarded: Boolean(tab.url),
              crashed: false,
              error: undefined,
            }))
        : [];
      if (tabs.length === 0)
        return {
          ...freshBrowserState(now),
          history: state.history,
          bookmarks: state.bookmarks,
          permissions: state.permissions,
          extensions: state.extensions,
          downloads: state.downloads.map((download) => ({
            ...download,
            status:
              download.status === "progressing" ? "failed" : download.status,
            canReveal: false,
          })),
          settings: state.settings,
        };
      const activeTabId = tabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : tabs[0]!.id;
      return {
        ...state,
        tabs,
        activeTabId,
        downloads: state.downloads.map((download) => ({
          ...download,
          status:
            download.status === "progressing" ? "failed" : download.status,
          canReveal: false,
        })),
      };
    } catch {
      return freshBrowserState(now);
    }
  }

  save(state: UserBrowserState): void {
    const tabs = state.tabs.filter((tab) => tab.mode !== "private");
    const safe = UserBrowserStateSchema.parse({
      ...state,
      tabs: tabs.map(({ faviconDataUrl: _faviconDataUrl, ...tab }) => ({
        ...tab,
        url: tab.url ? sanitizeBrowserUrl(tab.url) : "",
      })),
      activeTabId:
        state.activeTabId && tabs.some((tab) => tab.id === state.activeTabId)
          ? state.activeTabId
          : tabs[0]?.id ?? null,
      history: state.history.flatMap((entry) => {
        const url = sanitizeBrowserUrl(entry.url);
        return url ? [{ ...entry, url }] : [];
      }),
      downloads: state.downloads.flatMap((download) => {
        const sourceUrl = sanitizeBrowserUrl(download.sourceUrl);
        return sourceUrl ? [{ ...download, sourceUrl }] : [];
      }),
      bookmarks: state.bookmarks.flatMap((bookmark) => {
        const url = sanitizeBrowserUrl(bookmark.url);
        return url ? [{ ...bookmark, url }] : [];
      }),
    });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}
