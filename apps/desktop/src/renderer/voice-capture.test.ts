import { describe, expect, it, vi } from "vitest";
import { VoiceCaptureOwner } from "./voice-capture";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function mediaStream() {
	const stop = vi.fn();
	return { getTracks: () => [{ stop }], stop };
}
type Stream = ReturnType<typeof mediaStream>;

describe("voice capture ownership", () => {
	it("does not open the microphone when permission arrives after cancellation", async () => {
		const owner = new VoiceCaptureOwner<Stream>();
		const permission = deferred<void>();
		const open = vi.fn(async () => mediaStream());
		const pending = owner.acquire(() => permission.promise, open);
		owner.cancel(); permission.resolve();
		expect(await pending).toBeUndefined();
		expect(open).not.toHaveBeenCalled();
	});

	it("stops a stream returned after the composer closed", async () => {
		const owner = new VoiceCaptureOwner<Stream>();
		const acquired = deferred<Stream>();
		const open = vi.fn(() => acquired.promise);
		const pending = owner.acquire(async () => {}, open);
		await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
		owner.cancel(); const stream = mediaStream(); acquired.resolve(stream);
		expect(await pending).toBeUndefined();
		expect(stream.stop).toHaveBeenCalledOnce();
	});

	it("admits one start synchronously while permission is pending", async () => {
		const owner = new VoiceCaptureOwner<Stream>();
		const permission = deferred<void>();
		const request = vi.fn(() => permission.promise);
		const pending = owner.acquire(request, async () => mediaStream());
		expect(owner.busy).toBe(true);
		expect(await owner.acquire(request, async () => mediaStream())).toBeUndefined();
		expect(request).toHaveBeenCalledOnce();
		permission.resolve(); const capture = await pending;
		expect(capture?.isCurrent()).toBe(true);
		owner.cancel(); expect(capture?.isCurrent()).toBe(false);
	});

	it("keeps a new capture when an older cancelled stream arrives", async () => {
		const owner = new VoiceCaptureOwner<Stream>();
		const late = deferred<Stream>();
		const open = vi.fn(() => late.promise);
		const pending = owner.acquire(async () => {}, open);
		await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
		owner.cancel(); const currentStream = mediaStream();
		const current = await owner.acquire(async () => {}, async () => currentStream);
		const oldStream = mediaStream(); late.resolve(oldStream);
		expect(await pending).toBeUndefined();
		expect(oldStream.stop).toHaveBeenCalledOnce();
		expect(current?.isCurrent()).toBe(true);
		expect(currentStream.stop).not.toHaveBeenCalled();
		current?.release(); expect(currentStream.stop).toHaveBeenCalledOnce();
	});

	it("releases a failed permission attempt and allows an explicit retry", async () => {
		const owner = new VoiceCaptureOwner<Stream>();
		const open = vi.fn(async () => mediaStream());
		await expect(owner.acquire(async () => { throw Error("denied"); }, open)).rejects.toThrow("denied");
		expect(open).not.toHaveBeenCalled(); expect(owner.busy).toBe(false);
		const capture = await owner.acquire(async () => {}, open);
		expect(capture?.isCurrent()).toBe(true); capture?.release();
	});

	it("does not let a stale release or rejection cancel a newer capture", async () => {
		const owner = new VoiceCaptureOwner<Stream>();
		const old = await owner.acquire(async () => {}, async () => mediaStream());
		owner.cancel(); const permission = deferred<void>();
		const pending = owner.acquire(() => permission.promise, async () => mediaStream());
		owner.cancel(); const current = await owner.acquire(async () => {}, async () => mediaStream());
		old?.release(); permission.reject(Error("late denial"));
		expect(await pending).toBeUndefined(); expect(current?.isCurrent()).toBe(true);
		current?.release();
	});
});
