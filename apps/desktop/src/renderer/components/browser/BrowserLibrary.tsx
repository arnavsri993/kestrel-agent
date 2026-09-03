import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type {
  UserBrowserBookmark,
  UserBrowserBookmarkDisplayMode,
  UserBrowserBookmarkFolder,
} from "@kestrel/shared-types";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { Icon } from "../Icon";
import { SurfaceBackButton } from "./SurfaceBackButton";
import { Button, PageFrame } from "../ui";
import {
  bookmarkDisplayModeLabel,
  hostnameFromBookmarkUrl,
} from "./bookmarks-bar";
import { BookmarkFavicon } from "./BookmarkFavicon";
import "./surface-pages.css";
import "./bookmark-library.css";

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
  const [folderFilter, setFolderFilter] = useState("all");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [libraryBusy, setLibraryBusy] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const bookmarks = browser.state?.bookmarks ?? [];
  const bookmarkFolders = browser.state?.bookmarkFolders ?? [];
  const originFavicons = browser.state?.originFavicons ?? [];

  useEffect(() => {
    if (
      folderFilter !== "all" &&
      folderFilter !== "bar" &&
      !bookmarkFolders.some((folder) => folder.id === folderFilter)
    ) {
      setFolderFilter("all");
    }
  }, [bookmarkFolders, folderFilter]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return bookmarks.filter(
      (entry) =>
        !normalized ||
        `${entry.title} ${entry.url} ${hostnameFromBookmarkUrl(entry.url)}`
          .toLowerCase()
          .includes(normalized),
    );
  }, [bookmarks, query]);
  const folderFiltered = useMemo(() => {
    if (folderFilter === "all") return filtered;
    if (folderFilter === "bar") return filtered.filter((entry) => !entry.folderId);
    return filtered.filter((entry) => entry.folderId === folderFilter);
  }, [filtered, folderFilter]);
  const folderNameById = useMemo(
    () => new Map(bookmarkFolders.map((folder) => [folder.id, folder.name])),
    [bookmarkFolders],
  );

  async function createFolder() {
    const name = newFolderName.trim();
    if (!name) {
      setLibraryError("Give the new folder a name.");
      return;
    }
    setLibraryBusy("create-folder");
    setLibraryError("");
    try {
      const folder = await browser.createBookmarkFolder(name);
      setNewFolderName("");
      setNewFolderOpen(false);
      if (folder) setFolderFilter(folder.id);
    } catch (cause) {
      setLibraryError(
        cause instanceof Error
          ? cause.message
          : "The folder could not be created. Try again.",
      );
    } finally {
      setLibraryBusy("");
    }
  }

  function startRenameFolder(folder: UserBrowserBookmarkFolder) {
    setDeletingFolderId(null);
    setRenamingFolderId(folder.id);
    setRenameFolderName(folder.name);
    setLibraryError("");
  }

  async function renameFolder(folderId: string) {
    const name = renameFolderName.trim();
    if (!name) {
      setLibraryError("Give the folder a name.");
      return;
    }
    setLibraryBusy(`rename-folder-${folderId}`);
    setLibraryError("");
    try {
      await browser.renameBookmarkFolder(folderId, name);
      setRenamingFolderId(null);
      setRenameFolderName("");
    } catch (cause) {
      setLibraryError(
        cause instanceof Error
          ? cause.message
          : "The folder could not be renamed. Try again.",
      );
    } finally {
      setLibraryBusy("");
    }
  }

  async function removeFolder(folderId: string) {
    setLibraryBusy(`delete-folder-${folderId}`);
    setLibraryError("");
    try {
      await browser.removeBookmarkFolder(folderId);
      if (folderFilter === folderId) setFolderFilter("all");
      setDeletingFolderId(null);
    } catch (cause) {
      setLibraryError(
        cause instanceof Error
          ? cause.message
          : "The folder could not be deleted. Try again.",
      );
    } finally {
      setLibraryBusy("");
    }
  }

  function startEditBookmark(bookmark: UserBrowserBookmark) {
    setEditingBookmarkId(bookmark.id);
    setLibraryError("");
  }

  async function saveBookmarkEdit(
    bookmark: UserBrowserBookmark,
    input: {
      title: string;
      displayMode: UserBrowserBookmarkDisplayMode;
      folderId: string | null;
    },
  ) {
    setLibraryBusy(`edit-bookmark-${bookmark.id}`);
    setLibraryError("");
    try {
      await browser.updateBookmark({
        bookmarkId: bookmark.id,
        ...input,
      });
      setEditingBookmarkId(null);
    } catch (cause) {
      setLibraryError(
        cause instanceof Error
          ? cause.message
          : "The bookmark could not be updated. Try again.",
      );
      throw cause;
    } finally {
      setLibraryBusy("");
    }
  }

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
          <Button
            variant="quiet"
            size="compact"
            onClick={() => {
              setNewFolderOpen((open) => !open);
              setLibraryError("");
            }}
          >
            <Icon name="folder" />
            New folder
          </Button>
        </>
      }
    >
      <div className="bookmark-library-controls">
        <label>
          <span>Show</span>
          <select
            value={folderFilter}
            onChange={(event) => setFolderFilter(event.target.value)}
          >
            <option value="all">All bookmarks · {bookmarks.length}</option>
            <option value="bar">
              Bookmarks bar · {bookmarks.filter((entry) => !entry.folderId).length}
            </option>
            {bookmarkFolders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name} · {bookmarks.filter((entry) => entry.folderId === folder.id).length}
              </option>
            ))}
          </select>
        </label>
        <span className="bookmark-library-count">
          {folderFiltered.length} {folderFiltered.length === 1 ? "page" : "pages"}
        </span>
      </div>

      {newFolderOpen && (
        <form
          className="bookmark-library-create-folder"
          onSubmit={(event) => {
            event.preventDefault();
            void createFolder();
          }}
        >
          <label htmlFor="bookmark-library-new-folder">New folder</label>
          <input
            id="bookmark-library-new-folder"
            value={newFolderName}
            maxLength={80}
            placeholder="e.g. Read later"
            autoFocus
            onChange={(event) => setNewFolderName(event.target.value)}
          />
          <Button
            type="submit"
            variant="solid"
            size="compact"
            busy={libraryBusy === "create-folder"}
          >
            Create
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="compact"
            onClick={() => setNewFolderOpen(false)}
            disabled={Boolean(libraryBusy)}
          >
            Cancel
          </Button>
        </form>
      )}

      {libraryError && (
        <p className="bookmark-library-error" role="alert">
          <Icon name="warning" />
          {libraryError}
        </p>
      )}

      <section
        className="bookmark-library-folders"
        aria-labelledby="bookmark-folders-title"
      >
        <div className="bookmark-library-section-heading">
          <span>
            <strong id="bookmark-folders-title">Folders</strong>
            <small>Keep the bar tidy without losing saved pages.</small>
          </span>
          <span>{bookmarkFolders.length}</span>
        </div>
        {bookmarkFolders.length > 0 ? (
          <ul>
            {bookmarkFolders.map((folder) => {
              const count = bookmarks.filter((entry) => entry.folderId === folder.id).length;
              const renaming = renamingFolderId === folder.id;
              const deleting = deletingFolderId === folder.id;
              const folderBusy = libraryBusy.endsWith(folder.id);
              return (
                <li key={folder.id}>
                  {renaming ? (
                    <form
                      className="bookmark-library-folder-rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void renameFolder(folder.id);
                      }}
                    >
                      <Icon name="folder" />
                      <input
                        value={renameFolderName}
                        maxLength={80}
                        aria-label={`Rename ${folder.name}`}
                        autoFocus
                        onChange={(event) => setRenameFolderName(event.target.value)}
                      />
                      <Button
                        type="submit"
                        variant="solid"
                        size="compact"
                        busy={folderBusy}
                      >
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="quiet"
                        size="compact"
                        onClick={() => setRenamingFolderId(null)}
                        disabled={Boolean(libraryBusy)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <div className="bookmark-library-folder-row">
                      <button
                        type="button"
                        className="bookmark-library-folder-select"
                        onClick={() => setFolderFilter(folder.id)}
                        aria-pressed={folderFilter === folder.id}
                      >
                        <Icon name="folder" />
                        <span>
                          <strong>{folder.name}</strong>
                          <small>{count} {count === 1 ? "bookmark" : "bookmarks"}</small>
                        </span>
                      </button>
                      <div className="bookmark-library-folder-actions">
                        {deleting ? (
                          <>
                            <span>Move pages to bar?</span>
                            <button
                              type="button"
                              className="quiet-link danger-link"
                              disabled={Boolean(libraryBusy)}
                              onClick={() => void removeFolder(folder.id)}
                            >
                              {folderBusy ? "Deleting…" : "Delete"}
                            </button>
                            <button
                              type="button"
                              className="quiet-link"
                              disabled={Boolean(libraryBusy)}
                              onClick={() => setDeletingFolderId(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="quiet-link"
                              onClick={() => startRenameFolder(folder)}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              className="quiet-link danger-link"
                              onClick={() => setDeletingFolderId(folder.id)}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="bookmark-library-folders-empty">
            No folders yet. Create one to organize pages by project, topic, or read-later queue.
          </p>
        )}
      </section>

      {folderFiltered.length === 0 ? (
        <LibraryEmptyState
          className="library-empty"
          icon="star"
          title={query || folderFilter !== "all" ? "No matching bookmarks" : "No bookmarks yet"}
          detail={
            query || folderFilter !== "all"
              ? "Try a different search or folder."
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
        <ol className="bookmark-library-list">
          {folderFiltered.map((entry) => (
            <li key={entry.id}>
              <div className="bookmark-library-row">
                <button
                  type="button"
                  className="bookmark-library-open"
                  onClick={() => void browser.createTab(entry.url)}
                  title={`Open ${entry.title}`}
                >
                  <BookmarkFavicon
                    title={entry.title}
                    url={entry.url}
                    {...(entry.faviconDataUrl
                      ? { faviconDataUrl: entry.faviconDataUrl }
                      : {})}
                    originFavicons={originFavicons}
                    className="history-favicon bookmark-library-favicon"
                  />
                  <span className="bookmark-library-copy">
                    <strong>{entry.title}</strong>
                    <small>{entry.url}</small>
                    <small className="bookmark-library-meta">
                      {entry.folderId ? folderNameById.get(entry.folderId) : "Bookmarks bar"}
                      {" · "}
                      {bookmarkDisplayModeLabel(entry.displayMode)}
                    </small>
                  </span>
                  <Icon name="forward" />
                </button>
                <div className="bookmark-library-actions">
                  <button
                    type="button"
                    className="quiet-link"
                    onClick={() => startEditBookmark(entry)}
                    aria-expanded={editingBookmarkId === entry.id}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="quiet-link danger-link"
                    onClick={() => void browser.removeBookmark(entry.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
              {editingBookmarkId === entry.id && (
                <BookmarkEditForm
                  bookmark={entry}
                  folders={bookmarkFolders}
                  busy={libraryBusy === `edit-bookmark-${entry.id}`}
                  onCancel={() => setEditingBookmarkId(null)}
                  onSave={(input) => saveBookmarkEdit(entry, input)}
                />
              )}
            </li>
          ))}
        </ol>
      )}
    </PageFrame>
  );
}

function BookmarkEditForm({
  bookmark,
  folders,
  busy,
  onCancel,
  onSave,
}: {
  bookmark: UserBrowserBookmark;
  folders: readonly UserBrowserBookmarkFolder[];
  busy: boolean;
  onCancel(): void;
  onSave(input: {
    title: string;
    displayMode: UserBrowserBookmarkDisplayMode;
    folderId: string | null;
  }): Promise<void>;
}) {
  const [title, setTitle] = useState(bookmark.title);
  const [displayMode, setDisplayMode] = useState<UserBrowserBookmarkDisplayMode>(
    bookmark.displayMode ?? "title",
  );
  const [folderId, setFolderId] = useState<string | null>(bookmark.folderId ?? null);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      setError("Give this bookmark a title before saving.");
      return;
    }
    setError("");
    try {
      await onSave({ title: normalizedTitle, displayMode, folderId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save changes.");
    }
  }

  return (
    <form className="bookmark-library-edit" onSubmit={submit}>
      <div className="bookmark-library-edit-fields">
        <label>
          <span>Title</span>
          <input value={title} maxLength={500} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          <span>Show on bar as</span>
          <select
            value={displayMode}
            onChange={(event) =>
              setDisplayMode(event.target.value as UserBrowserBookmarkDisplayMode)
            }
          >
            <option value="full">Full link</option>
            <option value="title">Suggested title</option>
            <option value="icon">Icon only</option>
          </select>
        </label>
        <label>
          <span>Folder</span>
          <select value={folderId ?? ""} onChange={(event) => setFolderId(event.target.value || null)}>
            <option value="">Bookmarks bar</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="bookmark-library-edit-footer">
        {error && <span className="bookmark-library-edit-error" role="alert">{error}</span>}
        <span className="bookmark-library-edit-actions">
          <Button type="button" variant="quiet" size="compact" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="solid" size="compact" busy={busy}>
            Save changes
          </Button>
        </span>
      </div>
    </form>
  );
}
