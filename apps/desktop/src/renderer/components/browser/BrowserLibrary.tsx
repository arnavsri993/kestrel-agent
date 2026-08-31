import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { Icon } from "../Icon";
import { SurfaceBackButton } from "./SurfaceBackButton";
import { Button, PageFrame } from "../ui";
import "./surface-pages.css";

function LibraryEmptyState({
  icon,
  title,
  detail,
  action,
  className = "",
}: {
  icon: ComponentProps<typeof Icon>["name"];
  title: string;
  detail?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`ui-empty-state ${className}`.trim()}>
      <span className="ui-empty-state-mark" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <h2>{title}</h2>
      {detail ? <p>{detail}</p> : null}
      {action && <div className="ui-empty-state-action">{action}</div>}
    </section>
  );
}

function compactBytes(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} KB`;
  return `${value} B`;
}

function downloadStatusLabel(status: string): string {
  return (
    {
      completed: "Completed",
      cancelled: "Cancelled",
      failed: "Failed",
      interrupted: "Interrupted",
      progressing: "Downloading",
    }[status] ?? status
  );
}

export function BrowserHistory({
  browser,
  onOpenBrowser,
  onBack,
}: {
  browser: UserBrowserController;
  onOpenBrowser(): void;
  onBack?(): void;
}) {
  const [query, setQuery] = useState("");
  const history = browser.state?.history ?? [];
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...history]
      .reverse()
      .filter(
        (entry) =>
          !normalized ||
          `${entry.title} ${entry.url}`.toLowerCase().includes(normalized),
      );
  }, [history, query]);

  async function open(url: string) {
    await browser.createTab(url);
  }

  return (
    <PageFrame
      as="main"
      className="browser-library"
      title="Browsing history"
      titleId="history-title"
      description="Pages opened in this local profile, newest first."
      measure="wide"
      actions={
        <>
          {onBack ? <SurfaceBackButton onBack={onBack} /> : null}
          <label className="library-search">
            <Icon name="search" />
            <span className="sr-only">Search history</span>
            <input
              value={query}
              placeholder="Search history"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {history.length > 0 ? (
            <Button
              variant="quiet"
              size="compact"
              onClick={() => void browser.clearHistory()}
            >
              Clear browsing history
            </Button>
          ) : null}
        </>
      }
    >
      {filtered.length === 0 ? (
        <LibraryEmptyState
          className="library-empty"
          icon="history"
          title={query ? "No matching pages" : "No history yet"}
          detail={
            query
              ? "Try a different search."
              : "Pages you open in Kestrel stay available here on this Mac."
          }
          action={
            !query ? (
              <button
                type="button"
                className="button secondary"
                onClick={onOpenBrowser}
              >
                Open browser
              </button>
            ) : undefined
          }
        />
      ) : (
        <ol className="history-list">
          {filtered.map((entry) => (
            <li key={entry.id}>
              <button type="button" onClick={() => void open(entry.url)}>
                <span className="history-favicon">
                  {new URL(entry.url).hostname.charAt(0).toUpperCase()}
                </span>
                <span>
                  <strong>{entry.title}</strong>
                  <small>{entry.url}</small>
                </span>
                <time dateTime={entry.visitedAt}>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(entry.visitedAt))}
                </time>
              </button>
            </li>
          ))}
        </ol>
      )}
    </PageFrame>
  );
}

export function BrowserDownloads({
  browser,
  onBack,
}: {
  browser: UserBrowserController;
  onBack?(): void;
}) {
  const downloads = [...(browser.state?.downloads ?? [])].reverse();
  return (
    <PageFrame
      as="main"
      className="browser-library"
      title="Downloaded files"
      titleId="downloads-title"
      description="Files saved from this local browser profile."
      measure="wide"
      actions={onBack ? <SurfaceBackButton onBack={onBack} /> : undefined}
    >
      {downloads.length === 0 ? (
        <LibraryEmptyState
          className="library-empty"
          icon="downloads"
          title="No downloads yet"
          detail="Files you save will appear here on this Mac."
        />
      ) : (
        <ul className="download-list">
          {downloads.map((download) => {
            const progress =
              download.totalBytes > 0
                ? Math.min(
                    100,
                    Math.round(
                      (download.receivedBytes / download.totalBytes) * 100,
                    ),
                  )
                : 0;
            return (
              <li key={download.id}>
                <span className={`download-state ${download.status}`}>
                  <Icon
                    name={
                      download.status === "completed"
                        ? "check"
                        : download.status === "progressing"
                          ? "downloads"
                          : "warning"
                    }
                  />
                </span>
                <div>
                  <strong>{download.filename}</strong>
                  <small>
                    {download.status === "progressing"
                      ? `Downloading · ${progress}% · ${compactBytes(download.receivedBytes)}`
                      : `${downloadStatusLabel(download.status)} · ${compactBytes(download.receivedBytes)}`}
                  </small>
                  {download.status === "progressing" && (
                    <progress
                      value={download.receivedBytes}
                      max={Math.max(
                        download.totalBytes,
                        download.receivedBytes,
                        1,
                      )}
                    />
                  )}
                </div>
                {download.canReveal && (
                  <button
                    type="button"
                    className="quiet-link"
                    onClick={() => void browser.openDownload(download.id)}
                  >
                    Open
                  </button>
                )}
                {download.canReveal && (
                  <button
                    type="button"
                    className="quiet-link"
                    onClick={() => void browser.revealDownload(download.id)}
                  >
                    Show in Finder
                  </button>
                )}
                {download.status === "progressing" && (
                  <button
                    type="button"
                    className="quiet-link"
                    onClick={() => void browser.cancelDownload(download.id)}
                  >
                    Cancel
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PageFrame>
  );
}

export function BrowserBookmarks({
  browser,
  onOpenBrowser,
  onBack,
}: {
  browser: UserBrowserController;
  onOpenBrowser(): void;
  onBack?(): void;
}) {
  const [query, setQuery] = useState("");
  const bookmarks = browser.state?.bookmarks ?? [];
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return bookmarks.filter(
      (entry) =>
        !normalized ||
        `${entry.title} ${entry.url}`.toLowerCase().includes(normalized),
    );
  }, [bookmarks, query]);

  return (
    <PageFrame
      as="main"
      className="browser-library"
      title="Saved pages"
      titleId="bookmarks-title"
      description="Pages you chose to keep in this local browser profile."
      measure="wide"
      actions={
        <>
          {onBack ? <SurfaceBackButton onBack={onBack} /> : null}
          <label className="library-search">
            <Icon name="search" />
            <span className="sr-only">Search bookmarks</span>
            <input
              value={query}
              placeholder="Search bookmarks"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </>
      }
    >
      {filtered.length === 0 ? (
        <LibraryEmptyState
          className="library-empty"
          icon="star"
          title={query ? "No matching bookmarks" : "No bookmarks yet"}
          detail={
            query
              ? "Try a different search term."
              : "Press ⌘D on a page to save it here."
          }
          action={
            !query ? (
              <button
                type="button"
                className="button secondary"
                onClick={onOpenBrowser}
              >
                Open browser
              </button>
            ) : undefined
          }
        />
      ) : (
        <ol className="history-list">
          {filtered.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => void browser.createTab(entry.url)}
              >
                <span className="history-favicon">
                  <Icon name="star" />
                </span>
                <span>
                  <strong>{entry.title}</strong>
                  <small>{entry.url}</small>
                </span>
                <span
                  className="quiet-link"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void browser.removeBookmark(entry.id);
                  }}
                >
                  Remove
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </PageFrame>
  );
}
