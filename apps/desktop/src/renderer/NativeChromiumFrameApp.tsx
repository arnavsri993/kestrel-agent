import { useCallback, useEffect, useState } from "react";
import type { MemoryRecallStatus, UserBrowserFile } from "@kestrel/shared-types";
import { BrowserWorkspace } from "./components/browser/BrowserWorkspace";
import { useUserBrowser } from "./browser/useUserBrowser";
import {
	closeNativeAgentPanel,
	openNativeAgentPanel,
	useNativeCompanionOpen,
} from "./native-extension-transport";

const EMPTY_MEMORY_RECALL: MemoryRecallStatus = {
	chatInjection: "off",
	activeMemories: 0,
	confirmedPreferences: 0,
	explicitCapture: true,
	personalityScope: "shared",
	personalityName: "Kestrel",
	useSharedContext: true,
	offReason: "Memory status is unavailable in the browser frame.",
};

/** First-party Kestrel browser controls hosted in Chromium's native frame. */
export function NativeChromiumFrameApp() {
	const browser = useUserBrowser();
	useEffect(() => {
		// Chromium keeps its own controls until this first-party frame has both
		// rendered the controls and completed a live browser bridge request.
		// A short lease lets Chromium recover if this renderer hangs or exits.
		let active = true;
		let pending = false;
		const clear = () => { delete document.documentElement.dataset.kestrelFrameReady; };
		const probe = async () => {
			if (!active || pending) return;
			pending = true;
			try {
				const result = await window.kestrel.request({ type: "browser-get-state" });
				if (!active) return;
				if (!result.ok || !("browserState" in result) ||
					!document.querySelector(".browser-workspace-native-frame-shell .browser-tab-row") ||
					!document.querySelector(".browser-workspace-native-frame-shell .browser-toolbar")) {
					clear(); return;
				}
				document.documentElement.dataset.kestrelFrameReady = String(Date.now());
			} catch { if (active) clear(); }
			finally { pending = false; }
		};
		clear();
		const timer = window.setInterval(() => void probe(), 4_000);
		void probe();
		const stop = () => { active = false; clear(); window.clearInterval(timer); };
		window.addEventListener("pagehide", stop);
		return () => { stop(); window.removeEventListener("pagehide", stop); };
	}, []);
	const companionOpen = useNativeCompanionOpen();
	const [actionError, setActionError] = useState("");
	const openPage = useCallback((page: string) => {
		const pages = ["settings", "projects", "history", "downloads", "bookmarks"];
		if (!pages.includes(page)) {
			setActionError("That Kestrel page is not available.");
			return;
		}
		setActionError("");
		void browser.createTab(`kestrel://${page}`).catch(() => {
			setActionError(`Could not open Kestrel ${page}. Try again.`);
		});
	}, [browser.createTab]);
	const toggleAgent = useCallback(() => {
		void (companionOpen ? closeNativeAgentPanel() : openNativeAgentPanel());
	}, [companionOpen]);
	const ignoreFile = useCallback((_file: UserBrowserFile) => undefined, []);

	return (
		<main className="ai-browser-app kestrel-chromium-frame-app">
			{actionError && (
				<p className="native-frame-action-error" role="alert">
					{actionError}
				</p>
			)}
			<BrowserWorkspace
				browser={browser}
				agentName="Kestrel"
				agentOpen={companionOpen}
				onToggleAgent={toggleAgent}
				onNewAgent={() => void openNativeAgentPanel()}
				onOpenTaskSettings={() => openPage("settings")}
				onOpenSettings={() => openPage("settings")}
				onOpenWorkspaces={() => openPage("projects")}
				onOpenHistory={() => openPage("history")}
				onOpenDownloads={() => openPage("downloads")}
				onOpenBookmarks={() => openPage("bookmarks")}
				onOpenMenu={() => openPage("settings")}
				onAskFile={ignoreFile}
				memoryRecall={EMPTY_MEMORY_RECALL}
				onProjectsChange={() => undefined}
				onSubmitNewTabDraft={() => false}
			/>
		</main>
	);
}
