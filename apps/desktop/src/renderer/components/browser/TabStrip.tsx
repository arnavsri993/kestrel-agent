import type { UserBrowserTab } from "@kestrel/shared-types";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type MouseEvent,
} from "react";
import { Icon } from "../Icon";
import {
	computeLockedTabStyle,
	shouldRetainTabWidthOnClose,
} from "./tab-strip-layout";

export function TabStrip({
	tabs,
	activeTabId,
	onSelect,
	onClose,
	onCreate,
	onPin,
	onMute,
	onDuplicate,
	onCloseOthers,
	orientation,
	onToggleOrientation,
}: {
	tabs: UserBrowserTab[];
	activeTabId: string | null;
	onSelect(tabId: string): void;
	onClose(tabId: string): void;
	onCreate(): void;
	onPin?(tabId: string, pinned: boolean): void;
	onMute?(tabId: string, muted: boolean): void;
	onDuplicate?(tabId: string): void;
	onCloseOthers?(tabId: string): void;
	orientation: "horizontal" | "vertical";
	onToggleOrientation?(): void;
}) {
	const [lockedWidth, setLockedWidth] = useState<number | null>(null);
	const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(
		null,
	);
	const tabsContainerRef = useRef<HTMLDivElement | null>(null);

	const handleRowMouseLeave = useCallback(() => {
		setLockedWidth(null);
	}, []);

	useEffect(() => {
		if (tabs.length <= 1 || orientation === "vertical") {
			setLockedWidth(null);
		}
	}, [tabs.length, orientation]);

	const lockTabWidthBeforeClose = useCallback(() => {
		if (!shouldRetainTabWidthOnClose(orientation, tabs.length)) {
			setLockedWidth(null);
			return;
		}
		if (tabsContainerRef.current) {
			const firstTab =
				tabsContainerRef.current.querySelector<HTMLElement>(".browser-tab");
			if (firstTab) {
				const rect = firstTab.getBoundingClientRect();
				if (rect.width > 0) {
					setLockedWidth(rect.width);
				}
			}
		}
	}, [orientation, tabs.length]);

	function handleTabClose(tabId: string) {
		lockTabWidthBeforeClose();
		onClose(tabId);
	}

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
		// Middle-click (button 1) closes tab, exact Microsoft Edge / Chrome behavior
		if (event.button === 1) {
			event.preventDefault();
			event.stopPropagation();
			handleTabClose(tabId);
		}
	}

	function handleDragFillAuxClick(event: MouseEvent) {
		// Middle-click on empty tab strip opens new tab
		if (event.button === 1) {
			event.preventDefault();
			setLockedWidth(null);
			onCreate();
		}
	}

	function handleCreate() {
		setLockedWidth(null);
		onCreate();
	}

	function openMenu(event: MouseEvent, tabId: string) {
		event.preventDefault();
		setMenu({ tabId, x: event.clientX, y: event.clientY });
	}

	const menuTab = tabs.find((tab) => tab.id === menu?.tabId);

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

	const tabStyle = computeLockedTabStyle(lockedWidth, orientation);

	return (
		<div
			className={`browser-tab-row browser-tab-row-${orientation} drag-region-browser`}
			onMouseLeave={handleRowMouseLeave}
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
				ref={tabsContainerRef}
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
							className={`browser-tab ${active ? "active" : ""} ${isSleeping ? "tab-sleeping" : ""} ${tab.pinned ? "tab-pinned" : ""}`}
							key={tab.id}
							style={tabStyle}
							onAuxClick={(event) => handleTabAuxClick(event, tab.id)}
							onContextMenu={(event) => openMenu(event, tab.id)}
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
									{tab.pinned && (
										<span className="tab-pin-badge" title="Pinned">
											<Icon name="pin" />
										</span>
									)}
									{tab.title}
									{isSleeping && (
										<span
											className="tab-sleep-badge"
											title="Sleeping tab"
											aria-hidden="true"
										>
											<svg
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="1.75"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
											</svg>
										</span>
									)}
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
									handleTabClose(tab.id);
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
				onClick={handleCreate}
			>
				<Icon name="plus" />
				<span>New Tab</span>
			</button>
			<div
				className="browser-tab-drag-fill"
				onDoubleClick={handleCreate}
				onAuxClick={handleDragFillAuxClick}
			/>
			{menu && menuTab && (
				<div
					className="browser-tab-menu"
					style={{ left: menu.x, top: menu.y }}
					role="menu"
				>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							onPin?.(menuTab.id, !menuTab.pinned);
							setMenu(null);
						}}
					>
						{menuTab.pinned ? "Unpin tab" : "Pin tab"}
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							onMute?.(menuTab.id, !menuTab.muted);
							setMenu(null);
						}}
					>
						{menuTab.muted ? "Unmute tab" : "Mute tab"}
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							onDuplicate?.(menuTab.id);
							setMenu(null);
						}}
					>
						Duplicate tab
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							onCloseOthers?.(menuTab.id);
							setMenu(null);
						}}
					>
						Close other tabs
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							handleTabClose(menuTab.id);
							setMenu(null);
						}}
					>
						Close tab
					</button>
					<button type="button" role="menuitem" onClick={() => setMenu(null)}>
						Cancel
					</button>
				</div>
			)}
		</div>
	);
}
