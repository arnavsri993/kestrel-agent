import SwiftUI

@main
public struct KestrelMobileApp: App {
    public init() {}

    public var body: some Scene {
        WindowGroup {
            MainContainerView()
                .preferredColorScheme(.dark)
        }
    }
}
