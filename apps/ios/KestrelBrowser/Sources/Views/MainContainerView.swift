import SwiftUI

public struct MainContainerView: View {
    @StateObject private var appState = AppState.shared
    @State private var webViewCurrentURL: URL?
    @State private var webViewTitle: String = ""
    @State private var webViewIsLoading: Bool = false
    @State private var webViewProgress: Double = 0.0
    @State private var webViewCanGoBack: Bool = false
    @State private var webViewCanGoForward: Bool = false
    @State private var webViewReaderAvailable: Bool = false
    @State private var webViewSnapshot: UIImage?

    public init() {}

    private var activeTab: Tab? {
        appState.tabManager.activeTab
    }

    public var body: some View {
        ZStack {
            KestrelTheme.background.ignoresSafeArea()

            VStack(spacing: 0) {
                // Top Omnibox Bar
                OmniboxView(
                    tabManager: appState.tabManager,
                    isEditing: $appState.isOmniboxEditing,
                    isPageAssistantOpen: $appState.isPageAssistantPresented,
                    onNavigate: { url in
                        appState.tabManager.updateActiveTabURL(url)
                    },
                    onReload: {
                        // Reload current tab
                        if let current = activeTab?.url {
                            appState.tabManager.updateActiveTabURL(current)
                        }
                    }
                )

                // Main Web View / Reader View / Home View
                ZStack {
                    if let tab = activeTab {
                        if tab.isReaderModeActive, let readerContent = tab.readerContent {
                            ReaderModeView(
                                content: readerContent,
                                onExit: {
                                    appState.tabManager.toggleReaderMode(for: tab.id)
                                }
                            )
                        } else if tab.url == nil || tab.url?.absoluteString == "about:blank" || tab.url?.absoluteString.contains("kestrel.agent/home") == true {
                            NewTabHomeView(
                                isPrivate: appState.tabManager.isPrivateModeActive,
                                onOpenURL: { url in
                                    appState.tabManager.updateActiveTabURL(url)
                                }
                            )
                        } else {
                            #if canImport(UIKit)
                            KestrelWebView(
                                tabId: tab.id,
                                initialURL: tab.url,
                                isPrivate: tab.isPrivate,
                                currentURL: $webViewCurrentURL,
                                title: $webViewTitle,
                                isLoading: $webViewIsLoading,
                                estimatedProgress: $webViewProgress,
                                canGoBack: $webViewCanGoBack,
                                canGoForward: $webViewCanGoForward,
                                readerAvailable: $webViewReaderAvailable,
                                snapshot: $webViewSnapshot,
                                onReaderContentExtracted: { content in
                                    if let idx = appState.tabManager.currentTabs.firstIndex(where: { $0.id == tab.id }) {
                                        if appState.tabManager.isPrivateModeActive {
                                            appState.tabManager.privateTabs[idx].readerContent = content
                                        } else {
                                            appState.tabManager.tabs[idx].readerContent = content
                                        }
                                    }
                                },
                                onNewTabRequested: { url in
                                    appState.tabManager.createTab(url: url)
                                },
                                onDownloadRequested: { url, filename in
                                    appState.downloadManager.startDownload(url: url, filename: filename)
                                    appState.isDownloadsPresented = true
                                }
                            )
                            .onChange(of: webViewCurrentURL) { newURL in
                                if let newURL = newURL {
                                    appState.tabManager.updateActiveTabURL(newURL, title: webViewTitle)
                                }
                            }
                            #endif
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                // Bottom Browser Navigation Toolbar
                bottomToolbar
            }
        }
        .sheet(isPresented: $appState.isTabGridPresented) {
            TabGridView(tabManager: appState.tabManager, isPresented: $appState.isTabGridPresented)
        }
        .sheet(isPresented: $appState.isBookmarksPresented) {
            BookmarksAndHistoryView(isPresented: $appState.isBookmarksPresented) { url in
                appState.tabManager.updateActiveTabURL(url)
            }
        }
        .sheet(isPresented: $appState.isAgentCompanionPresented) {
            AgentCompanionView(isPresented: $appState.isAgentCompanionPresented)
        }
        .sheet(isPresented: $appState.isPageAssistantPresented) {
            PageAssistantDrawer(
                activeTab: activeTab,
                gatewayClient: appState.gatewayClient,
                isPresented: $appState.isPageAssistantPresented
            )
            .presentationDetents([.fraction(0.6), .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $appState.isDownloadsPresented) {
            DownloadsView(isPresented: $appState.isDownloadsPresented)
        }
    }

    // Bottom Navigation Bar
    private var bottomToolbar: some View {
        HStack {
            // Back Button
            Button(action: {
                // Trigger back
                KestrelTheme.triggerHaptic(.light)
            }) {
                Image(systemName: "chevron.backward")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(webViewCanGoBack ? KestrelTheme.textPrimary : KestrelTheme.textMuted.opacity(0.4))
            }
            .disabled(!webViewCanGoBack)
            .frame(maxWidth: .infinity)

            // Forward Button
            Button(action: {
                // Trigger forward
                KestrelTheme.triggerHaptic(.light)
            }) {
                Image(systemName: "chevron.forward")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(webViewCanGoForward ? KestrelTheme.textPrimary : KestrelTheme.textMuted.opacity(0.4))
            }
            .disabled(!webViewCanGoForward)
            .frame(maxWidth: .infinity)

            // Agent Companion Hub Center Button (with Pending Approval Badge)
            Button(action: {
                appState.isAgentCompanionPresented = true
                KestrelTheme.triggerHaptic(.medium)
            }) {
                ZStack {
                    Circle()
                        .fill(KestrelTheme.panelBackground)
                        .frame(width: 44, height: 44)
                        .overlay(
                            Circle().stroke(
                                !appState.gatewayClient.pendingApprovals.isEmpty ? KestrelTheme.warning : (appState.gatewayClient.isConnected ? KestrelTheme.accent : KestrelTheme.border),
                                lineWidth: 1.5
                            )
                        )

                    Image(systemName: "cpu.fill")
                        .font(.system(size: 20))
                        .foregroundColor(!appState.gatewayClient.pendingApprovals.isEmpty ? KestrelTheme.warning : (appState.gatewayClient.isConnected ? KestrelTheme.accent : KestrelTheme.textMuted))

                    // Approval notification badge
                    if !appState.gatewayClient.pendingApprovals.isEmpty {
                        Text("\(appState.gatewayClient.pendingApprovals.count)")
                            .font(.system(size: 10, weight: .heavy))
                            .foregroundColor(KestrelTheme.background)
                            .frame(width: 16, height: 16)
                            .background(KestrelTheme.warning)
                            .clipShape(Circle())
                            .offset(x: 14, y: -14)
                    }
                }
            }
            .frame(maxWidth: .infinity)

            // Bookmarks & History Library Button
            Button(action: {
                appState.isBookmarksPresented = true
                KestrelTheme.triggerHaptic(.light)
            }) {
                Image(systemName: "book")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(KestrelTheme.textPrimary)
            }
            .frame(maxWidth: .infinity)

            // Tab Switcher Button (with Open Tabs Count Badge)
            Button(action: {
                appState.isTabGridPresented = true
                KestrelTheme.triggerHaptic(.light)
            }) {
                ZStack {
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(appState.tabManager.isPrivateModeActive ? KestrelTheme.privateAccent : KestrelTheme.accent, lineWidth: 1.5)
                        .frame(width: 22, height: 22)

                    Text("\(appState.tabManager.currentTabs.count)")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(appState.tabManager.isPrivateModeActive ? KestrelTheme.privateAccent : KestrelTheme.accent)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .background(KestrelTheme.panelBackground)
        .overlay(
            Rectangle()
                .fill(KestrelTheme.border)
                .frame(height: 0.5),
            alignment: .top
        )
    }
}

// New Tab Speed Dial Home View
public struct NewTabHomeView: View {
    public let isPrivate: Bool
    public let onOpenURL: (URL) -> Void

    private let quickFavorites = [
        ("Google Antigravity", "https://antigravity.google", "sparkles"),
        ("Kestrel Docs", "https://kestrel.agent/docs", "doc.text.fill"),
        ("GitHub", "https://github.com", "chevron.left.forwardslash.chevron.right"),
        ("Hacker News", "https://news.ycombinator.com", "flame.fill"),
        ("Anthropic", "https://anthropic.com", "brain.head.profile"),
        ("OpenAI", "https://openai.com", "cpu"),
        ("Wikipedia", "https://wikipedia.org", "books.vertical.fill"),
        ("Weather", "https://weather.com", "cloud.sun.fill")
    ]

    public var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header Logo
                VStack(spacing: 8) {
                    Image(systemName: isPrivate ? "lock.shield.fill" : "globe.americas.fill")
                        .font(.system(size: 48))
                        .foregroundColor(isPrivate ? KestrelTheme.privateAccent : KestrelTheme.accent)
                        .padding(.top, 40)

                    Text(isPrivate ? "Private Browsing" : "Kestrel Browser")
                        .font(.system(size: 24, weight: .bold))
                        .foregroundColor(KestrelTheme.textPrimary)

                    Text(isPrivate ? "Browsing history, cache, and cookies are isolated and erased on close." : "Your AI-native companion browser.")
                        .font(.system(size: 13))
                        .foregroundColor(KestrelTheme.textMuted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                }

                // Speed Dial Favorites Grid
                VStack(alignment: .leading, spacing: 12) {
                    Text("Favorites")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(KestrelTheme.textMuted)
                        .padding(.horizontal, 4)

                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 4), spacing: 16) {
                        ForEach(quickFavorites, id: \.0) { item in
                            Button(action: {
                                if let url = URL(string: item.1) {
                                    onOpenURL(url)
                                }
                            }) {
                                VStack(spacing: 6) {
                                    ZStack {
                                        RoundedRectangle(cornerRadius: 14)
                                            .fill(KestrelTheme.panelBackground)
                                            .frame(width: 56, height: 56)
                                            .overlay(RoundedRectangle(cornerRadius: 14).stroke(KestrelTheme.border, lineWidth: 1))

                                        Image(systemName: item.2)
                                            .font(.system(size: 22))
                                            .foregroundColor(isPrivate ? KestrelTheme.privateAccent : KestrelTheme.accent)
                                    }

                                    Text(item.0)
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundColor(KestrelTheme.textPrimary)
                                        .lineLimit(1)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 20)

                // Privacy Shield Badge
                HStack(spacing: 8) {
                    Image(systemName: "shield.lefthalf.filled")
                        .foregroundColor(KestrelTheme.accent)
                    Text("Content Blocker & Tracking Protection Active")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(KestrelTheme.textMuted)
                }
                .padding(.vertical, 8)
                .padding(.horizontal, 14)
                .background(KestrelTheme.panelBackground)
                .cornerRadius(20)
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(KestrelTheme.border, lineWidth: 1))
                .padding(.top, 10)
            }
            .padding(.bottom, 40)
        }
    }
}
