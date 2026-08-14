import { describe, test, expect } from "vitest";
import { DevelopmentEmailConnector, DevelopmentCalendarConnector } from "./connectors";

describe("DevelopmentEmailConnector", () => {
  test("creates and verifies an email draft", () => {
    const connector = new DevelopmentEmailConnector();
    const result = connector.sendDraft({
      operationId: "op1",
      to: "test@example.com",
      subject: "Hello",
      body: "World",
    });

    expect(result.messageId).toMatch(/^mock-message-\d+$/);
    expect(connector.verifySent(result.messageId)).toBe(true);
  });

  test("returns the same message id for the same operation id", () => {
    const connector = new DevelopmentEmailConnector();
    const res1 = connector.sendDraft({
      operationId: "op-id",
      to: "a@a.com",
      subject: "A",
      body: "B",
    });

    const res2 = connector.sendDraft({
      operationId: "op-id",
      to: "b@b.com",
      subject: "B",
      body: "C",
    });

    expect(res1.messageId).toBe(res2.messageId);
    // The underlying data should remain as the first submission due to existing check
    const sentData = connector.sent.get("op-id");
    expect(sentData?.to).toBe("a@a.com");
  });

  test("verifySent returns false for non-existent messages", () => {
    const connector = new DevelopmentEmailConnector();
    expect(connector.verifySent("does-not-exist")).toBe(false);
  });
});

describe("DevelopmentCalendarConnector", () => {
  test("creates and verifies a calendar event", () => {
    const connector = new DevelopmentCalendarConnector();
    const result = connector.createEvent({
      operationId: "op1",
      title: "Meeting",
      startsAt: "2026-08-14T10:00:00Z",
      durationMinutes: 60,
    });

    expect(result.eventId).toMatch(/^mock-event-\d+$/);
    expect(connector.verifyEvent(result.eventId)).toBe(true);
  });

  test("returns the same event id for the same operation id", () => {
    const connector = new DevelopmentCalendarConnector();
    const res1 = connector.createEvent({
      operationId: "op2",
      title: "Task 1",
      startsAt: "2026-08-14T10:00:00Z",
      durationMinutes: 30,
    });

    const res2 = connector.createEvent({
      operationId: "op2",
      title: "Task 2",
      startsAt: "2026-08-15T10:00:00Z",
      durationMinutes: 45,
    });

    expect(res1.eventId).toBe(res2.eventId);
    const eventData = connector.events.get("op2");
    expect(eventData?.title).toBe("Task 1");
  });

  test("verifyEvent returns false for non-existent events", () => {
    const connector = new DevelopmentCalendarConnector();
    expect(connector.verifyEvent("does-not-exist")).toBe(false);
  });
});
