import { describe, expect, it, vi } from "vitest";
import {
  acquireSingleInstanceLock,
  terminateForSignal,
} from "./single-instance";

describe("acquireSingleInstanceLock", () => {
  it("keeps startup ownership in the first process", () => {
    const application = {
      requestSingleInstanceLock: vi.fn(() => true),
      quit: vi.fn(),
    };

    expect(acquireSingleInstanceLock(application)).toBe(true);
    expect(application.quit).not.toHaveBeenCalled();
  });

  it("quits a process that cannot acquire the lock", () => {
    const application = {
      requestSingleInstanceLock: vi.fn(() => false),
      quit: vi.fn(),
    };

    expect(acquireSingleInstanceLock(application)).toBe(false);
    expect(application.quit).toHaveBeenCalledOnce();
  });
});

describe("terminateForSignal", () => {
  it("exits immediately during a development watcher restart", () => {
    const application = {
      quit: vi.fn(),
      exit: vi.fn(),
    };

    terminateForSignal(application, true);

    expect(application.exit).toHaveBeenCalledOnce();
    expect(application.exit).toHaveBeenCalledWith(0);
    expect(application.quit).not.toHaveBeenCalled();
  });

  it("uses the graceful quit path for packaged app signals", () => {
    const application = {
      quit: vi.fn(),
      exit: vi.fn(),
    };

    terminateForSignal(application, false);

    expect(application.quit).toHaveBeenCalledOnce();
    expect(application.exit).not.toHaveBeenCalled();
  });
});
