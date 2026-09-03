import type {
	NewTabWidgetId,
	NewTabWidgetLayoutClass,
	NewTabWidgetLayoutItem,
	NewTabWidgetSettings,
	NewTabWidgetSize,
	MemoryRecord,
	MemoryRecallStatus,
	RuntimeSession,
	UserBrowserBookmark,
	UserBrowserDownload,
	UserBrowserHistoryEntry,
	UserBrowserOriginFavicon,
	UserBrowserTab,
} from "@kestrel/shared-types";
import {
	AnimatePresence,
	motion,
	useReducedMotion,
	type MotionStyle,
} from "motion/react";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { agentSessionRecency } from "../../agent-workspace";
import { sessionTitleForDisplay } from "../../chat-title";
import {
	KESTREL_CRITICAL_SPRING,
	KESTREL_STATE_TRANSITION,
} from "../../motion-contract";
import { Icon } from "../Icon";
import type { FrequentBrowserSite, SuggestedAgentAction } from "./new-tab";
import {
	addWidget,
	columnSpanForSize,
	layoutClassForWidth,
	layoutItemsForClass,
	moveWidget,
	NEW_TAB_WIDGET_DEFINITIONS,
	normalizedWidgetSettings,
	removeWidget,
	reorderWidget,
	resizeWidget,
	rowSpanForSize,
	saveLayout,
	WIDGET_SIZE_DESCRIPTIONS,
	WIDGET_SIZE_LABELS,
	type NewTabWidgetDefinition,
} from "./new-tab-widgets";
import { bookmarkBarFaviconDataUrl } from "./bookmarks-bar";
import "./new-tab-widgets.css";

type WidgetContext = {
	frequent: FrequentBrowserSite[];
	history: UserBrowserHistoryEntry[];
	bookmarks: UserBrowserBookmark[];
	originFavicons: readonly Pick<
		UserBrowserOriginFavicon,
		"origin" | "faviconDataUrl"
	>[];
	downloads: UserBrowserDownload[];
	tabs: Pick<
		UserBrowserTab,
		"id" | "title" | "url" | "faviconDataUrl" | "pinned"
	>[];
	sessions: RuntimeSession[];
	suggestedActions: SuggestedAgentAction[];
	memories: MemoryRecord[];
	memoryRecall: MemoryRecallStatus;
	agentName: string;
	onNavigate(input: string): void;
	onOpenTab(tabId: string): void;
	onNewAgent(prompt?: string): void;
	onOpenLifeMemory?(): void;
	onOpenSession?: ((sessionId: string) => void) | undefined;
	onOpenHistory(): void;
	onOpenDownloads(): void;
	onOpenBookmarks(): void;
};

type WidgetRenderContext = WidgetContext & { size: NewTabWidgetSize };

type NewTabWidgetsProps = WidgetContext & {
	settings: NewTabWidgetSettings;
	onSettingsChange(next: NewTabWidgetSettings): void;
};

const EMPTY_DRAG_DELTA = { x: 0, y: 0 };

function visibleItemCount(size: NewTabWidgetSize): number {
	if (size === "small") return 2;
	if (size === "medium") return 4;
	return 6;
}

function widgetText(value: string, maxLength = 46): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function hostnameForUrl(value: string): string {
	try {
		return new URL(value).hostname || value;
	} catch {
		return value;
	}
}

function FaviconGlyph({
	faviconDataUrl,
	hostname,
}: {
	faviconDataUrl?: string | undefined;
	hostname: string;
}) {
	const [broken, setBroken] = useState(false);
	const showFavicon = Boolean(faviconDataUrl) && !broken;
	return (
		<span className="kestrel-widget-site-glyph" aria-hidden="true">
			{showFavicon ? (
				<img src={faviconDataUrl} alt="" onError={() => setBroken(true)} />
			) : (
				(hostname[0] ?? "?").toUpperCase()
			)}
		</span>
	);
}

function SiteGlyph({ site }: { site: FrequentBrowserSite }) {
	return (
		<FaviconGlyph
			faviconDataUrl={site.faviconDataUrl}
			hostname={site.hostname}
		/>
	);
}

function BookmarkGlyph({
	bookmark,
	originFavicons,
}: {
	bookmark: UserBrowserBookmark;
	originFavicons: WidgetContext["originFavicons"];
}) {
	return (
		<FaviconGlyph
			faviconDataUrl={bookmarkBarFaviconDataUrl(
				bookmark.url,
				originFavicons,
				bookmark.faviconDataUrl,
			)}
			hostname={hostnameForUrl(bookmark.url)}
		/>
	);
}

function EmptyWidgetState({
	icon,
	children,
	action,
}: {
	icon: string;
	children: React.ReactNode;
	action?: { label: string; onClick(): void };
}) {
	return (
		<div className="kestrel-widget-empty">
			<span className="kestrel-widget-empty-icon" aria-hidden="true">
				<Icon name={icon} />
			</span>
			<div>
				<strong>{children}</strong>
				{action && (
					<button type="button" onClick={action.onClick}>
						{action.label}
					</button>
				)}
			</div>
		</div>
	);
}

function FrequentTabsWidget({
	frequent,
	size,
	onNavigate,
	onOpenHistory,
}: Pick<WidgetContext, "frequent" | "onNavigate" | "onOpenHistory"> & {
	size: NewTabWidgetSize;
}) {
	const items = frequent.slice(0, visibleItemCount(size));
	if (items.length === 0) {
		return (
			<EmptyWidgetState
				icon="history"
				action={{ label: "Open history", onClick: onOpenHistory }}
			>
				Your frequent tabs will appear here.
			</EmptyWidgetState>
		);
	}
	return (
		<ul className="kestrel-widget-list">
			{items.map((site) => (
				<li key={site.origin}>
					<button
						type="button"
						onClick={() => onNavigate(site.url)}
						title={`${site.title} · ${site.hostname}`}
					>
						<SiteGlyph site={site} />
						<span>
							<strong>{widgetText(site.title || site.hostname, 34)}</strong>
							<small>{site.hostname}</small>
						</span>
						<Icon name="forward" />
					</button>
				</li>
			))}
		</ul>
	);
}

function BookmarksWidget({
	bookmarks,
	originFavicons,
	size,
	onNavigate,
	onOpenBookmarks,
}: Pick<
	WidgetContext,
	| "bookmarks"
	| "originFavicons"
	| "onNavigate"
	| "onOpenBookmarks"
> & {
	size: NewTabWidgetSize;
}) {
	const items = bookmarks.slice(0, visibleItemCount(size));
	if (items.length === 0) {
		return (
			<EmptyWidgetState
				icon="star"
				action={{ label: "Manage bookmarks", onClick: onOpenBookmarks }}
			>
			Save a page to start a bookmark shelf.
			</EmptyWidgetState>
		);
	}
	return (
		<ul className="kestrel-widget-list">
			{items.map((bookmark) => (
				<li key={bookmark.id}>
					<button
						type="button"
						onClick={() => onNavigate(bookmark.url)}
						title={bookmark.url}
					>
						<BookmarkGlyph bookmark={bookmark} originFavicons={originFavicons} />
						<span>
							<strong>{widgetText(bookmark.title, 38)}</strong>
							<small>{hostnameForUrl(bookmark.url)}</small>
						</span>
						<Icon name="forward" />
					</button>
				</li>
			))}
		</ul>
	);
}

function downloadStatus(download: UserBrowserDownload): string {
	switch (download.status) {
		case "progressing":
			return "In progress";
		case "completed":
			return "Completed";
		case "cancelled":
			return "Canceled";
		case "failed":
			return "Failed";
	}
}

function DownloadsWidget({
	downloads,
	size,
	onOpenDownloads,
}: Pick<WidgetContext, "downloads" | "onOpenDownloads"> & {
	size: NewTabWidgetSize;
}) {
	const items = downloads
		.slice()
		.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
		.slice(0, visibleItemCount(size));
	if (items.length === 0) {
		return (
			<EmptyWidgetState
				icon="downloads"
				action={{ label: "Open downloads", onClick: onOpenDownloads }}
			>
				Downloads will appear here when you save a file.
			</EmptyWidgetState>
		);
	}
	return (
		<div className="kestrel-widget-downloads">
			<ul className="kestrel-widget-list">
				{items.map((download) => (
					<li key={download.id}>
						<button type="button" onClick={onOpenDownloads} title={download.sourceUrl}>
							<span className="kestrel-widget-list-icon" aria-hidden="true">
								<Icon name="artifacts" />
							</span>
							<span>
								<strong>{widgetText(download.filename, 38)}</strong>
								<small>
									{downloadStatus(download)} · {agentSessionRecency(download.startedAt)}
								</small>
							</span>
							<Icon name="forward" />
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function RecentWorkWidget({
	sessions,
	size,
	onOpenSession,
	onNewAgent,
}: Pick<WidgetContext, "sessions" | "onOpenSession" | "onNewAgent"> & {
	size: NewTabWidgetSize;
}) {
	const items = sessions.slice(0, visibleItemCount(size));
	if (items.length === 0) {
		return (
			<EmptyWidgetState
				icon="agent"
				action={{ label: "Start a task", onClick: () => onNewAgent() }}
			>
				Your recent Kestrel conversations will appear here.
			</EmptyWidgetState>
		);
	}
	return (
		<ul className="kestrel-widget-list">
			{items.map((session) => (
				<li key={session.id}>
					<button
						type="button"
						disabled={!onOpenSession}
						onClick={() => onOpenSession?.(session.id)}
						title={sessionTitleForDisplay(session.title)}
					>
						<span className="kestrel-widget-list-icon" aria-hidden="true">
							<Icon name="agent" />
						</span>
						<span>
							<strong>{widgetText(sessionTitleForDisplay(session.title), 38)}</strong>
							<small>{agentSessionRecency(session.updatedAt)}</small>
						</span>
						<Icon name="forward" />
					</button>
				</li>
			))}
		</ul>
	);
}

function RecentMemoriesWidget({
	memories,
	size,
	memoryRecall,
	onOpenLifeMemory,
	onNewAgent,
}: Pick<
	WidgetContext,
	"memories" | "memoryRecall" | "onOpenLifeMemory" | "onNewAgent"
> & {
	size: NewTabWidgetSize;
}) {
	const items = useMemo(
		() =>
			memories
				.filter((memory) => memory.status === "active")
				.slice()
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
				.slice(0, visibleItemCount(size)),
		[memories, size],
	);
	if (items.length === 0) {
		const emptyAction = memoryRecall.explicitCapture
			? {
					label: "Try a remember command",
					onClick: () =>
						onNewAgent("Remember that I prefer concise status updates"),
				}
			: onOpenLifeMemory
				? { label: "Open Life → Memory", onClick: onOpenLifeMemory }
				: undefined;
		return (
			<EmptyWidgetState
				icon="memory"
				{...(emptyAction ? { action: emptyAction } : {})}
			>
				{memoryRecall.explicitCapture
					? "Say remember that … in chat to store a preference on this Mac."
					: "Explicit memory capture is off in Settings → Memory."}
			</EmptyWidgetState>
		);
	}
	return (
		<ul className="kestrel-widget-list">
			{items.map((memory) => (
				<li key={memory.id}>
					<button
						type="button"
						onClick={() => onOpenLifeMemory?.()}
						title={memory.content}
					>
						<span className="kestrel-widget-list-icon" aria-hidden="true">
							<Icon name="memory" />
						</span>
						<span>
							<strong>{widgetText(memory.subject ?? memory.content, 38)}</strong>
							<small>
								{memory.confirmationStatus === "explicit" ||
								memory.userConfirmed
									? "Confirmed"
									: "Inferred"}{" "}
								· {agentSessionRecency(memory.updatedAt)}
							</small>
						</span>
						<Icon name="forward" />
					</button>
				</li>
			))}
		</ul>
	);
}

function QuickActionsWidget({
	suggestedActions,
	size,
	agentName,
	onNewAgent,
}: Pick<WidgetContext, "suggestedActions" | "agentName" | "onNewAgent"> & {
	size: NewTabWidgetSize;
}) {
	const items = suggestedActions.slice(0, visibleItemCount(size));
	if (items.length === 0) {
		return (
			<EmptyWidgetState
				icon="arrow"
				action={{ label: `Ask ${agentName}`, onClick: () => onNewAgent() }}
			>
				Start a task above or browse a little to unlock tailored suggestions.
			</EmptyWidgetState>
		);
	}
	return (
		<ul className="kestrel-widget-action-list">
			{items.map((action) => (
				<li key={action.id}>
					<button
						type="button"
						onClick={() => onNewAgent(action.prompt)}
						aria-label={`Open ${action.title} in ${agentName}`}
						title={action.description}
					>
						<span className="kestrel-widget-action-marker" aria-hidden="true">
							<Icon name="arrow" />
						</span>
						<span>{action.title}</span>
					</button>
				</li>
			))}
		</ul>
	);
}

function OpenTabsWidget({
	tabs,
	size,
	onOpenTab,
	pinnedOnly = false,
}: Pick<WidgetContext, "tabs" | "onOpenTab"> & {
	size: NewTabWidgetSize;
	pinnedOnly?: boolean;
}) {
	const items = tabs
		.filter((tab) => Boolean(tab.url) && (!pinnedOnly || tab.pinned))
		.slice(0, visibleItemCount(size));
	if (items.length === 0) {
		return (
			<EmptyWidgetState icon={pinnedOnly ? "pin" : "browser"}>
				{pinnedOnly
					? "Pin a tab to keep it ready here."
					: "Tabs you open will be ready to pick up here."}
			</EmptyWidgetState>
		);
	}
	return (
		<ul className="kestrel-widget-list">
			{items.map((tab) => (
				<li key={tab.id}>
					<button
						type="button"
						onClick={() => onOpenTab(tab.id)}
						title={tab.url}
					>
						<FaviconGlyph
							faviconDataUrl={tab.faviconDataUrl}
							hostname={hostnameForUrl(tab.url)}
						/>
						<span>
							<strong>
								{widgetText(tab.title || hostnameForUrl(tab.url), 38)}
							</strong>
							<small>{hostnameForUrl(tab.url)}</small>
						</span>
						<Icon name="forward" />
					</button>
				</li>
			))}
		</ul>
	);
}

function RecentPagesWidget({
	history,
	size,
	onNavigate,
}: Pick<WidgetContext, "history" | "onNavigate"> & {
	size: NewTabWidgetSize;
}) {
	const seen = new Set<string>();
	const items = history
		.slice()
		.sort((left, right) => right.visitedAt.localeCompare(left.visitedAt))
		.filter((entry) => {
			if (seen.has(entry.url)) return false;
			seen.add(entry.url);
			return true;
		})
		.slice(0, visibleItemCount(size));
	if (items.length === 0) {
		return (
			<EmptyWidgetState icon="history">
				Pages you visit will appear here for a quick return.
			</EmptyWidgetState>
		);
	}
	return (
		<ul className="kestrel-widget-list">
			{items.map((entry) => (
				<li key={entry.id}>
					<button
						type="button"
						onClick={() => onNavigate(entry.url)}
						title={entry.url}
					>
						<FaviconGlyph hostname={hostnameForUrl(entry.url)} />
						<span>
							<strong>{widgetText(entry.title, 38)}</strong>
							<small>
								{hostnameForUrl(entry.url)} · {agentSessionRecency(entry.visitedAt)}
							</small>
						</span>
						<Icon name="forward" />
					</button>
				</li>
			))}
		</ul>
	);
}

function WidgetBody({
	definition,
	context,
}: {
	definition: NewTabWidgetDefinition;
	context: WidgetRenderContext;
}) {
	switch (definition.id) {
		case "frequent-tabs":
			return <FrequentTabsWidget {...context} />;
		case "bookmarks":
			return <BookmarksWidget {...context} />;
		case "downloads":
			return <DownloadsWidget {...context} />;
		case "recent-work":
			return <RecentWorkWidget {...context} />;
		case "recent-memories":
			return <RecentMemoriesWidget {...context} />;
		case "quick-actions":
			return <QuickActionsWidget {...context} />;
		case "open-tabs":
			return <OpenTabsWidget {...context} />;
		case "pinned-tabs":
			return <OpenTabsWidget {...context} pinnedOnly />;
		case "recent-pages":
			return <RecentPagesWidget {...context} />;
	}
}

type WidgetPopover = {
	open: boolean;
	menuId: string;
	rootRef: React.RefObject<HTMLDivElement | null>;
	triggerRef: React.RefObject<HTMLButtonElement | null>;
	menuRef: React.RefObject<HTMLDivElement | null>;
	toggle(): void;
	close(options?: { restoreFocus?: boolean }): void;
};

function useWidgetPopover(): WidgetPopover {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const menuId = useId();

	const close = useCallback(({ restoreFocus = false } = {}) => {
		setOpen(false);
		if (restoreFocus)
			window.requestAnimationFrame(() => triggerRef.current?.focus());
	}, []);

	const toggle = useCallback(() => {
		setOpen((current) => !current);
	}, []);

	useEffect(() => {
		if (!open) return;
		const frame = window.requestAnimationFrame(() => {
			const menu = menuRef.current;
			const current = menu?.querySelector<HTMLElement>(
				'[aria-checked="true"]:not(:disabled)',
			);
			const first = menu?.querySelector<HTMLElement>(
				'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
			);
			(current ?? first)?.focus();
		});
		const isInside = (target: EventTarget | null) =>
			target instanceof Node && Boolean(rootRef.current?.contains(target));
		const onPointerDown = (event: PointerEvent) => {
			if (!isInside(event.target)) close();
		};
		const onFocusIn = (event: FocusEvent) => {
			if (!isInside(event.target)) close();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			close({ restoreFocus: true });
		};
		const onWindowBlur = () => close();
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("focusin", onFocusIn);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("blur", onWindowBlur);
		return () => {
			window.cancelAnimationFrame(frame);
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("focusin", onFocusIn);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("blur", onWindowBlur);
		};
	}, [close, open]);

	return { open, menuId, rootRef, triggerRef, menuRef, toggle, close };
}

function moveWidgetPopoverFocus(
	event: React.KeyboardEvent<HTMLDivElement>,
) {
	if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
	const items = Array.from(
		event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
	);
	if (items.length === 0) return;
	const current = items.indexOf(document.activeElement as HTMLButtonElement);
	const next =
		event.key === "Home"
			? 0
			: event.key === "End"
				? items.length - 1
				: (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
					items.length;
	event.preventDefault();
	items[next]?.focus();
}

function SizeMenu({
	definition,
	currentSize,
	onChange,
}: {
	definition: NewTabWidgetDefinition;
	currentSize: NewTabWidgetSize;
	onChange(size: NewTabWidgetSize): void;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const popover = useWidgetPopover();
	return (
		<div
			ref={popover.rootRef}
			className="kestrel-widget-size-menu"
			data-open={popover.open ? "true" : "false"}
		>
			<button
				ref={popover.triggerRef}
				type="button"
				aria-label={`Change ${definition.title} size`}
				aria-haspopup="menu"
				aria-controls={popover.menuId}
				aria-expanded={popover.open}
				title={`Change ${definition.title} size`}
				onClick={popover.toggle}
			>
				<Icon name="sliders" />
			</button>
			<AnimatePresence initial={false}>
				{popover.open && (
					<motion.div
						id={popover.menuId}
						ref={popover.menuRef}
						className="kestrel-widget-size-popover"
						role="menu"
						aria-label={`Change ${definition.title} size`}
						initial={reducedMotion ? false : { opacity: 0, y: -4, scale: 0.98 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={
							reducedMotion
								? { opacity: 1, y: 0, scale: 1, pointerEvents: "none" }
								: { opacity: 0, y: -4, scale: 0.98, pointerEvents: "none" }
						}
						transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
						onKeyDown={moveWidgetPopoverFocus}
					>
						<strong>Widget size</strong>
						{definition.supportedSizes.map((size) => (
							<button
								key={size}
								type="button"
								role="menuitemradio"
								aria-checked={size === currentSize}
								onClick={() => {
									onChange(size);
									popover.close({ restoreFocus: true });
								}}
							>
								<span>
									<strong>{WIDGET_SIZE_LABELS[size]}</strong>
									<small>{WIDGET_SIZE_DESCRIPTIONS[size]}</small>
								</span>
								{size === currentSize && <Icon name="check" />}
							</button>
						))}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

function WidgetCard({
	item,
	definition,
	layoutClass,
	editing,
	dragging,
	dragDelta,
	context,
	onMove,
	onResize,
	onRemove,
	onDragStart,
	onDragMove,
	onDragEnd,
}: {
	item: NewTabWidgetLayoutItem;
	definition: NewTabWidgetDefinition;
	layoutClass: NewTabWidgetLayoutClass;
	editing: boolean;
	dragging: boolean;
	dragDelta: { x: number; y: number };
	context: WidgetContext;
	onMove(id: NewTabWidgetId, direction: "up" | "down"): void;
	onResize(id: NewTabWidgetId, size: NewTabWidgetSize): void;
	onRemove(id: NewTabWidgetId): void;
	onDragStart(id: NewTabWidgetId, event: ReactPointerEvent<HTMLButtonElement>): void;
	onDragMove(event: ReactPointerEvent<HTMLButtonElement>): void;
	onDragEnd(event: ReactPointerEvent<HTMLButtonElement>): void;
}) {
	const definitionForItem = definition;
	const reducedMotion = useReducedMotion() ?? false;
	const style = {
		"--kestrel-widget-column-span": columnSpanForSize(item.size, layoutClass),
		"--kestrel-widget-row-span": rowSpanForSize(item.size),
	} as MotionStyle;

	return (
		<motion.article
			className={`kestrel-widget-card kestrel-widget-card-${item.size}${
				dragging ? " is-dragging" : ""
			}`}
			layout={!reducedMotion}
			animate={
				dragging
					? { x: dragDelta.x, y: dragDelta.y, scale: reducedMotion ? 1 : 1.015 }
					: { x: 0, y: 0, scale: 1 }
			}
			transition={
				dragging
					? { duration: 0 }
					: reducedMotion
						? { duration: 0 }
						: {
								default: KESTREL_CRITICAL_SPRING,
								layout: KESTREL_CRITICAL_SPRING,
							}
			}
			data-kestrel-widget-id={item.id}
			style={style}
			aria-label={`${definitionForItem.title} widget`}
		>
			<header className="kestrel-widget-card-header">
				<span className="kestrel-widget-card-icon" aria-hidden="true">
					<Icon name={definitionForItem.icon} />
				</span>
				<div className="kestrel-widget-card-heading">
					<h3>{definitionForItem.title}</h3>
					<p>{definitionForItem.description}</p>
				</div>
				{editing && (
					<div className="kestrel-widget-card-actions">
						<button
							type="button"
							className="kestrel-widget-drag-handle"
							onPointerDown={(event) => onDragStart(item.id, event)}
							onPointerMove={onDragMove}
							onPointerUp={onDragEnd}
							onPointerCancel={onDragEnd}
							onLostPointerCapture={onDragEnd}
							onKeyDown={(event) => {
								if (event.key === "ArrowUp" || event.key === "ArrowDown") {
									event.preventDefault();
									onMove(item.id, event.key === "ArrowUp" ? "up" : "down");
								}
							}}
							aria-label={`Move ${definitionForItem.title}. Use arrow keys to reorder.`}
								title="Drag to reorder"
						>
							<Icon name="tabActions" />
						</button>
						<SizeMenu
							definition={definitionForItem}
							currentSize={item.size}
							onChange={(size) => onResize(item.id, size)}
						/>
						<button
							type="button"
							className="kestrel-widget-small-action"
							onClick={() => onRemove(item.id)}
							aria-label={`Remove ${definitionForItem.title}`}
							title={`Remove ${definitionForItem.title}`}
						>
							<Icon name="close" />
						</button>
					</div>
				)}
			</header>
			<div className="kestrel-widget-card-body">
				<WidgetBody definition={definitionForItem} context={{ ...context, size: item.size }} />
			</div>
		</motion.article>
	);
}

function AddWidgetMenu({
	enabled,
	onAdd,
}: {
	enabled: readonly NewTabWidgetId[];
	onAdd(id: NewTabWidgetId): void;
}) {
	const available = Object.values(NEW_TAB_WIDGET_DEFINITIONS).filter(
		(definition) => !enabled.includes(definition.id),
	);
	const reducedMotion = useReducedMotion() ?? false;
	const popover = useWidgetPopover();
	return (
		<div
			ref={popover.rootRef}
			className="kestrel-widget-add-menu"
			data-open={popover.open ? "true" : "false"}
		>
			<button
				ref={popover.triggerRef}
				type="button"
				aria-haspopup="dialog"
				aria-controls={popover.menuId}
				aria-expanded={popover.open}
				onClick={popover.toggle}
			>
				<Icon name="plus" />
				<span>Add widget</span>
			</button>
			<AnimatePresence initial={false}>
				{popover.open && (
					<motion.div
						id={popover.menuId}
						ref={popover.menuRef}
						className="kestrel-widget-add-popover"
						role="dialog"
						aria-label="Add widget"
						initial={reducedMotion ? false : { opacity: 0, y: -4, scale: 0.985 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={
							reducedMotion
								? { opacity: 1, y: 0, scale: 1, pointerEvents: "none" }
								: { opacity: 0, y: -4, scale: 0.985, pointerEvents: "none" }
						}
						transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
						onKeyDown={moveWidgetPopoverFocus}
					>
						<strong>Widgets</strong>
						<p>Choose what should live beneath your Kestrel input.</p>
						{available.length > 0 ? (
							<ul>
								{available.map((definition) => (
									<li key={definition.id}>
										<button
											type="button"
											onClick={() => {
												onAdd(definition.id);
												popover.close({ restoreFocus: true });
											}}
										>
											<span className="kestrel-widget-add-icon" aria-hidden="true">
												<Icon name={definition.icon} />
											</span>
											<span>
												<strong>{definition.title}</strong>
												<small>{definition.description}</small>
											</span>
											<Icon name="plus" />
										</button>
									</li>
								))}
							</ul>
						) : (
							<span className="kestrel-widget-add-empty">All available widgets are already on your page.</span>
						)}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

export function NewTabWidgets({
	settings,
	onSettingsChange,
	...context
}: NewTabWidgetsProps) {
	const canvasRef = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);
	const [editing, setEditing] = useState(false);
	const [workingSettings, setWorkingSettings] = useState(() =>
		normalizedWidgetSettings(settings),
	);
	const settingsRef = useRef(workingSettings);
	const [draggingId, setDraggingId] = useState<NewTabWidgetId | null>(null);
	const dragStateRef = useRef<{
		id: NewTabWidgetId;
		startX: number;
		startY: number;
		pointerId: number;
		handle: HTMLButtonElement;
	} | null>(null);
	const [dragDelta, setDragDelta] = useState(EMPTY_DRAG_DELTA);

	const updateWorkingSettings = useCallback(
		(next: NewTabWidgetSettings, persist: boolean) => {
			const normalized = normalizedWidgetSettings(next);
			settingsRef.current = normalized;
			setWorkingSettings(normalized);
			if (persist) onSettingsChange(normalized);
		},
		[onSettingsChange],
	);

	useEffect(() => {
		const normalized = normalizedWidgetSettings(settings);
		settingsRef.current = normalized;
		setWorkingSettings(normalized);
	}, [settings]);

	useEffect(() => {
		const node = canvasRef.current;
		if (!node) return;
		const measure = () => {
			const nextWidth = Math.round(node.getBoundingClientRect().width);
			setWidth((current) => (current === nextWidth ? current : nextWidth));
		};
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		measure();
		return () => observer.disconnect();
	}, []);

	const layoutClass = layoutClassForWidth(width);
	const items = useMemo(
		() => layoutItemsForClass(workingSettings, layoutClass),
		[layoutClass, workingSettings],
	);

	useEffect(() => {
		if (!width || workingSettings.layouts[layoutClass]) return;
		const next = saveLayout(workingSettings, layoutClass, items, false);
		updateWorkingSettings(next, true);
	}, [items, layoutClass, updateWorkingSettings, width, workingSettings]);

	const commitReorder = useCallback(
		(id: NewTabWidgetId, toIndex: number, persist: boolean) => {
			const currentItems = layoutItemsForClass(settingsRef.current, layoutClass);
			const nextItems = reorderWidget(currentItems, id, toIndex);
			updateWorkingSettings(
				saveLayout(settingsRef.current, layoutClass, nextItems),
				persist,
			);
		},
		[layoutClass, updateWorkingSettings],
	);

	const endDrag = useCallback((pointerId?: number) => {
		const drag = dragStateRef.current;
		if (!drag) return;
		if (pointerId !== undefined && drag.pointerId !== pointerId) return;
		/* Clear ownership before releasing capture so lostpointercapture cannot
		 * finish the same gesture twice. */
		dragStateRef.current = null;
		if (drag.handle.hasPointerCapture(drag.pointerId))
			drag.handle.releasePointerCapture(drag.pointerId);
		setDraggingId(null);
		setDragDelta(EMPTY_DRAG_DELTA);
		onSettingsChange(settingsRef.current);
	}, [onSettingsChange]);

	const handleDragMove = useCallback(
		(event: ReactPointerEvent<HTMLButtonElement>) => {
			const dragState = dragStateRef.current;
			if (!dragState || event.pointerId !== dragState.pointerId) return;
			setDragDelta({
				x: event.clientX - dragState.startX,
				y: event.clientY - dragState.startY,
			});

			const nodes = [...document.querySelectorAll<HTMLElement>("[data-kestrel-widget-id]")]
				.filter((node) => node.dataset.kestrelWidgetId !== dragState.id);
			if (nodes.length === 0) return;
			const target = nodes
				.map((node) => {
					const rect = node.getBoundingClientRect();
					const centerX = rect.left + rect.width / 2;
					const centerY = rect.top + rect.height / 2;
					return {
						node,
						distance: Math.abs(event.clientX - centerX) + Math.abs(event.clientY - centerY),
					};
				})
				.sort((left, right) => left.distance - right.distance)[0]?.node;
			if (!target) return;
			const targetId = target.dataset.kestrelWidgetId as NewTabWidgetId | undefined;
			if (!targetId) return;
			const currentItems = layoutItemsForClass(settingsRef.current, layoutClass);
			const targetIndex = currentItems.findIndex((item) => item.id === targetId);
			if (targetIndex < 0) return;
			const rect = target.getBoundingClientRect();
			const before =
				event.clientY < rect.top + rect.height / 2 ||
				(Math.abs(event.clientY - (rect.top + rect.height / 2)) < rect.height / 3 &&
					event.clientX < rect.left + rect.width / 2);
			const destination = targetIndex + (before ? 0 : 1);
			const currentIndex = currentItems.findIndex((item) => item.id === dragState.id);
			const adjustedDestination = destination > currentIndex ? destination - 1 : destination;
			if (adjustedDestination !== currentIndex) {
				commitReorder(dragState.id, adjustedDestination, false);
			}
		},
		[commitReorder, layoutClass],
	);

	const handleDragEnd = useCallback(
		(event: ReactPointerEvent<HTMLButtonElement>) => endDrag(event.pointerId),
		[endDrag],
	);

	const handleDragStart = useCallback(
		(id: NewTabWidgetId, event: ReactPointerEvent<HTMLButtonElement>) => {
			if (!editing || event.button !== 0 || dragStateRef.current) return;
			event.preventDefault();
			event.currentTarget.setPointerCapture(event.pointerId);
			dragStateRef.current = {
				id,
				startX: event.clientX,
				startY: event.clientY,
				pointerId: event.pointerId,
				handle: event.currentTarget,
			};
			setDraggingId(id);
			setDragDelta(EMPTY_DRAG_DELTA);
		},
		[editing],
	);

	const handleMove = useCallback(
		(id: NewTabWidgetId, direction: "up" | "down") => {
			const nextItems = moveWidget(
				layoutItemsForClass(settingsRef.current, layoutClass),
				id,
				direction,
			);
			updateWorkingSettings(saveLayout(settingsRef.current, layoutClass, nextItems), true);
		},
		[layoutClass, updateWorkingSettings],
	);

	const handleResize = useCallback(
		(id: NewTabWidgetId, size: NewTabWidgetSize) => {
			updateWorkingSettings(
				resizeWidget(settingsRef.current, layoutClass, id, size),
				true,
			);
		},
		[layoutClass, updateWorkingSettings],
	);

	const handleRemove = useCallback(
		(id: NewTabWidgetId) => {
			updateWorkingSettings(removeWidget(settingsRef.current, id), true);
		},
		[updateWorkingSettings],
	);

	const handleAdd = useCallback(
		(id: NewTabWidgetId) => {
			updateWorkingSettings(
				addWidget(settingsRef.current, layoutClass, id),
				true,
			);
		},
		[layoutClass, updateWorkingSettings],
	);

	return (
		<section
			ref={canvasRef}
			className={`kestrel-widget-canvas kestrel-widget-canvas-${layoutClass}${
				editing ? " is-editing" : ""
			}`}
			aria-label="New Tab widgets"
			data-layout-class={layoutClass}
		>
			<div className="kestrel-widget-canvas-toolbar">
				<div className="kestrel-widget-canvas-actions">
					{editing && (
						<AddWidgetMenu enabled={workingSettings.enabled} onAdd={handleAdd} />
					)}
					<button
						type="button"
						className={`kestrel-widget-customize ${editing ? "is-active" : ""}`}
						onClick={() => setEditing((current) => !current)}
						aria-pressed={editing}
					>
						<Icon name={editing ? "check" : "sliders"} />
						<span>{editing ? "Done" : "Customize"}</span>
					</button>
				</div>
			</div>

			{items.length > 0 ? (
				<div className="kestrel-widget-grid kestrel-widget-shelves" aria-label="New Tab widgets">
					{items.map((item) => {
						const definition = NEW_TAB_WIDGET_DEFINITIONS[item.id];
						return (
							<WidgetCard
								key={item.id}
								item={item}
								definition={definition}
								layoutClass={layoutClass}
								editing={editing}
								dragging={draggingId === item.id}
								dragDelta={dragDelta}
								context={context}
								onMove={handleMove}
								onResize={handleResize}
								onRemove={handleRemove}
								onDragStart={handleDragStart}
								onDragMove={handleDragMove}
								onDragEnd={handleDragEnd}
							/>
						);
					})}
				</div>
			) : (
				<div className="kestrel-widget-canvas-empty">
					<span className="kestrel-widget-canvas-empty-icon" aria-hidden="true">
						<Icon name="sparkle" />
					</span>
					<div>
						<strong>Make New Tab yours.</strong>
						<p>Add a widget when you want a little more here.</p>
						{!editing && (
							<button type="button" onClick={() => setEditing(true)}>
								Customize New Tab
							</button>
						)}
					</div>
				</div>
			)}
		</section>
	);
}
