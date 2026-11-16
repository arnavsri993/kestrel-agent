import { useCallback } from "react";
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
	const companionOpen = useNativeCompanionOpen();
	const openPage = useCallback((page: string) => {
		const extensionId = (globalThis as typeof globalThis & {
			chrome?: { runtime?: { id?: string } };
		}).chrome?.runtime?.id;
		if (!extensionId) return;
		void browser.createTab(`chrome-extension://${extensionId}/index.html?app=${encodeURIComponent(page)}`);
	}, [browser.createTab]);
	const toggleAgent = useCallback(() => {
		void (companionOpen ? closeNativeAgentPanel() : openNativeAgentPanel());
	}, [companionOpen]);
	const ignoreFile = useCallback((_file: UserBrowserFile) => undefined, []);

	return (
		<main className="ai-browser-app kestrel-chromium-frame-app">
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
