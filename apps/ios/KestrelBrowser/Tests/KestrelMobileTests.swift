import XCTest
@testable import KestrelMobile

final class KestrelMobileTests: XCTestCase {

    @MainActor
    func testTabManagerLifecycle() {
        let manager = TabManager()
        XCTAssertEqual(manager.tabs.count, 1)
        XCTAssertNotNil(manager.activeTab)

        // Create new tab
        let tab2 = manager.createTab(url: URL(string: "https://apple.com"))
        XCTAssertEqual(manager.tabs.count, 2)
        XCTAssertEqual(manager.activeTabId, tab2.id)

        // Duplicate tab
        manager.duplicateTab(id: tab2.id)
        XCTAssertEqual(manager.tabs.count, 3)

        // Close tab
        manager.closeTab(id: tab2.id)
        XCTAssertEqual(manager.tabs.count, 2)
    }

    @MainActor
    func testPrivateModeSeparation() {
        let manager = TabManager()
        XCTAssertFalse(manager.isPrivateModeActive)
        XCTAssertEqual(manager.tabs.count, 1)
        XCTAssertEqual(manager.privateTabs.count, 0)

        // Switch to private mode
        manager.switchToPrivateMode(true)
        XCTAssertTrue(manager.isPrivateModeActive)
        XCTAssertEqual(manager.privateTabs.count, 1)
        XCTAssertTrue(manager.currentTabs.allSatisfy { $0.isPrivate })

        // Switch back to standard
        manager.switchToPrivateMode(false)
        XCTAssertFalse(manager.isPrivateModeActive)
        XCTAssertEqual(manager.tabs.count, 1)
    }

    func testSearchEngineURLFormatting() {
        let ddg = SearchEngine.duckDuckGo

        // Query with spaces
        let queryURL = ddg.buildSearchURL(query: "local first ai agent")
        XCTAssertTrue(queryURL.absoluteString.contains("duckduckgo.com"))
        XCTAssertTrue(queryURL.absoluteString.contains("local%20first%20ai%20agent"))

        // Direct domain
        let domainURL = ddg.buildSearchURL(query: "github.com")
        XCTAssertEqual(domainURL.absoluteString, "https://github.com")

        // Full HTTPS URL
        let fullURL = ddg.buildSearchURL(query: "https://antigravity.google/docs")
        XCTAssertEqual(fullURL.absoluteString, "https://antigravity.google/docs")
    }

    func testAgentJobDecoding() throws {
        let json = """
        {
            "id": "job-101",
            "title": "Analyze Repository",
            "sessionId": "sess-alpha",
            "model": "auto",
            "providerIds": ["auto"],
            "prompt": "Inspect codebase architecture",
            "status": "waiting_approval",
            "createdAt": "2026-08-15T12:00:00Z",
            "updatedAt": "2026-08-15T12:05:00Z"
        }
        """

        let data = json.data(using: .utf8)!
        let job = try JSONDecoder().decode(AgentJobRecord.self, from: data)

        XCTAssertEqual(job.id, "job-101")
        XCTAssertEqual(job.title, "Analyze Repository")
        XCTAssertEqual(job.status, .waitingApproval)
    }
}
