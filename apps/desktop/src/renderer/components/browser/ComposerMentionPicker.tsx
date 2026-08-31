import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type {
	SelectedAttachment,
	UserBrowserBookmark,
	UserBrowserTab,
} from "@kestrel/shared-types";
import { composerMentions, type ComposerMention } from "./composer-mentions";
import { KESTREL_STATE_TRANSITION } from "../../motion-contract";

export function ComposerMentionPicker({
	query,
	tabs,
	bookmarks,
	files,
	onSelect,
	onDismiss,
}: {
	query: string | null;
	tabs: UserBrowserTab[];
	bookmarks: UserBrowserBookmark[];
	files: SelectedAttachment[];
	onSelect(mention: ComposerMention): void;
	onDismiss(): void;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const [active, setActive] = useState(0);
	const items = query === null ? [] : composerMentions({ query, tabs, bookmarks, files });
	useEffect(() => setActive(0), [query, items.length]);
	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (event.defaultPrevented) return;
			if (!(event.target instanceof HTMLTextAreaElement) || event.target.id !== "runtime-prompt")
				return;
			if (items.length === 0) return;
			if (event.key === "Escape") {
				event.preventDefault();
				onDismiss();
			} else if (event.key === "ArrowDown") {
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
	}, [active, items, onDismiss, onSelect]);
	return (
		<AnimatePresence initial={false}>
		{items.length > 0 && (
		<motion.ul
			key="composer-mention-list"
			className="composer-mention-list"
			role="listbox"
			aria-label="Add context"
			initial={reducedMotion ? false : { opacity: 0, y: 4, scale: 0.992 }}
			animate={{ opacity: 1, y: 0, scale: 1, pointerEvents: "auto" }}
			exit={
				reducedMotion
					? { opacity: 1, y: 0, scale: 1, pointerEvents: "none" }
					: { opacity: 0, y: 4, scale: 0.992, pointerEvents: "none" }
			}
			transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
			style={{ transformOrigin: "bottom center" }}
		>
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
		</motion.ul>
		)}
		</AnimatePresence>
	);
}
