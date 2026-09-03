import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import type {
	UserBrowserBookmark,
	UserBrowserBookmarkDisplayMode,
	UserBrowserBookmarkFolder,
	UserBrowserOriginFavicon,
	UserBrowserTab,
} from "@kestrel/shared-types";
import { Icon } from "../Icon";
import {
	bookmarkBarDisplayLabel,
	bookmarkDisplayModeLabel,
} from "./bookmarks-bar";
import { BookmarkFavicon } from "./BookmarkFavicon";
import { recommendedBookmarkTitle } from "./bookmark-title";
import "./bookmark-dialog.css";
import { KESTREL_STATE_TRANSITION } from "../../motion-contract";

const DISPLAY_OPTIONS: readonly {
	mode: UserBrowserBookmarkDisplayMode;
	label: string;
	icon: "copy" | "writing" | "star";
	description: string;
}[] = [
	{
		mode: "full",
		label: "Full link",
		icon: "copy",
		description: "Keep the complete address visible on the bar.",
	},
	{
		mode: "title",
		label: "Suggested title",
		icon: "writing",
		description: "Let Kestrel make a concise title for this page.",
	},
	{
		mode: "icon",
		label: "Icon only",
		icon: "star",
		description: "Keep the bar quiet and use the site icon as the label.",
	},
];

function pageHost(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./i, "");
	} catch {
		return url;
	}
}

function BookmarkPreview({
	url,
	title,
	displayMode,
	faviconDataUrl,
	originFavicons,
}: {
	url: string;
	title: string;
	displayMode: UserBrowserBookmarkDisplayMode;
	faviconDataUrl?: string;
	originFavicons: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
}) {
	const label = bookmarkBarDisplayLabel(title, url, displayMode);
	return (
		<div
			className="bookmark-dialog-preview-bar"
			role="img"
			aria-label={`${bookmarkDisplayModeLabel(displayMode)} bookmark bar preview`}
		>
			<span className="bookmark-dialog-preview-chrome">
				<Icon name="star" />
				Bookmarks bar
			</span>
			<span className="bookmark-dialog-preview-divider" aria-hidden="true" />
			<span
				className={`bookmark-dialog-preview-entry${displayMode === "icon" ? " icon-only" : ""}`}
			>
				<BookmarkFavicon
					title={title}
					url={url}
					{...(faviconDataUrl ? { faviconDataUrl } : {})}
					originFavicons={originFavicons}
					className="browser-bookmarks-bar-glyph"
				/>
				{displayMode !== "icon" && (
					<span className="bookmark-dialog-preview-label">{label}</span>
				)}
			</span>
		</div>
	);
}

function BookmarkOptionPreview({
	title,
	url,
	displayMode,
	faviconDataUrl,
	originFavicons,
}: {
	title: string;
	url: string;
	displayMode: UserBrowserBookmarkDisplayMode;
	faviconDataUrl?: string;
	originFavicons: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
}) {
	const label = bookmarkBarDisplayLabel(title, url, displayMode);
	return (
		<span className="bookmark-dialog-option-preview" aria-hidden="true">
			<span className="bookmark-dialog-option-preview-chrome">bar</span>
			<span
				className={`bookmark-dialog-option-preview-entry${displayMode === "icon" ? " icon-only" : ""}`}
			>
				<BookmarkFavicon
					title={title}
					url={url}
					{...(faviconDataUrl ? { faviconDataUrl } : {})}
					originFavicons={originFavicons}
					className="browser-bookmarks-bar-glyph"
				/>
				{displayMode !== "icon" && <span>{label}</span>}
			</span>
		</span>
	);
}

export type BookmarkDialogSaveInput = {
	title: string;
	displayMode: UserBrowserBookmarkDisplayMode;
	folderId: string | null;
};

export function BookmarkDialog({
	tab,
	bookmark,
	bookmarkFolders,
	originFavicons,
	onCancel,
	onSave,
	onCreateFolder,
}: {
	tab: UserBrowserTab;
	bookmark?: UserBrowserBookmark;
	bookmarkFolders: readonly UserBrowserBookmarkFolder[];
	originFavicons: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
	onCancel(): void;
	onSave(input: BookmarkDialogSaveInput): Promise<void>;
	onCreateFolder(name: string): Promise<UserBrowserBookmarkFolder | undefined>;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const recommendedTitle = recommendedBookmarkTitle(tab.url, tab.title);
	const [title, setTitle] = useState(bookmark?.title ?? recommendedTitle);
	const [titleTouched, setTitleTouched] = useState(Boolean(bookmark));
	const [displayMode, setDisplayMode] = useState<UserBrowserBookmarkDisplayMode>(
		bookmark ? (bookmark.displayMode ?? "title") : "full",
	);
	const [folderId, setFolderId] = useState<string | null>(
		bookmark?.folderId ?? null,
	);
	const [folderName, setFolderName] = useState("");
	const [creatingFolder, setCreatingFolder] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const titleRef = useRef<HTMLInputElement | null>(null);
	const busyRef = useRef(false);
	busyRef.current = busy;

	useEffect(() => {
		const returnFocus =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const frame = window.requestAnimationFrame(() => {
			titleRef.current?.focus();
			titleRef.current?.select();
		});
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				if (event.defaultPrevented || busyRef.current) return;
				event.preventDefault();
				onCancel();
				return;
			}
			if (event.key !== "Tab" || !dialogRef.current) return;
			const focusable = Array.from(
				dialogRef.current.querySelectorAll<HTMLElement>(
					"button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
				),
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			window.cancelAnimationFrame(frame);
			document.removeEventListener("keydown", onKeyDown);
			returnFocus?.focus();
		};
	}, [onCancel]);

	function chooseDisplayMode(mode: UserBrowserBookmarkDisplayMode) {
		setDisplayMode(mode);
		if (mode === "title" && !titleTouched) setTitle(recommendedTitle);
	}

	async function createFolder() {
		const name = folderName.trim();
		if (!name) {
			setError("Give the new folder a name.");
			return;
		}
		setCreatingFolder(true);
		setError("");
		try {
			const folder = await onCreateFolder(name);
			if (folder) {
				setFolderId(folder.id);
				setFolderName("");
				setCreatingFolder(false);
				return;
			}
			setError("The new folder was not returned. Try again.");
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "The folder could not be created. Try again.",
			);
		} finally {
			setCreatingFolder(false);
		}
	}

	async function save(event: FormEvent) {
		event.preventDefault();
		const normalizedTitle = title.trim();
		if (!normalizedTitle) {
			setError("Give this bookmark a title before saving.");
			return;
		}
		setBusy(true);
		setError("");
		try {
			await onSave({
				title: normalizedTitle,
				displayMode,
				folderId,
			});
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "The bookmark could not be saved. Try again.",
			);
			setBusy(false);
		}
	}

	const heading = bookmark ? "Edit bookmark" : "Save bookmark";
	return (
		<motion.div
			className="bookmark-dialog-overlay"
			role="presentation"
			initial={reducedMotion ? false : { opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={
				reducedMotion
					? { opacity: 1, pointerEvents: "none" }
					: { opacity: 0, pointerEvents: "none" }
			}
			transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
			onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
				if (event.target === event.currentTarget && !busy) onCancel();
			}}
		>
			<motion.div
				ref={dialogRef}
				className="bookmark-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="bookmark-dialog-title"
				aria-describedby="bookmark-dialog-description"
				aria-busy={busy}
				initial={reducedMotion ? false : { opacity: 0, y: 8, scale: 0.985 }}
				animate={{ opacity: 1, y: 0, scale: 1 }}
				exit={
					reducedMotion
						? { opacity: 1, y: 0, scale: 1 }
						: { opacity: 0, y: 8, scale: 0.985 }
				}
				transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
			>
				<header className="bookmark-dialog-header">
					<div className="bookmark-dialog-heading">
						<span className="bookmark-dialog-mark" aria-hidden="true">
							<BookmarkFavicon
								title={tab.title}
								url={tab.url}
								{...(tab.faviconDataUrl
									? { faviconDataUrl: tab.faviconDataUrl }
									: {})}
								originFavicons={originFavicons}
								className="bookmark-dialog-favicon"
							/>
						</span>
						<span>
							<strong id="bookmark-dialog-title">{heading}</strong>
							<small>{pageHost(tab.url)}</small>
						</span>
					</div>
					<button
						type="button"
						className="bookmark-dialog-close"
						aria-label={`Close ${heading.toLowerCase()}`}
						onClick={onCancel}
						disabled={busy}
					>
						<Icon name="close" />
					</button>
				</header>

				<form onSubmit={save}>
					<div className="bookmark-dialog-body">
						<p id="bookmark-dialog-description" className="bookmark-dialog-intro">
							Choose how this page should appear on your bookmarks bar.
						</p>

						<fieldset className="bookmark-dialog-options">
							<legend>Bookmark style</legend>
							<div className="bookmark-dialog-option-grid">
								{DISPLAY_OPTIONS.map((option) => (
									<label
										key={option.mode}
										className={`bookmark-dialog-option${displayMode === option.mode ? " selected" : ""}`}
									>
										<input
											type="radio"
											name="bookmark-display-mode"
											value={option.mode}
											checked={displayMode === option.mode}
											onChange={() => chooseDisplayMode(option.mode)}
										/>
									<span className="bookmark-dialog-option-main">
										<span className="bookmark-dialog-option-icon" aria-hidden="true">
											<Icon name={option.icon} />
										</span>
									<span className="bookmark-dialog-option-copy">
										<strong>{option.label}</strong>
										<small>{option.description}</small>
									</span>
									<BookmarkOptionPreview
										title={title || recommendedTitle}
										url={tab.url}
										displayMode={option.mode}
										originFavicons={originFavicons}
										{...(tab.faviconDataUrl
											? { faviconDataUrl: tab.faviconDataUrl }
											: {})}
									/>
								</span>
									<span className="bookmark-dialog-option-check" aria-hidden="true">
										<Icon name="check" />
									</span>
									</label>
								))}
							</div>
						</fieldset>

						<div className="bookmark-dialog-preview-section">
							<div className="bookmark-dialog-section-heading">
								<span>
									<strong>Bookmark bar preview</strong>
									<small>{bookmarkDisplayModeLabel(displayMode)}</small>
								</span>
								<span className="bookmark-dialog-live-label">Live preview</span>
							</div>
								<BookmarkPreview
									url={tab.url}
									title={title || recommendedTitle}
									displayMode={displayMode}
									originFavicons={originFavicons}
									{...(tab.faviconDataUrl
										? { faviconDataUrl: tab.faviconDataUrl }
										: {})}
								/>
						</div>

						<label className="bookmark-dialog-field">
							<span>Title</span>
							<input
								ref={titleRef}
								value={title}
								maxLength={500}
								onChange={(event) => {
									setTitleTouched(true);
									setTitle(event.target.value);
								}}
							/>
							<small>
								Kestrel suggests “{recommendedTitle}”. You can edit it anytime.
							</small>
						</label>

						<div className="bookmark-dialog-field">
							<label htmlFor="bookmark-folder-select">Folder</label>
							<div className="bookmark-dialog-folder-row">
								<select
									id="bookmark-folder-select"
									value={folderId ?? ""}
									onChange={(event) => setFolderId(event.target.value || null)}
								>
									<option value="">Bookmarks bar</option>
									{bookmarkFolders.map((folder) => (
										<option key={folder.id} value={folder.id}>
											{folder.name}
										</option>
									))}
								</select>
								<button
									type="button"
									className="bookmark-dialog-new-folder"
									onClick={() => setCreatingFolder((current) => !current)}
									disabled={busy}
								>
									<Icon name="plus" />
									New folder
								</button>
							</div>
							{creatingFolder && (
								<div className="bookmark-dialog-create-folder">
									<input
										value={folderName}
										placeholder="Folder name"
										maxLength={80}
										autoFocus
										onKeyDown={(event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												void createFolder();
											}
										}}
										onChange={(event) => setFolderName(event.target.value)}
									/>
									<button type="button" disabled={busy} onClick={() => void createFolder()}>
										Create
									</button>
								</div>
							)}
						</div>
						{error && (
							<p className="bookmark-dialog-error" role="alert">
								<Icon name="warning" />
								{error}
							</p>
						)}
					</div>
					<footer className="bookmark-dialog-footer">
						<button
							type="button"
							className="bookmark-dialog-secondary"
							onClick={onCancel}
							disabled={busy}
						>
							Cancel
						</button>
						<button type="submit" className="bookmark-dialog-primary" disabled={busy}>
							{busy ? "Saving…" : bookmark ? "Save changes" : "Save bookmark"}
						</button>
					</footer>
				</form>
			</motion.div>
		</motion.div>
	);
}
