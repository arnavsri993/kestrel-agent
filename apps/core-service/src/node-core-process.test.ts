import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nodeCoreProcess } from "./node-core-process";

vi.mock("node:child_process", () => ({ fork: vi.fn() }));

class Child extends EventEmitter {
  connected = true;
  callback: ((error: Error | null) => void) | undefined;
  send = vi.fn((_message, callback) => { this.callback = callback; return false; });
  kill = vi.fn(() => true);
}
let child: Child;
beforeEach(() => {
  child = new Child();
  vi.mocked(fork).mockReturnValue(child as unknown as ReturnType<typeof fork>);
});
function create() {
  return nodeCoreProcess({ executable: "/node", entryPath: "/core.js", env: {} });
}
describe("standalone Node transport", () => {
  it("accepts a backpressured send exactly once and still delivers its response", () => {
    const core = create();
    const received = vi.fn();
    core.on("message", received);
    expect(() => core.postMessage({ type: "request" })).not.toThrow();
    child.callback!(null);
    child.emit("message", { response: { ok: true } });
    expect(received).toHaveBeenCalledWith({ response: { ok: true } });
    expect(child.send).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("contains spawn errors and reports termination once after close", () => {
    const core = create();
    const exited = vi.fn();
    core.on("exit", exited);
    expect(() => child.emit("error", new Error("spawn ENOENT"))).not.toThrow();
    expect(exited).not.toHaveBeenCalled();
    child.emit("close", -2);
    child.emit("close", -2);
    expect(exited).toHaveBeenCalledExactlyOnceWith(-2);
    expect(() => core.postMessage({})).toThrow("not connected");
  });
  it("terminates on asynchronous send failure without replay or premature recovery", () => {
    const core = create();
    const exited = vi.fn();
    const received = vi.fn();
    core.on("exit", exited);
    core.on("message", received);
    core.postMessage({ type: "request" });
    child.callback!(new Error("channel closed"));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(exited).not.toHaveBeenCalled();
    expect(() => core.postMessage({})).toThrow("not connected");
    child.emit("message", { response: { ok: true } });
    expect(received).not.toHaveBeenCalled();
    child.emit("close", null);
    expect(exited).toHaveBeenCalledExactlyOnceWith(null);
    expect(child.send).toHaveBeenCalledTimes(1);
  });
});
