import { useEffect, useState } from "react";
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
	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		bookmark: UserBrowserBookmark;
	} | null>(null);

	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("blur", close);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("blur", close);
		};
	}, [menu]);

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
			{menu && (
				<div
					className="browser-tab-menu"
					style={{ left: menu.x, top: menu.y }}
					role="menu"
					onClick={(event) => event.stopPropagation()}
				>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							onOpen(menu.bookmark.url);
							setMenu(null);
						}}
					>
						Open
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							onOpenInNewTab(menu.bookmark.url);
							setMenu(null);
						}}
					>
						Open in new tab
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							onRemove(menu.bookmark.id);
							setMenu(null);
						}}
					>
						Remove
					</button>
				</div>
			)}
		</div>
	);
}
