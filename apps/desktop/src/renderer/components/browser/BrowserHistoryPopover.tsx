import { useMemo, useState } from "react";
import type { UserBrowserHistoryEntry } from "@kestrel/shared-types";
import { Icon } from "../Icon";

export function BrowserHistoryPopover({
	history,
	onOpen,
	onOpenFull,
	onClear,
}: {
	history: readonly UserBrowserHistoryEntry[];
	onOpen(url: string): void;
	onOpenFull(): void;
	onClear(): void;
}) {
	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return [...history]
			.reverse()
			.filter(
				(entry) =>
					!normalized ||
					`${entry.title} ${entry.url}`.toLowerCase().includes(normalized),
			)
			.slice(0, 50);
	}, [history, query]);

	return (
		<>
			<header className="browser-toolbar-popover-header browser-toolbar-popover-header-actions">
				<Icon name="history" />
				<span>
					<strong>History</strong>
					<small>Recent pages on this Mac</small>
				</span>
				<button
					type="button"
					className="browser-toolbar-popover-expand"
					aria-label="Open full history view"
					title="Open full history view"
					onClick={onOpenFull}
				>
					<Icon name="expand" />
				</button>
			</header>
			<label className="browser-history-popover-search">
				<Icon name="search" />
				<span className="sr-only">Search history</span>
				<input
					value={query}
					placeholder="Search history"
					onChange={(event) => setQuery(event.target.value)}
				/>
			</label>
			{filtered.length === 0 ? (
				<p className="browser-toolbar-popover-empty">
					{query ? "No matching pages." : "Pages you open in Kestrel stay here on this Mac."}
				</p>
			) : (
				<ol className="browser-history-popover-list">
					{filtered.map((entry) => {
						let hostname = entry.url;
						try {
							hostname = new URL(entry.url).hostname;
						} catch {
							// Keep the raw URL when history contains a non-standard entry.
						}
						return (
							<li key={entry.id}>
								<button
									type="button"
									role="menuitem"
									onClick={() => onOpen(entry.url)}
								>
									<span className="history-favicon" aria-hidden="true">
										{hostname.charAt(0).toUpperCase()}
									</span>
									<span className="browser-history-popover-copy">
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
						);
					})}
				</ol>
			)}
			{history.length > 0 && (
				<button
					type="button"
					role="menuitem"
					className="browser-toolbar-menu-link browser-history-popover-clear"
					onClick={onClear}
				>
					<Icon name="close" />
					<span>Clear browsing history</span>
				</button>
			)}
		</>
	);
}
