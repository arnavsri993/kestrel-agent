import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { Icon } from "../Icon";
import { KESTREL_STATE_TRANSITION } from "../../motion-contract";

interface ShortcutItem {
	keys: string[];
	description: string;
}

interface ShortcutCategory {
	title: string;
	shortcuts: ShortcutItem[];
}

const isMac =
	typeof navigator !== "undefined" &&
	/Mac|iPod|iPhone|iPad/.test(`${navigator.userAgent} ${navigator.platform}`);

const cmd = isMac ? "⌘" : "Ctrl";
const opt = isMac ? "⌥" : "Alt";
const shift = isMac ? "⇧" : "Shift";
const ctrl = isMac ? "⌃" : "Ctrl";

const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
	{
		title: "Tabs & Windows",
		shortcuts: [
			{ keys: [cmd, "T"], description: "New browser tab" },
			{ keys: [cmd, "W"], description: "Close active tab" },
			{ keys: [cmd, shift, "T"], description: "Reopen last closed tab" },
			{ keys: [ctrl, "Tab"], description: "Next tab" },
			{ keys: [ctrl, shift, "Tab"], description: "Previous tab" },
			{ keys: [cmd, "1–8"], description: "Switch to tab 1–8" },
			{ keys: [cmd, "9"], description: "Switch to last tab" },
		],
	},
	{
		title: "Navigation & Actions",
		shortcuts: [
			{ keys: [cmd, "L"], description: "Focus address bar" },
			{ keys: [cmd, "R"], description: "Reload page" },
			{ keys: [cmd, shift, "R"], description: "Hard reload (ignore cache)" },
			{
				keys: isMac ? [cmd, "["] : [opt, "←"],
				description: "Go back in history",
			},
			{
				keys: isMac ? [cmd, "]"] : [opt, "→"],
				description: "Go forward in history",
			},
			{ keys: [cmd, "F"], description: "Find in page" },
			{ keys: [cmd, "D"], description: "Bookmark this page" },
			{ keys: [cmd, shift, "B"], description: "Show or hide the bookmarks bar" },
			{ keys: [cmd, shift, "D"], description: "Open bookmarks" },
			{ keys: [cmd, "P"], description: "Print this page" },
			{ keys: [cmd, shift, "I"], description: "Inspect page (DevTools)" },
			{ keys: ["Esc"], description: "Stop loading / Close find" },
		],
	},
	{
		title: "Zoom & View",
		shortcuts: [
			{ keys: [cmd, "+"], description: "Zoom in" },
			{ keys: [cmd, "−"], description: "Zoom out" },
			{ keys: [cmd, "0"], description: "Reset zoom to 100%" },
		],
	},
	{
		title: "Agent & Workspace",
		shortcuts: [
			{ keys: ["@"], description: "Mention a tab, bookmark, or file" },
			{ keys: [cmd, "K"], description: "Open the Command Center" },
			{ keys: [cmd, "H"], description: "Open browsing history" },
			{ keys: [cmd, shift, "D"], description: "Open bookmarks" },
			{ keys: [cmd, "J"], description: "Open downloads" },
			{ keys: [cmd, ","], description: "Open settings" },
			{ keys: [cmd, "B"], description: "Toggle agent sidebar" },
			{ keys: [cmd, "/"], description: "Show keyboard shortcuts" },
		],
	},
];

export function KeyboardShortcutsModal({ onClose }: { onClose(): void }) {
	const reducedMotion = useReducedMotion() ?? false;
	const cardRef = useRef<HTMLDivElement | null>(null);
	const closeRef = useRef<HTMLButtonElement | null>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const close = useCallback(() => {
		returnFocusRef.current?.focus();
		onClose();
	}, [onClose]);

	useEffect(() => {
		if (document.activeElement instanceof HTMLElement)
			returnFocusRef.current = document.activeElement;
		const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				if (event.defaultPrevented) return;
				event.preventDefault();
				close();
				return;
			}
			if (event.key !== "Tab" || !cardRef.current) return;
			const focusable = Array.from(
				cardRef.current.querySelectorAll<HTMLElement>(
					"button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
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
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			window.cancelAnimationFrame(frame);
			document.removeEventListener("keydown", handleKeyDown);
			if (cardRef.current?.contains(document.activeElement))
				returnFocusRef.current?.focus();
		};
	}, [close]);

	return (
		<motion.div
			className="shortcuts-modal-overlay"
			role="dialog"
			aria-modal="true"
			aria-labelledby="shortcuts-modal-title"
			initial={reducedMotion ? false : { opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={
				reducedMotion
					? { opacity: 1, pointerEvents: "none" }
					: { opacity: 0, pointerEvents: "none" }
			}
			transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
			onClick={(event) => {
				if (event.target === event.currentTarget) close();
			}}
		>
			<motion.div
				ref={cardRef}
				className="shortcuts-modal-card"
				initial={reducedMotion ? false : { opacity: 0, scale: 0.985, y: 8 }}
				animate={{ opacity: 1, scale: 1, y: 0 }}
				exit={
					reducedMotion
						? { opacity: 1, scale: 1, y: 0 }
						: { opacity: 0, scale: 0.985, y: 8 }
				}
				transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
			>
				<header className="shortcuts-modal-header">
					<div className="shortcuts-modal-title-group">
						<span className="shortcuts-modal-icon">
							<Icon name="command" />
						</span>
						<div>
							<h2 id="shortcuts-modal-title">Keyboard shortcuts</h2>
						</div>
					</div>
					<button
						ref={closeRef}
						type="button"
						className="shortcuts-modal-close"
						aria-label="Close keyboard shortcuts"
						onClick={close}
					>
						<Icon name="close" />
					</button>
				</header>

				<div className="shortcuts-modal-grid">
					{SHORTCUT_CATEGORIES.map((category) => (
						<section key={category.title} className="shortcuts-category">
							<h3>{category.title}</h3>
							<div className="shortcuts-list">
								{category.shortcuts.map((shortcut) => (
									<div
										key={shortcut.description}
										className="shortcut-row"
									>
										<span className="shortcut-desc">
											{shortcut.description}
										</span>
										<span className="shortcut-keys">
											{shortcut.keys.map((k) => (
												<kbd key={k}>{k}</kbd>
											))}
										</span>
									</div>
								))}
							</div>
						</section>
					))}
				</div>

				<footer className="shortcuts-modal-footer">
					<span>
						Press <kbd>Esc</kbd> or <kbd>{cmd}</kbd> <kbd>/</kbd> to dismiss
					</span>
				</footer>
			</motion.div>
		</motion.div>
	);
}
