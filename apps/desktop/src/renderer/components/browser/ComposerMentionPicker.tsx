import { useEffect, useState } from "react";
import type {
	SelectedAttachment,
	UserBrowserBookmark,
	UserBrowserTab,
} from "@kestrel/shared-types";
import { composerMentions, type ComposerMention } from "./composer-mentions";

export function ComposerMentionPicker({
	query,
	tabs,
	bookmarks,
	files,
	onSelect,
}: {
	query: string;
	tabs: UserBrowserTab[];
	bookmarks: UserBrowserBookmark[];
	files: SelectedAttachment[];
	onSelect(mention: ComposerMention): void;
}) {
	const [active, setActive] = useState(0);
	const items = composerMentions({ query, tabs, bookmarks, files });
	useEffect(() => setActive(0), [query, items.length]);
	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (items.length === 0) return;
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setActive((current) => (current + 1) % items.length);
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setActive((current) => (current - 1 + items.length) % items.length);
			} else if (event.key === "Enter" || event.key === "Tab") {
				const item = items[active];
				if (!item) return;
				event.preventDefault();
				onSelect(item);
			}
		}
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [active, items, onSelect]);
	if (items.length === 0) return null;
	return (
		<ul className="composer-mention-list" role="listbox" aria-label="Add context">
			{items.map((item, index) => (
				<li key={item.id}>
					<button
						type="button"
						role="option"
						aria-selected={index === active}
						className={index === active ? "active" : ""}
						onMouseDown={(event) => {
							event.preventDefault();
							onSelect(item);
						}}
					>
						<small>{item.kind}</small>
						<strong>{item.label}</strong>
						<span>{item.detail}</span>
					</button>
				</li>
			))}
		</ul>
	);
}
