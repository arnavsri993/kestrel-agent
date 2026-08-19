import SwiftUI

public struct OmniboxView: View {
    @ObservedObject public var tabManager: TabManager
    @Binding public var isEditing: Bool
    @Binding public var isPageAssistantOpen: Bool
    @State private var inputText: String = ""
    @State private var selectedSearchEngine: SearchEngine = .duckDuckGo
    @FocusState private var isFieldFocused: Bool

    public var onNavigate: ((URL) -> Void)?
    public var onReload: (() -> Void)?

    public init(
        tabManager: TabManager,
        isEditing: Binding<Bool>,
        isPageAssistantOpen: Binding<Bool>,
        onNavigate: ((URL) -> Void)? = nil,
        onReload: (() -> Void)? = nil
    ) {
        self.tabManager = tabManager
        self._isEditing = isEditing
        self._isPageAssistantOpen = isPageAssistantOpen
        self.onNavigate = onNavigate
        self.onReload = onReload
    }

    private var activeTab: Tab? {
        tabManager.activeTab
    }

    private var displayHost: String {
        if let host = activeTab?.url?.host {
            return host.replacingOccurrences(of: "www.", with: "")
        }
        return "Search or enter address"
    }

    private var isSecure: Bool {
        activeTab?.url?.scheme == "https"
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                // Main Omnibox Capsule
                HStack(spacing: 8) {
                    if !isEditing {
                        // SSL Lock / Security Status
                        Image(systemName: isSecure ? "lock.fill" : "globe")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(isSecure ? KestrelTheme.accent : KestrelTheme.textMuted)

                        // Reader Mode Toggle Button (if available)
                        if activeTab?.readerAvailable == true {
                            Button(action: {
                                if let id = activeTab?.id {
                                    tabManager.toggleReaderMode(for: id)
                                }
                            }) {
                                Image(systemName: activeTab?.isReaderModeActive == true ? "doc.plaintext.fill" : "doc.plaintext")
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundColor(activeTab?.isReaderModeActive == true ? KestrelTheme.accent : KestrelTheme.textMuted)
                            }
                        }

                        // Domain Display (Tapping switches to edit mode)
                        Text(displayHost)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(activeTab?.url == nil ? KestrelTheme.textMuted : KestrelTheme.textPrimary)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                startEditing()
                            }

                        // AI In-Browser Page Assistant Action Pill
                        Button(action: {
                            isPageAssistantOpen.toggle()
                            KestrelTheme.triggerHaptic(.medium)
                        }) {
                            HStack(spacing: 4) {
                                Image(systemName: "sparkles")
                                    .font(.system(size: 12, weight: .bold))
                                Text("AI")
                                    .font(.system(size: 11, weight: .heavy))
                            }
                            .foregroundColor(KestrelTheme.background)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(KestrelTheme.accent)
                            .cornerRadius(12)
                        }

                        // Reload Button
                        Button(action: {
                            onReload?()
                        }) {
                            Image(systemName: activeTab?.isLoading == true ? "xmark" : "arrow.clockwise")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(KestrelTheme.textMuted)
                        }
                    } else {
                        // In Editing Mode: Search Engine icon + TextField + Clear
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 13))
                            .foregroundColor(KestrelTheme.accent)

                        TextField("Search or enter address", text: $inputText)
                            .font(.system(size: 15))
                            .foregroundColor(KestrelTheme.textPrimary)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .keyboardType(.webSearch)
                            .focused($isFieldFocused)
                            .submitLabel(.go)
                            .onSubmit {
                                submitSearch()
                            }

                        if !inputText.isEmpty {
                            Button(action: { inputText = "" }) {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 14))
                                    .foregroundColor(KestrelTheme.textMuted)
                            }
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(KestrelTheme.panelBackground)
                .cornerRadius(16)
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(isEditing ? KestrelTheme.accent.opacity(0.8) : KestrelTheme.border, lineWidth: 1)
                )

                // Cancel Button when editing
                if isEditing {
                    Button(action: {
                        stopEditing()
                    }) {
                        Text("Cancel")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(KestrelTheme.accent)
                    }
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            // Page Load Progress Bar
            if activeTab?.isLoading == true, let progress = activeTab?.estimatedProgress, progress < 1.0 {
                GeometryReader { geo in
                    Rectangle()
                        .fill(KestrelTheme.accent)
                        .frame(width: geo.size.width * CGFloat(progress), height: 2.5)
                        .animation(.linear(duration: 0.15), value: progress)
                }
                .frame(height: 2.5)
            }
        }
    }

    private func startEditing() {
        inputText = activeTab?.url?.absoluteString ?? ""
        isEditing = true
        isFieldFocused = true
        KestrelTheme.triggerHaptic(.light)
    }

    private func stopEditing() {
        isEditing = false
        isFieldFocused = false
    }

    private func submitSearch() {
        guard !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            stopEditing()
            return
        }

        let targetURL = selectedSearchEngine.buildSearchURL(query: inputText)
        onNavigate?(targetURL)
        stopEditing()
        KestrelTheme.triggerHaptic(.medium)
    }
}
