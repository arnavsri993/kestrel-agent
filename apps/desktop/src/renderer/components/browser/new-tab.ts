import type { UserBrowserHistoryEntry } from "@kestrel/shared-types";

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

export function siteInitial(site: Pick<FrequentBrowserSite, "hostname" | "title">): string {
  return (
    site.hostname.replace(/^www\./, "")[0] ||
    site.title[0] ||
    "?"
  ).toUpperCase();
}
