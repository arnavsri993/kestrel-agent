import SwiftUI

#if os(iOS)
import UIKit
#endif

public enum KestrelTheme {
    // Primary Colors matching Kestrel design identity
    public static let background = Color(red: 0.051, green: 0.063, blue: 0.051) // #0d100d
    public static let panelBackground = Color(red: 0.082, green: 0.102, blue: 0.078) // #151a14
    public static let secondaryPanel = Color(red: 0.114, green: 0.141, blue: 0.110) // #1d241c
    public static let border = Color(red: 0.165, green: 0.200, blue: 0.153) // #2a3327
    public static let accent = Color(red: 0.788, green: 1.000, blue: 0.322) // #c9ff52 (Lime)
    public static let accentMuted = Color(red: 0.322, green: 0.427, blue: 0.208) // #526d35
    public static let textPrimary = Color(red: 0.949, green: 0.953, blue: 0.918) // #f2f3ea
    public static let textMuted = Color(red: 0.612, green: 0.647, blue: 0.580) // #9ca594
    public static let danger = Color(red: 1.000, green: 0.545, blue: 0.490) // #ff8b7d
    public static let warning = Color(red: 1.000, green: 0.784, blue: 0.322) // #ffc852
    public static let privateAccent = Color(red: 0.655, green: 0.545, blue: 0.984) // #a78bfa (Purple for private browsing)

    public enum HapticStyle {
        case light
        case medium
        case heavy
    }

    public enum NotificationFeedback {
        case success
        case warning
        case error
    }

    // UI Haptics Helper
    public static func triggerHaptic(_ style: HapticStyle = .light) {
        #if os(iOS)
        let feedbackStyle: UIImpactFeedbackGenerator.FeedbackStyle = {
            switch style {
            case .light: return .light
            case .medium: return .medium
            case .heavy: return .heavy
            }
        }()
        let generator = UIImpactFeedbackGenerator(style: feedbackStyle)
        generator.prepare()
        generator.impactOccurred()
        #endif
    }

    public static func triggerNotificationHaptic(_ type: NotificationFeedback) {
        #if os(iOS)
        let feedbackType: UINotificationFeedbackGenerator.FeedbackType = {
            switch type {
            case .success: return .success
            case .warning: return .warning
            case .error: return .error
            }
        }()
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(feedbackType)
        #endif
    }
}

// Reusable card styling
public struct KestrelCardModifier: ViewModifier {
    public var cornerRadius: CGFloat = 16
    public var isHighlighted: Bool = false

    public func body(content: Content) -> some View {
        content
            .background(KestrelTheme.panelBackground)
            .cornerRadius(cornerRadius)
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .stroke(isHighlighted ? KestrelTheme.accent.opacity(0.6) : KestrelTheme.border, lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.25), radius: 8, x: 0, y: 4)
    }
}

public extension View {
    func kestrelCard(cornerRadius: CGFloat = 16, isHighlighted: Bool = false) -> some View {
        self.modifier(KestrelCardModifier(cornerRadius: cornerRadius, isHighlighted: isHighlighted))
    }
}
