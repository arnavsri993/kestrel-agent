import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { EventApplicationManager } from "./event-applications";

describe("event application manager", () => {
  it("persists a review and explicit approval boundary before submission", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const manager = new EventApplicationManager(database, () => new Date("2026-07-23T14:00:00.000Z"));
    const draft = manager.create({ title: "Builder Weekend", organizer: "Example Labs", url: "https://events.example.test/apply", deadline: "2026-08-01T18:00:00Z" });
    const ready = manager.update(draft.id, {
      status: "ready",
      eligibility: [{ id: "age", label: "18 or older", met: true, evidence: "Confirmed by applicant" }],
      answers: [{ id: "bio", label: "Short bio", value: "Product engineer.", required: true, reviewed: true, sensitivity: "personal", source: "agent" }]
    });
    expect(ready.status).toBe("ready");
    expect(() => manager.markSubmitted(draft.id, "receipt")).toThrow("approved");
    expect(manager.update(draft.id, { status: "approved" }).approvedAt).toBeTruthy();
    expect(manager.markSubmitted(draft.id, "Confirmation #123")).toMatchObject({ status: "submitted", receipt: "Confirmation #123" });
    expect(manager.list()).toHaveLength(1);
    database.close();
  });

  it("rejects unsafe URLs and incomplete review", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const manager = new EventApplicationManager(database);
    expect(() => manager.create({ title: "Event", organizer: "Host", url: "http://events.example.test" })).toThrow("HTTPS");
    const draft = manager.create({ title: "Event", organizer: "Host", url: "https://events.example.test" });
    manager.update(draft.id, {
      eligibility: [{ id: "region", label: "Eligible region", met: null }],
      answers: [{ id: "email", label: "Email", value: "", required: true, reviewed: false, sensitivity: "sensitive", source: "profile" }]
    });
    expect(() => manager.update(draft.id, { status: "approved" })).toThrow("Review");
    database.close();
  });

  it("recovers from malformed persisted application state", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const manager = new EventApplicationManager(database);
    database.setPrivateState("event-applications.v1", { corrupted: true });
    expect(manager.list()).toEqual([]);
    database.setPrivateState("event-applications.v1", [null, { id: "incomplete", updatedAt: "2026-07-23T14:00:00.000Z" }]);
    expect(manager.list()).toEqual([]);
    database.close();
  });
});
