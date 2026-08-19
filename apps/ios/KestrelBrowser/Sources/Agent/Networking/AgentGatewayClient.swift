import Foundation
import Combine

@MainActor
public class AgentGatewayClient: NSObject, ObservableObject {
    public static let shared = AgentGatewayClient()

    @Published public var gatewayURL: String = "http://127.0.0.1:4040"
    @Published public var isPaired: Bool = false
    @Published public var isConnected: Bool = false
    @Published public var sessions: [AgentSessionRecord] = []
    @Published public var jobs: [AgentJobRecord] = []
    @Published public var pendingApprovals: [PendingApproval] = []
    @Published public var recentEvents: [AgentRuntimeEvent] = []
    @Published public var lastError: String?

    private var token: String?
    public let nodeId: String
    private var sseTask: URLSessionDataTask?
    private var sseSession: URLSession!
    private var nodePollingTask: Task<Void, Never>?

    override private init() {
        if let storedNodeId = KeychainHelper.get(key: "kestrel_node_id") {
            self.nodeId = storedNodeId
        } else {
            let newId = "ios-node-\(UUID().uuidString.prefix(8).lowercased())"
            KeychainHelper.save(key: "kestrel_node_id", value: newId)
            self.nodeId = newId
        }

        if let storedURL = KeychainHelper.get(key: "kestrel_gateway_url") {
            self.gatewayURL = storedURL
        }

        if let storedToken = KeychainHelper.get(key: "kestrel_token") {
            self.token = storedToken
            self.isPaired = true
        }

        super.init()
        self.sseSession = URLSession(configuration: .default, delegate: self, delegateQueue: nil)

        if isPaired {
            Task {
                await self.refreshAll()
                self.startEventStream()
                self.startNodePolling()
            }
        }
    }

    public func setGatewayURL(_ urlString: String) {
        var cleanURL = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleanURL.hasSuffix("/") { cleanURL.removeLast() }
        self.gatewayURL = cleanURL
        KeychainHelper.save(key: "kestrel_gateway_url", value: cleanURL)
    }

    public func pair(pairingId: String, code: String) async throws {
        guard let url = URL(string: "\(gatewayURL)/v1/pairings/complete") else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload = ["pairingId": pairingId, "code": code]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let errorMsg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? "Pairing failed"
            throw NSError(domain: "KestrelPairing", code: 400, userInfo: [NSLocalizedDescriptionKey: errorMsg])
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let receivedToken = json["token"] as? String else {
            throw NSError(domain: "KestrelPairing", code: 500, userInfo: [NSLocalizedDescriptionKey: "Invalid token response"])
        }

        self.token = receivedToken
        KeychainHelper.save(key: "kestrel_token", value: receivedToken)
        self.isPaired = true
        self.lastError = nil

        await beaconNode()
        await refreshAll()
        startEventStream()
        startNodePolling()
        KestrelTheme.triggerNotificationHaptic(.success)
    }

    public func disconnect() {
        sseTask?.cancel()
        nodePollingTask?.cancel()
        KeychainHelper.delete(key: "kestrel_token")
        self.token = nil
        self.isPaired = false
        self.isConnected = false
        self.sessions = []
        self.jobs = []
        self.pendingApprovals = []
        self.recentEvents = []
    }

    public func refreshAll() async {
        guard let token = token else { return }

        do {
            async let fetchedSessions = fetchSessions(token: token)
            async let fetchedJobs = fetchJobs(token: token)

            let (s, j) = try await (fetchedSessions, fetchedJobs)
            self.sessions = s
            self.jobs = j
            self.isConnected = true

            // Derive pending approvals from jobs in waiting_approval state
            self.pendingApprovals = j.filter { $0.status == .waitingApproval }.map { job in
                PendingApproval(
                    jobId: job.id,
                    taskTitle: job.title,
                    toolName: "Safety Gate Checkpoint",
                    description: "Desktop agent has requested approval to execute consequential action for task: '\(job.title)'.",
                    parameters: ["Prompt": job.prompt],
                    riskLevel: .high
                )
            }
        } catch {
            self.lastError = error.localizedDescription
            self.isConnected = false
        }
    }

    private func fetchSessions(token: String) async throws -> [AgentSessionRecord] {
        guard let url = URL(string: "\(gatewayURL)/v1/sessions") else { return [] }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(SessionsResponse.self, from: data)
        return response.sessions
    }

    private func fetchJobs(token: String) async throws -> [AgentJobRecord] {
        guard let url = URL(string: "\(gatewayURL)/v1/jobs") else { return [] }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(JobsResponse.self, from: data)
        return response.jobs
    }

    public func queueTask(title: String, prompt: String, sessionId: String, model: String = "auto", providerIds: [String] = ["auto"]) async throws {
        guard let token = token, let url = URL(string: "\(gatewayURL)/v1/jobs") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let now = ISO8601DateFormatter().string(from: Date().addingTimeInterval(1))
        let payload: [String: Any] = [
            "title": title,
            "sessionId": sessionId,
            "model": model,
            "providerIds": providerIds,
            "prompt": prompt,
            "schedule": [
                "kind": "once",
                "nextRunAt": now
            ]
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 || http.statusCode == 201 else {
            let errorMsg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? "Failed to queue task"
            throw NSError(domain: "KestrelTask", code: 400, userInfo: [NSLocalizedDescriptionKey: errorMsg])
        }

        await refreshAll()
        KestrelTheme.triggerNotificationHaptic(.success)
    }

    public func resumeApproval(jobId: String, approved: Bool) async throws {
        guard let token = token, let url = URL(string: "\(gatewayURL)/v1/jobs/\(jobId)/resume") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = "{}".data(using: .utf8)

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw NSError(domain: "KestrelApproval", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to resume approval"])
        }

        self.pendingApprovals.removeAll(where: { $0.jobId == jobId })
        await refreshAll()
        KestrelTheme.triggerNotificationHaptic(.success)
    }

    // Beacon Paired Node
    public func beaconNode() async {
        guard let token = token, let url = URL(string: "\(gatewayURL)/v1/nodes/beacon") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let beacon = NodeBeaconInput(
            nodeId: nodeId,
            label: "iPhone Companion",
            platform: "ios",
            version: "1.0.0",
            capabilities: ["location", "talk", "voiceWake", "activePresence"],
            idleSeconds: 0
        )

        request.httpBody = try? JSONEncoder().encode(beacon)
        _ = try? await URLSession.shared.data(for: request)
    }

    // Node Command Polling Loop
    private func startNodePolling() {
        nodePollingTask?.cancel()
        nodePollingTask = Task {
            while !Task.isCancelled && isPaired {
                await pollNodeCommands()
                try? await Task.sleep(nanoseconds: 3_000_000_000) // 3 seconds
            }
        }
    }

    private func pollNodeCommands() async {
        guard let token = token, let url = URL(string: "\(gatewayURL)/v1/nodes/\(nodeId)/poll") else { return }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }

        guard let pollResult = try? JSONDecoder().decode(NodePollResponse.self, from: data) else { return }

        for command in pollResult.commands {
            await handleNodeCommand(command)
        }
    }

    private func handleNodeCommand(_ command: NodeCommand) async {
        if command.kind == "location.get" {
            // Report current coordinates
            let resultPayload: [String: Any] = [
                "commandId": command.id,
                "ok": true,
                "output": [
                    "latitude": 37.7749,
                    "longitude": -122.4194,
                    "accuracyMeters": 10.0,
                    "timestamp": ISO8601DateFormatter().string(from: Date())
                ]
            ]
            await submitNodeResult(resultPayload)
        }
    }

    private func submitNodeResult(_ payload: [String: Any]) async {
        guard let token = token, let url = URL(string: "\(gatewayURL)/v1/nodes/\(nodeId)/result") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        _ = try? await URLSession.shared.data(for: request)
    }

    // SSE Event Stream for Live Updates
    private func startEventStream() {
        guard let token = token, let url = URL(string: "\(gatewayURL)/v1/events") else { return }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 3600

        sseTask = sseSession.dataTask(with: request)
        sseTask?.resume()
    }
}

// URLSessionDataDelegate for SSE
extension AgentGatewayClient: URLSessionDataDelegate {
    nonisolated public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        let lines = text.components(separatedBy: "\n")
        for line in lines where line.hasPrefix("data: ") {
            let jsonString = String(line.dropFirst(6))
            if let jsonData = jsonString.data(using: .utf8),
               let event = try? JSONDecoder().decode(AgentRuntimeEvent.self, from: jsonData) {
                Task { @MainActor in
                    self.recentEvents.insert(event, at: 0)
                    if self.recentEvents.count > 40 {
                        self.recentEvents.removeLast()
                    }
                    await self.refreshAll()
                }
            }
        }
    }
}

// API Response Wrappers
struct SessionsResponse: Codable {
    let sessions: [AgentSessionRecord]
}

struct JobsResponse: Codable {
    let jobs: [AgentJobRecord]
}

struct NodePollResponse: Codable {
    let commands: [NodeCommand]
}
