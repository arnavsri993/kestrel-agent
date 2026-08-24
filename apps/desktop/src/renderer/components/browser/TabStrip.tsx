import type {
	UserBrowserOriginFavicon,
	UserBrowserRecentlyClosedTab,
	UserBrowserTab,
} from "@kestrel/shared-types";
import {
	AnimatePresence,
	LayoutGroup,
	motion,
	useReducedMotion,
	type MotionStyle,
} from "motion/react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { Icon } from "../Icon";
import {
	computeLockedTabStyle,
	shouldRetainTabWidthOnClose,
} from "./tab-strip-layout";
import { tabFaviconDataUrl } from "./tab-favicon";

const DETACH_DRAG_THRESHOLD_PX = 36;
const REORDER_DRAG_THRESHOLD_PX = 12;

function relativeClosedTime(value: string): string {
	const elapsed = Math.max(0, Date.now() - Date.parse(value));
	if (!Number.isFinite(elapsed) || elapsed < 60_000) return "Just now";
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

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
	originFavicons,
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
	onReopenClosedTab,
	onOrganizeTabs,
	onOpenWorkspaces,
	recentlyClosedTabs = [],
	orientation,
	onToggleOrientation,
}: {
	tabs: UserBrowserTab[];
	originFavicons?: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
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
	onReopenClosedTab?(index?: number): void;
	onOrganizeTabs?(): void | Promise<void>;
	onOpenWorkspaces?: (() => void) | undefined;
	recentlyClosedTabs?: UserBrowserRecentlyClosedTab[];
	orientation: "horizontal" | "vertical";
	onToggleOrientation?(): void;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const [lockedWidth, setLockedWidth] = useState<number | null>(null);
	const [compact, setCompact] = useState(false);
	const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(
		null,
	);
	const [tabToolsOpen, setTabToolsOpen] = useState(false);
	const [tabSearch, setTabSearch] = useState("");
	const [openTabsExpanded, setOpenTabsExpanded] = useState(false);
	const [recentlyClosedExpanded, setRecentlyClosedExpanded] = useState(true);
	const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
	const [dragIntent, setDragIntent] = useState<"none" | "reorder" | "detach">(
		"none",
	);
	const draggingTabIdRef = useRef<string | null>(null);
	const dragStartRef = useRef<{ x: number; y: number } | null>(null);
	const suppressClickRef = useRef(false);
	const tabsContainerRef = useRef<HTMLDivElement | null>(null);
	const tabToolsRef = useRef<HTMLDivElement | null>(null);
	const tabToolsTriggerRef = useRef<HTMLButtonElement | null>(null);
	const tabSearchRef = useRef<HTMLInputElement | null>(null);

	const handleRowMouseLeave = useCallback(() => {
		setLockedWidth(null);
	}, []);

	useEffect(() => {
		if (tabs.length <= 1 || orientation === "vertical") {
			setLockedWidth(null);
		}
	}, [tabs.length, orientation]);

	useEffect(() => {
		const activeTab = tabsContainerRef.current?.querySelector<HTMLElement>(
			".browser-tab.active",
		);
		activeTab?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
	}, [activeTabId, orientation, tabs.length]);

	const closeTabTools = useCallback(() => {
		setTabToolsOpen(false);
		setTabSearch("");
		window.requestAnimationFrame(() => tabToolsTriggerRef.current?.focus());
	}, []);

	useEffect(() => {
		if (!tabToolsOpen) return;
		const frame = window.requestAnimationFrame(() => {
			if (tabSearch) tabSearchRef.current?.focus();
			else
				tabToolsRef.current
					?.querySelector<HTMLButtonElement>(
						"button[role='menuitem'], button[role='menuitemcheckbox']",
					)
					?.focus();
		});
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (
				target &&
				!tabToolsRef.current?.contains(target) &&
				!tabToolsTriggerRef.current?.contains(target)
			)
				closeTabTools();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				closeTabTools();
				return;
			}
			if (!tabToolsRef.current || !["ArrowDown", "ArrowUp"].includes(event.key))
				return;
			const items = Array.from(
				tabToolsRef.current.querySelectorAll<HTMLElement>(
					"button[role='menuitem'], button[role='menuitemcheckbox'], input",
				),
			);
			if (items.length === 0) return;
			const index = items.indexOf(document.activeElement as HTMLElement);
			const delta = event.key === "ArrowDown" ? 1 : -1;
			event.preventDefault();
			items[(index + delta + items.length) % items.length]?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			window.cancelAnimationFrame(frame);
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [closeTabTools, tabSearch, tabToolsOpen]);

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

	function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
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

	function handleTabAuxClick(event: ReactMouseEvent, tabId: string) {
		if (event.button === 1) {
			event.preventDefault();
			event.stopPropagation();
			handleTabClose(tabId);
		}
	}

	function handleDragFillAuxClick(event: ReactMouseEvent) {
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

	function openMenu(event: ReactMouseEvent, tabId: string) {
		event.preventDefault();
		setMenu({ tabId, x: event.clientX, y: event.clientY });
	}

	function resetDrag() {
		draggingTabIdRef.current = null;
		dragStartRef.current = null;
		setDraggingTabId(null);
		setDragIntent("none");
	}

	function handleTabPointerDown(event: ReactPointerEvent, tabId: string) {
		if (event.button !== 0) return;
		if ((event.target as HTMLElement).closest(".browser-tab-close")) return;
		draggingTabIdRef.current = tabId;
		dragStartRef.current = { x: event.clientX, y: event.clientY };
		setDraggingTabId(tabId);
		setDragIntent("none");
		event.currentTarget.setPointerCapture(event.pointerId);
	}

	function handleTabPointerMove(event: ReactPointerEvent) {
		if (!draggingTabIdRef.current || !dragStartRef.current) return;
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

	function handleTabPointerUp(event: ReactPointerEvent, tabId: string) {
		if (
			!draggingTabIdRef.current ||
			draggingTabIdRef.current !== tabId ||
			!dragStartRef.current
		) {
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
		if (tab.file) return <Icon name="artifacts" />;
		const faviconDataUrl = tabFaviconDataUrl(tab, originFavicons);
		if (faviconDataUrl) {
			return <img src={faviconDataUrl} alt="" />;
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

	function getRecentFaviconContent(tab: UserBrowserRecentlyClosedTab) {
		try {
			const host = new URL(tab.url).hostname.replace(/^www\./, "");
			return <span className="browser-favicon-letter">{host.charAt(0).toUpperCase()}</span>;
		} catch {
			return <Icon name="history" />;
		}
	}

	function tabHost(tab: UserBrowserTab | UserBrowserRecentlyClosedTab): string {
		try {
			return new URL(tab.url).hostname.replace(/^www\./, "");
		} catch {
			return "Kestrel";
		}
	}

	const filteredTabs = tabs.filter((tab) =>
		`${tab.title} ${tab.url}`.toLowerCase().includes(tabSearch.toLowerCase()),
	);

	const tabStyle = computeLockedTabStyle(lockedWidth, orientation);

	return (
		<div
			className={`browser-tab-row browser-tab-row-${orientation} drag-region-browser${
				compact ? " browser-tab-row-compact" : ""
			}${dragIntent === "detach" ? " browser-tab-row-detaching" : ""}`}
			onMouseLeave={handleRowMouseLeave}
		>
			<div className="browser-tab-leading-actions no-drag">
				<button
					type="button"
					ref={tabToolsTriggerRef}
					className={`browser-tab-actions-btn ${tabToolsOpen ? "active" : ""}`}
					aria-label="Tab tools"
					aria-haspopup="menu"
					aria-expanded={tabToolsOpen}
					title="Tab tools"
					onClick={(event) => {
						tabToolsTriggerRef.current = event.currentTarget;
						setTabToolsOpen((value) => {
							if (value) setTabSearch("");
							return !value;
						});
					}}
				>
					<Icon name="tabActions" />
				</button>
				{tabToolsOpen && (
					<div
						ref={tabToolsRef}
						className="browser-tab-tools-menu no-drag"
						role="menu"
						aria-label="Tab tools"
					>
						{onToggleOrientation && (
							<button
								type="button"
								className="browser-tab-tools-action"
								role="menuitem"
								onClick={() => {
									onToggleOrientation();
									closeTabTools();
								}}
							>
								<Icon name="verticalTabs" />
								<span>
									{orientation === "horizontal"
										? "Turn On Vertical Tabs"
										: "Turn Off Vertical Tabs"}
								</span>
							</button>
						)}
						{onOrganizeTabs && (
							<button
								type="button"
								className="browser-tab-tools-action"
								role="menuitem"
								onClick={() => {
									void Promise.resolve(onOrganizeTabs()).catch(() => undefined);
									closeTabTools();
								}}
							>
								<Icon name="tabActions" />
								<span>Organize Tabs</span>
							</button>
						)}
						{onOpenWorkspaces && (
							<button
								type="button"
								className="browser-tab-tools-action"
								role="menuitem"
								onClick={() => {
									onOpenWorkspaces();
									closeTabTools();
								}}
							>
								<Icon name="work" />
								<span>Manage Workspaces</span>
							</button>
						)}
						<div className="browser-tab-tools-divider" />
						<button
							type="button"
							className="browser-tab-tools-action browser-tab-tools-secondary-action"
							role="menuitemcheckbox"
							aria-checked={compact}
							onClick={() => setCompact((value) => !value)}
						>
							<Icon name="tabActions" />
							<span>Compact tabs to favicons</span>
							<Icon name={compact ? "check" : "close"} />
						</button>
						{onReopenClosedTab && (
							<button
								type="button"
								className="browser-tab-tools-action browser-tab-tools-secondary-action"
								role="menuitem"
								disabled={recentlyClosedTabs.length === 0}
								onClick={() => {
									onReopenClosedTab();
									closeTabTools();
								}}
							>
								<Icon name="history" />
								<span>Reopen most recent tab</span>
							</button>
						)}
						<label className="browser-tab-tools-search">
							<Icon name="search" />
							<span className="sr-only">Search Tabs</span>
							<input
								ref={tabSearchRef}
								type="search"
								value={tabSearch}
								aria-label="Search Tabs"
								placeholder="Search Tabs"
								onChange={(event) => {
									setTabSearch(event.target.value);
									setOpenTabsExpanded(true);
								}}
							/>
						</label>
						<section className="browser-tab-tools-section">
							<button
								type="button"
								role="menuitem"
								aria-expanded={openTabsExpanded}
								onClick={() => setOpenTabsExpanded((value) => !value)}
							>
								<Icon name="browser" />
								<span>Open Tabs</span>
								<Icon
									name="chevron"
									className={`browser-tab-tools-chevron ${openTabsExpanded ? "expanded" : ""}`}
								/>
							</button>
							{openTabsExpanded && (
								<div className="browser-tab-tools-list browser-tab-search-results">
									{filteredTabs.length > 0 ? (
										filteredTabs.map((tab) => (
											<button
												type="button"
												role="menuitem"
												key={tab.id}
												aria-current={tab.id === activeTabId ? "page" : undefined}
												onClick={() => {
													onSelect(tab.id);
													closeTabTools();
												}}
											>
												<span className="browser-tab-search-favicon">
													{getFaviconContent(tab)}
												</span>
												<span>
													<strong>{tab.title}</strong>
													<small>{tabHost(tab)}</small>
												</span>
											</button>
										))
									) : (
										<small>No matching tabs</small>
									)}
								</div>
							)}
						</section>
						<section className="browser-tab-tools-section">
							<button
								type="button"
								role="menuitem"
								aria-expanded={recentlyClosedExpanded}
								onClick={() => setRecentlyClosedExpanded((value) => !value)}
							>
								<Icon name="history" />
								<span>Recently Closed</span>
								<Icon
									name="chevron"
									className={`browser-tab-tools-chevron ${recentlyClosedExpanded ? "expanded" : ""}`}
								/>
							</button>
							{recentlyClosedExpanded && (
								<div className="browser-tab-tools-list browser-tab-search-results">
									{recentlyClosedTabs.length > 0 ? (
										recentlyClosedTabs.slice(0, 8).map((tab, index) => (
											<button
												type="button"
												role="menuitem"
												key={`${tab.url}-${tab.closedAt}-${index}`}
												onClick={() => {
													onReopenClosedTab?.(index);
													closeTabTools();
												}}
											>
												<span className="browser-tab-search-favicon">
													{getRecentFaviconContent(tab)}
												</span>
												<span>
													<strong>{tab.title}</strong>
													<small>
														{tabHost(tab)} · {relativeClosedTime(tab.closedAt)}
													</small>
												</span>
											</button>
										))
									) : (
										<small>No recently closed tabs</small>
									)}
								</div>
							)}
						</section>
					</div>
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
				<LayoutGroup id="kestrel-browser-tabs">
					<AnimatePresence initial={false} mode="popLayout">
						{tabs.map((tab) => {
							const active = tab.id === activeTabId;
							const isSleeping = tab.discarded && Boolean(tab.url);
							const isDragging = draggingTabId === tab.id;
							const isDragActive = isDragging && dragIntent !== "none";
							return (
								<motion.div
									className={`browser-tab no-drag ${active ? "active" : ""} ${isSleeping ? "tab-sleeping" : ""} ${tab.pinned ? "tab-pinned" : ""} ${isDragActive ? "is-dragging" : ""}`}
									key={tab.id}
									layout="position"
									initial={reducedMotion ? false : { opacity: 0, y: 5, scale: 0.98 }}
									animate={{ opacity: isDragActive ? 0.72 : 1, y: 0, scale: 1 }}
									exit={
										reducedMotion
											? { opacity: 1 }
											: {
													opacity: 0,
													y: -4,
													scale: 0.96,
													transition: { duration: 0.14, ease: [0.4, 0, 1, 1] },
												}
									}
									transition={
										reducedMotion
											? { duration: 0 }
											: {
													default: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
													layout: { type: "spring", stiffness: 520, damping: 38, mass: 0.72 },
												}
									}
									style={tabStyle as MotionStyle}
									onAuxClick={(event) => handleTabAuxClick(event, tab.id)}
									onContextMenu={(event) => openMenu(event, tab.id)}
									onClick={(event) => {
										if ((event.target as HTMLElement).closest(".browser-tab-close")) return;
										if (suppressClickRef.current) {
											suppressClickRef.current = false;
											return;
										}
										onSelect(tab.id);
									}}
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
								</motion.div>
							);
						})}
					</AnimatePresence>
				</LayoutGroup>
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
