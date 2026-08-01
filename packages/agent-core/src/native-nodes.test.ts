import { describe, expect, it } from "vitest";
import { NativeNodeManager } from "./native-nodes";

describe("native node manager", () => {
  it("keeps presence privacy-preserving and delivers bounded commands", () => {
    let now = new Date("2026-07-23T12:00:00.000Z");
    const manager = new NativeNodeManager(() => now);
    manager.beacon({ nodeId: "phone-1", label: "Arnav's phone", platform: "ios", capabilities: ["location", "talk", "voiceWake"], idleSeconds: 80 });
    expect(manager.list()[0]).toMatchObject({ nodeId: "phone-1", status: "idle" });
    expect(JSON.stringify(manager.list())).not.toMatch(/latitude|longitude|app|window|input/i);
    const location = manager.enqueueLocation("phone-1", { timeoutMs: 500_000, desiredAccuracy: "precise" });
    const talk = manager.enqueueTalk("phone-1", "Setup is ready.", "session-1");
    expect(manager.poll("phone-1")).toMatchObject({ commands: [{ id: location.id, input: { timeoutMs: 60_000 } }, { id: talk.id }], voiceWake: ["openclaw", "claude", "computer"] });
    expect(manager.poll("phone-1").commands).toEqual([]);
    manager.complete("phone-1", { commandId: location.id, ok: false, error: { code: "LOCATION_PERMISSION_DENIED", message: "Location permission is off." } });
    expect(manager.result(location.id)?.error?.code).toBe("LOCATION_PERMISSION_DENIED");
    now = new Date("2026-07-23T12:06:00.000Z");
    expect(manager.list()).toEqual([]);
  });

  it("normalizes gateway-owned voice-wake phrases", () => {
    const manager = new NativeNodeManager();
    expect(manager.setVoiceWake([" Hey Kestrel ", "hey   kestrel", "Computer"])).toEqual(["hey kestrel", "computer"]);
    expect(manager.setVoiceWake([])).toEqual(["openclaw", "claude", "computer"]);
    expect(() => manager.setVoiceWake(Array.from({ length: 33 }, (_, i) => `wake ${i}`))).toThrow("32");
  });

  it("accepts a command result only from the node that received the command", () => {
    const manager = new NativeNodeManager();
    manager.beacon({ nodeId: "phone-1", label: "Phone 1", platform: "ios", capabilities: ["location"] });
    manager.beacon({ nodeId: "phone-2", label: "Phone 2", platform: "ios", capabilities: ["location"] });
    const command = manager.enqueueLocation("phone-1", {});
    manager.poll("phone-1");

    expect(() => manager.complete("phone-2", { commandId: command.id, ok: true, output: {} })).toThrow("does not belong");
    manager.complete("phone-1", { commandId: command.id, ok: true, output: {} });
    expect(manager.result(command.id)).toMatchObject({ ok: true });
    expect(() => manager.complete("phone-1", { commandId: command.id, ok: true, output: {} })).toThrow("does not belong");
  });
});
