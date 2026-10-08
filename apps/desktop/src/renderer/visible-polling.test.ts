import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVisiblePolling } from "./visible-polling";

class TestVisibility extends EventTarget {
	visibilityState: DocumentVisibilityState = "visible";

	change(state: DocumentVisibilityState): void {
		this.visibilityState = state;
		this.dispatchEvent(new Event("visibilitychange"));
	}
}

function deferred() {
	let resolve!: () => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("visible background polling", () => {
	const intervalMs = 1_000;

	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("joins refreshes during a slow read and waits a full interval after settlement", async () => {
		const visibility = new TestVisibility();
		const firstRead = deferred();
		let activeReads = 0;
		let maxActiveReads = 0;
		const load = vi.fn(async () => {
			activeReads += 1;
			maxActiveReads = Math.max(maxActiveReads, activeReads);
			if (load.mock.calls.length === 1) await firstRead.promise;
			activeReads -= 1;
		});
		const polling = startVisiblePolling({ intervalMs, load, visibility });
		const firstRefresh = polling.refresh();
		expect(polling.refresh()).toBe(firstRefresh);
		await vi.advanceTimersByTimeAsync(intervalMs * 5);
		visibility.change("hidden");
		visibility.change("visible");
		visibility.change("visible");
		expect(polling.refresh()).toBe(firstRefresh);
		expect(load).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);

		firstRead.resolve();
		await firstRefresh;
		await vi.advanceTimersByTimeAsync(intervalMs - 1);
		expect(load).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(load).toHaveBeenCalledTimes(2);
		expect(maxActiveReads).toBe(1);
		polling.stop();
	});

	it("leaves hidden views idle and refreshes once when they become visible", async () => {
		const visibility = new TestVisibility();
		visibility.visibilityState = "hidden";
		const load = vi.fn(async () => undefined);
		const polling = startVisiblePolling({ intervalMs, load, visibility });
		await polling.refresh();
		await vi.advanceTimersByTimeAsync(intervalMs * 10);
		expect(load).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);

		visibility.change("visible");
		visibility.change("visible");
		await vi.advanceTimersByTimeAsync(0);
		expect(load).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);
		visibility.change("hidden");
		await vi.advanceTimersByTimeAsync(intervalMs * 10);
		expect(load).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);

		visibility.change("visible");
		await vi.advanceTimersByTimeAsync(0);
		expect(load).toHaveBeenCalledTimes(2);
		polling.stop();
	});

	it("does not schedule another read when a pending read finishes while hidden", async () => {
		const visibility = new TestVisibility();
		const pending = deferred();
		const load = vi.fn(() => pending.promise);
		const polling = startVisiblePolling({ intervalMs, load, visibility });
		const completion = polling.refresh();
		await vi.advanceTimersByTimeAsync(0);
		visibility.change("hidden");
		pending.resolve();
		await completion;
		await vi.advanceTimersByTimeAsync(intervalMs * 10);
		expect(load).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		polling.stop();
	});

	it("reports a failed read and retries on the next interval", async () => {
		const visibility = new TestVisibility();
		const failure = new Error("IPC temporarily unavailable");
		const onError = vi.fn();
		const load = vi.fn<() => Promise<void>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValue(undefined);
		const polling = startVisiblePolling({ intervalMs, load, onError, visibility });
		await polling.refresh();
		expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
		await vi.advanceTimersByTimeAsync(intervalMs);
		expect(load).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);
		polling.stop();
	});

	it("recovers from a synchronous loader failure", async () => {
		const visibility = new TestVisibility();
		const failure = new Error("bridge disconnected");
		const onError = vi.fn();
		const load = vi.fn<() => Promise<void>>()
			.mockImplementationOnce(() => { throw failure; })
			.mockResolvedValue(undefined);
		const polling = startVisiblePolling({ intervalMs, load, onError, visibility });
		await polling.refresh();
		expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
		await vi.advanceTimersByTimeAsync(intervalMs);
		expect(load).toHaveBeenCalledTimes(2);
		polling.stop();
	});

	it("lets a stopped consumer suppress its pending result and removes the listener", async () => {
		const visibility = new TestVisibility();
		const removeListener = vi.spyOn(visibility, "removeEventListener");
		const pending = deferred();
		const applyResult = vi.fn();
		const load = vi.fn(async (isCurrent: () => boolean) => {
			await pending.promise;
			if (isCurrent()) applyResult();
		});
		const polling = startVisiblePolling({ intervalMs, load, visibility });
		const completion = polling.refresh();
		await vi.advanceTimersByTimeAsync(0);
		polling.stop();
		pending.resolve();
		await completion;
		visibility.change("hidden");
		visibility.change("visible");
		await polling.refresh();
		await vi.advanceTimersByTimeAsync(intervalMs * 10);
		expect(applyResult).not.toHaveBeenCalled();
		expect(load).toHaveBeenCalledTimes(1);
		expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ignores a read that rejects after the consumer stops", async () => {
		const visibility = new TestVisibility();
		const pending = deferred();
		const onError = vi.fn();
		const polling = startVisiblePolling({
			intervalMs,
			load: () => pending.promise,
			onError,
			visibility,
		});
		const completion = polling.refresh();
		await vi.advanceTimersByTimeAsync(0);
		polling.stop();
		pending.reject(new Error("late IPC rejection"));
		await completion;
		expect(onError).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not start the queued initial read when stopped before its microtask", async () => {
		const visibility = new TestVisibility();
		const load = vi.fn(async () => undefined);
		const polling = startVisiblePolling({ intervalMs, load, visibility });
		polling.stop();
		await vi.advanceTimersByTimeAsync(intervalMs * 10);
		expect(load).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
