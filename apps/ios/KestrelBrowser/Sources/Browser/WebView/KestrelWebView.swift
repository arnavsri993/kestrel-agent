import SwiftUI
import WebKit

#if canImport(UIKit)
import UIKit

public struct KestrelWebView: UIViewRepresentable {
    public let tabId: UUID
    public let initialURL: URL?
    public let isPrivate: Bool
    @Binding public var currentURL: URL?
    @Binding public var title: String
    @Binding public var isLoading: Bool
    @Binding public var estimatedProgress: Double
    @Binding public var canGoBack: Bool
    @Binding public var canGoForward: Bool
    @Binding public var readerAvailable: Bool
    @Binding public var snapshot: UIImage?

    public var onReaderContentExtracted: ((ReaderContent) -> Void)?
    public var onNewTabRequested: ((URL) -> Void)?
    public var onDownloadRequested: ((URL, String) -> Void)?

    public init(
        tabId: UUID,
        initialURL: URL?,
        isPrivate: Bool,
        currentURL: Binding<URL?>,
        title: Binding<String>,
        isLoading: Binding<Bool>,
        estimatedProgress: Binding<Double>,
        canGoBack: Binding<Bool>,
        canGoForward: Binding<Bool>,
        readerAvailable: Binding<Bool>,
        snapshot: Binding<UIImage?>,
        onReaderContentExtracted: ((ReaderContent) -> Void)? = nil,
        onNewTabRequested: ((URL) -> Void)? = nil,
        onDownloadRequested: ((URL, String) -> Void)? = nil
    ) {
        self.tabId = tabId
        self.initialURL = initialURL
        self.isPrivate = isPrivate
        self._currentURL = currentURL
        self._title = title
        self._isLoading = isLoading
        self._estimatedProgress = estimatedProgress
        self._canGoBack = canGoBack
        self._canGoForward = canGoForward
        self._readerAvailable = readerAvailable
        self._snapshot = snapshot
        self.onReaderContentExtracted = onReaderContentExtracted
        self.onNewTabRequested = onNewTabRequested
        self.onDownloadRequested = onDownloadRequested
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    public func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        if isPrivate {
            config.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        } else {
            config.websiteDataStore = WKWebsiteDataStore.default()
        }

        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        config.defaultWebpagePreferences = preferences

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic

        // Setup custom user agent
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1 Kestrel/1.0"

        context.coordinator.setupObservers(for: webView)

        // Setup privacy content blocker asynchronously
        Task {
            await ContentBlockerManager.shared.setupContentBlocker(configuration: config)
        }

        // Load initial URL if available
        if let url = initialURL {
            var request = URLRequest(url: url)
            request.timeoutInterval = 30
            webView.load(request)
        }

        return webView
    }

    public func updateUIView(_ uiView: WKWebView, context: Context) {
        // Handle external navigations if needed
    }

    public class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private var parent: KestrelWebView
        private var estimatedProgressObservation: NSKeyValueObservation?
        private var titleObservation: NSKeyValueObservation?
        private var urlObservation: NSKeyValueObservation?
        private var loadingObservation: NSKeyValueObservation?
        private var canGoBackObservation: NSKeyValueObservation?
        private var canGoForwardObservation: NSKeyValueObservation?

        init(_ parent: KestrelWebView) {
            self.parent = parent
            super.init()
        }

        deinit {
            estimatedProgressObservation?.invalidate()
            titleObservation?.invalidate()
            urlObservation?.invalidate()
            loadingObservation?.invalidate()
            canGoBackObservation?.invalidate()
            canGoForwardObservation?.invalidate()
        }

        func setupObservers(for webView: WKWebView) {
            estimatedProgressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] wv, _ in
                DispatchQueue.main.async {
                    self?.parent.estimatedProgress = wv.estimatedProgress
                }
            }

            titleObservation = webView.observe(\.title, options: [.new]) { [weak self] wv, _ in
                DispatchQueue.main.async {
                    if let title = wv.title, !title.isEmpty {
                        self?.parent.title = title
                    }
                }
            }

            urlObservation = webView.observe(\.url, options: [.new]) { [weak self] wv, _ in
                DispatchQueue.main.async {
                    self?.parent.currentURL = wv.url
                }
            }

            loadingObservation = webView.observe(\.isLoading, options: [.new]) { [weak self] wv, _ in
                DispatchQueue.main.async {
                    self?.parent.isLoading = wv.isLoading
                }
            }

            canGoBackObservation = webView.observe(\.canGoBack, options: [.new]) { [weak self] wv, _ in
                DispatchQueue.main.async {
                    self?.parent.canGoBack = wv.canGoBack
                }
            }

            canGoForwardObservation = webView.observe(\.canGoForward, options: [.new]) { [weak self] wv, _ in
                DispatchQueue.main.async {
                    self?.parent.canGoForward = wv.canGoForward
                }
            }
        }

        public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Check for Reader mode content
            webView.evaluateJavaScript(ReaderScript.extractionScript) { [weak self] result, error in
                guard let self = self, let dict = result as? [String: Any] else { return }
                if let text = dict["textContent"] as? String, text.count > 300 {
                    let title = dict["title"] as? String ?? webView.title ?? ""
                    let byline = dict["byline"] as? String
                    let excerpt = dict["excerpt"] as? String
                    let siteName = dict["siteName"] as? String
                    let contentHtml = dict["contentHtml"] as? String ?? ""

                    let content = ReaderContent(
                        title: title,
                        byline: byline,
                        excerpt: excerpt,
                        contentHtml: contentHtml,
                        textContent: text,
                        siteName: siteName
                    )

                    DispatchQueue.main.async {
                        self.parent.readerAvailable = true
                        self.parent.onReaderContentExtracted?(content)
                    }
                }
            }

            // Capture snapshot for tab switcher thumbnail
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self = self else { return }
                let config = WKSnapshotConfiguration()
                config.rect = CGRect(origin: .zero, size: CGSize(width: webView.bounds.width, height: min(webView.bounds.height, 600)))
                webView.takeSnapshot(with: config) { image, _ in
                    if let image = image {
                        DispatchQueue.main.async {
                            self.parent.snapshot = image
                        }
                    }
                }
            }
        }

        // Handle target="_blank"
        public func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
                parent.onNewTabRequested?(url)
            }
            return nil
        }

        // Handle file downloads
        public func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            if let response = navigationResponse.response as? HTTPURLResponse,
               let mimeType = response.mimeType {
                let downloadableMimes = ["application/pdf", "application/zip", "application/octet-stream", "application/x-tar", "audio/mpeg", "video/mp4"]
                if downloadableMimes.contains(mimeType) || response.suggestedFilename?.hasSuffix(".dmg") == true || response.suggestedFilename?.hasSuffix(".zip") == true {
                    if let url = response.url {
                        let filename = response.suggestedFilename ?? "download"
                        parent.onDownloadRequested?(url, filename)
                    }
                }
            }
            decisionHandler(.allow)
        }
    }
}
#endif
