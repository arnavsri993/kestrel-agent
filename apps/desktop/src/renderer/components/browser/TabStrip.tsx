import type { UserBrowserTab } from "@kestrel/shared-types";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
} from "react";
import { Icon } from "../Icon";
import {
	computeLockedTabStyle,
	shouldRetainTabWidthOnClose,
} from "./tab-strip-layout";

const DETACH_DRAG_THRESHOLD_PX = 36;
const REORDER_DRAG_THRESHOLD_PX = 12;

function tabDropIndex(
	pointer: number,
	tabElements: HTMLElement[],
	tabCount: number,
	orientation: "horizontal" | "vertical",
): number {
	for (let index = 0; index < tabElements.length; index += 1) {
		const rect = tabElements[index]?.getBoundingClientRect();
		if (!rect) continue;
		const midpoint =
			orientation === "horizontal"
				? rect.left + rect.width / 2
				: rect.top + rect.height / 2;
		if (pointer < midpoint) return index;
	}
	return tabCount;
}

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
	onMoveTab,
	onDetachTab,
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
	onMoveTab?(tabId: string, toIndex: number): void;
	onDetachTab?(tabId: string): void;
	orientation: "horizontal" | "vertical";
	onToggleOrientation?(): void;
}) {
	const [lockedWidth, setLockedWidth] = useState<number | null>(null);
	const [compact, setCompact] = useState(false);
	const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(
		null,
	);
	const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
	const [dragIntent, setDragIntent] = useState<"none" | "reorder" | "detach">(
		"none",
	);
	const dragStartRef = useRef<{ x: number; y: number } | null>(null);
	const suppressClickRef = useRef(false);
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
		if (event.button === 1) {
			event.preventDefault();
			event.stopPropagation();
			handleTabClose(tabId);
		}
	}

	function handleDragFillAuxClick(event: MouseEvent) {
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

	function resetDrag() {
		dragStartRef.current = null;
		setDraggingTabId(null);
		setDragIntent("none");
	}

	function handleTabPointerDown(event: PointerEvent, tabId: string) {
		if (event.button !== 0) return;
		if ((event.target as HTMLElement).closest(".browser-tab-close")) return;
		dragStartRef.current = { x: event.clientX, y: event.clientY };
		setDraggingTabId(tabId);
		setDragIntent("none");
		event.currentTarget.setPointerCapture(event.pointerId);
	}

	function handleTabPointerMove(event: PointerEvent) {
		if (!draggingTabId || !dragStartRef.current) return;
		const dx = event.clientX - dragStartRef.current.x;
		const dy = event.clientY - dragStartRef.current.y;
		if (orientation === "horizontal") {
			if (
				Math.abs(dy) >= DETACH_DRAG_THRESHOLD_PX &&
				Math.abs(dy) > Math.abs(dx)
			) {
				setDragIntent("detach");
				return;
			}
			if (Math.abs(dx) >= REORDER_DRAG_THRESHOLD_PX) {
				setDragIntent("reorder");
			}
			return;
		}
		if (Math.abs(dx) >= DETACH_DRAG_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
			setDragIntent("detach");
			return;
		}
		if (Math.abs(dy) >= REORDER_DRAG_THRESHOLD_PX) {
			setDragIntent("reorder");
		}
	}

	function handleTabPointerUp(event: PointerEvent, tabId: string) {
		if (!draggingTabId || draggingTabId !== tabId || !dragStartRef.current) {
			resetDrag();
			return;
		}
		const dx = event.clientX - dragStartRef.current.x;
		const dy = event.clientY - dragStartRef.current.y;
		const shouldDetach =
			orientation === "horizontal"
				? Math.abs(dy) >= DETACH_DRAG_THRESHOLD_PX &&
					Math.abs(dy) > Math.abs(dx)
				: Math.abs(dx) >= DETACH_DRAG_THRESHOLD_PX &&
					Math.abs(dx) > Math.abs(dy);
		if (shouldDetach && onDetachTab) {
			suppressClickRef.current = true;
			onDetachTab(tabId);
		} else if (
			onMoveTab &&
			tabsContainerRef.current &&
			((orientation === "horizontal" && Math.abs(dx) >= REORDER_DRAG_THRESHOLD_PX) ||
				(orientation === "vertical" && Math.abs(dy) >= REORDER_DRAG_THRESHOLD_PX))
		) {
			const tabElements = Array.from(
				tabsContainerRef.current.querySelectorAll<HTMLElement>(".browser-tab"),
			);
			const fromIndex = tabs.findIndex((tab) => tab.id === tabId);
			const pointer = orientation === "horizontal" ? event.clientX : event.clientY;
			let toIndex = tabDropIndex(
				pointer,
				tabElements,
				tabs.length,
				orientation,
			);
			if (fromIndex >= 0 && toIndex > fromIndex) toIndex -= 1;
			if (fromIndex >= 0 && toIndex !== fromIndex) {
				suppressClickRef.current = true;
				onMoveTab(tabId, toIndex);
			}
		}
		resetDrag();
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
			className={`browser-tab-row browser-tab-row-${orientation} drag-region-browser${
				compact ? " browser-tab-row-compact" : ""
			}${dragIntent === "detach" ? " browser-tab-row-detaching" : ""}`}
			onMouseLeave={handleRowMouseLeave}
		>
			<div className="browser-tab-leading-actions no-drag">
				{orientation === "horizontal" && (
					<button
						type="button"
						className="browser-tab-actions-btn"
						aria-label={compact ? "Expand tabs" : "Compact tabs to favicons"}
						title={compact ? "Expand tabs" : "Compact tabs to favicons"}
						onClick={() => setCompact((value) => !value)}
					>
						<Icon name={compact ? "forward" : "back"} />
					</button>
				)}
				{onToggleOrientation && (
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
				)}
			</div>
			<div
				ref={tabsContainerRef}
				className="browser-tabs"
				role="tablist"
				aria-label="Browser tabs"
				aria-orientation={orientation}
				onKeyDown={moveFocus}
			>
				{tabs.map((tab) => {
					const active = tab.id === activeTabId;
					const isSleeping = tab.discarded && Boolean(tab.url);
					const isDragging = draggingTabId === tab.id;
					return (
						<div
							className={`browser-tab no-drag ${active ? "active" : ""} ${isSleeping ? "tab-sleeping" : ""} ${tab.pinned ? "tab-pinned" : ""} ${isDragging ? "is-dragging" : ""}`}
							key={tab.id}
							style={tabStyle}
							onAuxClick={(event) => handleTabAuxClick(event, tab.id)}
							onContextMenu={(event) => openMenu(event, tab.id)}
							onPointerDown={(event) => handleTabPointerDown(event, tab.id)}
							onPointerMove={handleTabPointerMove}
							onPointerUp={(event) => handleTabPointerUp(event, tab.id)}
							onPointerCancel={resetDrag}
						>
							<button
								type="button"
								role="tab"
								aria-selected={active}
								aria-controls="browser-viewport"
								tabIndex={active ? 0 : -1}
								title={`${tab.title}${isSleeping ? " (Sleeping — click to wake)" : ""}${tab.url ? ` — ${tab.url}` : ""}`}
								onClick={() => {
									if (suppressClickRef.current) {
										suppressClickRef.current = false;
										return;
									}
									onSelect(tab.id);
								}}
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
										<span className="tab-sleep-badge" title="Sleeping tab">
											💤
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
			</div>
			<div
				className="browser-tab-drag-fill"
				onDoubleClick={handleCreate}
				onAuxClick={handleDragFillAuxClick}
			/>
			{menu && menuTab && (
				<div
					className="browser-tab-menu no-drag"
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
					{onDetachTab && menuTab.url && !menuTab.error && (
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								onDetachTab(menuTab.id);
								setMenu(null);
							}}
						>
							Move tab to new window
						</button>
					)}
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
