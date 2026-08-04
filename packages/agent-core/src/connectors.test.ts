import { describe, expect, it } from "vitest";
import { DevelopmentCalendarConnector, DevelopmentEmailConnector } from "./connectors";

describe("development connectors", () => {
  it("only replays an email operation when its content matches", () => {
    const connector = new DevelopmentEmailConnector();
    const input = { operationId: "email-operation-1", to: "person@example.test", subject: "Hello", body: "First message" };

    const first = connector.sendDraft(input);
    expect(connector.sendDraft(input)).toEqual(first);
    expect(() => connector.sendDraft({ ...input, body: "Different message" })).toThrow("different content");
    expect(connector.verifySent(first.messageId)).toBe(true);
    expect(connector.verifySent("missing-message")).toBe(false);
  });

  it("only replays a calendar operation when its details match", () => {
    const connector = new DevelopmentCalendarConnector();
    const input = { operationId: "calendar-operation-1", title: "Project review", startsAt: "2026-08-03T16:00:00.000Z", durationMinutes: 60 };

    const first = connector.createEvent(input);
    expect(connector.createEvent(input)).toEqual(first);
    expect(() => connector.createEvent({ ...input, durationMinutes: 90 })).toThrow("different details");
    expect(connector.verifyEvent(first.eventId)).toBe(true);
    expect(connector.verifyEvent("missing-event")).toBe(false);
  });
});
