import SwiftUI

public struct ApprovalCardView: View {
    public let approval: PendingApproval
    public let onApprove: () -> Void
    public let onReject: () -> Void

    @State private var isSubmitting: Bool = false

    public init(
        approval: PendingApproval,
        onApprove: @escaping () -> Void,
        onReject: @escaping () -> Void
    ) {
        self.approval = approval
        self.onApprove = onApprove
        self.onReject = onReject
    }

    private var riskColor: Color {
        switch approval.riskLevel {
        case .low: return KestrelTheme.accent
        case .medium: return KestrelTheme.warning
        case .high, .critical: return KestrelTheme.danger
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            // Header: Warning Icon + Risk Pill + Tool Name
            HStack {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.shield.fill")
                        .foregroundColor(riskColor)
                    Text("Safety Gate Required")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundColor(KestrelTheme.textPrimary)
                }

                Spacer()

                Text(approval.riskLevel.rawValue.uppercased())
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundColor(riskColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(riskColor.opacity(0.15))
                    .cornerRadius(8)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(riskColor.opacity(0.4), lineWidth: 1))
            }

            // Task Context & Tool Name
            VStack(alignment: .leading, spacing: 4) {
                Text(approval.taskTitle)
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(KestrelTheme.textPrimary)

                Text(approval.toolName)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(KestrelTheme.accent)
            }

            // Description
            Text(approval.description)
                .font(.system(size: 13))
                .foregroundColor(KestrelTheme.textMuted)
                .lineLimit(4)

            // Parameter Table
            if !approval.parameters.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(approval.parameters.keys), id: \.self) { key in
                        HStack(alignment: .top) {
                            Text(key)
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                .foregroundColor(KestrelTheme.textMuted)
                                .frame(width: 80, alignment: .leading)
                            Text(approval.parameters[key] ?? "")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundColor(KestrelTheme.textPrimary)
                        }
                    }
                }
                .padding(10)
                .background(KestrelTheme.secondaryPanel)
                .cornerRadius(8)
            }

            // Action Buttons (Approve vs Reject)
            HStack(spacing: 12) {
                Button(action: {
                    isSubmitting = true
                    onReject()
                    KestrelTheme.triggerNotificationHaptic(.warning)
                }) {
                    Text("Reject")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(KestrelTheme.danger)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(KestrelTheme.danger.opacity(0.12))
                        .cornerRadius(10)
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(KestrelTheme.danger.opacity(0.3), lineWidth: 1))
                }
                .disabled(isSubmitting)

                Button(action: {
                    isSubmitting = true
                    onApprove()
                    KestrelTheme.triggerNotificationHaptic(.success)
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark")
                        Text("Approve Action")
                    }
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(KestrelTheme.background)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(KestrelTheme.accent)
                    .cornerRadius(10)
                }
                .disabled(isSubmitting)
            }
        }
        .padding(16)
        .kestrelCard(cornerRadius: 16, isHighlighted: true)
    }
}
