import { describe, expect, it, vi } from "vitest";
import {
	acquireSingleInstanceLock,
	developmentHeartbeatIsStale,
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

describe("developmentHeartbeatIsStale", () => {
	it("keeps a recently updated development process alive", () => {
		expect(developmentHeartbeatIsStale(1_000, 1_500, 1_000)).toBe(false);
	});

	it("detects when its launcher heartbeat stops", () => {
		expect(developmentHeartbeatIsStale(1_000, 2_001, 1_000)).toBe(true);
	});
});
