import Foundation

public enum SearchEngine: String, CaseIterable, Identifiable, Codable {
    case duckDuckGo = "DuckDuckGo"
    case google = "Google"
    case kestrelAI = "Kestrel AI"
    case bing = "Bing"
    case ecosia = "Ecosia"

    public var id: String { rawValue }

    public var searchURLTemplate: String {
        switch self {
        case .duckDuckGo:
            return "https://duckduckgo.com/?q="
        case .google:
            return "https://www.google.com/search?q="
        case .kestrelAI:
            return "https://duckduckgo.com/?q=" // Falls back to DDG or paired agent web search
        case .bing:
            return "https://www.bing.com/search?q="
        case .ecosia:
            return "https://www.ecosia.org/search?q="
        }
    }

    public func buildSearchURL(query: String) -> URL {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)

        // Check if query is already a valid full URL with scheme
        if trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://") {
            if let url = URL(string: trimmed) { return url }
        }

        // Check if query looks like a domain name (e.g. apple.com, github.com, news.ycombinator.com)
        let domainRegex = "^[a-zA-Z0-9-]+\\.[a-zA-Z]{2,}(/.*)?$"
        if let _ = trimmed.range(of: domainRegex, options: .regularExpression), !trimmed.contains(" ") {
            if let url = URL(string: "https://\(trimmed)") { return url }
        }

        // Otherwise format search query URL
        let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? trimmed
        return URL(string: "\(searchURLTemplate)\(encoded)") ?? URL(string: "https://duckduckgo.com/?q=\(encoded)")!
    }
}
