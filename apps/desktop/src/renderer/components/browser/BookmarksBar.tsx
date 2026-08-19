import { useEffect, useState, type MouseEvent } from "react";
import type { UserBrowserTab } from "@kestrel/shared-types";
import { Icon } from "../Icon";
import { siteAccent, siteInitial } from "./new-tab";

export interface BookmarkItem {
  id: string;
  title: string;
  url: string;
  favicon?: string;
}

export const DEFAULT_BOOKMARKS: BookmarkItem[] = [
  {
    id: "bm-google",
    title: "Google",
    url: "https://www.google.com",
  },
  {
    id: "bm-github",
    title: "GitHub",
    url: "https://github.com",
  },
  {
    id: "bm-youtube",
    title: "YouTube",
    url: "https://www.youtube.com",
  },
  {
    id: "bm-reddit",
    title: "Reddit",
    url: "https://www.reddit.com",
  },
  {
    id: "bm-wikipedia",
    title: "Wikipedia",
    url: "https://www.wikipedia.org",
  },
  {
    id: "bm-hackernews",
    title: "Hacker News",
    url: "https://news.ycombinator.com",
  },
  {
    id: "bm-claude",
    title: "Claude",
    url: "https://claude.ai",
  },
];

const STORAGE_KEY = "kestrel:bookmarks";

export function loadBookmarks(): BookmarkItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_BOOKMARKS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    return DEFAULT_BOOKMARKS;
  } catch {
    return DEFAULT_BOOKMARKS;
  }
}

export function saveBookmarks(bookmarks: BookmarkItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
  } catch {
    // ignore quota errors
  }
}

export function BookmarksBar({
  activeTab,
  onNavigate,
  onCreateTab,
}: {
  activeTab?: UserBrowserTab;
  onNavigate(url: string): void;
  onCreateTab(url?: string): void;
}) {
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>(loadBookmarks);

  useEffect(() => {
    saveBookmarks(bookmarks);
  }, [bookmarks]);

  const isCurrentTabBookmarked = Boolean(
    activeTab?.url &&
      bookmarks.some((bm) => bm.url.replace(/\/$/, "") === activeTab.url.replace(/\/$/, "")),
  );

  function toggleCurrentTabBookmark() {
    if (!activeTab?.url) return;
    const cleanUrl = activeTab.url;
    if (isCurrentTabBookmarked) {
      setBookmarks((current) =>
        current.filter((bm) => bm.url.replace(/\/$/, "") !== cleanUrl.replace(/\/$/, "")),
      );
    } else {
      const newBm: BookmarkItem = {
        id: `bm-${Date.now()}`,
        title: activeTab.title || cleanUrl,
        url: cleanUrl,
        ...(activeTab.faviconDataUrl ? { favicon: activeTab.faviconDataUrl } : {}),
      };
      setBookmarks((current) => [...current, newBm]);
    }
  }

  function handleBookmarkClick(event: MouseEvent, url: string) {
    if (event.button === 1 || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      onCreateTab(url);
    } else if (event.button === 0) {
      event.preventDefault();
      onNavigate(url);
    }
  }

  function deleteBookmark(id: string, event: MouseEvent) {
    event.stopPropagation();
    setBookmarks((current) => current.filter((bm) => bm.id !== id));
  }

  function getHostname(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  return (
    <div className="browser-bookmarks-bar" aria-label="Bookmarks bar">
      <div className="bookmarks-list" role="toolbar" aria-label="Bookmarks">
        {bookmarks.map((bookmark) => {
          const hostname = getHostname(bookmark.url);
          return (
            <div
              key={bookmark.id}
              className="bookmark-item"
              title={`${bookmark.title}\n${bookmark.url}`}
            >
              <button
                type="button"
                className="bookmark-button"
                onClick={(e) => handleBookmarkClick(e, bookmark.url)}
                onAuxClick={(e) => handleBookmarkClick(e, bookmark.url)}
              >
                <span
                  className={`bookmark-favicon site-accent-${siteAccent(hostname)}`}
                  aria-hidden="true"
                >
                  {bookmark.favicon ? (
                    <img src={bookmark.favicon} alt="" />
                  ) : (
                    <span>{siteInitial({ hostname, title: bookmark.title })}</span>
                  )}
                </span>
                <span className="bookmark-label">{bookmark.title}</span>
              </button>
              <button
                type="button"
                className="bookmark-remove"
                aria-label={`Remove bookmark ${bookmark.title}`}
                title="Remove bookmark"
                onClick={(e) => deleteBookmark(bookmark.id, e)}
              >
                <Icon name="close" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="bookmarks-actions">
        {activeTab?.url && (
          <button
            type="button"
            className={`bookmark-star-action ${isCurrentTabBookmarked ? "is-bookmarked" : ""}`}
            aria-label={isCurrentTabBookmarked ? "Remove bookmark" : "Bookmark this tab"}
            title={isCurrentTabBookmarked ? "Remove bookmark (Cmd+D)" : "Bookmark this tab (Cmd+D)"}
            onClick={toggleCurrentTabBookmark}
          >
            <Icon name="star" />
          </button>
        )}
      </div>
    </div>
  );
}
