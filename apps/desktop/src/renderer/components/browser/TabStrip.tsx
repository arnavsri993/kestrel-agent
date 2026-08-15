import type { UserBrowserTab } from "@kestrel/shared-types";
import type { KeyboardEvent, MouseEvent } from "react";
import { Icon } from "../Icon";

export function TabStrip({
	tabs,
	activeTabId,
	onSelect,
	onClose,
	onCreate,
	orientation,
	onToggleOrientation,
}: {
	tabs: UserBrowserTab[];
	activeTabId: string | null;
	onSelect(tabId: string): void;
	onClose(tabId: string): void;
	onCreate(): void;
	orientation: "horizontal" | "vertical";
	onToggleOrientation?(): void;
}) {
	function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
		const previousKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
		const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
		if (![previousKey, nextKey, "Home", "End"].includes(event.key)) return;
		const buttons = Array.from(
			event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']"),
		);
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		if (index < 0 || buttons.length === 0) return;
		event.preventDefault();
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? buttons.length - 1
					: (index + (event.key === nextKey ? 1 : -1) + buttons.length) %
						buttons.length;
		buttons[next]?.focus();
	}

	function handleTabAuxClick(event: MouseEvent, tabId: string) {
		// Middle-click (button 1) closes tab, exact Microsoft Edge behavior
		if (event.button === 1) {
			event.preventDefault();
			event.stopPropagation();
			onClose(tabId);
		}
	}

	function handleDragFillAuxClick(event: MouseEvent) {
		// Middle-click on empty tab strip opens new tab
		if (event.button === 1) {
			event.preventDefault();
			onCreate();
		}
	}

	function getFaviconContent(tab: UserBrowserTab) {
		if (tab.faviconDataUrl) {
			return <img src={tab.faviconDataUrl} alt="" />;
		}
		if (tab.loading) {
			return <span className="browser-tab-spinner" />;
		}
		if (!tab.url) {
			return <Icon name="globe" />;
		}
		try {
			const host = new URL(tab.url).hostname.replace(/^www\./, "");
			return (
				<span className="browser-favicon-letter">
					{host.charAt(0).toUpperCase()}
				</span>
			);
		} catch {
			return <Icon name="globe" />;
		}
	}

	return (
		<div
			className={`browser-tab-row browser-tab-row-${orientation} drag-region-browser`}
		>
			{onToggleOrientation && (
				<div className="browser-tab-leading-actions no-drag">
					<button
						type="button"
						className="browser-tab-actions-btn"
						aria-label={
							orientation === "horizontal"
								? "Turn on vertical tabs"
								: "Turn off vertical tabs"
						}
						title={
							orientation === "horizontal"
								? "Turn on vertical tabs"
								: "Turn off vertical tabs"
						}
						onClick={onToggleOrientation}
					>
						<Icon
							name={orientation === "horizontal" ? "tabActions" : "browser"}
						/>
					</button>
				</div>
			)}
			<div
				className="browser-tabs no-drag"
				role="tablist"
				aria-label="Browser tabs"
				aria-orientation={orientation}
				onKeyDown={moveFocus}
			>
				{tabs.map((tab) => {
					const active = tab.id === activeTabId;
					const isSleeping = tab.discarded && Boolean(tab.url);
					return (
						<div
							className={`browser-tab ${active ? "active" : ""} ${isSleeping ? "tab-sleeping" : ""}`}
							key={tab.id}
							onAuxClick={(event) => handleTabAuxClick(event, tab.id)}
						>
							<button
								type="button"
								role="tab"
								aria-selected={active}
								aria-controls="browser-viewport"
								tabIndex={active ? 0 : -1}
								title={`${tab.title}${isSleeping ? " (Sleeping — click to wake)" : ""}${tab.url ? ` — ${tab.url}` : ""}`}
								onClick={() => onSelect(tab.id)}
							>
								<span className="browser-favicon" aria-hidden="true">
									{getFaviconContent(tab)}
								</span>
								<span className="browser-tab-title">
									{tab.title}
									{isSleeping && <span className="tab-sleep-badge" title="Sleeping tab">💤</span>}
								</span>
							</button>
							<button
								type="button"
								className="browser-tab-close"
								aria-label={`Close ${tab.title}`}
								title="Close tab (Cmd+W)"
								tabIndex={active ? 0 : -1}
								onClick={(event) => {
									event.stopPropagation();
									onClose(tab.id);
								}}
							>
								<Icon name="close" />
							</button>
						</div>
					);
				})}
			</div>
			<button
				type="button"
				className="browser-new-tab no-drag"
				aria-label="New Tab"
				aria-keyshortcuts="Meta+T"
				title="New tab (Cmd+T)"
				onClick={onCreate}
			>
				<Icon name="plus" />
				<span>New Tab</span>
			</button>
			<div
				className="browser-tab-drag-fill"
				onDoubleClick={onCreate}
				onAuxClick={handleDragFillAuxClick}
			/>
		</div>
	);
}
