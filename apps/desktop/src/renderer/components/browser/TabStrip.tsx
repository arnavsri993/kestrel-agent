import type {
	UserBrowserOriginFavicon,
	UserBrowserRecentlyClosedTab,
	UserBrowserSettings,
	UserBrowserTab,
	UserBrowserTabFolder,
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
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { Icon } from "../Icon";
import {
	KESTREL_CRITICAL_SPRING,
	KESTREL_STATE_TRANSITION,
} from "../../motion-contract";
import {
	computeLockedTabStyle,
	shouldRetainTabWidthOnClose,
	TAB_CLOSE_REFIT_DELAY_MS,
} from "./tab-strip-layout";
import { recentTabFavicon, TabFavicon } from "./TabFavicon";

// A tab only needs to leave the chrome by roughly two-thirds of its height to
// tear off. Do not require the cross-axis movement to dominate: real pointer
// drags are often diagonal, especially when moving a tab down and away.
const DETACH_DRAG_THRESHOLD_PX = 24;
const REORDER_DRAG_THRESHOLD_PX = 12;
const COLLAPSED_TAB_FOLDERS_KEY = "kestrel:collapsed-tab-folders";

function readCollapsedTabFolders(): Set<string> {
	try {
		const raw = localStorage.getItem(COLLAPSED_TAB_FOLDERS_KEY);
		if (!raw) return new Set();
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((value) => typeof value === "string"));
	} catch {
		return new Set();
	}
}

function writeCollapsedTabFolders(folderIds: Set<string>) {
	localStorage.setItem(
		COLLAPSED_TAB_FOLDERS_KEY,
		JSON.stringify([...folderIds]),
	);
}

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

function tabCanDetach(tab: UserBrowserTab | undefined): boolean {
	return Boolean(
		tab?.url && !tab.file && !tab.error && !tab.url.startsWith("kestrel://"),
	);
}

export function TabStrip({
	tabs,
	originFavicons,
	tabFolders,
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
	onReattachTab,
	onReopenClosedTab,
	onOrganizeTabs,
	onOpenWorkspaces,
	recentlyClosedTabs = [],
	orientation,
	onToggleOrientation,
	tabSizing,
	onTabSizingChange,
	onMenuOpenChange,
}: {
	tabs: UserBrowserTab[];
	originFavicons?: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
	tabFolders: UserBrowserTabFolder[];
	activeTabId: string | null;
	onSelect(tabId: string): void;
	onClose(tabId: string): void | Promise<void>;
	onCreate(): void;
	onPin?(tabId: string, pinned: boolean): void;
	onMute?(tabId: string, muted: boolean): void;
	onDuplicate?(tabId: string): void;
	onCloseOthers?(tabId: string): void | Promise<void>;
	onMoveTab?(tabId: string, toIndex: number): void | Promise<void>;
	onDetachTab?(tabId: string): void | Promise<void>;
	onReattachTab?(tabId: string): void | Promise<void>;
	onReopenClosedTab?(index?: number): void;
	onOrganizeTabs?(): void | Promise<void>;
	onOpenWorkspaces?: (() => void) | undefined;
	recentlyClosedTabs?: UserBrowserRecentlyClosedTab[];
	orientation: "horizontal" | "vertical";
	onToggleOrientation?(): void;
	tabSizing: UserBrowserSettings["tabSizing"];
	onTabSizingChange?(tabSizing: UserBrowserSettings["tabSizing"]): void;
	onMenuOpenChange?(open: boolean): void;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const [lockedWidth, setLockedWidth] = useState<number | null>(null);
	const lockedWidthRef = useRef<number | null>(null);
	const tabRefitTimerRef = useRef<number | null>(null);
	const pendingCloseCountRef = useRef(0);
	const pendingCloseKeysRef = useRef(new Set<string>());
	const [menu, setMenu] = useState<{
		tabId: string;
		x: number;
		y: number;
		anchorX: number;
		anchorY: number;
	} | null>(null);
	const [tabToolsOpen, setTabToolsOpen] = useState(false);
	const menuOpenRef = useRef(false);
	const [tabSearch, setTabSearch] = useState("");
	const [openTabsExpanded, setOpenTabsExpanded] = useState(false);
	const [recentlyClosedExpanded, setRecentlyClosedExpanded] = useState(true);
	const [collapsedFolderIds, setCollapsedFolderIds] = useState(
		readCollapsedTabFolders,
	);
	const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
	const [dragIntent, setDragIntent] = useState<"none" | "reorder" | "detach">(
		"none",
	);
	const draggingTabIdRef = useRef<string | null>(null);
	const [dragDelta, setDragDelta] = useState({ x: 0, y: 0 });
	const [provisionalTabOrder, setProvisionalTabOrder] = useState<string[] | null>(
		null,
	);
	const provisionalTabOrderRef = useRef<string[] | null>(null);
	const reorderFrameRef = useRef<number | null>(null);
	const reorderPendingRef = useRef(false);
	const dragStartRef = useRef<{
		pointerId: number;
		x: number;
		y: number;
		lastX: number;
		lastY: number;
		lastAt: number;
		velocityX: number;
		velocityY: number;
	} | null>(null);
	const dragListenersRef = useRef<{
		move: (event: PointerEvent) => void;
		up: (event: PointerEvent) => void;
		cancel: (event: PointerEvent) => void;
	} | null>(null);
	const suppressClickTabIdRef = useRef<string | null>(null);
	const tabsContainerRef = useRef<HTMLDivElement | null>(null);
	const tabToolsRef = useRef<HTMLDivElement | null>(null);
	const contextMenuRef = useRef<HTMLDivElement | null>(null);
	const tabToolsTriggerRef = useRef<HTMLButtonElement | null>(null);
	const tabSearchRef = useRef<HTMLInputElement | null>(null);

	const clearTabRefitTimer = useCallback(() => {
		if (tabRefitTimerRef.current === null) return;
		window.clearTimeout(tabRefitTimerRef.current);
		tabRefitTimerRef.current = null;
	}, []);

	const releaseLockedTabWidth = useCallback(() => {
		clearTabRefitTimer();
		lockedWidthRef.current = null;
		setLockedWidth(null);
	}, [clearTabRefitTimer]);

	const scheduleTabRefit = useCallback(() => {
		clearTabRefitTimer();
		if (pendingCloseCountRef.current > 0) return;
		tabRefitTimerRef.current = window.setTimeout(() => {
			tabRefitTimerRef.current = null;
			if (pendingCloseCountRef.current > 0) return;
			lockedWidthRef.current = null;
			setLockedWidth(null);
		}, TAB_CLOSE_REFIT_DELAY_MS);
	}, [clearTabRefitTimer]);

	useEffect(() => {
		return () => clearTabRefitTimer();
	}, [clearTabRefitTimer]);

	useEffect(() => {
		if (tabs.length <= 1 || orientation === "vertical") {
			releaseLockedTabWidth();
		}
	}, [orientation, releaseLockedTabWidth, tabs.length]);

	useEffect(() => {
		const activeTab = tabsContainerRef.current?.querySelector<HTMLElement>(
			".browser-tab.active",
		);
		activeTab?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
	}, [activeTabId, orientation, tabs.length]);

	const dismissTabTools = useCallback(() => {
		setTabToolsOpen(false);
		setTabSearch("");
	}, []);

	const closeTabTools = useCallback(() => {
		dismissTabTools();
		window.requestAnimationFrame(() => tabToolsTriggerRef.current?.focus());
	}, [dismissTabTools]);

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
				dismissTabTools();
		};
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target as Node | null;
			if (
				target &&
				!tabToolsRef.current?.contains(target) &&
				!tabToolsTriggerRef.current?.contains(target)
			)
				dismissTabTools();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				if (event.defaultPrevented) return;
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
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			window.cancelAnimationFrame(frame);
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [closeTabTools, dismissTabTools, tabSearch, tabToolsOpen]);

	const menuOpen = Boolean(menu || tabToolsOpen);
	menuOpenRef.current = menuOpen;

	useLayoutEffect(() => {
		if (menuOpen) onMenuOpenChange?.(true);
	}, [menuOpen, onMenuOpenChange]);

	useEffect(
		() => () => {
			onMenuOpenChange?.(false);
		},
		[onMenuOpenChange],
	);

	const handleMenuExitComplete = useCallback(() => {
		if (!menuOpenRef.current) onMenuOpenChange?.(false);
	}, [onMenuOpenChange]);

	const lockTabWidthBeforeClose = useCallback(() => {
		if (!shouldRetainTabWidthOnClose(orientation, tabs.length)) {
			releaseLockedTabWidth();
			return;
		}
		let width = lockedWidthRef.current ?? 0;
		if (width <= 0 && tabsContainerRef.current) {
			const firstTab =
				tabsContainerRef.current.querySelector<HTMLElement>(".browser-tab");
			if (firstTab) width = firstTab.getBoundingClientRect().width;
		}
		if (width > 0) {
			lockedWidthRef.current = width;
			setLockedWidth(width);
		}
	}, [orientation, releaseLockedTabWidth, tabs.length]);

	const finishCloseRequest = useCallback(
		(key?: string) => {
			if (key) pendingCloseKeysRef.current.delete(key);
			pendingCloseCountRef.current = Math.max(
				0,
				pendingCloseCountRef.current - 1,
			);
			if (pendingCloseCountRef.current === 0) scheduleTabRefit();
		},
		[scheduleTabRefit],
	);

	const runCloseRequest = useCallback(
		(key: string | undefined, request: () => void | Promise<void>) => {
			if (key && pendingCloseKeysRef.current.has(key)) return;
			if (key) pendingCloseKeysRef.current.add(key);
			pendingCloseCountRef.current += 1;
			clearTabRefitTimer();
			lockTabWidthBeforeClose();
			let result: void | Promise<void>;
			try {
				result = request();
			} catch {
				finishCloseRequest(key);
				return;
			}
			if (result && typeof result.then === "function") {
				void result.then(
					() => finishCloseRequest(key),
					() => finishCloseRequest(key),
				);
			} else {
				finishCloseRequest(key);
			}
		},
		[clearTabRefitTimer, finishCloseRequest, lockTabWidthBeforeClose],
	);

	function handleTabClose(tabId: string) {
		runCloseRequest(tabId, () => onClose(tabId));
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
			releaseLockedTabWidth();
			onCreate();
		}
	}

	function handleCreate() {
		releaseLockedTabWidth();
		onCreate();
	}

	function handleReattach(tabId = activeTabId ?? tabs[0]?.id) {
		if (!tabId || !onReattachTab) return;
		void Promise.resolve(onReattachTab(tabId)).catch(() => undefined);
	}

	function openMenu(event: ReactMouseEvent, tabId: string) {
		event.preventDefault();
		setTabToolsOpen(false);
		setMenu({
			tabId,
			x: event.clientX,
			y: event.clientY,
			anchorX: event.clientX,
			anchorY: event.clientY,
		});
	}

	const dismissContextMenu = useCallback(() => {
		setMenu(null);
	}, []);

	const closeContextMenu = useCallback(() => {
		const tabId = menu?.tabId;
		dismissContextMenu();
		if (!tabId) return;
		window.requestAnimationFrame(() =>
			tabsContainerRef.current
				?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabId)}"] [role="tab"]`)
				?.focus(),
		);
	}, [dismissContextMenu, menu?.tabId]);

	useLayoutEffect(() => {
		if (!menu || !contextMenuRef.current) return;
		const rect = contextMenuRef.current.getBoundingClientRect();
		const gutter = 8;
		const x = Math.max(
			gutter,
			Math.min(menu.anchorX, window.innerWidth - rect.width - gutter),
		);
		const y = Math.max(
			gutter,
			Math.min(menu.anchorY, window.innerHeight - rect.height - gutter),
		);
		if (x !== menu.x || y !== menu.y)
			setMenu((current) => (current ? { ...current, x, y } : current));
	}, [menu]);

	useEffect(() => {
		if (!menu) return;
		const frame = window.requestAnimationFrame(() =>
			contextMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
		);
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && !contextMenuRef.current?.contains(target)) dismissContextMenu();
		};
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target as Node | null;
			if (target && !contextMenuRef.current?.contains(target)) dismissContextMenu();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				if (event.defaultPrevented) return;
				event.preventDefault();
				closeContextMenu();
				return;
			}
			if (!contextMenuRef.current || !["ArrowDown", "ArrowUp"].includes(event.key))
				return;
			const items = Array.from(
				contextMenuRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
			);
			if (items.length === 0) return;
			const current = items.indexOf(document.activeElement as HTMLButtonElement);
			const delta = event.key === "ArrowDown" ? 1 : -1;
			event.preventDefault();
			items[(current + delta + items.length) % items.length]?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			window.cancelAnimationFrame(frame);
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [closeContextMenu, dismissContextMenu, menu]);

	function resetDrag({ preserveProvisional = false } = {}) {
		if (dragListenersRef.current) {
			window.removeEventListener(
				"pointermove",
				dragListenersRef.current.move,
				true,
			);
			window.removeEventListener(
				"pointerup",
				dragListenersRef.current.up,
				true,
			);
			window.removeEventListener(
				"pointercancel",
				dragListenersRef.current.cancel,
				true,
			);
			dragListenersRef.current = null;
		}
		if (reorderFrameRef.current !== null) {
			window.cancelAnimationFrame(reorderFrameRef.current);
			reorderFrameRef.current = null;
		}
		reorderPendingRef.current = false;
		draggingTabIdRef.current = null;
		dragStartRef.current = null;
		setDragDelta({ x: 0, y: 0 });
		setDraggingTabId(null);
		setDragIntent("none");
		if (!preserveProvisional) {
			provisionalTabOrderRef.current = null;
			setProvisionalTabOrder(null);
		}
	}

	function detachDraggedTab() {
		const tabId = draggingTabIdRef.current;
		if (
			!tabId ||
			!onDetachTab ||
			!tabCanDetach(tabs.find((tab) => tab.id === tabId))
		)
			return false;
		suppressClickTabIdRef.current = tabId;
		resetDrag();
		void Promise.resolve()
			.then(() => onDetachTab(tabId))
			.catch(() => undefined);
		return true;
	}

	function handleTabPointerDown(event: ReactPointerEvent, tabId: string) {
		if (event.button !== 0) return;
		if ((event.target as HTMLElement).closest(".browser-tab-close")) return;
		resetDrag();
		draggingTabIdRef.current = tabId;
		const initialOrder = tabs.map((tab) => tab.id);
		provisionalTabOrderRef.current = initialOrder;
		setProvisionalTabOrder(initialOrder);
		dragStartRef.current = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			lastX: event.clientX,
			lastY: event.clientY,
			lastAt: event.timeStamp,
			velocityX: 0,
			velocityY: 0,
		};
		setDragDelta({ x: 0, y: 0 });
		setDraggingTabId(tabId);
		setDragIntent("none");
		event.currentTarget.setPointerCapture(event.pointerId);
		const onPointerMove = (moveEvent: PointerEvent) =>
			handleTabPointerMove(moveEvent);
		const onPointerUp = (upEvent: PointerEvent) => {
			if (dragStartRef.current?.pointerId !== upEvent.pointerId) return;
			handleTabPointerUp(upEvent, tabId);
		};
		const onPointerCancel = (cancelEvent: PointerEvent) => {
			if (dragStartRef.current?.pointerId !== cancelEvent.pointerId) return;
			resetDrag();
		};
		dragListenersRef.current = {
			move: onPointerMove,
			up: onPointerUp,
			cancel: onPointerCancel,
		};
		window.addEventListener("pointermove", onPointerMove, true);
		window.addEventListener("pointerup", onPointerUp, true);
		window.addEventListener("pointercancel", onPointerCancel, true);
	}

	function updateProvisionalOrder(event: PointerEvent) {
		const tabId = draggingTabIdRef.current;
		const drag = dragStartRef.current;
		const order = provisionalTabOrderRef.current;
		const container = tabsContainerRef.current;
		if (
			!tabId ||
			!drag ||
			!order ||
			!container ||
			reorderPendingRef.current
		)
			return;
		const candidates = Array.from(
			container.querySelectorAll<HTMLElement>(".browser-tab"),
		).filter((node) => node.dataset.tabId !== tabId);
		if (candidates.length === 0) return;
		const pointer = orientation === "horizontal" ? event.clientX : event.clientY;
		const slot = tabDropIndex(pointer, candidates, candidates.length, orientation);
		const withoutDragged = order.filter((id) => id !== tabId);
		const targetId =
			slot < candidates.length
				? candidates[slot]?.dataset.tabId
				: candidates.at(-1)?.dataset.tabId;
		if (!targetId) return;
		const targetIndex = withoutDragged.indexOf(targetId);
		if (targetIndex < 0) return;
		const insertionIndex =
			slot < candidates.length ? targetIndex : targetIndex + 1;
		const next = [...withoutDragged];
		next.splice(insertionIndex, 0, tabId);
		if (next.every((id, index) => id === order[index])) return;

		const draggedNode = container.querySelector<HTMLElement>(
			`[data-tab-id="${CSS.escape(tabId)}"]`,
		);
		const before = draggedNode?.getBoundingClientRect();
		provisionalTabOrderRef.current = next;
		setProvisionalTabOrder(next);
		reorderPendingRef.current = true;
		reorderFrameRef.current = window.requestAnimationFrame(() => {
			reorderFrameRef.current = null;
			const activeDrag = dragStartRef.current;
			const node = tabsContainerRef.current?.querySelector<HTMLElement>(
				`[data-tab-id="${CSS.escape(tabId)}"]`,
			);
			const after = node?.getBoundingClientRect();
			if (activeDrag && before && after) {
				/* React moved the tab's layout box. Offset the gesture origin by
				 * that exact shift so the presentation stays under the pointer. */
				activeDrag.x += after.left - before.left;
				activeDrag.y += after.top - before.top;
				setDragDelta({
					x: activeDrag.lastX - activeDrag.x,
					y: activeDrag.lastY - activeDrag.y,
				});
			}
			reorderPendingRef.current = false;
		});
	}

	function handleTabPointerMove(
		event: PointerEvent,
	) {
		if (!draggingTabIdRef.current || !dragStartRef.current) return;
		const drag = dragStartRef.current;
		if (event.pointerId !== drag.pointerId) return;
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		const elapsed = Math.max(8, event.timeStamp - drag.lastAt) / 1000;
		const sampleVelocityX = (event.clientX - drag.lastX) / elapsed;
		const sampleVelocityY = (event.clientY - drag.lastY) / elapsed;
		drag.velocityX = drag.velocityX * 0.65 + sampleVelocityX * 0.35;
		drag.velocityY = drag.velocityY * 0.65 + sampleVelocityY * 0.35;
		drag.lastX = event.clientX;
		drag.lastY = event.clientY;
		drag.lastAt = event.timeStamp;
		setDragDelta({ x: dx, y: dy });
		if (orientation === "horizontal") {
			if (Math.abs(dy) >= DETACH_DRAG_THRESHOLD_PX) {
				if (!detachDraggedTab()) setDragIntent("detach");
				return;
			}
			if (Math.abs(dx) >= REORDER_DRAG_THRESHOLD_PX) {
				setDragIntent("reorder");
				updateProvisionalOrder(event);
			}
			return;
		}
		if (Math.abs(dx) >= DETACH_DRAG_THRESHOLD_PX) {
			if (!detachDraggedTab()) setDragIntent("detach");
			return;
		}
		if (Math.abs(dy) >= REORDER_DRAG_THRESHOLD_PX) {
			setDragIntent("reorder");
			updateProvisionalOrder(event);
		}
	}

	function handleTabPointerUp(
		event: PointerEvent,
		tabId: string,
	) {
		if (
			!draggingTabIdRef.current ||
			draggingTabIdRef.current !== tabId ||
			!dragStartRef.current
		) {
			resetDrag();
			return;
		}
		const drag = dragStartRef.current;
		if (event.pointerId !== drag.pointerId) return;
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		const fastDetach =
			orientation === "horizontal"
				? Math.abs(drag.velocityY) >= 900 &&
					Math.abs(dy) >= 10
				: Math.abs(drag.velocityX) >= 900 &&
					Math.abs(dx) >= 10;
		const shouldDetach =
			fastDetach || (orientation === "horizontal"
				? Math.abs(dy) >= DETACH_DRAG_THRESHOLD_PX
				: Math.abs(dx) >= DETACH_DRAG_THRESHOLD_PX);
		if (shouldDetach && onDetachTab) {
			if (tabCanDetach(tabs.find((tab) => tab.id === tabId))) {
				suppressClickTabIdRef.current = tabId;
				void Promise.resolve()
					.then(() => onDetachTab(tabId))
					.catch(() => undefined);
			}
		} else if (
			onMoveTab &&
			((orientation === "horizontal" && Math.abs(dx) >= REORDER_DRAG_THRESHOLD_PX) ||
				(orientation === "vertical" && Math.abs(dy) >= REORDER_DRAG_THRESHOLD_PX))
		) {
			const fromIndex = tabs.findIndex((tab) => tab.id === tabId);
			const toIndex = provisionalTabOrderRef.current?.indexOf(tabId) ?? fromIndex;
			if (fromIndex >= 0 && toIndex !== fromIndex) {
				suppressClickTabIdRef.current = tabId;
				resetDrag({ preserveProvisional: true });
				void Promise.resolve().then(() => onMoveTab(tabId, toIndex)).catch(() => {
					provisionalTabOrderRef.current = null;
					setProvisionalTabOrder(null);
				});
				return;
			}
		}
		resetDrag();
	}

	useEffect(() => () => resetDrag(), []);

	useEffect(() => {
		if (draggingTabId || !provisionalTabOrder) return;
		const current = tabs.map((tab) => tab.id);
		if (
			current.length === provisionalTabOrder.length &&
			current.every((id, index) => id === provisionalTabOrder[index])
		) {
			provisionalTabOrderRef.current = null;
			setProvisionalTabOrder(null);
		}
	}, [draggingTabId, provisionalTabOrder, tabs]);

	const menuTab = tabs.find((tab) => tab.id === menu?.tabId);
	const folderById = new Map(tabFolders.map((folder) => [folder.id, folder]));

	const toggleFolderCollapse = useCallback((folderId: string) => {
		setCollapsedFolderIds((current) => {
			const next = new Set(current);
			if (next.has(folderId)) next.delete(folderId);
			else next.add(folderId);
			writeCollapsedTabFolders(next);
			return next;
		});
	}, []);

	const expandFolder = useCallback((folderId: string) => {
		setCollapsedFolderIds((current) => {
			if (!current.has(folderId)) return current;
			const next = new Set(current);
			next.delete(folderId);
			writeCollapsedTabFolders(next);
			return next;
		});
	}, []);

	useEffect(() => {
		const validFolderIds = new Set(tabFolders.map((folder) => folder.id));
		setCollapsedFolderIds((current) => {
			const next = new Set(
				[...current].filter((folderId) => validFolderIds.has(folderId)),
			);
			if (next.size === current.size) return current;
			writeCollapsedTabFolders(next);
			return next;
		});
	}, [tabFolders]);
	const folderTabCounts = new Map<string, number>();
	for (const tab of tabs) {
		if (tab.tabFolderId)
			folderTabCounts.set(
				tab.tabFolderId,
				(folderTabCounts.get(tab.tabFolderId) ?? 0) + 1,
			);
	}

	function getFaviconContent(tab: UserBrowserTab) {
		return (
			<TabFavicon
				tab={tab}
				{...(originFavicons ? { originFavicons } : {})}
			/>
		);
	}

	function getRecentFaviconContent(tab: UserBrowserRecentlyClosedTab) {
		return recentTabFavicon(tab.url);
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
	const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
	const renderedTabs = provisionalTabOrder
		? [
				...provisionalTabOrder.flatMap((id) => {
					const tab = tabById.get(id);
					return tab ? [tab] : [];
				}),
				...tabs.filter((tab) => !provisionalTabOrder.includes(tab.id)),
			]
		: tabs;
	const renderedFolderIds = new Set<string>();

	return (
		<div
			className={`browser-tab-row browser-tab-row-${orientation} browser-tab-row-${tabSizing} drag-region-browser${
					dragIntent === "detach" ? " browser-tab-row-detaching" : ""
				}`}
		>
			<div
				className="window-controls-clearance no-drag"
				aria-hidden="true"
			/>
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
				{onReattachTab && (
					<button
						type="button"
						className="browser-tab-actions-btn browser-tab-reattach-btn"
						aria-label="Move tab back to main window"
						title="Move tab back to main window"
						onClick={() => handleReattach()}
					>
						<Icon name="arrow" />
					</button>
				)}
				<AnimatePresence initial={false} onExitComplete={handleMenuExitComplete}>
				{tabToolsOpen && (
					<motion.div
						key="browser-tab-tools"
						ref={tabToolsRef}
						className="browser-tab-tools-menu no-drag"
						role="menu"
						aria-label="Tab tools"
						initial={reducedMotion ? false : { opacity: 0, y: -4, scale: 0.99 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={
							reducedMotion
								? { opacity: 1, y: 0, scale: 1, pointerEvents: "none" }
								: { opacity: 0, y: -4, scale: 0.99, pointerEvents: "none" }
						}
						transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
						style={{ transformOrigin: "top left" }}
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
									void Promise.resolve()
										.then(() => onOrganizeTabs())
										.catch(() => undefined);
									closeTabTools();
								}}
							>
								<Icon name="folder" />
								<span>Organize tabs</span>
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
						{onDetachTab &&
							tabCanDetach(tabs.find((tab) => tab.id === activeTabId)) && (
								<button
									type="button"
									className="browser-tab-tools-action"
									role="menuitem"
									onClick={() => {
										const tabId = activeTabId ?? tabs[0]?.id;
										if (tabId)
											void Promise.resolve(onDetachTab(tabId)).catch(
												() => undefined,
											);
										closeTabTools();
									}}
								>
									<Icon name="arrow" />
									<span>Move active tab to new window</span>
								</button>
							)}
						{onReattachTab && (
							<button
								type="button"
								className="browser-tab-tools-action"
								role="menuitem"
								onClick={() => {
									handleReattach();
									closeTabTools();
								}}
							>
								<Icon name="arrow" />
								<span>Move tab back to main window</span>
							</button>
						)}
						{orientation === "horizontal" && onTabSizingChange && (
							<>
								<div className="browser-tab-tools-divider" />
								<button
									type="button"
									className="browser-tab-tools-action browser-tab-tools-secondary-action"
									role="menuitem"
									onClick={() => {
										onTabSizingChange(
											tabSizing === "scrolling" ? "shrinking" : "scrolling",
										);
										closeTabTools();
									}}
								>
									<Icon
										name={tabSizing === "scrolling" ? "sliders" : "tabActions"}
									/>
									<span>
										{tabSizing === "scrolling"
											? "Turn On Shrinking Tabs"
											: "Turn On Horizontal Scrolling Tabs"}
									</span>
								</button>
							</>
						)}
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
													if (tab.tabFolderId) expandFolder(tab.tabFolderId);
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
					</motion.div>
				)}
				</AnimatePresence>
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
						{renderedTabs.flatMap((tab) => {
							const active = tab.id === activeTabId;
							const isSleeping = tab.discarded && Boolean(tab.url);
							const isDragging = draggingTabId === tab.id;
							const isDragActive = isDragging && dragIntent !== "none";
							const folder = tab.tabFolderId
								? folderById.get(tab.tabFolderId)
								: undefined;
							const folderCollapsed = folder
								? collapsedFolderIds.has(folder.id)
								: false;
							const folderHasActiveTab =
								folder &&
								tabs.some(
									(candidate) =>
										candidate.tabFolderId === folder.id &&
										candidate.id === activeTabId,
								);
							const shouldRenderFolder = folder
								? !renderedFolderIds.has(folder.id)
								: false;
							if (folder && folderCollapsed && !shouldRenderFolder) return [];
							const rows: ReactNode[] = [];
							if (folder && shouldRenderFolder) {
								renderedFolderIds.add(folder.id);
								rows.push(
									<motion.button
										type="button"
										className={`browser-tab-folder browser-tab-folder-${folder.color} no-drag${folderHasActiveTab ? " active" : ""}${folderCollapsed ? " collapsed" : ""}`}
										key={`folder-${folder.id}`}
										initial={
											reducedMotion ? false : { opacity: 0 }
										}
										animate={{ opacity: 1 }}
										exit={
											reducedMotion
												? { opacity: 1, pointerEvents: "none" }
												: { opacity: 0, pointerEvents: "none" }
										}
										transition={
											reducedMotion ? { duration: 0 } : { duration: 0.16 }
										}
										aria-expanded={!folderCollapsed}
										aria-label={`${folder.name}, ${folderTabCounts.get(folder.id) ?? 0} tabs`}
										title={`${folder.name} · ${folderTabCounts.get(folder.id) ?? 0} tabs`}
										onClick={() => toggleFolderCollapse(folder.id)}
									>
										<Icon
											name="chevron"
											className={`browser-tab-folder-chevron${folderCollapsed ? "" : " expanded"}`}
										/>
										<span className="browser-tab-folder-dot" aria-hidden="true" />
										<span className="browser-tab-folder-name">{folder.name}</span>
										<span className="browser-tab-folder-count">
											{folderTabCounts.get(folder.id) ?? 0}
										</span>
									</motion.button>,
								);
							}
							if (folder && folderCollapsed) return rows;
							// Keep tab boxes on the same baseline while flexbox recalculates
							// widths. Lifecycle feedback should not move neighbors or scale
							// their hit targets.
							rows.push(
								<motion.div
									className={`browser-tab no-drag ${active ? "active" : ""} ${isSleeping ? "tab-sleeping" : ""} ${tab.pinned ? "tab-pinned" : ""} ${isDragActive ? "is-dragging" : ""}`}
									key={tab.id}
									layout={draggingTabId && !reducedMotion ? "position" : false}
									initial={reducedMotion ? false : { opacity: 0 }}
									animate={{
										opacity: isDragActive ? 0.82 : 1,
										x: isDragging ? dragDelta.x : 0,
										y: isDragging ? dragDelta.y : 0,
										scale: isDragActive && !reducedMotion ? 1.015 : 1,
									}}
										exit={
											reducedMotion
												? { opacity: 1, pointerEvents: "none" }
												: {
														opacity: 0,
														pointerEvents: "none",
													transition: { duration: 0.14, ease: [0.4, 0, 1, 1] },
												}
									}
									transition={
										isDragging || reducedMotion
											? { duration: 0 }
											: draggingTabId
												? {
													default: KESTREL_STATE_TRANSITION,
													layout: KESTREL_CRITICAL_SPRING,
												}
												: KESTREL_STATE_TRANSITION
									}
									style={tabStyle as MotionStyle}
									data-tab-id={tab.id}
									data-drag-intent={isDragging ? dragIntent : undefined}
									onAuxClick={(event) => handleTabAuxClick(event, tab.id)}
									onContextMenu={(event) => openMenu(event, tab.id)}
									onClick={(event) => {
										if ((event.target as HTMLElement).closest(".browser-tab-close")) return;
										if (suppressClickTabIdRef.current === tab.id) {
											suppressClickTabIdRef.current = null;
											return;
										}
										onSelect(tab.id);
									}}
									onPointerDown={(event) => handleTabPointerDown(event, tab.id)}
									onPointerCancel={() => resetDrag()}
								>
									<button
										type="button"
										role="tab"
										aria-selected={active}
										aria-controls="browser-viewport"
										tabIndex={active ? 0 : -1}
										aria-label={`${tab.title}${folder ? `, ${folder.name} folder` : ""}${isSleeping ? " (Sleeping)" : ""}`}
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
							return rows;
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
			<AnimatePresence initial={false} onExitComplete={handleMenuExitComplete}>
			{menu && menuTab && (
				<motion.div
					key={`browser-tab-menu-${menu.tabId}`}
					ref={contextMenuRef}
					className="browser-tab-menu no-drag"
					style={{
						left: menu.x,
						top: menu.y,
						transformOrigin: `${Math.max(8, menu.anchorX - menu.x)}px ${Math.max(8, menu.anchorY - menu.y)}px`,
					}}
					role="menu"
					initial={reducedMotion ? false : { opacity: 0, scale: 0.985 }}
					animate={{ opacity: 1, scale: 1 }}
				exit={
					reducedMotion
						? { opacity: 1, scale: 1, pointerEvents: "none" }
						: { opacity: 0, scale: 0.985, pointerEvents: "none" }
				}
					transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
				>
					{onOrganizeTabs && (
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								void Promise.resolve()
									.then(() => onOrganizeTabs())
									.catch(() => undefined);
								closeContextMenu();
							}}
						>
							Organize tabs
						</button>
					)}
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							onPin?.(menuTab.id, !menuTab.pinned);
							closeContextMenu();
						}}
					>
						{menuTab.pinned ? "Unpin tab" : "Pin tab"}
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							onMute?.(menuTab.id, !menuTab.muted);
							closeContextMenu();
						}}
					>
						{menuTab.muted ? "Unmute tab" : "Mute tab"}
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							onDuplicate?.(menuTab.id);
							closeContextMenu();
						}}
					>
						Duplicate tab
					</button>
					{onDetachTab && tabCanDetach(menuTab) && (
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								void Promise.resolve()
									.then(() => onDetachTab(menuTab.id))
									.catch(() => undefined);
								closeContextMenu();
							}}
						>
							Move tab to new window
						</button>
					)}
					{onReattachTab && (
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								void Promise.resolve()
									.then(() => onReattachTab(menuTab.id))
									.catch(() => undefined);
								closeContextMenu();
							}}
						>
							Move tab back to main window
						</button>
					)}
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							runCloseRequest("close-others", () =>
								onCloseOthers?.(menuTab.id),
							);
							closeContextMenu();
						}}
					>
						Close other tabs
					</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							handleTabClose(menuTab.id);
							closeContextMenu();
						}}
					>
						Close tab
					</button>
					<button type="button" role="menuitem" onClick={closeContextMenu}>
						Cancel
					</button>
				</motion.div>
			)}
			</AnimatePresence>
		</div>
	);
}
