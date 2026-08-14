import { describe, it, expect, vi } from "vitest";
import { ConsoleLogger, NoopLogger } from "./index";

describe("ConsoleLogger", () => {
  it("should log messages with appropriate context", () => {
    const logger = new ConsoleLogger({ app: "test" });
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    logger.info("Test message", { request: "123" });

    expect(consoleInfoSpy).toHaveBeenCalled();
    const callArg = consoleInfoSpy.mock.calls[0][0];
    const parsed = JSON.parse(callArg);
    
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("Test message");
    expect(parsed.context.app).toBe("test");
    expect(parsed.context.request).toBe("123");

    consoleInfoSpy.mockRestore();
  });

  it("should support child loggers", () => {
    const parent = new ConsoleLogger({ parent: true });
    const child = parent.child({ child: true });
    
    const consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    child.debug("Child message");

    expect(consoleDebugSpy).toHaveBeenCalled();
    const callArg = consoleDebugSpy.mock.calls[0][0];
    const parsed = JSON.parse(callArg);
    
    expect(parsed.level).toBe("debug");
    expect(parsed.context.parent).toBe(true);
    expect(parsed.context.child).toBe(true);

    consoleDebugSpy.mockRestore();
  });
});

describe("NoopLogger", () => {
  it("should do nothing", () => {
    const logger = new NoopLogger();
    logger.info("Nothing happens");
    const child = logger.child({ x: 1 });
    child.error("Still nothing");
    expect(true).toBe(true);
  });
});
