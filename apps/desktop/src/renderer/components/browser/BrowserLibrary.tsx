import { useMemo, useState } from "react";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { Icon } from "../Icon";
import { EmptyState } from "../ui";
import { SurfaceBackButton } from "./SurfaceBackButton";

function compactBytes(value: number): string {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
	if (value >= 1_000) return `${Math.round(value / 1_000)} KB`;
	return `${value} B`;
}

function downloadStatusLabel(status: string): string {
	return {
		completed: "Completed",
		cancelled: "Cancelled",
		failed: "Failed",
		interrupted: "Interrupted",
		progressing: "Downloading",
	}[status] ?? status;
}

export function BrowserHistory({
	browser,
	onOpenBrowser,
	onBack,
}: {
	browser: UserBrowserController;
	onOpenBrowser(): void;
	onBack(): void;
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
		onOpenBrowser();
	}

	return (
		<main className="browser-library" aria-labelledby="history-title">
			<header>
				<div>
					<SurfaceBackButton onBack={onBack} />
					<span className="library-icon">
						<Icon name="history" />
					</span>
					<h1 id="history-title">Pages you visited</h1>
				</div>
				<label>
					<Icon name="search" />
					<span className="sr-only">Search history</span>
					<input
						value={query}
						placeholder="Search history"
						onChange={(event) => setQuery(event.target.value)}
					/>
				</label>
				{history.length > 0 && (
					<button
						type="button"
						className="quiet-link"
						onClick={() => void browser.clearHistory()}
					>
						Clear browsing history
					</button>
				)}
			</header>
			{filtered.length === 0 ? (
				<EmptyState
					className="library-empty"
					title={query ? "No matching pages" : "No history yet"}
					detail={
						query
							? "Try a different search term."
							: "Pages you open in Kestrel stay available here on this Mac."
					}
					action={
						!query ? (
							<button type="button" className="button secondary" onClick={onOpenBrowser}>
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
		</main>
	);
}

export function BrowserDownloads({
	browser,
	onBack,
}: {
	browser: UserBrowserController;
	onBack(): void;
}) {
	const downloads = [...(browser.state?.downloads ?? [])].reverse();
	return (
		<main className="browser-library" aria-labelledby="downloads-title">
			<header>
				<div>
					<SurfaceBackButton onBack={onBack} />
					<span className="library-icon">
						<Icon name="downloads" />
					</span>
					<h1 id="downloads-title">Files from the web</h1>
				</div>
			</header>
			{downloads.length === 0 ? (
				<EmptyState
					className="library-empty"
					title="No downloads yet"
					detail="Files you save from browser tabs will appear here."
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
										onClick={() => void browser.revealDownload(download.id)}
									>
										Show in Finder
									</button>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</main>
	);
}
