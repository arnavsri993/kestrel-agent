import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type {
	UserBrowserBookmark,
	UserBrowserBookmarkFolder,
	UserBrowserOriginFavicon,
} from "@kestrel/shared-types";
import { Icon } from "../Icon";
import { BookmarkFavicon } from "./BookmarkFavicon";
import { bookmarkBarDisplayLabel } from "./bookmarks-bar";
import "./bookmarks-bar.css";
import { KESTREL_STATE_TRANSITION } from "../../motion-contract";

type BookmarkMenu = {
	x: number;
	y: number;
	anchorX: number;
	anchorY: number;
	bookmark: UserBrowserBookmark;
};

function BookmarkBarEntry({
	bookmark,
	originFavicons,
	onOpen,
	onOpenInNewTab,
	onContextMenu,
}: {
	bookmark: UserBrowserBookmark;
	originFavicons: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
	onOpen(url: string): void;
	onOpenInNewTab(url: string): void;
	onContextMenu(
		event: MouseEvent<HTMLButtonElement>,
		bookmark: UserBrowserBookmark,
	): void;
}) {
	const label = bookmarkBarDisplayLabel(
		bookmark.title,
		bookmark.url,
		bookmark.displayMode,
	);
	const iconOnly = bookmark.displayMode === "icon";
	return (
		<button
			type="button"
			className={`browser-bookmarks-bar-link${iconOnly ? " icon-only" : ""}`}
			data-bookmark-id={bookmark.id}
			data-display-mode={bookmark.displayMode ?? "title"}
			aria-label={`Open ${bookmark.title}`}
			title={`${bookmark.title} — ${bookmark.url}`}
			onClick={(event) => {
				if (event.metaKey || event.ctrlKey) onOpenInNewTab(bookmark.url);
				else onOpen(bookmark.url);
			}}
			onAuxClick={(event) => {
				if (event.button === 1) {
					event.preventDefault();
					onOpenInNewTab(bookmark.url);
				}
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				onContextMenu(event, bookmark);
			}}
		>
			<BookmarkFavicon
				title={bookmark.title}
				url={bookmark.url}
				{...(bookmark.faviconDataUrl
					? { faviconDataUrl: bookmark.faviconDataUrl }
					: {})}
				originFavicons={originFavicons}
				className="browser-bookmarks-bar-glyph"
			/>
			{!iconOnly && <span className="browser-bookmarks-bar-label">{label}</span>}
		</button>
	);
}

function BookmarkFolderDropdown({
	folder,
	bookmarks,
	originFavicons,
	onOpen,
	onOpenInNewTab,
	onContextMenu,
}: {
	folder: UserBrowserBookmarkFolder;
	bookmarks: readonly UserBrowserBookmark[];
	originFavicons: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
	onOpen(url: string): void;
	onOpenInNewTab(url: string): void;
	onContextMenu(
		event: MouseEvent<HTMLButtonElement>,
		bookmark: UserBrowserBookmark,
	): void;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState({ left: 12, top: 12 });
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const folderBookmarks = bookmarks.filter(
		(bookmark) => bookmark.folderId === folder.id,
	);

	const positionMenu = useCallback(() => {
		if (!triggerRef.current || !menuRef.current) return;
		const trigger = triggerRef.current.getBoundingClientRect();
		const menu = menuRef.current.getBoundingClientRect();
		const gutter = 12;
		let left = Math.max(
			gutter,
			Math.min(trigger.left, window.innerWidth - menu.width - gutter),
		);
		let top = trigger.bottom + 7;
		if (top + menu.height > window.innerHeight - gutter)
			top = trigger.top - menu.height - 7;
		if (top < gutter)
			top = Math.max(gutter, window.innerHeight - menu.height - gutter);
		if (left < gutter) left = gutter;
		setPosition({ left, top });
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		positionMenu();
		const frame = window.requestAnimationFrame(positionMenu);
		return () => window.cancelAnimationFrame(frame);
	}, [folderBookmarks.length, open, positionMenu]);

	useEffect(() => {
		if (!open) return;
		const reposition = () => positionMenu();
		const frame = window.requestAnimationFrame(() =>
			menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
		);
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (
				target &&
				(triggerRef.current?.contains(target) || menuRef.current?.contains(target))
			)
				return;
			setOpen(false);
		};
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target as Node | null;
			if (
				target &&
				(triggerRef.current?.contains(target) || menuRef.current?.contains(target))
			)
				return;
			setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				setOpen(false);
				window.requestAnimationFrame(() => triggerRef.current?.focus());
				return;
			}
			if (!menuRef.current || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
			const items = Array.from(
				menuRef.current.querySelectorAll<HTMLButtonElement>("button"),
			);
			if (items.length === 0) return;
			event.preventDefault();
			const current = items.indexOf(document.activeElement as HTMLButtonElement);
			const delta = event.key === "ArrowDown" ? 1 : -1;
			items[(current + delta + items.length) % items.length]?.focus();
		};
		const onBlur = () => setOpen(false);
		window.addEventListener("resize", reposition);
		window.addEventListener("scroll", reposition, true);
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("focusin", onFocusIn);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("blur", onBlur);
		return () => {
			window.cancelAnimationFrame(frame);
			window.removeEventListener("resize", reposition);
			window.removeEventListener("scroll", reposition, true);
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("focusin", onFocusIn);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("blur", onBlur);
		};
	}, [open, positionMenu]);

	function closeFolder() {
		setOpen(false);
	}

	return (
		<>
			<li className="browser-bookmarks-bar-item">
				<button
					ref={triggerRef}
					type="button"
					className="browser-bookmarks-bar-folder-trigger"
					aria-haspopup="menu"
					aria-expanded={open}
					title={`${folder.name} bookmark folder`}
					onClick={() => setOpen((current) => !current)}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" && !open) {
							event.preventDefault();
							setOpen(true);
						}
					}}
				>
					<Icon name="folder" />
					<span>{folder.name}</span>
				</button>
			</li>
			{createPortal(
				<AnimatePresence initial={false}>
					{open && (
						<motion.div
							ref={menuRef}
							className="browser-bookmarks-bar-folder-menu"
							role="menu"
							aria-label={`${folder.name} bookmarks`}
							style={{ left: position.left, top: position.top }}
							initial={reducedMotion ? false : { opacity: 0, y: -3, scale: 0.99 }}
							animate={{ opacity: 1, y: 0, scale: 1 }}
							exit={
								reducedMotion
									? { opacity: 1, pointerEvents: "none" }
									: { opacity: 0, y: -3, scale: 0.99, pointerEvents: "none" }
							}
							transition={
								reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION
							}
						>
							{folderBookmarks.length === 0 ? (
								<span className="browser-bookmarks-bar-folder-empty">
									No bookmarks in this folder
								</span>
							) : (
								folderBookmarks.map((bookmark) => {
									const iconOnly = bookmark.displayMode === "icon";
									return (
										<button
											type="button"
											role="menuitem"
											className={`browser-bookmarks-bar-folder-item${iconOnly ? " icon-only" : ""}`}
											key={bookmark.id}
											aria-label={`Open ${bookmark.title}`}
											title={`${bookmark.title} — ${bookmark.url}`}
											onClick={(event) => {
												if (event.metaKey || event.ctrlKey)
													onOpenInNewTab(bookmark.url);
												else onOpen(bookmark.url);
												closeFolder();
											}}
											onAuxClick={(event) => {
												if (event.button === 1) {
													event.preventDefault();
													onOpenInNewTab(bookmark.url);
													closeFolder();
												}
											}}
											onContextMenu={(event) => {
												event.preventDefault();
												onContextMenu(event, bookmark);
												closeFolder();
											}}
										>
											<BookmarkFavicon
												title={bookmark.title}
												url={bookmark.url}
												{...(bookmark.faviconDataUrl
													? { faviconDataUrl: bookmark.faviconDataUrl }
													: {})}
													originFavicons={originFavicons}
													className="browser-bookmarks-bar-glyph"
												/>
											{!iconOnly && (
												<span>
													{bookmarkBarDisplayLabel(
														bookmark.title,
														bookmark.url,
														bookmark.displayMode,
													)}
												</span>
											)}
										</button>
									);
								})
							)}
						</motion.div>
					)}
				</AnimatePresence>,
				document.body,
			)}
		</>
	);
}

export function BookmarksBar({
	bookmarks,
	bookmarkFolders = [],
	originFavicons = [],
	onOpen,
	onOpenInNewTab,
	onRemove,
	onManage,
	onEdit,
}: {
	bookmarks: UserBrowserBookmark[];
	bookmarkFolders?: UserBrowserBookmarkFolder[];
	originFavicons?: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
	onOpen(url: string): void;
	onOpenInNewTab(url: string): void;
	onRemove(bookmarkId: string): void;
	onManage(): void;
	onEdit(bookmarkId: string): void;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const [menu, setMenu] = useState<BookmarkMenu | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const rootBookmarks = bookmarks.filter((bookmark) => !bookmark.folderId);

	const dismissMenu = useCallback(() => {
		setMenu(null);
	}, []);

	const closeMenu = useCallback(() => {
		const bookmarkId = menu?.bookmark.id;
		dismissMenu();
		if (!bookmarkId) return;
		window.requestAnimationFrame(() =>
			document
				.querySelector<HTMLElement>(
					`[data-bookmark-id="${CSS.escape(bookmarkId)}"]`,
				)
				?.focus(),
		);
	}, [dismissMenu, menu?.bookmark.id]);

	useLayoutEffect(() => {
		if (!menu || !menuRef.current) return;
		const rect = menuRef.current.getBoundingClientRect();
		const gutter = 8;
		const x = Math.max(
			gutter,
			Math.min(menu.anchorX, window.innerWidth - rect.width - gutter),
		);
		const y = Math.max(
			gutter,
			Math.min(menu.anchorY, window.innerHeight - rect.height - gutter),
		);
		if (x !== menu.x || y !== menu.y)
			setMenu((current) => (current ? { ...current, x, y } : current));
	}, [menu]);

	useEffect(() => {
		if (!menu) return;
		const frame = window.requestAnimationFrame(() =>
			menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
		);
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && !menuRef.current?.contains(target)) dismissMenu();
		};
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target as Node | null;
			if (target && !menuRef.current?.contains(target)) dismissMenu();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				if (event.defaultPrevented) return;
				event.preventDefault();
				closeMenu();
				return;
			}
			if (!menuRef.current || !["ArrowDown", "ArrowUp"].includes(event.key))
				return;
			const items = Array.from(
				menuRef.current.querySelectorAll<HTMLButtonElement>("button"),
			);
			if (items.length === 0) return;
			const current = items.indexOf(document.activeElement as HTMLButtonElement);
			const delta = event.key === "ArrowDown" ? 1 : -1;
			event.preventDefault();
			items[(current + delta + items.length) % items.length]?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("blur", dismissMenu);
		return () => {
			window.cancelAnimationFrame(frame);
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("blur", dismissMenu);
		};
	}, [closeMenu, dismissMenu, menu]);

	function setContextMenu(
		event: React.MouseEvent<HTMLButtonElement>,
		bookmark: UserBrowserBookmark,
	) {
		setMenu({
			x: event.clientX,
			y: event.clientY,
			anchorX: event.clientX,
			anchorY: event.clientY,
			bookmark,
		});
	}

	const hasBookmarkItems = rootBookmarks.length > 0 || bookmarkFolders.length > 0;
	return (
		<div className="browser-bookmarks-bar" aria-label="Bookmarks bar">
			{!hasBookmarkItems ? (
				<p className="browser-bookmarks-bar-empty">
					Bookmark a page with ⌘D to pin it here.
				</p>
			) : (
				<ul className="browser-bookmarks-bar-list">
					{rootBookmarks.map((bookmark) => (
						<li key={bookmark.id} className="browser-bookmarks-bar-item">
							<BookmarkBarEntry
								bookmark={bookmark}
								originFavicons={originFavicons}
								onOpen={onOpen}
								onOpenInNewTab={onOpenInNewTab}
												onContextMenu={setContextMenu}
											/>
										</li>
									))}
					{bookmarkFolders.map((folder) => (
						<BookmarkFolderDropdown
							key={folder.id}
							folder={folder}
							bookmarks={bookmarks}
							originFavicons={originFavicons}
							onOpen={onOpen}
							onOpenInNewTab={onOpenInNewTab}
							onContextMenu={setContextMenu}
						/>
					))}
				</ul>
			)}
			<button
				type="button"
				className="browser-bookmarks-bar-manage"
				aria-label="Manage bookmarks"
				title="Manage bookmarks (⌘⇧D)"
				onClick={onManage}
			>
				<Icon name="star" />
				Manage
			</button>
			<AnimatePresence initial={false}>
				{menu && (
					<motion.div
						key={`bookmark-menu-${menu.bookmark.id}`}
						ref={menuRef}
						className="browser-tab-menu"
						style={{
							left: menu.x,
							top: menu.y,
							transformOrigin: `${Math.max(8, menu.anchorX - menu.x)}px ${Math.max(8, menu.anchorY - menu.y)}px`,
						}}
						role="menu"
						initial={reducedMotion ? false : { opacity: 0, scale: 0.985 }}
						animate={{ opacity: 1, scale: 1 }}
						exit={
							reducedMotion
								? { opacity: 1, scale: 1, pointerEvents: "none" }
								: { opacity: 0, scale: 0.985, pointerEvents: "none" }
						}
						transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
					>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								onEdit(menu.bookmark.id);
								closeMenu();
							}}
						>
							Edit
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								onOpen(menu.bookmark.url);
								closeMenu();
							}}
						>
							Open
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								onOpenInNewTab(menu.bookmark.url);
								closeMenu();
							}}
						>
							Open in new tab
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								onRemove(menu.bookmark.id);
								closeMenu();
							}}
						>
							Remove
						</button>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
