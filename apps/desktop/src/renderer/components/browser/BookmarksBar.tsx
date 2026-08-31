import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
	UserBrowserBookmark,
	UserBrowserOriginFavicon,
} from "@kestrel/shared-types";
import { Icon } from "../Icon";
import {
	bookmarkBarFaviconDataUrl,
	bookmarkBarGlyph,
	bookmarkBarLabel,
} from "./bookmarks-bar";
import "./bookmarks-bar.css";
import { KESTREL_STATE_TRANSITION } from "../../motion-contract";

export function BookmarksBar({
	bookmarks,
	originFavicons = [],
	onOpen,
	onOpenInNewTab,
	onRemove,
	onManage,
}: {
	bookmarks: UserBrowserBookmark[];
	originFavicons?: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
	onOpen(url: string): void;
	onOpenInNewTab(url: string): void;
	onRemove(bookmarkId: string): void;
	onManage(): void;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		anchorX: number;
		anchorY: number;
		bookmark: UserBrowserBookmark;
	} | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

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
		const x = Math.max(gutter, Math.min(menu.anchorX, window.innerWidth - rect.width - gutter));
		const y = Math.max(gutter, Math.min(menu.anchorY, window.innerHeight - rect.height - gutter));
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
			if (!menuRef.current || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
			const items = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>("button"));
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

	return (
		<div className="browser-bookmarks-bar" aria-label="Bookmarks bar">
			{bookmarks.length === 0 ? (
				<p className="browser-bookmarks-bar-empty">
					Bookmark a page with ⌘D to pin it here.
				</p>
			) : (
				<ul className="browser-bookmarks-bar-list">
					{bookmarks.map((bookmark) => {
						const label = bookmarkBarLabel(bookmark.title, bookmark.url);
						const faviconDataUrl = bookmarkBarFaviconDataUrl(
							bookmark.url,
							originFavicons,
						);
						return (
							<li key={bookmark.id} className="browser-bookmarks-bar-item">
								<button
									type="button"
									className="browser-bookmarks-bar-link"
									data-bookmark-id={bookmark.id}
									title={bookmark.url}
									onClick={(event) => {
										if (event.metaKey || event.ctrlKey)
											onOpenInNewTab(bookmark.url);
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
										setMenu({
											x: event.clientX,
											y: event.clientY,
											anchorX: event.clientX,
											anchorY: event.clientY,
											bookmark,
										});
									}}
								>
									<span className="browser-bookmarks-bar-glyph" aria-hidden="true">
										{faviconDataUrl ? (
											<img src={faviconDataUrl} alt="" draggable={false} />
										) : (
											bookmarkBarGlyph(bookmark.title, bookmark.url)
										)}
									</span>
									<span className="browser-bookmarks-bar-label">{label}</span>
								</button>
							</li>
						);
					})}
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
