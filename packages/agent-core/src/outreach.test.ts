import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { DevelopmentEmailConnector } from "./connectors";
import { OutreachManager } from "./outreach";

describe("outreach manager", () => {
  it("keeps outreach local until approval, then verifies delivery", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const connector = new DevelopmentEmailConnector();
    const manager = new OutreachManager(database, connector, () => new Date("2026-08-03T18:00:00.000Z"));
    const contact = manager.upsertContact({ name: "Morgan Lee", email: "Morgan@Example.com", organization: "Example Labs", source: "application-form", campaign: "application-follow-up" });
    const draft = manager.createDraft({ contactId: contact.id, subject: "Finish your application", body: "If you still want to apply, here is the next step.", purpose: "application_follow_up" });

    expect(draft.status).toBe("draft");
    expect(() => manager.sendDraft(draft.id)).toThrow("explicit approval");
    const approved = manager.approveDraft(draft.id);
    const sent = manager.sendDraft(approved.id);

    expect(sent).toMatchObject({ status: "sent", providerMessageId: "mock-message-1" });
    expect(manager.listContacts()[0]).toMatchObject({ email: "morgan@example.com", status: "contacted" });
    expect(manager.sendDraft(draft.id)).toEqual(sent);
    database.close();
  });

  it("deduplicates contacts and blocks do-not-contact recipients", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const manager = new OutreachManager(database, new DevelopmentEmailConnector());
    const contact = manager.upsertContact({ name: "Taylor", email: "taylor@example.com" });
    const updated = manager.upsertContact({ name: "Taylor Updated", email: "TAYLOR@example.com", role: "Founder" });

    expect(updated.id).toBe(contact.id);
    expect(manager.listContacts()).toHaveLength(1);
    manager.updateContactStatus(contact.id, "do_not_contact");
    expect(() => manager.createDraft({ contactId: contact.id, subject: "Hello", body: "Body", purpose: "business_outreach" })).toThrow("do not contact");
    database.close();
  });
});
