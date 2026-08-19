import Foundation
import SwiftUI
import Combine

@MainActor
public class AppState: ObservableObject {
    public static let shared = AppState()

    @Published public var tabManager = TabManager()
    @Published public var gatewayClient = AgentGatewayClient.shared
    @Published public var downloadManager = DownloadManager.shared
    @Published public var voiceService = VoiceTalkService.shared

    @Published public var isOmniboxEditing: Bool = false
    @Published public var isTabGridPresented: Bool = false
    @Published public var isBookmarksPresented: Bool = false
    @Published public var isDownloadsPresented: Bool = false
    @Published public var isAgentCompanionPresented: Bool = false
    @Published public var isPageAssistantPresented: Bool = false

    public init() {}
}
