import { describe, expect, it } from "vitest";
import { DevelopmentEmailConnector, DevelopmentCalendarConnector } from "./connectors.js";

describe("DevelopmentEmailConnector", () => {
  it("sends a draft and stores it", () => {
    const connector = new DevelopmentEmailConnector();
    const result = connector.sendDraft({ operationId: "op1", to: "test@example.com", subject: "Hello", body: "World" });
    expect(result.messageId).toBe("mock-message-1");
    expect(connector.sent.get("op1")).toEqual({ messageId: "mock-message-1", to: "test@example.com", subject: "Hello", body: "World" });
  });

  it("is idempotent for the same operationId", () => {
    const connector = new DevelopmentEmailConnector();
    connector.sendDraft({ operationId: "op1", to: "test@example.com", subject: "Hello", body: "World" });
    const result2 = connector.sendDraft({ operationId: "op1", to: "test2@example.com", subject: "Hello 2", body: "World 2" });
    expect(result2.messageId).toBe("mock-message-1");
    expect(connector.sent.size).toBe(1);
  });

  it("verifies sent messages", () => {
    const connector = new DevelopmentEmailConnector();
    const { messageId } = connector.sendDraft({ operationId: "op1", to: "test@example.com", subject: "Hello", body: "World" });
    expect(connector.verifySent(messageId)).toBe(true);
    expect(connector.verifySent("invalid-id")).toBe(false);
  });
});

describe("DevelopmentCalendarConnector", () => {
  it("creates an event and stores it", () => {
    const connector = new DevelopmentCalendarConnector();
    const result = connector.createEvent({ operationId: "op1", title: "Meeting", startsAt: "2024-01-01T10:00:00Z", durationMinutes: 60 });
    expect(result.eventId).toBe("mock-event-1");
    expect(connector.events.get("op1")).toEqual({ eventId: "mock-event-1", title: "Meeting", startsAt: "2024-01-01T10:00:00Z", durationMinutes: 60 });
  });

  it("is idempotent for the same operationId", () => {
    const connector = new DevelopmentCalendarConnector();
    connector.createEvent({ operationId: "op1", title: "Meeting", startsAt: "2024-01-01T10:00:00Z", durationMinutes: 60 });
    const result2 = connector.createEvent({ operationId: "op1", title: "Meeting 2", startsAt: "2024-01-01T11:00:00Z", durationMinutes: 30 });
    expect(result2.eventId).toBe("mock-event-1");
    expect(connector.events.size).toBe(1);
  });

  it("verifies created events", () => {
    const connector = new DevelopmentCalendarConnector();
    const { eventId } = connector.createEvent({ operationId: "op1", title: "Meeting", startsAt: "2024-01-01T10:00:00Z", durationMinutes: 60 });
    expect(connector.verifyEvent(eventId)).toBe(true);
    expect(connector.verifyEvent("invalid-id")).toBe(false);
  });
});
