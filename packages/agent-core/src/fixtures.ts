import type { ActivityItem, Approval, MemoryRecord, TaskOpportunity } from "@kestrel/shared-types";

export const FIXTURE_NOW = "2026-07-22T14:00:00.000Z";

export const teacherOpportunity: TaskOpportunity = {
  id: "opp-teacher-test-date",
  title: "Choose the better test date",
  description: "Ms. Rivera offered Friday or Monday. Calendar context makes one option meaningfully better.",
  reasonDetected: "A new teacher email contains two dates, a response request, and a deadline-sensitive decision.",
  triggerEventIds: ["evt-teacher-email"],
  relatedEntityIds: ["person-ms-rivera", "class-algebra-2", "event-friday-swim"],
  relevantMemoryIds: ["memory-friday-swim", "memory-weekend-study"],
  proposedGoal: "Confirm Monday, reserve the test, and protect study time.",
  expectedOutputs: [
    { type: "email-draft", description: "A concise reply choosing Monday" },
    { type: "calendar-event", description: "A tentative Monday test event" },
    { type: "study-plan", description: "Two weekend preparation blocks" }
  ],
  confidence: 0.96,
  urgency: 0.72,
  importance: 0.82,
  expectedUtility: 8.4,
  estimatedInterruptionCost: 1.1,
  estimatedComputeCost: 0.02,
  estimatedDurationSeconds: 45,
  riskLevel: "external",
  requiredApprovalLevel: 2,
  status: "awaiting_approval",
  createdAt: FIXTURE_NOW,
  expiresAt: "2026-07-24T22:00:00.000Z",
  priority: 4.71
};

export function emptyOpportunity(now: string): TaskOpportunity {
  return {
    id: "opportunity-empty",
    title: "No task queued",
    description: "Kestrel will show the next useful step after you ask for one.",
    reasonDetected: "No background task has been requested.",
    triggerEventIds: [],
    relatedEntityIds: [],
    relevantMemoryIds: [],
    proposedGoal: "Start with a request in the conversation.",
    expectedOutputs: [],
    confidence: 0,
    urgency: 0,
    importance: 0,
    expectedUtility: 0,
    estimatedInterruptionCost: 0,
    estimatedComputeCost: 0,
    riskLevel: "read_only",
    requiredApprovalLevel: 0,
    status: "suggested",
    createdAt: now,
    priority: 0,
  };
}

export const teacherApproval: Approval = {
  id: "approval-teacher-monday",
  title: "Finalize the Monday test plan?",
  recommendation: "Monday looks better.",
  reasoning: "Friday is compressed by swim immediately after school. Monday leaves the weekend open for two study blocks and has no known conflict.",
  proposedEmail: {
    to: "Ms. Rivera <teacher@example.test>",
    subject: "Re: Test date",
    body: "Hi Ms. Rivera,\n\nMonday works better for me. Thank you for giving me the option.\n\nBest,\nJordan"
  },
  proposedCalendarEvent: {
    title: "Algebra II test",
    startsAt: "Monday, August 17 · 10:20 AM",
    durationMinutes: 55
  },
  proposedStudyBlocks: [
    { label: "Review chapters 5–6", startsAt: "Saturday, August 15 · 11:00 AM", durationMinutes: 50 },
    { label: "Practice problems", startsAt: "Sunday, August 16 · 4:00 PM", durationMinutes: 50 }
  ],
  evidence: [
    { id: "evidence-email", label: "Teacher email", value: "Friday or Monday", source: "Mock Gmail · thread 1842", confirmed: true },
    { id: "evidence-swim", label: "Friday calendar", value: "Swim practice · 3:30–5:15 PM", source: "Mock Calendar · recurring event", confirmed: true },
    { id: "evidence-monday", label: "Monday calendar", value: "No conflict found", source: "Mock Calendar · availability read", confirmed: true },
    { id: "evidence-study", label: "Study preference", value: "Weekend blocks before math tests", source: "Confirmed procedural memory", confirmed: true }
  ],
  riskLevel: "external",
  approvalLevel: 2,
  status: "pending",
  policySuggestion: "Always prepare scheduling replies to Ms. Rivera; still ask before sending.",
  createdAt: FIXTURE_NOW
};

function memory(id: string, content: string, structuredData: Record<string, unknown>, sourceType = "user-confirmed"): MemoryRecord {
  return {
    id,
    type: "semantic",
    content,
    structuredData,
    sourceIds: [`source-${id}`],
    sourceType,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    confidence: 0.98,
    importance: 0.8,
    sensitivity: "personal",
    status: "active",
    entityIds: Object.values(structuredData).filter((value): value is string => typeof value === "string"),
    userConfirmed: true,
    inferred: false
  };
}

export const fixtureMemories: MemoryRecord[] = [
  memory("memory-friday-swim", "Swim practice starts immediately after school every Friday.", { category: "schedule", day: "Friday", startsAt: "15:30" }),
  { ...memory("memory-weekend-study", "Weekend study blocks work best before math tests.", { category: "preferences", subject: "math" }), type: "procedural" },
  memory("memory-drone", "The user's drone is a DJI Mini 3 with the controller that uses a connected phone.", { category: "devices", drone: "DJI Mini 3", controller: "RC-N1 style phone controller" }),
  memory("memory-phone", "The connected phone is an iPhone 16 Pro running an iOS developer beta.", { category: "software_versions", phone: "iPhone 16 Pro", os: "iOS developer beta" }),
  memory("memory-dji-symptoms", "The controller charges the phone and launches DJI Fly, but DJI Fly reports RC not connected.", { category: "prior_errors", error: "RC not connected to mobile device", positiveSignals: "charging and app launch" }),
  memory("memory-dji-attempts", "Another cable was tested and a phone restart did not fix the DJI connection.", { category: "prior_attempts", attempts: "alternate cable; restart" })
];

export const initialActivity: ActivityItem[] = [
  { id: "activity-email", title: "Teacher email observed", detail: "Detected a message that asks for a Friday-or-Monday decision.", timestamp: "2026-07-22T13:57:00.000Z", status: "observed", sourceIds: ["evt-teacher-email"] },
  { id: "activity-decision", title: "Decision detected", detail: "Extracted two supported options; no dates were invented.", timestamp: "2026-07-22T13:57:02.000Z", status: "reasoned", sourceIds: ["evt-teacher-email"] },
  { id: "activity-calendar", title: "Calendar checked", detail: "Friday swim conflicts with recovery and study time; Monday is open.", timestamp: "2026-07-22T13:57:03.000Z", status: "verified", sourceIds: ["event-friday-swim"] },
  { id: "activity-plan", title: "Plan prepared", detail: "Drafted the reply, test event, and two study blocks.", timestamp: "2026-07-22T13:57:05.000Z", status: "reasoned", sourceIds: ["approval-teacher-monday"] },
  { id: "activity-approval", title: "Approval required", detail: "Sending the reply is an external action, so execution is paused.", timestamp: "2026-07-22T13:57:06.000Z", status: "waiting", sourceIds: ["approval-teacher-monday"] }
];
