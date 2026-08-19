import Foundation
import SwiftUI

#if os(iOS)
import UIKit
public typealias PlatformImage = UIImage
#elseif os(macOS)
import AppKit
public typealias PlatformImage = NSImage
#else
public typealias PlatformImage = AnyObject
#endif

public struct Tab: Identifiable, Equatable {
    public let id: UUID
    public var url: URL?
    public var title: String
    public var faviconURL: URL?
    public var isLoading: Bool
    public var estimatedProgress: Double
    public var canGoBack: Bool
    public var canGoForward: Bool
    public var isPrivate: Bool
    public var snapshot: PlatformImage?
    public var lastAccessedAt: Date
    public var readerAvailable: Bool
    public var isReaderModeActive: Bool
    public var readerContent: ReaderContent?

    public init(
        id: UUID = UUID(),
        url: URL? = nil,
        title: String = "New Tab",
        faviconURL: URL? = nil,
        isLoading: Bool = false,
        estimatedProgress: Double = 0.0,
        canGoBack: Bool = false,
        canGoForward: Bool = false,
        isPrivate: Bool = false,
        snapshot: PlatformImage? = nil,
        lastAccessedAt: Date = Date(),
        readerAvailable: Bool = false,
        isReaderModeActive: Bool = false,
        readerContent: ReaderContent? = nil
    ) {
        self.id = id
        self.url = url
        self.title = title
        self.faviconURL = faviconURL
        self.isLoading = isLoading
        self.estimatedProgress = estimatedProgress
        self.canGoBack = canGoBack
        self.canGoForward = canGoForward
        self.isPrivate = isPrivate
        self.snapshot = snapshot
        self.lastAccessedAt = lastAccessedAt
        self.readerAvailable = readerAvailable
        self.isReaderModeActive = isReaderModeActive
        self.readerContent = readerContent
    }

    public static func == (lhs: Tab, rhs: Tab) -> Bool {
        lhs.id == rhs.id &&
        lhs.url == rhs.url &&
        lhs.title == rhs.title &&
        lhs.isLoading == rhs.isLoading &&
        lhs.estimatedProgress == rhs.estimatedProgress &&
        lhs.canGoBack == rhs.canGoBack &&
        lhs.canGoForward == rhs.canGoForward &&
        lhs.isPrivate == rhs.isPrivate &&
        lhs.isReaderModeActive == rhs.isReaderModeActive
    }
}

public struct ReaderContent: Codable, Equatable {
    public let title: String
    public let byline: String?
    public let excerpt: String?
    public let contentHtml: String
    public let textContent: String
    public let siteName: String?
    public let publishedTime: String?

    public init(
        title: String,
        byline: String? = nil,
        excerpt: String? = nil,
        contentHtml: String,
        textContent: String,
        siteName: String? = nil,
        publishedTime: String? = nil
    ) {
        self.title = title
        self.byline = byline
        self.excerpt = excerpt
        self.contentHtml = contentHtml
        self.textContent = textContent
        self.siteName = siteName
        self.publishedTime = publishedTime
    }
}
