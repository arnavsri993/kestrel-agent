import Foundation
import SwiftUI
import Combine

@MainActor
public class DownloadManager: NSObject, ObservableObject {
    public static let shared = DownloadManager()

    @Published public var downloads: [DownloadRecord] = []
    private var downloadTasks: [UUID: URLSessionDownloadTask] = [:]
    private var session: URLSession!

    override public init() {
        super.init()
        let config = URLSessionConfiguration.background(withIdentifier: "com.kestrel.browser.downloads")
        self.session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    public func startDownload(url: URL, filename: String) {
        let record = DownloadRecord(
            url: url,
            filename: filename,
            state: .downloading
        )
        downloads.insert(record, at: 0)

        let task = session.downloadTask(with: url)
        downloadTasks[record.id] = task
        task.resume()
        KestrelTheme.triggerHaptic(.medium)
    }

    public func cancelDownload(id: UUID) {
        if let task = downloadTasks[id] {
            task.cancel()
            downloadTasks.removeValue(forKey: id)
        }
        if let idx = downloads.firstIndex(where: { $0.id == id }) {
            downloads[idx].state = .cancelled
        }
    }

    public func clearCompleted() {
        downloads.removeAll(where: { $0.state == .completed || $0.state == .cancelled || $0.state == .failed })
    }
}

extension DownloadManager: URLSessionDownloadDelegate {
    nonisolated public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let url = downloadTask.originalRequest?.url else { return }

        // Find matching download
        Task { @MainActor in
            guard let index = self.downloads.firstIndex(where: { $0.url == url && $0.state == .downloading }) else { return }
            let id = self.downloads[index].id
            let filename = self.downloads[index].filename

            let fileManager = FileManager.default
            let documentsDir = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let downloadsDir = documentsDir.appendingPathComponent("Downloads", isDirectory: true)

            try? fileManager.createDirectory(at: downloadsDir, withIntermediateDirectories: true)
            let destinationURL = downloadsDir.appendingPathComponent(filename)

            try? fileManager.removeItem(at: destinationURL)
            do {
                try fileManager.moveItem(at: location, to: destinationURL)
                self.downloads[index].localPath = destinationURL
                self.downloads[index].state = .completed
                KestrelTheme.triggerNotificationHaptic(.success)
            } catch {
                self.downloads[index].state = .failed
            }
            self.downloadTasks.removeValue(forKey: id)
        }
    }

    nonisolated public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let url = downloadTask.originalRequest?.url else { return }

        Task { @MainActor in
            if let index = self.downloads.firstIndex(where: { $0.url == url && $0.state == .downloading }) {
                self.downloads[index].receivedBytes = totalBytesWritten
                self.downloads[index].totalBytes = max(totalBytesExpectedToWrite, totalBytesWritten)
            }
        }
    }
}

public struct DownloadsView: View {
    @ObservedObject public var downloadManager = DownloadManager.shared
    @Binding public var isPresented: Bool

    public var body: some View {
        NavigationStack {
            ZStack {
                KestrelTheme.background.ignoresSafeArea()

                if downloadManager.downloads.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "arrow.down.circle")
                            .font(.system(size: 48))
                            .foregroundColor(KestrelTheme.textMuted.opacity(0.5))
                        Text("No Downloads")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundColor(KestrelTheme.textPrimary)
                        Text("Files you download will appear here.")
                            .font(.system(size: 14))
                            .foregroundColor(KestrelTheme.textMuted)
                    }
                } else {
                    List {
                        ForEach(downloadManager.downloads) { item in
                            HStack(spacing: 12) {
                                Image(systemName: "doc.fill")
                                    .font(.system(size: 24))
                                    .foregroundColor(item.state == .completed ? KestrelTheme.accent : KestrelTheme.textMuted)

                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item.filename)
                                        .font(.system(size: 15, weight: .medium))
                                        .foregroundColor(KestrelTheme.textPrimary)
                                        .lineLimit(1)

                                    if item.state == .downloading {
                                        ProgressView(value: item.progress)
                                            .tint(KestrelTheme.accent)
                                        Text("\(ByteCountFormatter.string(fromByteCount: item.receivedBytes, countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: item.totalBytes, countStyle: .file))")
                                            .font(.system(size: 11))
                                            .foregroundColor(KestrelTheme.textMuted)
                                    } else {
                                        Text(item.state.rawValue.capitalized)
                                            .font(.system(size: 12))
                                            .foregroundColor(item.state == .completed ? KestrelTheme.accent : KestrelTheme.textMuted)
                                    }
                                }

                                Spacer()

                                if item.state == .downloading {
                                    Button(action: {
                                        downloadManager.cancelDownload(id: item.id)
                                    }) {
                                        Image(systemName: "xmark.circle.fill")
                                            .foregroundColor(KestrelTheme.textMuted)
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                            .listRowBackground(KestrelTheme.panelBackground)
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .navigationTitle("Downloads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        isPresented = false
                    }
                    .foregroundColor(KestrelTheme.accent)
                    .fontWeight(.bold)
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button("Clear") {
                        downloadManager.clearCompleted()
                    }
                    .foregroundColor(KestrelTheme.textMuted)
                }
            }
        }
    }
}
