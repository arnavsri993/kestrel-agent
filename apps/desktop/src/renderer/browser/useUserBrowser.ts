import type {
	FilePreview,
	RendererResponse,
	SelectedAttachment,
	UserBrowserFindMatch,
	UserBrowserPageContext,
	UserBrowserSettings,
	UserBrowserState,
	UserBrowserTabOrganizationApply,
	UserBrowserTabOrganizationPreview,
} from "@kestrel/shared-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function responseError(response: RendererResponse): string {
	return !response.ok && "error" in response
		? response.error
		: "The browser did not return its state.";
}

export interface UserBrowserController {
	state: UserBrowserState | null;
	error: string;
	findMatch: UserBrowserFindMatch | null;
	openFileTabs(paths: string[], active?: boolean): Promise<SelectedAttachment[]>;
	filePreview(tabId: string): Promise<FilePreview | undefined>;
	openFileDefault(tabId: string): Promise<void>;
	createTab(input?: string, active?: boolean): Promise<void>;
	reopenClosedTab(index?: number): Promise<void>;
	closeTab(tabId: string): Promise<void>;
	selectTab(tabId: string): Promise<void>;
	navigate(tabId: string, input: string): Promise<void>;
	back(tabId: string): Promise<void>;
	forward(tabId: string): Promise<void>;
	reload(tabId: string, ignoreCache?: boolean): Promise<void>;
	zoomIn(tabId?: string): Promise<void>;
	zoomOut(tabId?: string): Promise<void>;
	zoomReset(tabId?: string): Promise<void>;
	stop(tabId: string): Promise<void>;
	setContentBounds(
		bounds: { x: number; y: number; width: number; height: number },
		visible: boolean,
	): Promise<void>;
	toggleCalculator(bounds?: BrowserContentBounds): Promise<void>;
	pageContext(tabId?: string): Promise<UserBrowserPageContext | undefined>;
	updateSettings(settings: Partial<UserBrowserSettings>): Promise<void>;
	clearHistory(): Promise<void>;
	clearBrowsingData(options: {
		history?: boolean;
		cookies?: boolean;
		cache?: boolean;
	}): Promise<void>;
	revealDownload(downloadId: string): Promise<void>;
	openDownload(downloadId: string): Promise<void>;
	cancelDownload(downloadId: string): Promise<void>;
	toggleBookmark(url?: string, title?: string): Promise<void>;
	removeBookmark(bookmarkId: string): Promise<void>;
	pinTab(tabId: string, pinned: boolean): Promise<void>;
	muteTab(tabId: string, muted: boolean): Promise<void>;
	duplicateTab(tabId: string): Promise<void>;
	closeOtherTabs(tabId: string): Promise<void>;
	moveTab(tabId: string, toIndex: number): Promise<void>;
	organizeTabs(): Promise<void>;
	previewOrganizeTabs(): Promise<UserBrowserTabOrganizationPreview>;
	applyTabOrganization(
		organization: UserBrowserTabOrganizationApply,
	): Promise<void>;
	detachTab(tabId: string): Promise<void>;
	findInPage(
		tabId: string,
		query: string,
		options?: { findNext?: boolean; forward?: boolean },
	): Promise<void>;
	stopFindInPage(tabId: string): Promise<void>;
	printTab(tabId: string): Promise<void>;
	openDevTools(tabId: string): Promise<void>;
	saveScreenshot(tabId: string): Promise<string | undefined>;
	setSitePermission(
		origin: string,
		permission: string,
		decision: "allow" | "deny",
	): Promise<void>;
	sleepTab(tabId: string): Promise<void>;
	sleepInactiveTabs(): Promise<void>;
}

export interface BrowserContentBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function useUserBrowser(): UserBrowserController {
	const [state, setState] = useState<UserBrowserState | null>(null);
	const [error, setError] = useState("");
	const [findMatch, setFindMatch] = useState<UserBrowserFindMatch | null>(null);
	const stateRef = useRef<UserBrowserState | null>(state);
	const settingsRequestRef = useRef<Promise<void>>(Promise.resolve());
	const contentBoundsRequestRef = useRef<Promise<void>>(Promise.resolve());
	stateRef.current = state;
	const applyState = useCallback((nextState: UserBrowserState) => {
		stateRef.current = nextState;
		setState(nextState);
	}, []);

	const requestState = useCallback(
		async (request: Parameters<typeof window.kestrel.request>[0]) => {
			try {
				const response = await window.kestrel.request(request);
				if (!response.ok || !("browserState" in response))
					throw new Error(responseError(response));
				applyState(response.browserState);
				setError("");
			} catch (cause) {
				const message =
					cause instanceof Error
						? cause.message
						: "The browser request failed.";
				setError(message);
				throw cause;
			}
		},
		[applyState],
	);
	const openFileTabs = useCallback(
		async (paths: string[], active = true) => {
			const response = await window.kestrel.request({
				type: "browser-open-file-tabs",
				paths,
				active,
			});
			if (!response.ok || !("browserState" in response))
				throw new Error(responseError(response));
			applyState(response.browserState);
			setError("");
			return "selectedAttachments" in response
				? response.selectedAttachments
				: [];
		},
		[applyState],
	);
	const filePreview = useCallback(async (tabId: string) => {
		const response = await window.kestrel.request({
			type: "browser-file-preview",
			tabId,
		});
		if (!response.ok || !("filePreview" in response))
			throw new Error(responseError(response));
		return response.filePreview;
	}, []);
	const openFileDefault = useCallback(async (tabId: string) => {
		const response = await window.kestrel.request({
			type: "browser-open-file-default",
			tabId,
		});
		if (!response.ok) throw new Error(responseError(response));
	}, []);

	useEffect(() => {
		let active = true;
		const unsubscribe = window.kestrel.onBrowserEvent((event) => {
			if (!active) return;
			if (event.type === "state") {
				applyState(event.state);
				setError("");
			} else if (event.type === "find-in-page") {
				setFindMatch(event.match);
			}
		});
		void window.kestrel
			.request({ type: "browser-get-state" })
			.then((response) => {
				if (!active) return;
				if (!response.ok || !("browserState" in response))
					throw new Error(responseError(response));
				applyState(response.browserState);
			})
			.catch((cause) => {
				if (active)
					setError(
						cause instanceof Error
							? cause.message
							: "The browser could not start.",
					);
			});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [applyState]);

	const createTab = useCallback(
		(input?: string, active = true) =>
			requestState({
				type: "browser-create-tab",
				...(input ? { input } : {}),
				active,
			}),
		[requestState],
	);
	const reopenClosedTab = useCallback(
		(index = 0) => requestState({ type: "browser-reopen-closed-tab", index }),
		[requestState],
	);
	const closeTab = useCallback(
		(tabId: string) => requestState({ type: "browser-close-tab", tabId }),
		[requestState],
	);
	const selectTab = useCallback(
		(tabId: string) => requestState({ type: "browser-select-tab", tabId }),
		[requestState],
	);
	const navigate = useCallback(
		(tabId: string, input: string) =>
			requestState({ type: "browser-navigate", tabId, input }),
		[requestState],
	);
	const back = useCallback(
		(tabId: string) => requestState({ type: "browser-back", tabId }),
		[requestState],
	);
	const forward = useCallback(
		(tabId: string) => requestState({ type: "browser-forward", tabId }),
		[requestState],
	);
	const reload = useCallback(
		(tabId: string, ignoreCache?: boolean) =>
			requestState({
				type: "browser-reload",
				tabId,
				...(ignoreCache ? { ignoreCache: true } : {}),
			}),
		[requestState],
	);
	const zoomIn = useCallback(
		(tabId?: string) => {
			const targetId = tabId ?? stateRef.current?.activeTabId;
			return targetId
				? requestState({ type: "browser-zoom-in", tabId: targetId })
				: Promise.resolve();
		},
		[requestState],
	);
	const zoomOut = useCallback(
		(tabId?: string) => {
			const targetId = tabId ?? stateRef.current?.activeTabId;
			return targetId
				? requestState({ type: "browser-zoom-out", tabId: targetId })
				: Promise.resolve();
		},
		[requestState],
	);
	const zoomReset = useCallback(
		(tabId?: string) => {
			const targetId = tabId ?? stateRef.current?.activeTabId;
			return targetId
				? requestState({ type: "browser-zoom-reset", tabId: targetId })
				: Promise.resolve();
		},
		[requestState],
	);
	const stop = useCallback(
		(tabId: string) => requestState({ type: "browser-stop", tabId }),
		[requestState],
	);
	const setContentBounds = useCallback(
		(
			bounds: { x: number; y: number; width: number; height: number },
			visible: boolean,
		) => {
			// Layout effects hide the native view during cleanup and reveal it
			// again after a route or orientation change. Serialize those IPC
			// updates so an older cleanup cannot arrive after the newer visible
			// bounds and leave the active page detached.
			const pending = contentBoundsRequestRef.current
				.catch(() => undefined)
				.then(async () => {
					const response = await window.kestrel.request({
						type: "browser-set-content-bounds",
						bounds,
						visible,
					});
					if (!response.ok) throw new Error(responseError(response));
				});
			contentBoundsRequestRef.current = pending;
			return pending;
		},
		[],
	);
	const toggleCalculator = useCallback(
		async (bounds?: BrowserContentBounds) => {
			try {
				const response = await window.kestrel.request({
					type: "browser-toggle-calculator",
					bounds,
				});
				if (!response.ok) throw new Error(responseError(response));
				setError("");
			} catch (cause) {
				const message =
					cause instanceof Error
						? cause.message
						: "The calculator could not be opened.";
				setError(message);
				throw cause;
			}
		},
		[],
	);
	const pageContext = useCallback(async (tabId?: string) => {
		const selectedTabId =
			tabId ?? stateRef.current?.activeTabId ?? stateRef.current?.tabs[0]?.id;
		if (!selectedTabId) return undefined;
		try {
			const response = await window.kestrel.request({
				type: "browser-get-context",
				tabId: selectedTabId,
			});
			return response.ok && "browserContext" in response
				? response.browserContext
				: undefined;
		} catch {
			return undefined;
		}
	}, []);
	const updateSettings = useCallback(
		(settings: Partial<UserBrowserSettings>) => {
			// Settings controls can be changed faster than IPC state round-trips.
			// Serialize partial updates and merge each one into the latest observed
			// state so a later control never restores stale values from its render.
			const pending = settingsRequestRef.current
				.catch(() => undefined)
				.then(async () => {
					const current = stateRef.current?.settings;
					if (!current) throw new Error("Browser settings are unavailable.");
					await requestState({
						type: "browser-update-settings",
						settings: { ...current, ...settings },
					});
				});
			settingsRequestRef.current = pending;
			return pending;
		},
		[requestState],
	);
	const clearHistory = useCallback(
		() => requestState({ type: "browser-clear-history" }),
		[requestState],
	);
	const clearBrowsingData = useCallback(
		(options: { history?: boolean; cookies?: boolean; cache?: boolean }) =>
			requestState({
				type: "browser-clear-data",
				history: Boolean(options.history),
				cookies: Boolean(options.cookies),
				cache: Boolean(options.cache),
			}),
		[requestState],
	);
	const revealDownload = useCallback(async (downloadId: string) => {
		const response = await window.kestrel.request({
			type: "browser-reveal-download",
			downloadId,
		});
		if (!response.ok) throw new Error(responseError(response));
	}, []);
	const openDownload = useCallback(async (downloadId: string) => {
		const response = await window.kestrel.request({
			type: "browser-open-download",
			downloadId,
		});
		if (!response.ok) throw new Error(responseError(response));
	}, []);
	const cancelDownload = useCallback(
		(downloadId: string) =>
			requestState({ type: "browser-cancel-download", downloadId }),
		[requestState],
	);
	const toggleBookmark = useCallback(
		(url?: string, title?: string) =>
			requestState({
				type: "browser-toggle-bookmark",
				...(url ? { url } : {}),
				...(title ? { title } : {}),
			}),
		[requestState],
	);
	const removeBookmark = useCallback(
		(bookmarkId: string) =>
			requestState({ type: "browser-remove-bookmark", bookmarkId }),
		[requestState],
	);
	const pinTab = useCallback(
		(tabId: string, pinned: boolean) =>
			requestState({ type: "browser-pin-tab", tabId, pinned }),
		[requestState],
	);
	const muteTab = useCallback(
		(tabId: string, muted: boolean) =>
			requestState({ type: "browser-mute-tab", tabId, muted }),
		[requestState],
	);
	const duplicateTab = useCallback(
		(tabId: string) => requestState({ type: "browser-duplicate-tab", tabId }),
		[requestState],
	);
	const closeOtherTabs = useCallback(
		(tabId: string) => requestState({ type: "browser-close-other-tabs", tabId }),
		[requestState],
	);
	const moveTab = useCallback(
		(tabId: string, toIndex: number) =>
			requestState({ type: "browser-move-tab", tabId, toIndex }),
		[requestState],
	);
	const organizeTabs = useCallback(
		() => requestState({ type: "browser-organize-tabs" }),
		[requestState],
	);
	const previewOrganizeTabs = useCallback(async () => {
		const response = await window.kestrel.request({
			type: "browser-preview-organize-tabs",
		});
		if (!response.ok || !("browserOrganization" in response))
			throw new Error(responseError(response));
		return response.browserOrganization;
	}, []);
	const applyTabOrganization = useCallback(
		(organization: UserBrowserTabOrganizationApply) =>
			requestState({
				type: "browser-apply-tab-organization",
				...organization,
			}),
		[requestState],
	);
	const detachTab = useCallback(
		(tabId: string) => requestState({ type: "browser-detach-tab", tabId }),
		[requestState],
	);
	const findInPage = useCallback(
		(
			tabId: string,
			query: string,
			options?: { findNext?: boolean; forward?: boolean },
		) =>
			requestState({
				type: "browser-find-in-page",
				tabId,
				query,
				...(options?.findNext ? { findNext: true } : {}),
				...(options?.forward === false ? { forward: false } : {}),
			}),
		[requestState],
	);
	const stopFindInPage = useCallback(
		(tabId: string) => requestState({ type: "browser-stop-find-in-page", tabId }),
		[requestState],
	);
	const printTab = useCallback(
		(tabId: string) => requestState({ type: "browser-print", tabId }),
		[requestState],
	);
	const openDevTools = useCallback(
		(tabId: string) => requestState({ type: "browser-open-devtools", tabId }),
		[requestState],
	);
	const saveScreenshot = useCallback(async (tabId: string) => {
		const response = await window.kestrel.request({
			type: "browser-save-screenshot",
			tabId,
		});
		if (!response.ok)
			throw new Error(responseError(response));
		return "screenshotPath" in response ? response.screenshotPath : undefined;
	}, []);
	const setSitePermission = useCallback(
		(origin: string, permission: string, decision: "allow" | "deny") =>
			requestState({
				type: "browser-set-site-permission",
				origin,
				permission,
				decision,
			}),
		[requestState],
	);
	const sleepTab = useCallback(
		(tabId: string) => requestState({ type: "browser-sleep-tab", tabId }),
		[requestState],
	);
	const sleepInactiveTabs = useCallback(
		() => requestState({ type: "browser-sleep-inactive-tabs" }),
		[requestState],
	);

	return useMemo(
		() => ({
			state,
			error,
			findMatch,
			openFileTabs,
			filePreview,
			openFileDefault,
			createTab,
			reopenClosedTab,
			closeTab,
			selectTab,
			navigate,
			back,
			forward,
			reload,
			zoomIn,
			zoomOut,
			zoomReset,
			stop,
			setContentBounds,
			toggleCalculator,
			pageContext,
			updateSettings,
			clearHistory,
			clearBrowsingData,
			revealDownload,
			openDownload,
			cancelDownload,
			toggleBookmark,
			removeBookmark,
			pinTab,
			muteTab,
			duplicateTab,
			closeOtherTabs,
			moveTab,
			organizeTabs,
			previewOrganizeTabs,
			applyTabOrganization,
			detachTab,
			findInPage,
			stopFindInPage,
			printTab,
			openDevTools,
			saveScreenshot,
			setSitePermission,
			sleepTab,
			sleepInactiveTabs,
		}),
		[
			state,
			error,
			findMatch,
			openFileTabs,
			filePreview,
			openFileDefault,
			createTab,
			reopenClosedTab,
			closeTab,
			selectTab,
			navigate,
			back,
			forward,
			reload,
			zoomIn,
			zoomOut,
			zoomReset,
			stop,
			setContentBounds,
			toggleCalculator,
			pageContext,
			updateSettings,
			clearHistory,
			clearBrowsingData,
			revealDownload,
			openDownload,
			cancelDownload,
			toggleBookmark,
			removeBookmark,
			pinTab,
			muteTab,
			duplicateTab,
			closeOtherTabs,
			moveTab,
			organizeTabs,
			previewOrganizeTabs,
			applyTabOrganization,
			detachTab,
			findInPage,
			stopFindInPage,
			printTab,
			openDevTools,
			saveScreenshot,
			setSitePermission,
			sleepTab,
			sleepInactiveTabs,
		],
	);
}
