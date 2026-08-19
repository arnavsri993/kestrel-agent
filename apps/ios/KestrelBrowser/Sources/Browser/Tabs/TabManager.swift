import Foundation
import SwiftUI
import Combine
import LocalAuthentication

#if canImport(UIKit)
import UIKit
#endif

@MainActor
public class TabManager: ObservableObject {
    @Published public var tabs: [Tab] = []
    @Published public var privateTabs: [Tab] = []
    @Published public var isPrivateModeActive: Bool = false
    @Published public var activeTabId: UUID?
    @Published public var isPrivateLocked: Bool = false
    @Published public var isBiometricsAvailable: Bool = false

    private var recentlyClosedTabs: [Tab] = []

    public var currentTabs: [Tab] {
        isPrivateModeActive ? privateTabs : tabs
    }

    public var activeTab: Tab? {
        guard let activeTabId = activeTabId else { return nil }
        return currentTabs.first(where: { $0.id == activeTabId })
    }

    public init() {
        checkBiometrics()
        // Initialize with default home tab
        let defaultTab = Tab(url: URL(string: "https://kestrel.agent/home") ?? URL(string: "about:blank")!, title: "New Tab")
        self.tabs = [defaultTab]
        self.activeTabId = defaultTab.id
    }

    public func checkBiometrics() {
        let context = LAContext()
        var error: NSError?
        self.isBiometricsAvailable = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    }

    public func authenticatePrivateMode(completion: @escaping (Bool) -> Void) {
        let context = LAContext()
        var error: NSError?

        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Unlock Private Tabs") { success, _ in
                DispatchQueue.main.async {
                    if success {
                        self.isPrivateLocked = false
                    }
                    completion(success)
                }
            }
        } else {
            // No biometric hardware or not enrolled, unlock directly
            self.isPrivateLocked = false
            completion(true)
        }
    }

    public func switchToPrivateMode(_ enabled: Bool) {
        if enabled && !privateTabs.isEmpty && isPrivateLocked {
            authenticatePrivateMode { [weak self] success in
                guard let self = self, success else { return }
                self.isPrivateModeActive = true
                if self.privateTabs.isEmpty {
                    self.createTab(isPrivate: true)
                } else if self.activeTabId == nil || !self.privateTabs.contains(where: { $0.id == self.activeTabId }) {
                    self.activeTabId = self.privateTabs.first?.id
                }
            }
        } else {
            self.isPrivateModeActive = enabled
            if enabled {
                if privateTabs.isEmpty {
                    createTab(isPrivate: true)
                } else if activeTabId == nil || !privateTabs.contains(where: { $0.id == activeTabId }) {
                    activeTabId = privateTabs.first?.id
                }
            } else {
                if tabs.isEmpty {
                    createTab(isPrivate: false)
                } else if activeTabId == nil || !tabs.contains(where: { $0.id == activeTabId }) {
                    activeTabId = tabs.first?.id
                }
            }
        }
    }

    @discardableResult
    public func createTab(url: URL? = nil, isPrivate: Bool? = nil) -> Tab {
        let priv = isPrivate ?? isPrivateModeActive
        let newTab = Tab(
            url: url,
            title: url?.host ?? "New Tab",
            isPrivate: priv
        )

        if priv {
            privateTabs.append(newTab)
        } else {
            tabs.append(newTab)
        }

        activeTabId = newTab.id
        KestrelTheme.triggerHaptic(.light)
        return newTab
    }

    public func closeTab(id: UUID) {
        if isPrivateModeActive {
            if let index = privateTabs.firstIndex(where: { $0.id == id }) {
                let removed = privateTabs.remove(at: index)
                recentlyClosedTabs.append(removed)
                if activeTabId == id {
                    activeTabId = privateTabs.isEmpty ? nil : privateTabs[max(0, index - 1)].id
                }
            }
            if privateTabs.isEmpty {
                createTab(isPrivate: true)
            }
        } else {
            if let index = tabs.firstIndex(where: { $0.id == id }) {
                let removed = tabs.remove(at: index)
                recentlyClosedTabs.append(removed)
                if activeTabId == id {
                    activeTabId = tabs.isEmpty ? nil : tabs[max(0, index - 1)].id
                }
            }
            if tabs.isEmpty {
                createTab(isPrivate: false)
            }
        }
        KestrelTheme.triggerHaptic(.light)
    }

    public func closeAllTabs() {
        if isPrivateModeActive {
            privateTabs.removeAll()
            createTab(isPrivate: true)
        } else {
            tabs.removeAll()
            createTab(isPrivate: false)
        }
        KestrelTheme.triggerHaptic(.medium)
    }

    public func duplicateTab(id: UUID) {
        guard let tab = currentTabs.first(where: { $0.id == id }) else { return }
        createTab(url: tab.url, isPrivate: tab.isPrivate)
    }

    public func selectTab(id: UUID) {
        activeTabId = id
        KestrelTheme.triggerHaptic(.light)
    }

    public func updateActiveTabURL(_ url: URL, title: String? = nil) {
        guard let activeId = activeTabId else { return }
        if isPrivateModeActive {
            if let idx = privateTabs.firstIndex(where: { $0.id == activeId }) {
                privateTabs[idx].url = url
                if let t = title { privateTabs[idx].title = t }
            }
        } else {
            if let idx = tabs.firstIndex(where: { $0.id == activeId }) {
                tabs[idx].url = url
                if let t = title { tabs[idx].title = t }
            }
        }
    }

    public func toggleReaderMode(for id: UUID) {
        if isPrivateModeActive {
            if let idx = privateTabs.firstIndex(where: { $0.id == id }) {
                privateTabs[idx].isReaderModeActive.toggle()
            }
        } else {
            if let idx = tabs.firstIndex(where: { $0.id == id }) {
                tabs[idx].isReaderModeActive.toggle()
            }
        }
    }
}
