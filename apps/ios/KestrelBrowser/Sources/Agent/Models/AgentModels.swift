import Foundation

public struct AgentSessionRecord: Identifiable, Codable, Equatable {
    public let id: String
    public let title: String
    public let createdAt: String
    public let updatedAt: String

    public init(id: String, title: String, createdAt: String, updatedAt: String) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct AgentJobRecord: Identifiable, Codable, Equatable {
    public let id: String
    public let title: String
    public let sessionId: String
    public let model: String?
    public let providerIds: [String]?
    public let prompt: String
    public var status: JobStatus
    public let schedule: JobSchedule?
    public let createdAt: String
    public var updatedAt: String

    public enum JobStatus: String, Codable {
        case pending
        case running
        case waitingApproval = "waiting_approval"
        case completed
        case failed
        case cancelled
    }

    public struct JobSchedule: Codable, Equatable {
        public let kind: String
        public let nextRunAt: String
    }
}

public struct PendingApproval: Identifiable, Codable, Equatable {
    public let id: String
    public let jobId: String
    public let taskTitle: String
    public let toolName: String
    public let description: String
    public let parameters: [String: String]
    public let riskLevel: RiskLevel

    public enum RiskLevel: String, Codable {
        case low
        case medium
        case high
        case critical
    }

    public init(
        id: String = UUID().uuidString,
        jobId: String,
        taskTitle: String,
        toolName: String,
        description: String,
        parameters: [String: String] = [:],
        riskLevel: RiskLevel = .medium
    ) {
        self.id = id
        self.jobId = jobId
        self.taskTitle = taskTitle
        self.toolName = toolName
        self.description = description
        self.parameters = parameters
        self.riskLevel = riskLevel
    }
}

public struct AgentRuntimeEvent: Identifiable, Codable, Equatable {
    public var id: String { "\(type)_\(createdAt)" }
    public let type: String
    public let createdAt: String
    public let payload: Payload

    public struct Payload: Codable, Equatable {
        public let toolName: String?
        public let status: String?
        public let state: String?
    }
}

public struct NodeBeaconInput: Codable {
    public let nodeId: String
    public let label: String
    public let platform: String // "ios"
    public let version: String?
    public let capabilities: [String] // ["location", "talk", "voiceWake", "activePresence"]
    public let idleSeconds: Int?
}

public struct NodeCommand: Codable {
    public let id: String
    public let kind: String // "location.get" | "talk.speak"
    public let createdAt: String
    public let expiresAt: String
    public let input: [String: AnyCodable]
}

public struct AnyCodable: Codable, Equatable {
    public let value: Any

    public init(_ value: Any) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            value = string
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else {
            value = ""
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let string = value as? String {
            try container.encode(string)
        } else if let int = value as? Int {
            try container.encode(int)
        } else if let double = value as? Double {
            try container.encode(double)
        } else if let bool = value as? Bool {
            try container.encode(bool)
        }
    }

    public static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        String(describing: lhs.value) == String(describing: rhs.value)
    }
}
