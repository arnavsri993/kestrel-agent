import SwiftUI

public struct TabGridView: View {
    @ObservedObject public var tabManager: TabManager
    @Binding public var isPresented: Bool
    @State private var searchText = ""

    private let columns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14)
    ]

    public init(tabManager: TabManager, isPresented: Binding<Bool>) {
        self.tabManager = tabManager
        self._isPresented = isPresented
    }

    private var filteredTabs: [Tab] {
        if searchText.isEmpty {
            return tabManager.currentTabs
        }
        return tabManager.currentTabs.filter {
            $0.title.localizedCaseInsensitiveContains(searchText) ||
            ($0.url?.absoluteString.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                KestrelTheme.background.ignoresSafeArea()

                VStack(spacing: 0) {
                    // Mode Selector Pill (Normal vs Private)
                    HStack(spacing: 12) {
                        Button(action: {
                            tabManager.switchToPrivateMode(false)
                        }) {
                            HStack(spacing: 6) {
                                Image(systemName: "square.on.square")
                                Text("Standard (\(tabManager.tabs.count))")
                            }
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(!tabManager.isPrivateModeActive ? KestrelTheme.background : KestrelTheme.textMuted)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(!tabManager.isPrivateModeActive ? KestrelTheme.accent : Color.clear)
                            .cornerRadius(20)
                        }

                        Button(action: {
                            tabManager.switchToPrivateMode(true)
                        }) {
                            HStack(spacing: 6) {
                                Image(systemName: "lock.fill")
                                Text("Private (\(tabManager.privateTabs.count))")
                            }
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(tabManager.isPrivateModeActive ? Color.white : KestrelTheme.textMuted)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(tabManager.isPrivateModeActive ? KestrelTheme.privateAccent : Color.clear)
                            .cornerRadius(20)
                        }
                    }
                    .padding(.top, 12)
                    .padding(.bottom, 8)

                    // Search Tabs Bar
                    HStack {
                        Image(systemName: "magnifyingglass")
                            .foregroundColor(KestrelTheme.textMuted)
                        TextField("Search open tabs...", text: $searchText)
                            .foregroundColor(KestrelTheme.textPrimary)
                        if !searchText.isEmpty {
                            Button(action: { searchText = "" }) {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundColor(KestrelTheme.textMuted)
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(KestrelTheme.panelBackground)
                    .cornerRadius(10)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)

                    // Tab Grid ScrollView
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 14) {
                            ForEach(filteredTabs) { tab in
                                TabCard(
                                    tab: tab,
                                    isActive: tab.id == tabManager.activeTabId,
                                    isPrivate: tabManager.isPrivateModeActive,
                                    onSelect: {
                                        tabManager.selectTab(id: tab.id)
                                        isPresented = false
                                    },
                                    onClose: {
                                        tabManager.closeTab(id: tab.id)
                                    }
                                )
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 80)
                    }
                }
            }
            .navigationTitle(tabManager.isPrivateModeActive ? "Private Tabs" : "Tabs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(role: .destructive, action: {
                        tabManager.closeAllTabs()
                    }) {
                        Text("Close All")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(KestrelTheme.danger)
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: {
                        isPresented = false
                    }) {
                        Text("Done")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(tabManager.isPrivateModeActive ? KestrelTheme.privateAccent : KestrelTheme.accent)
                    }
                }

                ToolbarItem(placement: .bottomBar) {
                    HStack {
                        Spacer()
                        Button(action: {
                            tabManager.createTab()
                            isPresented = false
                        }) {
                            HStack(spacing: 8) {
                                Image(systemName: "plus")
                                Text("New Tab")
                            }
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(KestrelTheme.background)
                            .padding(.horizontal, 24)
                            .padding(.vertical, 10)
                            .background(tabManager.isPrivateModeActive ? KestrelTheme.privateAccent : KestrelTheme.accent)
                            .cornerRadius(24)
                        }
                        Spacer()
                    }
                }
            }
        }
    }
}

public struct TabCard: View {
    public let tab: Tab
    public let isActive: Bool
    public let isPrivate: Bool
    public let onSelect: () -> Void
    public let onClose: () -> Void

    public var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: 0) {
                // Card Header (Favicon + Title + Close Button)
                HStack(spacing: 6) {
                    Image(systemName: isPrivate ? "lock.fill" : "globe")
                        .font(.system(size: 11))
                        .foregroundColor(isPrivate ? KestrelTheme.privateAccent : KestrelTheme.accent)

                    Text(tab.title.isEmpty ? (tab.url?.host ?? "New Tab") : tab.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(KestrelTheme.textPrimary)
                        .lineLimit(1)

                    Spacer()

                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(KestrelTheme.textMuted)
                            .padding(6)
                            .background(Color.black.opacity(0.4))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.borderless)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(KestrelTheme.secondaryPanel)

                // Thumbnail Snapshot Preview
                ZStack {
                    Color.black.opacity(0.5)

                    if let snapshot = tab.snapshot {
                        Image(uiImage: snapshot)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(maxWidth: .infinity, maxHeight: 140)
                            .clipped()
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: isPrivate ? "lock.shield.fill" : "safari.fill")
                                .font(.system(size: 32))
                                .foregroundColor(KestrelTheme.textMuted.opacity(0.5))
                            Text(tab.url?.host ?? "kestrel.local")
                                .font(.system(size: 11))
                                .foregroundColor(KestrelTheme.textMuted)
                        }
                        .frame(height: 140)
                    }
                }
                .frame(height: 140)
            }
            .background(KestrelTheme.panelBackground)
            .cornerRadius(14)
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .stroke(
                        isActive
                            ? (isPrivate ? KestrelTheme.privateAccent : KestrelTheme.accent)
                            : KestrelTheme.border,
                        lineWidth: isActive ? 2 : 1
                    )
            )
            .shadow(color: Color.black.opacity(0.3), radius: 6, x: 0, y: 3)
        }
        .buttonStyle(.plain)
    }
}
