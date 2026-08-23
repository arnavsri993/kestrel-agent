import AppKit
import Foundation

private struct ExternalPayload: Codable {
    let kind: String
    let paths: [String]
    let text: String?
}

private final class ServiceProvider: NSObject {
    @objc(askKestrel:userData:error:)
    func askKestrel(
        _ pasteboard: NSPasteboard,
        userData: String?,
        error: AutoreleasingUnsafeMutablePointer<NSString?>
    ) {
        do {
            let text = pasteboard.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let paths = filePaths(from: pasteboard)
            guard !paths.isEmpty || !(text?.isEmpty ?? true) else {
                throw ServiceError.emptySelection
            }

            let identifier = UUID().uuidString.lowercased()
            let applicationSupport = try FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            let intakeDirectory = applicationSupport
                .appendingPathComponent("Kestrel", isDirectory: true)
                .appendingPathComponent("external-intake", isDirectory: true)
            try FileManager.default.createDirectory(
                at: intakeDirectory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )

            let payload = ExternalPayload(
                kind: "ask",
                paths: Array(paths.prefix(8)),
                text: text?.isEmpty == false ? String(text!.prefix(20_000)) : nil
            )
            let data = try JSONEncoder().encode(payload)
            let temporaryURL = intakeDirectory.appendingPathComponent(".\(identifier).tmp")
            let payloadURL = intakeDirectory.appendingPathComponent("\(identifier).json")
            try data.write(to: temporaryURL, options: [.atomic])
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: temporaryURL.path
            )
            try FileManager.default.moveItem(at: temporaryURL, to: payloadURL)

            guard let url = URL(string: "kestrel://ask?payload=\(identifier)"),
                  NSWorkspace.shared.open(url) else {
                try? FileManager.default.removeItem(at: payloadURL)
                throw ServiceError.couldNotOpenKestrel
            }
        } catch let failure {
            error.pointee = NSString(string: failure.localizedDescription)
        }
    }

    private func filePaths(from pasteboard: NSPasteboard) -> [String] {
        var paths: [String] = []
        if let urls = pasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [NSURL] {
            paths.append(contentsOf: urls.compactMap { url in
                guard let value = url as URL?, value.isFileURL else { return nil }
                return value.standardizedFileURL.path
            })
        }

        let filenamesType = NSPasteboard.PasteboardType("NSFilenamesPboardType")
        if let filenames = pasteboard.propertyList(forType: filenamesType) as? [String] {
            paths.append(contentsOf: filenames)
        }
        var seen = Set<String>()
        return paths.filter { seen.insert($0).inserted }
    }
}

private enum ServiceError: LocalizedError {
    case emptySelection
    case couldNotOpenKestrel

    var errorDescription: String? {
        switch self {
        case .emptySelection:
            return "Select text or one or more files before asking Kestrel."
        case .couldNotOpenKestrel:
            return "Kestrel is not registered to receive macOS Services yet."
        }
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
application.servicesProvider = ServiceProvider()
application.run()
