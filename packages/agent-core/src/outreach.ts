import { randomUUID } from "node:crypto";
import type { KestrelDatabase } from "@kestrel/database";
import type { AgentRuntime } from "./runtime";
import type { EmailConnector } from "./connectors";

export type OutreachContactStatus = "new" | "contacted" | "replied" | "do_not_contact";
export type OutreachDraftPurpose = "application_follow_up" | "business_outreach" | "recruiting" | "other";
export type OutreachDraftStatus = "draft" | "approved" | "sent" | "needs_attention";

export interface OutreachContact {
  id: string;
  name: string;
  email: string;
  organization?: string;
  role?: string;
  source?: string;
  campaign?: string;
  status: OutreachContactStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachDraft {
  id: string;
  contactId: string;
  recipientName: string;
  recipientEmail: string;
  subject: string;
  body: string;
  purpose: OutreachDraftPurpose;
  campaign?: string;
  status: OutreachDraftStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  sentAt?: string;
  providerMessageId?: string;
}

interface OutreachState {
  contacts: OutreachContact[];
  drafts: OutreachDraft[];
}

const KEY = "outreach.v1";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value: string, maximum: number, label: string): string {
  const result = value.trim();
  if (!result || result.length > maximum) throw new Error(`${label} is invalid.`);
  return result;
}

function optional(value: string | undefined, maximum: number, label: string): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  return clean(value, maximum, label);
}

function email(value: string): string {
  const result = clean(value, 320, "Contact email").toLowerCase();
  if (!EMAIL_PATTERN.test(result)) throw new Error("Contact email is invalid.");
  return result;
}

function emptyState(): OutreachState {
  return { contacts: [], drafts: [] };
}

export class OutreachManager {
  constructor(
    private readonly database: KestrelDatabase,
    private readonly emailConnector: EmailConnector,
    private readonly now: () => Date = () => new Date(),
  ) {}

  listContacts(): OutreachContact[] {
    return this.read().contacts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listDrafts(): OutreachDraft[] {
    return this.read().drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  upsertContact(input: {
    name: string;
    email: string;
    organization?: string;
    role?: string;
    source?: string;
    campaign?: string;
  }): OutreachContact {
    const state = this.read();
    const normalizedEmail = email(input.email);
    const timestamp = this.now().toISOString();
    const existing = state.contacts.find((contact) => contact.email === normalizedEmail);
    const next: OutreachContact = existing
      ? {
          ...existing,
          name: clean(input.name, 200, "Contact name"),
          email: normalizedEmail,
          ...this.optionalContactFields(input),
          updatedAt: timestamp,
        }
      : {
          id: `outreach-contact-${randomUUID()}`,
          name: clean(input.name, 200, "Contact name"),
          email: normalizedEmail,
          ...this.optionalContactFields(input),
          status: "new",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    this.save({ contacts: [next, ...state.contacts.filter((contact) => contact.id !== existing?.id)], drafts: state.drafts });
    return next;
  }

  updateContactStatus(id: string, status: OutreachContactStatus): OutreachContact {
    const state = this.read();
    const contact = state.contacts.find((candidate) => candidate.id === id);
    if (!contact) throw new Error("Outreach contact was not found.");
    const next = { ...contact, status, updatedAt: this.now().toISOString() };
    this.save({ contacts: state.contacts.map((candidate) => candidate.id === id ? next : candidate), drafts: state.drafts });
    return next;
  }

  createDraft(input: {
    contactId: string;
    subject: string;
    body: string;
    purpose: OutreachDraftPurpose;
    campaign?: string;
  }): OutreachDraft {
    const state = this.read();
    const contact = state.contacts.find((candidate) => candidate.id === input.contactId);
    if (!contact) throw new Error("Outreach contact was not found.");
    if (contact.status === "do_not_contact") throw new Error("This contact is marked do not contact.");
    const timestamp = this.now().toISOString();
    const campaign = optional(input.campaign, 200, "Outreach campaign");
    const draft: OutreachDraft = {
      id: `outreach-draft-${randomUUID()}`,
      contactId: contact.id,
      recipientName: contact.name,
      recipientEmail: contact.email,
      subject: clean(input.subject, 300, "Outreach subject"),
      body: clean(input.body, 20_000, "Outreach body"),
      purpose: input.purpose,
      ...(campaign ? { campaign } : {}),
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.save({ contacts: state.contacts, drafts: [draft, ...state.drafts] });
    return draft;
  }

  approveDraft(id: string): OutreachDraft {
    const state = this.read();
    const draft = state.drafts.find((candidate) => candidate.id === id);
    if (!draft) throw new Error("Outreach draft was not found.");
    if (draft.status === "sent") return draft;
    if (draft.status !== "draft") throw new Error("Only a draft can be approved.");
    const contact = state.contacts.find((candidate) => candidate.id === draft.contactId);
    if (!contact || contact.status === "do_not_contact") throw new Error("This contact is marked do not contact.");
    const next = { ...draft, status: "approved" as const, approvedAt: this.now().toISOString(), updatedAt: this.now().toISOString() };
    this.save({ contacts: state.contacts, drafts: state.drafts.map((candidate) => candidate.id === id ? next : candidate) });
    return next;
  }

  sendDraft(id: string): OutreachDraft {
    const state = this.read();
    const draft = state.drafts.find((candidate) => candidate.id === id);
    if (!draft) throw new Error("Outreach draft was not found.");
    if (draft.status === "sent") return draft;
    if (draft.status !== "approved") throw new Error("Outreach draft requires explicit approval before sending.");
    const contact = state.contacts.find((candidate) => candidate.id === draft.contactId);
    if (!contact || contact.status === "do_not_contact") throw new Error("This contact is marked do not contact.");
    const result = this.emailConnector.sendDraft({ operationId: `outreach-send:${draft.id}`, to: draft.recipientEmail, subject: draft.subject, body: draft.body });
    const timestamp = this.now().toISOString();
    if (!this.emailConnector.verifySent(result.messageId)) {
      const attention = { ...draft, status: "needs_attention" as const, providerMessageId: result.messageId, updatedAt: timestamp };
      this.save({ contacts: state.contacts, drafts: state.drafts.map((candidate) => candidate.id === id ? attention : candidate) });
      throw new Error("The email connector did not verify the sent message.");
    }
    const next = { ...draft, status: "sent" as const, providerMessageId: result.messageId, sentAt: timestamp, updatedAt: timestamp };
    this.save({
      contacts: state.contacts.map((candidate) => candidate.id === contact.id ? { ...candidate, status: "contacted" as const, updatedAt: timestamp } : candidate),
      drafts: state.drafts.map((candidate) => candidate.id === id ? next : candidate),
    });
    return next;
  }

  private optionalContactFields(input: { organization?: string; role?: string; source?: string; campaign?: string }): Partial<Pick<OutreachContact, "organization" | "role" | "source" | "campaign">> {
    const organization = optional(input.organization, 200, "Contact organization");
    const role = optional(input.role, 200, "Contact role");
    const source = optional(input.source, 200, "Contact source");
    const campaign = optional(input.campaign, 200, "Contact campaign");
    return {
      ...(organization ? { organization } : {}),
      ...(role ? { role } : {}),
      ...(source ? { source } : {}),
      ...(campaign ? { campaign } : {}),
    };
  }

  private read(): OutreachState {
    const state = this.database.getPrivateState<OutreachState>(KEY);
    if (!state || !Array.isArray(state.contacts) || !Array.isArray(state.drafts)) return emptyState();
    return { contacts: [...state.contacts], drafts: [...state.drafts] };
  }

  private save(state: OutreachState): void {
    if (state.contacts.length > 5_000 || state.drafts.length > 10_000 || Buffer.byteLength(JSON.stringify(state)) > 10_000_000) {
      throw new Error("Outreach storage exceeds limits.");
    }
    this.database.setPrivateState(KEY, state);
  }
}

export const OUTREACH_TOOL_NAMES = [
  "outreach.contacts.list",
  "outreach.contacts.upsert",
  "outreach.contacts.update_status",
  "outreach.drafts.list",
  "outreach.drafts.create",
  "outreach.drafts.approve",
  "outreach.send",
] as const;

export function installOutreachTools(runtime: AgentRuntime, manager: OutreachManager, sessionId: string): void {
  runtime.registerExternalTool({
    descriptor: { name: "outreach.contacts.list", title: "List outreach contacts", description: "Read the encrypted local outreach contact list, including recruitment and business prospects.", category: "connector", riskLevel: "sensitive", readOnly: true, requiresWorkspace: false, source: "builtin", tags: ["outreach", "contacts", "private"] },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ contacts: manager.listContacts() }),
  });
  runtime.registerExternalTool({
    descriptor: { name: "outreach.contacts.upsert", title: "Add or update an outreach contact", description: "Store one contact in the encrypted local outreach list. This never sends a message.", category: "connector", riskLevel: "sensitive", readOnly: false, requiresWorkspace: false, source: "builtin", tags: ["outreach", "contacts", "local"] },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        email: { type: "string", minLength: 3, maxLength: 320 },
        organization: { type: "string", maxLength: 200 },
        role: { type: "string", maxLength: 200 },
        source: { type: "string", maxLength: 200 },
        campaign: { type: "string", maxLength: 200 },
      },
      required: ["name", "email"],
      additionalProperties: false,
    },
    execute: async (_context, input) => ({ contact: manager.upsertContact({ name: String(input.name), email: String(input.email), ...(input.organization !== undefined ? { organization: String(input.organization) } : {}), ...(input.role !== undefined ? { role: String(input.role) } : {}), ...(input.source !== undefined ? { source: String(input.source) } : {}), ...(input.campaign !== undefined ? { campaign: String(input.campaign) } : {}) }) }),
  });
  runtime.registerExternalTool({
    descriptor: { name: "outreach.contacts.update_status", title: "Update outreach contact status", description: "Record a reply, contact attempt, or do-not-contact request in the encrypted local outreach list.", category: "connector", riskLevel: "sensitive", readOnly: false, requiresWorkspace: false, source: "builtin", tags: ["outreach", "contacts", "status"] },
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, status: { enum: ["new", "contacted", "replied", "do_not_contact"] } }, required: ["id", "status"], additionalProperties: false },
    execute: async (_context, input) => ({ contact: manager.updateContactStatus(String(input.id), input.status as OutreachContactStatus) }),
  });
  runtime.registerExternalTool({
    descriptor: { name: "outreach.drafts.list", title: "List outreach drafts", description: "Read local outreach drafts and their review or delivery state. No message is sent.", category: "connector", riskLevel: "sensitive", readOnly: true, requiresWorkspace: false, source: "builtin", tags: ["outreach", "drafts", "review"] },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ drafts: manager.listDrafts() }),
  });
  runtime.registerExternalTool({
    descriptor: { name: "outreach.drafts.create", title: "Create an outreach draft", description: "Create a local, reviewable outreach message for a stored contact. This never sends a message.", category: "connector", riskLevel: "sensitive", readOnly: false, requiresWorkspace: false, source: "builtin", tags: ["outreach", "drafts", "local", "review-required"] },
    inputSchema: { type: "object", properties: { contactId: { type: "string", minLength: 1 }, subject: { type: "string", minLength: 1, maxLength: 300 }, body: { type: "string", minLength: 1, maxLength: 20_000 }, purpose: { enum: ["application_follow_up", "business_outreach", "recruiting", "other"] }, campaign: { type: "string", maxLength: 200 } }, required: ["contactId", "subject", "body", "purpose"], additionalProperties: false },
    execute: async (_context, input) => ({ draft: manager.createDraft({ contactId: String(input.contactId), subject: String(input.subject), body: String(input.body), purpose: input.purpose as OutreachDraftPurpose, ...(input.campaign !== undefined ? { campaign: String(input.campaign) } : {}) }) }),
  });
  runtime.registerExternalTool({
    descriptor: { name: "outreach.drafts.approve", title: "Approve an outreach draft", description: "Mark one local outreach draft approved after the user has reviewed its recipient, purpose, and wording.", category: "connector", riskLevel: "sensitive", readOnly: false, requiresWorkspace: false, source: "builtin", tags: ["outreach", "drafts", "approval"] },
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false },
    execute: async (_context, input) => ({ draft: manager.approveDraft(String(input.id)) }),
  });
  runtime.registerExternalTool({
    descriptor: { name: "outreach.send", title: "Send an approved outreach message", description: "Send exactly one approved outreach draft through the configured email connector, then verify the provider result. A fresh one-time approval is always required; the development connector is deterministic and does not contact an account.", category: "connector", riskLevel: "external", readOnly: false, requiresWorkspace: false, source: "builtin", approvalMode: "always", tags: ["outreach", "email", "external", "approval-required", "verified"] },
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false },
    execute: async (_context, input) => ({ draft: manager.sendDraft(String(input.id)), verified: true }),
    verify: async (_context, _input, output) => ({ method: "EmailConnector.verifySent", evidence: { verified: output.verified === true, messageId: output.draft && typeof output.draft === "object" ? (output.draft as { providerMessageId?: unknown }).providerMessageId : undefined } }),
  });
  for (const name of OUTREACH_TOOL_NAMES) runtime.allowTool(sessionId, name);
}
