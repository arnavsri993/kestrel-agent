import SwiftUI

public enum LibrarySection: String, CaseIterable, Identifiable {
    case bookmarks = "Bookmarks"
    case readingList = "Reading List"
    case history = "History"

    public var id: String { rawValue }

    public var iconName: String {
        switch self {
        case .bookmarks: return "bookmark.fill"
        case .readingList: return "eyeglasses"
        case .history: return "clock.fill"
        }
    }
}

public struct BookmarksAndHistoryView: View {
    @Binding public var isPresented: Bool
    @State private var selectedSection: LibrarySection = .bookmarks
    @State private var searchText: String = ""

    // Sample/persisted collections
    @State private var bookmarks: [BookmarkItem] = [
        BookmarkItem(title: "Google Antigravity", url: URL(string: "https://antigravity.google")!, isFavorite: true),
        BookmarkItem(title: "Hacker News", url: URL(string: "https://news.ycombinator.com")!, isFavorite: true),
        BookmarkItem(title: "GitHub", url: URL(string: "https://github.com")!, isFavorite: true),
        BookmarkItem(title: "Anthropic", url: URL(string: "https://anthropic.com")!, isFavorite: true)
    ]

    @State private var readingList: [BookmarkItem] = [
        BookmarkItem(title: "The Architecture of AI Agents", url: URL(string: "https://kestrel.agent/docs/architecture")!, isReadingList: true),
        BookmarkItem(title: "Local-First LLM Execution on Apple Silicon", url: URL(string: "https://kestrel.agent/docs/local-ai")!, isReadingList: true)
    ]

    @State private var history: [HistoryRecord] = [
        HistoryRecord(title: "Kestrel Documentation", url: URL(string: "https://kestrel.agent/docs")!),
        HistoryRecord(title: "GitHub Models & Agent Protocol", url: URL(string: "https://github.com")!),
        HistoryRecord(title: "Fast Local LLM Inference Benchmarks", url: URL(string: "https://news.ycombinator.com")!)
    ]

    public var onOpenURL: ((URL) -> Void)?

    public init(isPresented: Binding<Bool>, onOpenURL: ((URL) -> Void)? = nil) {
        self._isPresented = isPresented
        self.onOpenURL = onOpenURL
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                KestrelTheme.background.ignoresSafeArea()

                VStack(spacing: 0) {
                    // Section Selector
                    Picker("Section", selection: $selectedSection) {
                        ForEach(LibrarySection.allCases) { section in
                            Label(section.rawValue, systemImage: section.iconName).tag(section)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)

                    // Search Bar
                    HStack {
                        Image(systemName: "magnifyingglass")
                            .foregroundColor(KestrelTheme.textMuted)
                        TextField("Search \(selectedSection.rawValue)...", text: $searchText)
                            .foregroundColor(KestrelTheme.textPrimary)
                    }
                    .padding(10)
                    .background(KestrelTheme.panelBackground)
                    .cornerRadius(10)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)

                    // Content View
                    List {
                        switch selectedSection {
                        case .bookmarks:
                            bookmarksSection
                        case .readingList:
                            readingListSection
                        case .history:
                            historySection
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .navigationTitle(selectedSection.rawValue)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        isPresented = false
                    }
                    .foregroundColor(KestrelTheme.accent)
                    .fontWeight(.bold)
                }
                if selectedSection == .history {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Clear") {
                            history.removeAll()
                            KestrelTheme.triggerNotificationHaptic(.warning)
                        }
                        .foregroundColor(KestrelTheme.danger)
                    }
                }
            }
        }
    }

    private var bookmarksSection: some View {
        ForEach(bookmarks.filter { searchText.isEmpty || $0.title.localizedCaseInsensitiveContains(searchText) }) { item in
            Button(action: {
                onOpenURL?(item.url)
                isPresented = false
            }) {
                HStack(spacing: 12) {
                    Image(systemName: "bookmark.fill")
                        .foregroundColor(KestrelTheme.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(KestrelTheme.textPrimary)
                        Text(item.url.host ?? item.url.absoluteString)
                            .font(.system(size: 12))
                            .foregroundColor(KestrelTheme.textMuted)
                    }
                }
                .padding(.vertical, 4)
            }
            .listRowBackground(KestrelTheme.panelBackground)
        }
        .onDelete { indices in
            bookmarks.remove(atOffsets: indices)
        }
    }

    private var readingListSection: some View {
        ForEach(readingList.filter { searchText.isEmpty || $0.title.localizedCaseInsensitiveContains(searchText) }) { item in
            Button(action: {
                onOpenURL?(item.url)
                isPresented = false
            }) {
                HStack(spacing: 12) {
                    Image(systemName: item.isRead ? "eyeglasses" : "circle.fill")
                        .font(.system(size: item.isRead ? 16 : 8))
                        .foregroundColor(item.isRead ? KestrelTheme.textMuted : KestrelTheme.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(KestrelTheme.textPrimary)
                        Text(item.url.host ?? item.url.absoluteString)
                            .font(.system(size: 12))
                            .foregroundColor(KestrelTheme.textMuted)
                    }
                }
                .padding(.vertical, 4)
            }
            .listRowBackground(KestrelTheme.panelBackground)
        }
        .onDelete { indices in
            readingList.remove(atOffsets: indices)
        }
    }

    private var historySection: some View {
        ForEach(history.filter { searchText.isEmpty || $0.title.localizedCaseInsensitiveContains(searchText) }) { item in
            Button(action: {
                onOpenURL?(item.url)
                isPresented = false
            }) {
                HStack(spacing: 12) {
                    Image(systemName: "clock")
                        .foregroundColor(KestrelTheme.textMuted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(KestrelTheme.textPrimary)
                        Text(item.url.host ?? item.url.absoluteString)
                            .font(.system(size: 12))
                            .foregroundColor(KestrelTheme.textMuted)
                    }
                }
                .padding(.vertical, 4)
            }
            .listRowBackground(KestrelTheme.panelBackground)
        }
        .onDelete { indices in
            history.remove(atOffsets: indices)
        }
    }
}
