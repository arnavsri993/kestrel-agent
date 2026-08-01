import { randomUUID } from "node:crypto";
import type { KestrelDatabase } from "@kestrel/database";
import type { AgentRuntime } from "./runtime";

export type EventApplicationStatus = "draft" | "preparing" | "ready" | "approved" | "submitted" | "needs_attention";
export type EventAnswerSensitivity = "public" | "personal" | "sensitive";
export interface EventApplicationAnswer {
  id: string;
  label: string;
  value: string;
  required: boolean;
  reviewed: boolean;
  sensitivity: EventAnswerSensitivity;
  source: "profile" | "event" | "agent";
}
export interface EventEligibilityItem { id: string; label: string; met: boolean | null; evidence?: string | undefined; }
export interface EventApplication {
  id: string;
  title: string;
  organizer: string;
  url: string;
  deadline?: string;
  status: EventApplicationStatus;
  eligibility: EventEligibilityItem[];
  answers: EventApplicationAnswer[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  submittedAt?: string;
  receipt?: string;
}

const KEY = "event-applications.v1";
function validHttps(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Event URL must be credential-free HTTPS."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Event URL must be credential-free HTTPS.");
  return url.toString();
}
function clean(value: string, maximum: number, label: string): string {
  const result = value.trim();
  if (!result || result.length > maximum) throw new Error(`${label} is invalid.`);
  return result;
}

export class EventApplicationManager {
  constructor(private readonly database: KestrelDatabase, private readonly now: () => Date = () => new Date()) {}
  list(): EventApplication[] { return (this.database.getPrivateState<EventApplication[]>(KEY) ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  create(input: { title: string; organizer: string; url: string; deadline?: string }): EventApplication {
    const timestamp = this.now().toISOString();
    const deadline = input.deadline?.trim();
    if (deadline && !Number.isFinite(new Date(deadline).getTime())) throw new Error("Event deadline is invalid.");
    const application: EventApplication = {
      id: `event-application-${randomUUID()}`,
      title: clean(input.title, 200, "Event title"),
      organizer: clean(input.organizer, 200, "Event organizer"),
      url: validHttps(input.url),
      ...(deadline ? { deadline: new Date(deadline).toISOString() } : {}),
      status: "draft", eligibility: [], answers: [], createdAt: timestamp, updatedAt: timestamp
    };
    this.save([application, ...this.list()]);
    return application;
  }
  update(id: string, patch: { status?: EventApplicationStatus; eligibility?: EventEligibilityItem[]; answers?: EventApplicationAnswer[] }): EventApplication {
    const applications = this.list(); const index = applications.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("Event application was not found.");
    const current = applications[index]!;
    if (patch.answers && (patch.answers.length > 100 || patch.answers.some((answer) => !answer.id || answer.label.length > 300 || answer.value.length > 20_000 || !["public", "personal", "sensitive"].includes(answer.sensitivity)))) throw new Error("Event application answers are invalid.");
    if (patch.eligibility && (patch.eligibility.length > 100 || patch.eligibility.some((item) => !item.id || item.label.length > 500 || (item.evidence?.length ?? 0) > 2_000))) throw new Error("Event eligibility is invalid.");
    const next: EventApplication = { ...current, ...patch, updatedAt: this.now().toISOString() };
    if (patch.status && patch.status !== "approved") delete next.approvedAt;
    if (patch.status === "approved") {
      const unresolved = (patch.eligibility ?? current.eligibility).some((item) => item.met !== true);
      const unreviewed = (patch.answers ?? current.answers).some((answer) => answer.required && (!answer.value.trim() || !answer.reviewed));
      if (unresolved || unreviewed) throw new Error("Review required answers and eligibility before approval.");
      next.approvedAt = next.updatedAt;
    }
    applications[index] = next; this.save(applications); return next;
  }
  markSubmitted(id: string, receipt: string): EventApplication {
    const current = this.list().find((item) => item.id === id);
    if (!current || current.status !== "approved") throw new Error("Only an approved event application can be marked submitted.");
    const timestamp = this.now().toISOString();
    return this.finishSubmitted(id, clean(receipt, 4_000, "Submission receipt"), timestamp);
  }
  private finishSubmitted(id: string, receipt: string, timestamp: string): EventApplication {
    const applications = this.list(); const index = applications.findIndex((item) => item.id === id); const current = applications[index]!;
    const next = { ...current, status: "submitted" as const, submittedAt: timestamp, receipt, updatedAt: timestamp };
    applications[index] = next; this.save(applications); return next;
  }
  remove(id: string): void { const next = this.list().filter((item) => item.id !== id); if (next.length === this.list().length) throw new Error("Event application was not found."); this.save(next); }
  private save(value: EventApplication[]): void {
    if (value.length > 200 || Buffer.byteLength(JSON.stringify(value)) > 5_000_000) throw new Error("Event application storage exceeds limits.");
    this.database.setPrivateState(KEY, value);
  }
}

export const EVENT_APPLICATION_TOOL_NAMES = ["events.list", "events.prepare", "events.mark_submitted"] as const;
export function installEventApplicationTools(runtime: AgentRuntime, manager: EventApplicationManager, sessionId: string): void {
  runtime.registerExternalTool({
    descriptor: { name: "events.list", title: "List event applications", description: "Read the user's local event and hackathon application workspace.", category: "automation", riskLevel: "sensitive", readOnly: true, requiresWorkspace: false, source: "builtin", tags: ["events", "applications", "private"] },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ applications: manager.list() })
  });
  runtime.registerExternalTool({
    descriptor: { name: "events.mark_submitted", title: "Record a verified event submission", description: "Mark an explicitly approved application submitted only after the external site returns a visible confirmation or receipt.", category: "automation", riskLevel: "high_consequence", readOnly: false, requiresWorkspace: false, source: "builtin", tags: ["events", "applications", "external-submission", "receipt-required"] },
    inputSchema: { type: "object", properties: { id: { type: "string" }, receipt: { type: "string", minLength: 1, maxLength: 4_000 } }, required: ["id", "receipt"], additionalProperties: false },
    execute: async (_context, input) => ({ application: manager.markSubmitted(String(input.id), String(input.receipt)) })
  });
  runtime.registerExternalTool({
    descriptor: { name: "events.prepare", title: "Prepare an event application for review", description: "Write eligibility checks and draft answers into a local application. This never submits an external form.", category: "automation", riskLevel: "sensitive", readOnly: false, requiresWorkspace: false, source: "builtin", tags: ["events", "applications", "review-required"] },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        eligibility: { type: "array", maxItems: 100, items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, met: { type: ["boolean", "null"] }, evidence: { type: "string" } }, required: ["id", "label", "met"], additionalProperties: false } },
        answers: { type: "array", maxItems: 100, items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, value: { type: "string" }, required: { type: "boolean" }, reviewed: { const: false }, sensitivity: { enum: ["public", "personal", "sensitive"] }, source: { const: "agent" } }, required: ["id", "label", "value", "required", "reviewed", "sensitivity", "source"], additionalProperties: false } }
      },
      required: ["id", "eligibility", "answers"],
      additionalProperties: false
    },
    execute: async (_context, input) => ({
      application: manager.update(String(input.id), {
        status: "ready",
        eligibility: input.eligibility as EventEligibilityItem[],
        answers: input.answers as EventApplicationAnswer[]
      })
    })
  });
  for (const name of EVENT_APPLICATION_TOOL_NAMES) runtime.allowTool(sessionId, name);
}
