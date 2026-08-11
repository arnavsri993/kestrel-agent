import { describe, expect, it, vi } from "vitest";
import { acquireSingleInstanceLock } from "./single-instance";

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
