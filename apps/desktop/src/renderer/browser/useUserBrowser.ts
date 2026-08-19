import type {
	RendererResponse,
	UserBrowserPageContext,
	UserBrowserSettings,
	UserBrowserState,
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
	createTab(input?: string, active?: boolean): Promise<void>;
	reopenClosedTab(): Promise<void>;
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
	pageContext(tabId?: string): Promise<UserBrowserPageContext | undefined>;
	updateSettings(settings: UserBrowserSettings): Promise<void>;
	clearHistory(): Promise<void>;
	revealDownload(downloadId: string): Promise<void>;
	sleepTab(tabId: string): Promise<void>;
	sleepInactiveTabs(): Promise<void>;
}

export function useUserBrowser(): UserBrowserController {
	const [state, setState] = useState<UserBrowserState | null>(null);
	const [error, setError] = useState("");
	const stateRef = useRef<UserBrowserState | null>(state);
	stateRef.current = state;

	const requestState = useCallback(
		async (request: Parameters<typeof window.kestrel.request>[0]) => {
			try {
				const response = await window.kestrel.request(request);
				if (!response.ok || !("browserState" in response))
					throw new Error(responseError(response));
				setState(response.browserState);
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
		[],
	);

	useEffect(() => {
		let active = true;
		const unsubscribe = window.kestrel.onBrowserEvent((event) => {
			if (active && event.type === "state") {
				setState(event.state);
				setError("");
			}
		});
		void window.kestrel
			.request({ type: "browser-get-state" })
			.then((response) => {
				if (!active) return;
				if (!response.ok || !("browserState" in response))
					throw new Error(responseError(response));
				setState(response.browserState);
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
	}, []);

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
		() => requestState({ type: "browser-reopen-closed-tab" }),
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
		async (
			bounds: { x: number; y: number; width: number; height: number },
			visible: boolean,
		) => {
			const response = await window.kestrel.request({
				type: "browser-set-content-bounds",
				bounds,
				visible,
			});
			if (!response.ok) throw new Error(responseError(response));
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
		(settings: UserBrowserSettings) =>
			requestState({ type: "browser-update-settings", settings }),
		[requestState],
	);
	const clearHistory = useCallback(
		() => requestState({ type: "browser-clear-history" }),
		[requestState],
	);
	const revealDownload = useCallback(async (downloadId: string) => {
		const response = await window.kestrel.request({
			type: "browser-reveal-download",
			downloadId,
		});
		if (!response.ok) throw new Error(responseError(response));
	}, []);
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
			pageContext,
			updateSettings,
			clearHistory,
			revealDownload,
			sleepTab,
			sleepInactiveTabs,
		}),
		[
			state,
			error,
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
			pageContext,
			updateSettings,
			clearHistory,
			revealDownload,
			sleepTab,
			sleepInactiveTabs,
		],
	);
}
