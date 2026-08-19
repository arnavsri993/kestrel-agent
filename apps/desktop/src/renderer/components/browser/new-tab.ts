import type { UserBrowserHistoryEntry, UserBrowserSettings } from "@kestrel/shared-types";

export type NewTabBackground = UserBrowserSettings["newTabBackground"];

export const NEW_TAB_BACKGROUND_OPTIONS: ReadonlyArray<{
  value: NewTabBackground;
  label: string;
  detail: string;
}> = [
  { value: "graphite", label: "Graphite", detail: "Quiet and focused" },
  { value: "meadow", label: "Meadow", detail: "Terraced green landscape" },
  { value: "dawn", label: "Dawn", detail: "Warm morning light" },
  { value: "paper", label: "Paper", detail: "Bright and minimal" },
];

export interface FrequentBrowserSite {
  origin: string;
  url: string;
  title: string;
  hostname: string;
  visits: number;
  lastVisitedAt: string;
}

/**
 * Turn durable local history into a small, origin-grouped shortcut row.
 * History remains the source of truth; the home screen never invents sites.
 */
export function frequentBrowserSites(
  history: UserBrowserHistoryEntry[],
  limit = 6,
): FrequentBrowserSite[] {
  const grouped = new Map<string, FrequentBrowserSite>();

  for (const entry of history) {
    try {
      const parsed = new URL(entry.url);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
      const origin = parsed.origin;
      const current = grouped.get(origin);
      if (!current) {
        grouped.set(origin, {
          origin,
          url: entry.url,
          title: entry.title,
          hostname: parsed.hostname.replace(/^www\./, ""),
          visits: 1,
          lastVisitedAt: entry.visitedAt,
        });
        continue;
      }
      current.visits += 1;
      if (entry.visitedAt > current.lastVisitedAt) {
        current.url = entry.url;
        current.title = entry.title;
        current.lastVisitedAt = entry.visitedAt;
      }
    } catch {
      // Corrupt or legacy history is ignored in the same spirit as the
      // browser's navigation surface: the home screen should fail closed.
    }
  }

  return [...grouped.values()]
    .sort((left, right) =>
      right.visits - left.visits ||
      right.lastVisitedAt.localeCompare(left.lastVisitedAt),
    )
    .slice(0, limit);
}

export interface ShortcutItem {
  id: string;
  url: string;
  title: string;
  hostname: string;
  favicon?: string;
}

export const DEFAULT_SHORTCUTS: ShortcutItem[] = [
  {
    id: "shortcut-google",
    url: "https://www.google.com",
    title: "Google",
    hostname: "google.com",
  },
  {
    id: "shortcut-github",
    url: "https://github.com",
    title: "GitHub",
    hostname: "github.com",
  },
  {
    id: "shortcut-youtube",
    url: "https://www.youtube.com",
    title: "YouTube",
    hostname: "youtube.com",
  },
  {
    id: "shortcut-reddit",
    url: "https://www.reddit.com",
    title: "Reddit",
    hostname: "reddit.com",
  },
  {
    id: "shortcut-wikipedia",
    url: "https://www.wikipedia.org",
    title: "Wikipedia",
    hostname: "wikipedia.org",
  },
  {
    id: "shortcut-claude",
    url: "https://claude.ai",
    title: "Claude",
    hostname: "claude.ai",
  },
  {
    id: "shortcut-hackernews",
    url: "https://news.ycombinator.com",
    title: "Hacker News",
    hostname: "news.ycombinator.com",
  },
  {
    id: "shortcut-x",
    url: "https://x.com",
    title: "X",
    hostname: "x.com",
  },
];

export function getNewTabShortcuts(
  history: UserBrowserHistoryEntry[],
  limit = 8,
): ShortcutItem[] {
  const frequent = frequentBrowserSites(history, limit);
  const items: ShortcutItem[] = frequent.map((site) => ({
    id: site.origin,
    url: site.url,
    title: site.title,
    hostname: site.hostname,
  }));

  const existingOrigins = new Set(
    items.map((i) => {
      try {
        return new URL(i.url).origin;
      } catch {
        return i.url;
      }
    }),
  );

  for (const def of DEFAULT_SHORTCUTS) {
    if (items.length >= limit) break;
    try {
      const defOrigin = new URL(def.url).origin;
      if (!existingOrigins.has(defOrigin)) {
        items.push(def);
        existingOrigins.add(defOrigin);
      }
    } catch {
      // ignore
    }
  }

  return items.slice(0, limit);
}

export function siteInitial(site: Pick<FrequentBrowserSite, "hostname" | "title"> | Pick<ShortcutItem, "hostname" | "title">): string {
  return (
    site.hostname.replace(/^www\./, "")[0] ||
    site.title[0] ||
    "?"
  ).toUpperCase();
}

export function siteAccent(hostname: string): string {
  const palette = ["sage", "blue", "amber", "rose", "violet", "teal"] as const;
  let hash = 0;
  for (const character of hostname) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}
