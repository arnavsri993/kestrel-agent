import SwiftUI

public struct PairingSheetView: View {
    @ObservedObject public var gatewayClient: AgentGatewayClient
    @Binding public var isPresented: Bool

    @State private var gatewayURL: String = ""
    @State private var pairingId: String = ""
    @State private var pairingCode: String = ""
    @State private var isPairing: Bool = false
    @State private var errorMessage: String?

    public init(gatewayClient: AgentGatewayClient, isPresented: Binding<Bool>) {
        self.gatewayClient = gatewayClient
        self._isPresented = isPresented
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                KestrelTheme.background.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // Info Header
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Pair with Kestrel Desktop")
                                .font(.system(size: 20, weight: .bold))
                                .foregroundColor(KestrelTheme.textPrimary)
                            Text("Enter the one-time pairing code displayed on your desktop Kestrel agent.")
                                .font(.system(size: 14))
                                .foregroundColor(KestrelTheme.textMuted)
                        }

                        // Gateway URL Field
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Gateway Endpoint")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(KestrelTheme.textMuted)

                            TextField("http://127.0.0.1:4040", text: $gatewayURL)
                                .font(.system(size: 15, design: .monospaced))
                                .foregroundColor(KestrelTheme.textPrimary)
                                .padding(12)
                                .background(KestrelTheme.panelBackground)
                                .cornerRadius(10)
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(KestrelTheme.border, lineWidth: 1))
                        }

                        // Pairing ID
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Pairing ID")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(KestrelTheme.textMuted)

                            TextField("e.g. pair-91a2...", text: $pairingId)
                                .font(.system(size: 15, design: .monospaced))
                                .foregroundColor(KestrelTheme.textPrimary)
                                .autocapitalization(.none)
                                .disableAutocorrection(true)
                                .padding(12)
                                .background(KestrelTheme.panelBackground)
                                .cornerRadius(10)
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(KestrelTheme.border, lineWidth: 1))
                        }

                        // One-time Code
                        VStack(alignment: .leading, spacing: 6) {
                            Text("One-Time Code")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(KestrelTheme.textMuted)

                            TextField("6-digit code", text: $pairingCode)
                                .font(.system(size: 18, weight: .bold, design: .monospaced))
                                .foregroundColor(KestrelTheme.accent)
                                .keyboardType(.numberPad)
                                .padding(12)
                                .background(KestrelTheme.panelBackground)
                                .cornerRadius(10)
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(KestrelTheme.border, lineWidth: 1))
                        }

                        if let error = errorMessage {
                            Text(error)
                                .font(.system(size: 13))
                                .foregroundColor(KestrelTheme.danger)
                        }

                        // Node Identity Glance
                        HStack {
                            Text("Node Identity:")
                                .font(.system(size: 12))
                                .foregroundColor(KestrelTheme.textMuted)
                            Text(gatewayClient.nodeId)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundColor(KestrelTheme.accent)
                        }
                        .padding(.top, 4)

                        // Pair Button
                        Button(action: {
                            performPairing()
                        }) {
                            HStack(spacing: 8) {
                                if isPairing {
                                    ProgressView().tint(KestrelTheme.background)
                                }
                                Text(isPairing ? "Pairing..." : "Complete Pairing")
                            }
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(KestrelTheme.background)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(KestrelTheme.accent)
                            .cornerRadius(12)
                        }
                        .disabled(isPairing || pairingId.isEmpty || pairingCode.isEmpty)

                        if gatewayClient.isPaired {
                            Button(role: .destructive, action: {
                                gatewayClient.disconnect()
                                isPresented = false
                            }) {
                                Text("Forget Paired Device")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundColor(KestrelTheme.danger)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                            }
                        }
                    }
                    .padding(20)
                }
            }
            .navigationTitle("Device Pairing")
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
                self.gatewayURL = gatewayClient.gatewayURL
            }
        }
    }

    private func performPairing() {
        errorMessage = nil
        isPairing = true
        gatewayClient.setGatewayURL(gatewayURL)

        Task {
            do {
                try await gatewayClient.pair(pairingId: pairingId, code: pairingCode)
                isPairing = false
                isPresented = false
            } catch {
                isPairing = false
                errorMessage = error.localizedDescription
                KestrelTheme.triggerNotificationHaptic(.error)
            }
        }
    }
}
