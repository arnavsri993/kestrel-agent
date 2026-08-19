import SwiftUI

public struct AgentCompanionView: View {
    @ObservedObject public var gatewayClient = AgentGatewayClient.shared
    @Binding public var isPresented: Bool

    @State private var showPairingSheet: Bool = false
    @State private var showNewTaskSheet: Bool = false
    @State private var showVoiceSheet: Bool = false
    @State private var isRefreshing: Bool = false

    public init(isPresented: Binding<Bool>) {
        self._isPresented = isPresented
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                KestrelTheme.background.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        // Connection Status Card
                        connectionHeaderCard

                        if !gatewayClient.isPaired {
                            notPairedPromptCard
                        } else {
                            // High Priority Safety Gate Approvals
                            if !gatewayClient.pendingApprovals.isEmpty {
                                pendingApprovalsSection
                            }

                            // Active Tasks & Queue
                            tasksQueueSection

                            // Live Event Stream
                            liveEventsSection
                        }
                    }
                    .padding(16)
                    .padding(.bottom, 40)
                }
            }
            .navigationTitle("Agent Companion")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: {
                        showVoiceSheet = true
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "waveform.circle.fill")
                            Text("Talk")
                        }
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(KestrelTheme.accent)
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        isPresented = false
                    }
                    .foregroundColor(KestrelTheme.accent)
                    .fontWeight(.bold)
                }
            }
            .sheet(isPresented: $showPairingSheet) {
                PairingSheetView(gatewayClient: gatewayClient, isPresented: $showPairingSheet)
            }
            .sheet(isPresented: $showNewTaskSheet) {
                NewTaskSheet(gatewayClient: gatewayClient, isPresented: $showNewTaskSheet)
            }
            .sheet(isPresented: $showVoiceSheet) {
                VoiceTalkSheetView(gatewayClient: gatewayClient, isPresented: $showVoiceSheet)
            }
        }
    }

    // Header Card
    private var connectionHeaderCard: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(gatewayClient.isPaired ? (gatewayClient.isConnected ? KestrelTheme.accent : KestrelTheme.warning) : KestrelTheme.textMuted)
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 2) {
                Text(gatewayClient.isPaired ? "Kestrel Gateway" : "Device Unpaired")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(KestrelTheme.textPrimary)
                Text(gatewayClient.isPaired ? (gatewayClient.isConnected ? "Live Connected" : "Connecting...") : "Connect to desktop agent")
                    .font(.system(size: 12))
                    .foregroundColor(KestrelTheme.textMuted)
            }

            Spacer()

            if gatewayClient.isPaired {
                Button(action: {
                    Task {
                        isRefreshing = true
                        await gatewayClient.refreshAll()
                        isRefreshing = false
                        KestrelTheme.triggerHaptic(.light)
                    }
                }) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(KestrelTheme.textMuted)
                        .padding(8)
                        .background(KestrelTheme.secondaryPanel)
                        .clipShape(Circle())
                }
            }

            Button(action: {
                showPairingSheet = true
            }) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(KestrelTheme.textMuted)
                    .padding(8)
                    .background(KestrelTheme.secondaryPanel)
                    .clipShape(Circle())
            }
        }
        .padding(14)
        .background(KestrelTheme.panelBackground)
        .cornerRadius(14)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(KestrelTheme.border, lineWidth: 1))
    }

    // Not Paired Promo Card
    private var notPairedPromptCard: some View {
        VStack(spacing: 14) {
            Image(systemName: "link.badge.plus")
                .font(.system(size: 40))
                .foregroundColor(KestrelTheme.accent)
                .padding(.top, 10)

            VStack(spacing: 4) {
                Text("Pair with Desktop Agent")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundColor(KestrelTheme.textPrimary)
                Text("Supervise live background tasks, approve consequential actions on the go, and talk to your agent.")
                    .font(.system(size: 13))
                    .foregroundColor(KestrelTheme.textMuted)
                    .multilineTextAlignment(.center)
            }

            Button(action: {
                showPairingSheet = true
            }) {
                Text("Pair Device Now")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(KestrelTheme.background)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(KestrelTheme.accent)
                    .cornerRadius(10)
            }
        }
        .padding(20)
        .kestrelCard(cornerRadius: 16)
    }

    // Pending Approvals Section
    private var pendingApprovalsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Pending Approvals")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(KestrelTheme.warning)
                Spacer()
                Text("\(gatewayClient.pendingApprovals.count)")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(KestrelTheme.background)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(KestrelTheme.warning)
                    .clipShape(Capsule())
            }

            ForEach(gatewayClient.pendingApprovals) { approval in
                ApprovalCardView(
                    approval: approval,
                    onApprove: {
                        Task {
                            try? await gatewayClient.resumeApproval(jobId: approval.jobId, approved: true)
                        }
                    },
                    onReject: {
                        Task {
                            try? await gatewayClient.resumeApproval(jobId: approval.jobId, approved: false)
                        }
                    }
                )
            }
        }
    }

    // Tasks Queue Section
    private var tasksQueueSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Tasks & Review Queue")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(KestrelTheme.textPrimary)

                Spacer()

                Button(action: {
                    showNewTaskSheet = true
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: "plus")
                        Text("New Task")
                    }
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(KestrelTheme.accent)
                }
            }

            if gatewayClient.jobs.isEmpty {
                Text("No active or scheduled tasks.")
                    .font(.system(size: 13))
                    .foregroundColor(KestrelTheme.textMuted)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(KestrelTheme.panelBackground)
                    .cornerRadius(12)
            } else {
                ForEach(gatewayClient.jobs) { job in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(job.status.rawValue.replacingOccurrences(of: "_", with: " ").uppercased())
                                .font(.system(size: 10, weight: .heavy))
                                .foregroundColor(job.status == .running ? KestrelTheme.accent : (job.status == .waitingApproval ? KestrelTheme.warning : KestrelTheme.textMuted))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(KestrelTheme.secondaryPanel)
                                .cornerRadius(6)

                            Spacer()

                            Text(job.updatedAt.prefix(19).replacingOccurrences(of: "T", with: " "))
                                .font(.system(size: 11))
                                .foregroundColor(KestrelTheme.textMuted)
                        }

                        Text(job.title)
                            .font(.system(size: 15, weight: .bold))
                            .foregroundColor(KestrelTheme.textPrimary)

                        Text(job.prompt)
                            .font(.system(size: 12))
                            .foregroundColor(KestrelTheme.textMuted)
                            .lineLimit(2)
                    }
                    .padding(14)
                    .kestrelCard(cornerRadius: 12)
                }
            }
        }
    }

    // Live Runtime Events Section
    private var liveEventsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Real-Time Event Stream")
                .font(.system(size: 15, weight: .bold))
                .foregroundColor(KestrelTheme.textPrimary)

            if gatewayClient.recentEvents.isEmpty {
                Text("Awaiting live agent events...")
                    .font(.system(size: 13))
                    .foregroundColor(KestrelTheme.textMuted)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(KestrelTheme.panelBackground)
                    .cornerRadius(12)
            } else {
                VStack(spacing: 8) {
                    ForEach(gatewayClient.recentEvents) { event in
                        HStack(spacing: 10) {
                            Circle()
                                .fill(KestrelTheme.accent)
                                .frame(width: 5, height: 5)
                            Text(event.type)
                                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                                .foregroundColor(KestrelTheme.accent)
                            if let tool = event.payload.toolName {
                                Text("(\(tool))")
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundColor(KestrelTheme.textMuted)
                            }
                            Spacer()
                            Text(event.createdAt.suffix(12))
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(KestrelTheme.textMuted)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(KestrelTheme.secondaryPanel)
                        .cornerRadius(8)
                    }
                }
            }
        }
    }
}

public struct NewTaskSheet: View {
    @ObservedObject public var gatewayClient: AgentGatewayClient
    @Binding public var isPresented: Bool

    @State private var taskTitle: String = ""
    @State private var taskPrompt: String = ""
    @State private var selectedSessionId: String = ""
    @State private var isSubmitting: Bool = false
    @State private var errorMessage: String?

    public var body: some View {
        NavigationStack {
            ZStack {
                KestrelTheme.background.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // Session Selector
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Target Session")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundColor(KestrelTheme.textMuted)

                            Picker("Session", selection: $selectedSessionId) {
                                if gatewayClient.sessions.isEmpty {
                                    Text("Default Session").tag("default")
                                } else {
                                    ForEach(gatewayClient.sessions) { session in
                                        Text(session.title).tag(session.id)
                                    }
                                }
                            }
                            .pickerStyle(.menu)
                            .padding(8)
                            .background(KestrelTheme.panelBackground)
                            .cornerRadius(10)
                        }

                        // Task Title
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Task Title")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundColor(KestrelTheme.textMuted)

                            TextField("e.g. Audit API dependencies", text: $taskTitle)
                                .font(.system(size: 15))
                                .foregroundColor(KestrelTheme.textPrimary)
                                .padding(12)
                                .background(KestrelTheme.panelBackground)
                                .cornerRadius(10)
                        }

                        // Prompt
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Instructions / Prompt")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundColor(KestrelTheme.textMuted)

                            TextEditor(text: $taskPrompt)
                                .font(.system(size: 14))
                                .foregroundColor(KestrelTheme.textPrimary)
                                .frame(height: 140)
                                .padding(8)
                                .background(KestrelTheme.panelBackground)
                                .cornerRadius(10)
                        }

                        if let err = errorMessage {
                            Text(err)
                                .font(.system(size: 13))
                                .foregroundColor(KestrelTheme.danger)
                        }

                        // Submit Button
                        Button(action: {
                            submitTask()
                        }) {
                            HStack(spacing: 8) {
                                if isSubmitting {
                                    ProgressView().tint(KestrelTheme.background)
                                }
                                Text("Queue Task on Desktop")
                            }
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(KestrelTheme.background)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(KestrelTheme.accent)
                            .cornerRadius(12)
                        }
                        .disabled(taskTitle.isEmpty || taskPrompt.isEmpty || isSubmitting)
                    }
                    .padding(20)
                }
            }
            .navigationTitle("Start a Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") {
                        isPresented = false
                    }
                    .foregroundColor(KestrelTheme.accent)
                }
            }
            .onAppear {
                if let first = gatewayClient.sessions.first {
                    selectedSessionId = first.id
                }
            }
        }
    }

    private func submitTask() {
        isSubmitting = true
        errorMessage = nil

        let sessionId = selectedSessionId.isEmpty ? (gatewayClient.sessions.first?.id ?? "default") : selectedSessionId

        Task {
            do {
                try await gatewayClient.queueTask(
                    title: taskTitle,
                    prompt: taskPrompt,
                    sessionId: sessionId
                )
                isSubmitting = false
                isPresented = false
            } catch {
                isSubmitting = false
                errorMessage = error.localizedDescription
            }
        }
    }
}
