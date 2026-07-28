import { describe, expect, it } from "vitest";
import {
  availableWorkspaceGrants,
  runtimeRunScope,
  runtimeTaskWorkspace,
  shouldPreserveActiveRun,
} from "./runtime-session-state";

describe("runtime run scope", () => {
  it("keeps unavailable grants visible to settings but out of task choices", () => {
    const available = {
      path: "/projects/available",
      name: "available",
      available: true,
    };
    const unavailable = {
      path: "/projects/unavailable",
      name: "unavailable",
      available: false,
    };
    expect(availableWorkspaceGrants([available, unavailable])).toEqual([
      available,
    ]);
  });

  it("does not borrow a draft workspace for a conversation-only session", () => {
    expect(
      runtimeTaskWorkspace({
        activeSessionId: "session-conversation-only",
        draftWorkspaceRoot: "/projects/available",
      }),
    ).toBeUndefined();
    expect(
      runtimeTaskWorkspace({
        activeSessionId: null,
        draftWorkspaceRoot: "/projects/available",
      }),
    ).toBe("/projects/available");
  });

  it("moves run controls into the background when the user switches chats", () => {
    expect(
      runtimeRunScope({
        busy: true,
        streamSessionId: "session-a",
        activeSessionId: "session-a",
        hasOptimisticNewTask: false,
      }),
    ).toBe("active");
    expect(
      runtimeRunScope({
        busy: true,
        streamSessionId: "session-a",
        activeSessionId: "session-b",
        hasOptimisticNewTask: false,
      }),
    ).toBe("background");
  });

  it("distinguishes an optimistic new task from idle state", () => {
    expect(
      runtimeRunScope({
        busy: true,
        streamSessionId: null,
        activeSessionId: null,
        hasOptimisticNewTask: true,
      }),
    ).toBe("active");
    expect(
      runtimeRunScope({
        busy: false,
        streamSessionId: null,
        activeSessionId: null,
        hasOptimisticNewTask: false,
      }),
    ).toBe("idle");
  });

  it("preserves the optimistic turn when a newly created session becomes active", () => {
    expect(
      shouldPreserveActiveRun({
        streamId: "stream-new",
        streamSessionId: "session-new",
        activeSessionId: "session-new",
      }),
    ).toBe(true);
    expect(
      runtimeRunScope({
        busy: true,
        streamSessionId: "session-new",
        activeSessionId: "session-new",
        hasOptimisticNewTask: true,
      }),
    ).toBe("active");
  });
});
