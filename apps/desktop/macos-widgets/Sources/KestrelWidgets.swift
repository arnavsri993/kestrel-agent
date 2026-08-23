import Foundation
import SwiftUI
import WidgetKit

private let kestrelGroupIdentifier = "group.com.kestrel.desktop"

private enum WidgetAgentState: String, Decodable {
    case idle
    case observing
    case working
    case waitingApproval = "waiting_approval"
    case paused
    case offline
    case error
    case updating
}

private struct KestrelWidgetData: Decodable {
    let schemaVersion: Int
    let updatedAt: String
    let status: Status
    let focus: Focus
    let queue: Queue
    let pulse: Pulse

    struct Status: Decodable {
        let kind: WidgetAgentState
        let label: String
        let detail: String
    }

    struct Focus: Decodable {
        let title: String
        let detail: String
    }

    struct Queue: Decodable {
        let approvals: Int
        let activeWorkers: Int
        let maximumWorkers: Int
    }

    struct Pulse: Decodable {
        let model: String
        let modelCostToday: Double
        let modelBudgetDaily: Double
        let connectedConnections: Int
        let totalConnections: Int
    }

    static let fallback = KestrelWidgetData(
        schemaVersion: 1,
        updatedAt: "",
        status: Status(
            kind: .idle,
            label: "Ready",
            detail: "Open Kestrel to start a task",
        ),
        focus: Focus(
            title: "Your next move",
            detail: "Kestrel keeps the useful context close at hand.",
        ),
        queue: Queue(approvals: 0, activeWorkers: 0, maximumWorkers: 1),
        pulse: Pulse(
            model: "Automatic routing",
            modelCostToday: 0,
            modelBudgetDaily: 0,
            connectedConnections: 0,
            totalConnections: 0,
        ),
    )

    static func load() -> KestrelWidgetData {
        guard
            let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: kestrelGroupIdentifier,
            )
        else { return .fallback }
        let path = container.appendingPathComponent("widgets.json")
        guard
            let data = try? Data(contentsOf: path),
            let value = try? JSONDecoder().decode(KestrelWidgetData.self, from: data),
            value.schemaVersion == 1
        else { return .fallback }
        return value
    }
}

private struct KestrelWidgetEntry: TimelineEntry {
    let date: Date
    let data: KestrelWidgetData
}

private struct KestrelTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> KestrelWidgetEntry {
        KestrelWidgetEntry(date: Date(), data: .fallback)
    }

    func getSnapshot(
        in context: Context,
        completion: @escaping (KestrelWidgetEntry) -> Void,
    ) {
        completion(KestrelWidgetEntry(date: Date(), data: .load()))
    }

    func getTimeline(
        in context: Context,
        completion: @escaping (Timeline<KestrelWidgetEntry>) -> Void,
    ) {
        let now = Date()
        let entry = KestrelWidgetEntry(date: now, data: .load())
        completion(
            Timeline(
                entries: [entry],
                policy: .after(now.addingTimeInterval(15 * 60)),
            ),
        )
    }
}

private enum KestrelPalette {
    static let ink = Color(red: 0.94, green: 0.95, blue: 0.98)
    static let muted = Color(red: 0.67, green: 0.71, blue: 0.78)
    static let panel = Color(red: 0.13, green: 0.15, blue: 0.19)
    static let panelBright = Color(red: 0.19, green: 0.22, blue: 0.28)
    static let accent = Color(red: 0.46, green: 0.78, blue: 1.0)
    static let warning = Color(red: 1.0, green: 0.72, blue: 0.36)
    static let success = Color(red: 0.46, green: 0.88, blue: 0.65)
    static let danger = Color(red: 1.0, green: 0.46, blue: 0.48)
}

private struct KestrelWidgetBackground: View {
    var body: some View {
        LinearGradient(
            colors: [
                Color(red: 0.08, green: 0.1, blue: 0.14),
                Color(red: 0.16, green: 0.19, blue: 0.24),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing,
        )
    }
}

private struct KestrelMark: View {
    let compact: Bool

    var body: some View {
        HStack(spacing: compact ? 5 : 7) {
            Image(systemName: "sparkles")
                .font(.system(size: compact ? 10 : 12, weight: .semibold))
                .foregroundColor(KestrelPalette.accent)
            Text("KESTREL")
                .font(.system(size: compact ? 9 : 10, weight: .bold, design: .rounded))
                .tracking(1.4)
                .foregroundColor(KestrelPalette.muted)
        }
    }
}

private struct StatusDot: View {
    let state: WidgetAgentState

    private var color: Color {
        switch state {
        case .working, .observing:
            return KestrelPalette.accent
        case .waitingApproval:
            return KestrelPalette.warning
        case .error:
            return KestrelPalette.danger
        case .offline, .paused:
            return KestrelPalette.muted
        case .updating:
            return KestrelPalette.accent
        case .idle:
            return KestrelPalette.success
        }
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .shadow(color: color.opacity(0.55), radius: 4)
    }
}

private struct StatusLabel: View {
    let data: KestrelWidgetData
    let compact: Bool

    var body: some View {
        HStack(spacing: 6) {
            StatusDot(state: data.status.kind)
            Text(data.status.label)
                .font(.system(size: compact ? 11 : 12, weight: .semibold, design: .rounded))
                .foregroundColor(KestrelPalette.ink)
                .lineLimit(1)
        }
    }
}

private struct KestrelFocusView: View {
    let entry: KestrelWidgetEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        ZStack {
            KestrelWidgetBackground()
            if family == .systemSmall {
                VStack(alignment: .leading, spacing: 0) {
                    KestrelMark(compact: true)
                    Spacer(minLength: 10)
                    StatusLabel(data: entry.data, compact: true)
                    Text(entry.data.focus.title)
                        .font(.system(size: 16, weight: .bold, design: .rounded))
                        .foregroundColor(KestrelPalette.ink)
                        .lineLimit(3)
                        .minimumScaleFactor(0.78)
                        .padding(.top, 6)
                    Spacer(minLength: 8)
                    Text("Open Agent  ›")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundColor(KestrelPalette.accent)
                }
                .padding(14)
            } else if family == .systemMedium {
                HStack(alignment: .top, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        KestrelMark(compact: false)
                        StatusLabel(data: entry.data, compact: false)
                        Text(entry.data.status.detail)
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundColor(KestrelPalette.muted)
                            .lineLimit(2)
                    }
                    .frame(maxWidth: 142, alignment: .leading)

                    VStack(alignment: .leading, spacing: 5) {
                        Text("FOCUS")
                            .font(.system(size: 9, weight: .bold, design: .rounded))
                            .tracking(1.1)
                            .foregroundColor(KestrelPalette.muted)
                        Text(entry.data.focus.title)
                            .font(.system(size: 16, weight: .bold, design: .rounded))
                            .foregroundColor(KestrelPalette.ink)
                            .lineLimit(2)
                            .minimumScaleFactor(0.8)
                        Text("Open Agent  ›")
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundColor(KestrelPalette.accent)
                            .padding(.top, 3)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(16)
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        KestrelMark(compact: false)
                        Spacer()
                        StatusLabel(data: entry.data, compact: false)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("CURRENT FOCUS")
                            .font(.system(size: 10, weight: .bold, design: .rounded))
                            .tracking(1.2)
                            .foregroundColor(KestrelPalette.muted)
                        Text(entry.data.focus.title)
                            .font(.system(size: 23, weight: .bold, design: .rounded))
                            .foregroundColor(KestrelPalette.ink)
                            .lineLimit(2)
                        Text(entry.data.focus.detail)
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundColor(KestrelPalette.muted)
                            .lineLimit(2)
                    }
                    HStack(spacing: 10) {
                        KestrelMetric(
                            label: "WAITING",
                            value: "\(entry.data.queue.approvals)",
                            tint: entry.data.queue.approvals > 0 ? KestrelPalette.warning : KestrelPalette.success,
                        )
                        KestrelMetric(
                            label: "WORKERS",
                            value: "\(entry.data.queue.activeWorkers)/\(max(entry.data.queue.maximumWorkers, 1))",
                            tint: KestrelPalette.accent,
                        )
                        Spacer()
                        Text("Open Agent  ›")
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundColor(KestrelPalette.accent)
                    }
                }
                .padding(20)
            }
        }
        .widgetURL(URL(string: "kestrel://agent"))
    }
}

private struct KestrelQueueView: View {
    let entry: KestrelWidgetEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        ZStack {
            KestrelWidgetBackground()
            if family == .systemMedium {
                HStack(spacing: 18) {
                    QueueCount(data: entry.data)
                    VStack(alignment: .leading, spacing: 7) {
                        KestrelMark(compact: false)
                        Text(entry.data.queue.approvals > 0 ? "A decision is waiting" : "Queue is clear")
                            .font(.system(size: 16, weight: .bold, design: .rounded))
                            .foregroundColor(KestrelPalette.ink)
                            .lineLimit(2)
                        Text(entry.data.queue.approvals > 0 ? "Review it in Kestrel before the agent continues." : "Kestrel is ready for the next useful task.")
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundColor(KestrelPalette.muted)
                            .lineLimit(2)
                        Text("Open Approvals  ›")
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundColor(KestrelPalette.accent)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(16)
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        KestrelMark(compact: false)
                        Spacer()
                        Text("LIVE QUEUE")
                            .font(.system(size: 9, weight: .bold, design: .rounded))
                            .tracking(1.1)
                            .foregroundColor(KestrelPalette.muted)
                    }
                    HStack(spacing: 14) {
                        QueueCount(data: entry.data)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(entry.data.queue.approvals > 0 ? "Review before Kestrel continues" : "Nothing needs your attention")
                                .font(.system(size: 16, weight: .bold, design: .rounded))
                                .foregroundColor(KestrelPalette.ink)
                                .lineLimit(2)
                            Text(entry.data.status.detail)
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundColor(KestrelPalette.muted)
                                .lineLimit(2)
                        }
                    }
                    HStack(spacing: 8) {
                        KestrelMetric(label: "ACTIVE WORKERS", value: "\(entry.data.queue.activeWorkers)", tint: KestrelPalette.accent)
                        Spacer()
                        Text("Open Approvals  ›")
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundColor(KestrelPalette.accent)
                    }
                }
                .padding(20)
            }
        }
        .widgetURL(URL(string: "kestrel://approvals"))
    }
}

private struct QueueCount: View {
    let data: KestrelWidgetData

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(data.queue.approvals)")
                .font(.system(size: 39, weight: .bold, design: .rounded))
                .foregroundColor(data.queue.approvals > 0 ? KestrelPalette.warning : KestrelPalette.success)
                .minimumScaleFactor(0.7)
            Text(data.queue.approvals == 1 ? "approval" : "approvals")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .tracking(0.7)
                .foregroundColor(KestrelPalette.muted)
        }
        .frame(minWidth: 74, alignment: .leading)
    }
}

private struct KestrelPulseView: View {
    let entry: KestrelWidgetEntry
    @Environment(\.widgetFamily) private var family

    private var budgetProgress: Double {
        guard entry.data.pulse.modelBudgetDaily > 0 else { return 0 }
        return min(1, max(0, entry.data.pulse.modelCostToday / entry.data.pulse.modelBudgetDaily))
    }

    var body: some View {
        ZStack {
            KestrelWidgetBackground()
            if family == .systemSmall {
                VStack(alignment: .leading, spacing: 0) {
                    KestrelMark(compact: true)
                    Spacer(minLength: 8)
                    Text("PULSE")
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .tracking(1.1)
                        .foregroundColor(KestrelPalette.muted)
                    Text("\(entry.data.queue.activeWorkers)")
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .foregroundColor(KestrelPalette.accent)
                    Text(entry.data.queue.activeWorkers == 1 ? "active worker" : "active workers")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundColor(KestrelPalette.ink)
                    Spacer(minLength: 8)
                    Text(entry.data.pulse.connectedConnections == entry.data.pulse.totalConnections ? "All routes ready" : "Check connections")
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                        .foregroundColor(KestrelPalette.muted)
                        .lineLimit(1)
                }
                .padding(14)
            } else {
                VStack(alignment: .leading, spacing: 13) {
                    HStack {
                        KestrelMark(compact: false)
                        Spacer()
                        StatusLabel(data: entry.data, compact: false)
                    }
                    HStack(alignment: .bottom) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("TODAY'S MODEL USE")
                                .font(.system(size: 9, weight: .bold, design: .rounded))
                                .tracking(1.0)
                                .foregroundColor(KestrelPalette.muted)
                            Text(String(format: "$%.2f", entry.data.pulse.modelCostToday))
                                .font(.system(size: 25, weight: .bold, design: .rounded))
                                .foregroundColor(KestrelPalette.ink)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 4) {
                            Text("ROUTE")
                                .font(.system(size: 9, weight: .bold, design: .rounded))
                                .tracking(1.0)
                                .foregroundColor(KestrelPalette.muted)
                            Text(entry.data.pulse.model)
                                .font(.system(size: 11, weight: .semibold, design: .rounded))
                                .foregroundColor(KestrelPalette.accent)
                                .lineLimit(1)
                        }
                    }
                    ProgressView(value: budgetProgress)
                        .tint(KestrelPalette.accent)
                    HStack {
                        Text(entry.data.pulse.modelBudgetDaily > 0 ? String(format: "%.0f%% of daily budget", budgetProgress * 100) : "No budget set")
                            .font(.system(size: 10, weight: .medium, design: .rounded))
                            .foregroundColor(KestrelPalette.muted)
                        Spacer()
                        Text("\(entry.data.pulse.connectedConnections)/\(entry.data.pulse.totalConnections) routes")
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundColor(KestrelPalette.ink)
                    }
                }
                .padding(16)
            }
        }
        .widgetURL(URL(string: "kestrel://readiness"))
    }
}

private struct KestrelMetric: View {
    let label: String
    let value: String
    let tint: Color

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(tint).frame(width: 6, height: 6)
            Text("\(label)  \(value)")
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundColor(KestrelPalette.ink)
                .lineLimit(1)
        }
    }
}

struct KestrelFocusWidget: Widget {
    let kind = "com.kestrel.desktop.widget.focus"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: KestrelTimelineProvider()) { entry in
            KestrelFocusView(entry: entry)
        }
        .configurationDisplayName("Focus")
        .description("See what Kestrel is working on and jump back in.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct KestrelQueueWidget: Widget {
    let kind = "com.kestrel.desktop.widget.queue"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: KestrelTimelineProvider()) { entry in
            KestrelQueueView(entry: entry)
        }
        .configurationDisplayName("Queue")
        .description("Keep approvals and active agent work visible.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

struct KestrelPulseWidget: Widget {
    let kind = "com.kestrel.desktop.widget.pulse"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: KestrelTimelineProvider()) { entry in
            KestrelPulseView(entry: entry)
        }
        .configurationDisplayName("Pulse")
        .description("A quiet read on model use, workers, and routes.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct KestrelWidgetBundle: WidgetBundle {
    var body: some Widget {
        KestrelFocusWidget()
        KestrelQueueWidget()
        KestrelPulseWidget()
    }
}
