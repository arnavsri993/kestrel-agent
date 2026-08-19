import Foundation

public struct BookmarkItem: Identifiable, Codable, Equatable {
    public let id: UUID
    public var title: String
    public var url: URL
    public var dateAdded: Date
    public var isFavorite: Bool // Appears in Speed Dial on New Tab
    public var isReadingList: Bool // Saved for offline reading
    public var isRead: Bool

    public init(
        id: UUID = UUID(),
        title: String,
        url: URL,
        dateAdded: Date = Date(),
        isFavorite: Bool = false,
        isReadingList: Bool = false,
        isRead: Bool = false
    ) {
        self.id = id
        self.title = title
        self.url = url
        self.dateAdded = dateAdded
        self.isFavorite = isFavorite
        self.isReadingList = isReadingList
        self.isRead = isRead
    }
}

public struct HistoryRecord: Identifiable, Codable, Equatable {
    public let id: UUID
    public let title: String
    public let url: URL
    public let visitedAt: Date

    public init(
        id: UUID = UUID(),
        title: String,
        url: URL,
        visitedAt: Date = Date()
    ) {
        self.id = id
        self.title = title
        self.url = url
        self.visitedAt = visitedAt
    }
}

public struct DownloadRecord: Identifiable, Equatable {
    public let id: UUID
    public let url: URL
    public var filename: String
    public var localPath: URL?
    public var totalBytes: Int64
    public var receivedBytes: Int64
    public var state: State
    public var startedAt: Date

    public enum State: String, Codable {
        case pending
        case downloading
        case completed
        case failed
        case cancelled
    }

    public var progress: Double {
        guard totalBytes > 0 else { return 0 }
        return Double(receivedBytes) / Double(totalBytes)
    }

    public init(
        id: UUID = UUID(),
        url: URL,
        filename: String,
        localPath: URL? = nil,
        totalBytes: Int64 = 0,
        receivedBytes: Int64 = 0,
        state: State = .pending,
        startedAt: Date = Date()
    ) {
        self.id = id
        self.url = url
        self.filename = filename
        self.localPath = localPath
        self.totalBytes = totalBytes
        self.receivedBytes = receivedBytes
        self.state = state
        self.startedAt = startedAt
    }
}
