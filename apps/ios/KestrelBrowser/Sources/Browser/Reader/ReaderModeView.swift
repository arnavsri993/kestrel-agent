import SwiftUI

public enum ReaderTheme: String, CaseIterable, Identifiable {
    case dark = "Dark"
    case sepia = "Sepia"
    case light = "Light"

    public var id: String { rawValue }

    public var backgroundColor: Color {
        switch self {
        case .dark:
            return KestrelTheme.background
        case .sepia:
            return Color(red: 0.95, green: 0.92, blue: 0.85)
        case .light:
            return Color(red: 0.98, green: 0.98, blue: 0.98)
        }
    }

    public var textColor: Color {
        switch self {
        case .dark:
            return KestrelTheme.textPrimary
        case .sepia:
            return Color(red: 0.25, green: 0.20, blue: 0.15)
        case .light:
            return Color(red: 0.12, green: 0.12, blue: 0.12)
        }
    }

    public var secondaryTextColor: Color {
        switch self {
        case .dark:
            return KestrelTheme.textMuted
        case .sepia:
            return Color(red: 0.50, green: 0.45, blue: 0.38)
        case .light:
            return Color(red: 0.45, green: 0.45, blue: 0.45)
        }
    }
}

public struct ReaderModeView: View {
    public let content: ReaderContent
    public let onExit: () -> Void

    @State private var fontSize: CGFloat = 18
    @State private var selectedTheme: ReaderTheme = .dark
    @State private var useSerif: Bool = true
    @State private var showAppearanceSheet: Bool = false

    public init(content: ReaderContent, onExit: @escaping () -> Void) {
        self.content = content
        self.onExit = onExit
    }

    public var body: some View {
        ZStack {
            selectedTheme.backgroundColor.ignoresSafeArea()

            VStack(spacing: 0) {
                // Top Reader Toolbar
                HStack {
                    Button(action: onExit) {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark")
                            Text("Done")
                        }
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(selectedTheme == .dark ? KestrelTheme.accent : selectedTheme.textColor)
                    }

                    Spacer()

                    // Appearance Button (AA)
                    Button(action: {
                        showAppearanceSheet.toggle()
                    }) {
                        HStack(spacing: 2) {
                            Text("A").font(.system(size: 13, weight: .bold))
                            Text("A").font(.system(size: 17, weight: .bold))
                        }
                        .foregroundColor(selectedTheme == .dark ? KestrelTheme.textPrimary : selectedTheme.textColor)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(selectedTheme == .dark ? KestrelTheme.panelBackground : Color.black.opacity(0.08))
                        .cornerRadius(8)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(selectedTheme.backgroundColor.opacity(0.95))

                // Scrollable Article Body
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // Title
                        Text(content.title)
                            .font(useSerif ? .custom("Georgia-Bold", size: fontSize + 8) : .system(size: fontSize + 8, weight: .bold))
                            .foregroundColor(selectedTheme.textColor)
                            .lineSpacing(4)

                        // Metadata (Byline + Site Name)
                        HStack(spacing: 8) {
                            if let byline = content.byline, !byline.isEmpty {
                                Text(byline)
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundColor(selectedTheme.secondaryTextColor)
                            }
                            if let site = content.siteName, !site.isEmpty {
                                Text("•")
                                    .foregroundColor(selectedTheme.secondaryTextColor)
                                Text(site)
                                    .font(.system(size: 14))
                                    .foregroundColor(selectedTheme.secondaryTextColor)
                            }
                        }

                        Divider()
                            .background(selectedTheme == .dark ? KestrelTheme.border : Color.gray.opacity(0.3))

                        // Article Plain / Extracted Text
                        Text(content.textContent)
                            .font(useSerif ? .custom("Georgia", size: fontSize) : .system(size: fontSize))
                            .foregroundColor(selectedTheme.textColor)
                            .lineSpacing(fontSize * 0.45)
                            .padding(.bottom, 60)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
                }
            }
        }
        .sheet(isPresented: $showAppearanceSheet) {
            ReaderAppearanceSheet(
                selectedTheme: $selectedTheme,
                fontSize: $fontSize,
                useSerif: $useSerif
            )
            .presentationDetents([.height(240)])
            .presentationDragIndicator(.visible)
        }
    }
}

public struct ReaderAppearanceSheet: View {
    @Binding public var selectedTheme: ReaderTheme
    @Binding public var fontSize: CGFloat
    @Binding public var useSerif: Bool

    public var body: some View {
        ZStack {
            KestrelTheme.panelBackground.ignoresSafeArea()

            VStack(spacing: 18) {
                Text("Reader Settings")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(KestrelTheme.textPrimary)

                // Themes (Dark, Sepia, Light)
                HStack(spacing: 12) {
                    ForEach(ReaderTheme.allCases) { theme in
                        Button(action: {
                            selectedTheme = theme
                            KestrelTheme.triggerHaptic(.light)
                        }) {
                            Text(theme.rawValue)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundColor(theme == .dark ? Color.white : Color.black)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .background(theme.backgroundColor)
                                .cornerRadius(10)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10)
                                        .stroke(selectedTheme == theme ? KestrelTheme.accent : KestrelTheme.border, lineWidth: 2)
                                )
                        }
                    }
                }

                // Font Family & Size Adjuster
                HStack(spacing: 16) {
                    // Font Family Toggle (Serif vs Sans)
                    Picker("Font", selection: $useSerif) {
                        Text("Serif").tag(true)
                        Text("Sans").tag(false)
                    }
                    .pickerStyle(.segmented)

                    // Font Sizing
                    HStack(spacing: 12) {
                        Button(action: {
                            if fontSize > 14 { fontSize -= 2 }
                            KestrelTheme.triggerHaptic(.light)
                        }) {
                            Text("A-").font(.system(size: 15, weight: .bold))
                                .padding(8)
                                .background(KestrelTheme.secondaryPanel)
                                .cornerRadius(8)
                        }

                        Button(action: {
                            if fontSize < 28 { fontSize += 2 }
                            KestrelTheme.triggerHaptic(.light)
                        }) {
                            Text("A+").font(.system(size: 18, weight: .bold))
                                .padding(8)
                                .background(KestrelTheme.secondaryPanel)
                                .cornerRadius(8)
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
        }
    }
}
