import Foundation
import WebKit

public actor ContentBlockerManager {
    public static let shared = ContentBlockerManager()

    private var compiledRuleList: WKContentRuleList?
    private var isCompiling = false

    private init() {}

    public func setupContentBlocker(configuration: WKWebViewConfiguration) async {
        if let ruleList = compiledRuleList {
            configuration.userContentController.add(ruleList)
            return
        }

        if let ruleList = await compileRules() {
            self.compiledRuleList = ruleList
            configuration.userContentController.add(ruleList)
        }
    }

    private func compileRules() async -> WKContentRuleList? {
        guard let rulesURL = Bundle.module.url(forResource: "ContentBlockerRules", withExtension: "json") ??
                Bundle.main.url(forResource: "ContentBlockerRules", withExtension: "json") else {
            // Fallback default rules
            let fallbackJSON = """
            [
              {
                "trigger": {
                  "url-filter": ".*",
                  "resource-type": ["script", "xmlhttprequest"],
                  "if-domain": ["*google-analytics.com", "*googletagmanager.com", "*doubleclick.net", "*hotjar.com"]
                },
                "action": { "type": "block" }
              }
            ]
            """
            return await compileRulesString(fallbackJSON)
        }

        do {
            let jsonString = try String(contentsOf: rulesURL, encoding: .utf8)
            return await compileRulesString(jsonString)
        } catch {
            return nil
        }
    }

    private func compileRulesString(_ jsonString: String) async -> WKContentRuleList? {
        await withCheckedContinuation { continuation in
            WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "KestrelPrivacyRules",
                encodedContentRuleList: jsonString
            ) { ruleList, error in
                continuation.resume(returning: ruleList)
            }
        }
    }
}
