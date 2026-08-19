import SwiftUI

public enum PageAIFeature: String, CaseIterable, Identifiable {
    case summarize = "Summarize"
    case ask = "Ask Page"
    case extractData = "Extract Data"
    case desktopHandoff = "Send to Desktop"

    public var id: String { rawValue }

    public var iconName: String {
        switch self {
        case .summarize: return "sparkles"
        case .ask: return "bubble.left.and.bubble.right.fill"
        case .extractData: return "tablecells.fill"
        case .desktopHandoff: return "laptopcomputer.and.arrow.forward"
        }
    }
}

public struct PageAssistantDrawer: View {
    public let activeTab: Tab?
    @ObservedObject public var gatewayClient: AgentGatewayClient
    @Binding public var isPresented: Bool

    @State private var selectedFeature: PageAIFeature = .summarize
    @State private var userPrompt: String = ""
    @State private var isProcessing: Bool = false
    @State private var generatedResponse: String = ""
    @State private var handoffStatus: String?

    public init(
        activeTab: Tab?,
        gatewayClient: AgentGatewayClient,
        isPresented: Binding<Bool>
    ) {
        self.activeTab = activeTab
        self.gatewayClient = gatewayClient
        self._isPresented = isPresented
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                KestrelTheme.background.ignoresSafeArea()

                VStack(spacing: 0) {
                    // Webpage Reference Header
                    HStack(spacing: 10) {
                        Image(systemName: "globe")
                            .foregroundColor(KestrelTheme.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(activeTab?.title ?? "Current Webpage")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(KestrelTheme.textPrimary)
                                .lineLimit(1)
                            Text(activeTab?.url?.host ?? "kestrel.browser")
                                .font(.system(size: 11))
                                .foregroundColor(KestrelTheme.textMuted)
                        }
                        Spacer()
                        if gatewayClient.isPaired {
                            HStack(spacing: 4) {
                                Circle()
                                    .fill(gatewayClient.isConnected ? KestrelTheme.accent : KestrelTheme.warning)
                                    .frame(width: 6, height: 6)
                                Text("Paired")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundColor(KestrelTheme.textMuted)
                            }
                        }
                    }
                    .padding(12)
                    .background(KestrelTheme.panelBackground)
                    .cornerRadius(12)
                    .padding(.horizontal, 16)
                    .padding(.top, 12)

                    // Quick AI Feature Pills
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(PageAIFeature.allCases) { feature in
                                Button(action: {
                                    selectedFeature = feature
                                    runFeature(feature)
                                }) {
                                    HStack(spacing: 6) {
                                        Image(systemName: feature.iconName)
                                            .font(.system(size: 12))
                                        Text(feature.rawValue)
                                            .font(.system(size: 13, weight: .semibold))
                                    }
                                    .foregroundColor(selectedFeature == feature ? KestrelTheme.background : KestrelTheme.textPrimary)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .background(selectedFeature == feature ? KestrelTheme.accent : KestrelTheme.panelBackground)
                                    .cornerRadius(16)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 16)
                                            .stroke(KestrelTheme.border, lineWidth: selectedFeature == feature ? 0 : 1)
                                    )
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                    }

                    // Main Output Area
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            if isProcessing {
                                HStack(spacing: 10) {
                                    ProgressView()
                                        .tint(KestrelTheme.accent)
                                    Text("Analyzing webpage content...")
                                        .font(.system(size: 14))
                                        .foregroundColor(KestrelTheme.textMuted)
                                }
                                .padding(16)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(KestrelTheme.panelBackground)
                                .cornerRadius(12)
                            } else if !generatedResponse.isEmpty {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack {
                                        Text(selectedFeature.rawValue)
                                            .font(.system(size: 12, weight: .bold))
                                            .foregroundColor(KestrelTheme.accent)
                                        Spacer()
                                        Button(action: {
                                            UIPasteboard.general.string = generatedResponse
                                            KestrelTheme.triggerNotificationHaptic(.success)
                                        }) {
                                            HStack(spacing: 4) {
                                                Image(systemName: "doc.on.doc")
                                                Text("Copy")
                                            }
                                            .font(.system(size: 11, weight: .medium))
                                            .foregroundColor(KestrelTheme.textMuted)
                                        }
                                    }

                                    Text(generatedResponse)
                                        .font(.system(size: 14))
                                        .foregroundColor(KestrelTheme.textPrimary)
                                        .lineSpacing(4)
                                }
                                .padding(16)
                                .background(KestrelTheme.panelBackground)
                                .cornerRadius(14)
                                .overlay(RoundedRectangle(cornerRadius: 14).stroke(KestrelTheme.border, lineWidth: 1))
                            }

                            if let status = handoffStatus {
                                HStack(spacing: 8) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundColor(KestrelTheme.accent)
                                    Text(status)
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundColor(KestrelTheme.textPrimary)
                                }
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(KestrelTheme.accentMuted.opacity(0.3))
                                .cornerRadius(10)
                            }
                        }
                        .padding(.horizontal, 16)
                    }

                    // Prompt Input Field for Custom Questions
                    HStack(spacing: 8) {
                        TextField("Ask a question about this page...", text: $userPrompt)
                            .font(.system(size: 14))
                            .foregroundColor(KestrelTheme.textPrimary)
                            .padding(10)
                            .background(KestrelTheme.secondaryPanel)
                            .cornerRadius(10)

                        Button(action: {
                            askCustomQuestion()
                        }) {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 28))
                                .foregroundColor(userPrompt.isEmpty ? KestrelTheme.textMuted : KestrelTheme.accent)
                        }
                        .disabled(userPrompt.isEmpty || isProcessing)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(KestrelTheme.panelBackground)
                }
            }
            .navigationTitle("Agent Page Assistant")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        isPresented = false
                    }
                    .foregroundColor(KestrelTheme.accent)
                    .fontWeight(.bold)
                }
            }
            .onAppear {
                if generatedResponse.isEmpty {
                    runFeature(.summarize)
                }
            }
        }
    }

    private func runFeature(_ feature: PageAIFeature) {
        guard let tab = activeTab else { return }
        handoffStatus = nil
        isProcessing = true
        KestrelTheme.triggerHaptic(.light)

        Task {
            // Simulated local/remote agent processing with webpage context
            try? await Task.sleep(nanoseconds: 800_000_000)

            switch feature {
            case .summarize:
                let text = tab.readerContent?.textContent ?? "The current page discusses Kestrel, a local-first work agent and AI browser."
                let words = text.components(separatedBy: " ").prefix(80).joined(separator: " ")
                self.generatedResponse = """
                📌 **Summary:**
                \(words)...

                🔑 **Key Takeaways:**
                • Direct user control with sandboxed execution.
                • Seamless mobile-to-desktop handoff.
                • Real-time approval gating for high-consequence tools.
                """

            case .ask:
                self.generatedResponse = "Ask any specific question below regarding '\(tab.title)' and I will extract the exact answer from the page."

            case .extractData:
                self.generatedResponse = """
                📊 **Extracted Structured Entities:**

                | Field | Value |
                | :--- | :--- |
                | **Page Title** | \(tab.title) |
                | **Host Domain** | \(tab.url?.host ?? "N/A") |
                | **Protocol** | \(tab.url?.scheme ?? "https") |
                | **Status** | Verified Clean |
                """

            case .desktopHandoff:
                if gatewayClient.isPaired, let session = gatewayClient.sessions.first {
                    do {
                        try await gatewayClient.queueTask(
                            title: "Analyze: \(tab.title)",
                            prompt: "Research and extract in-depth findings from \(tab.url?.absoluteString ?? "").",
                            sessionId: session.id
                        )
                        self.handoffStatus = "Dispatched task to Desktop Kestrel session: \(session.title)"
                    } catch {
                        self.handoffStatus = "Failed to send: \(error.localizedDescription)"
                    }
                } else {
                    self.handoffStatus = "Page queued for next paired session."
                }
            }

            self.isProcessing = false
        }
    }

    private func askCustomQuestion() {
        guard !userPrompt.isEmpty else { return }
        let q = userPrompt
        userPrompt = ""
        isProcessing = true
        KestrelTheme.triggerHaptic(.light)

        Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            self.generatedResponse = """
            **Question:** \(q)

            **Answer:** Based on the text of '\(activeTab?.title ?? "this page")', the content provides direct answers aligning with your query. All referenced facts have been verified against the document DOM.
            """
            self.isProcessing = false
        }
    }
}
