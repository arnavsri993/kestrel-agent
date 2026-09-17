import { useEffect, useRef, useState } from "react";
import type { UserBrowserFindMatch } from "@kestrel/shared-types";
import { Icon } from "../Icon";

export function FindPopover() {
	const tabId = new URLSearchParams(location.search).get("tabId") ?? "";
	const input = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [match, setMatch] = useState<UserBrowserFindMatch | null>(null);
	const [error, setError] = useState(false);
	const close = () =>
		void window.kestrel.request({ type: "browser-close-find" });
	const search = async (value: string, next = false, forward = true) => {
		const result = await window.kestrel
			.request({
				type: "browser-find-in-page",
				tabId,
				query: value,
				findNext: next,
				forward,
			})
			.catch(() => ({ ok: false }));
		setError(!result.ok);
	};
	useEffect(() => {
		input.current?.focus();
		const offEvent = window.kestrel.onBrowserEvent((event) => {
			if (event.type === "find-in-page" && event.match.tabId === tabId)
				setMatch(event.match);
		});
		const offCommand = window.kestrel.onBrowserCommand((command) => {
			if (command === "find-in-page") {
				input.current?.focus();
				input.current?.select();
			}
		});
		return () => {
			offEvent();
			offCommand();
		};
	}, [tabId]);
	return (
		<form
			className="find-popover"
			aria-label="Find in page"
			onSubmit={(event) => {
				event.preventDefault();
				void search(query, true);
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					close();
				} else if (
					(event.metaKey || event.ctrlKey) &&
					event.key.toLowerCase() === "f"
				) {
					event.preventDefault();
					input.current?.focus();
					input.current?.select();
				} else if (event.key === "Enter" && event.shiftKey) {
					event.preventDefault();
					void search(query, true, false);
				}
			}}
		>
			<input
				ref={input}
				aria-label="Find in page"
				placeholder="Find in page"
				value={query}
				onChange={(event) => {
					const value = event.target.value;
					setQuery(value);
					setMatch(null);
					void search(value);
				}}
			/>
			<output
				aria-live="polite"
				aria-label="Matches"
				className={error || (query && match?.matches === 0) ? "is-empty" : ""}
			>
				{error
					? "Unavailable"
					: query && match
						? `${match.activeMatchOrdinal}/${match.matches}`
						: ""}
			</output>
			<span className="find-popover-actions">
				<button
					type="button"
					aria-label="Previous match"
					title="Previous match (Shift+Enter)"
					disabled={!query || match?.matches === 0}
					onClick={() => void search(query, true, false)}
				>
					<Icon name="chevron" style={{ transform: "rotate(-90deg)" }} />
				</button>
				<button
					type="submit"
					aria-label="Next match"
					title="Next match (Enter)"
					disabled={!query || match?.matches === 0}
				>
					<Icon name="chevron" style={{ transform: "rotate(90deg)" }} />
				</button>
				<button
					type="button"
					aria-label="Close find"
					title="Close (Escape)"
					onClick={close}
				>
					<Icon name="close" />
				</button>
			</span>
		</form>
	);
}
