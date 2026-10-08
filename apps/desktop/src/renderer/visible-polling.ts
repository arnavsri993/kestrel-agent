type PollingVisibility = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/** Read-only UI refreshes: one request at a time, no timers while hidden. */
export function startVisiblePolling({
	intervalMs,
	load,
	onError = () => undefined,
	visibility = document,
}: {
	intervalMs: number;
	load(isCurrent: () => boolean): Promise<void>;
	onError?(cause: unknown): void;
	visibility?: PollingVisibility;
}): { refresh(): Promise<void>; stop(): void } {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | undefined;
	const isCurrent = () => !stopped;
	const isVisible = () => visibility.visibilityState !== "hidden";
	const clearTimer = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const schedule = () => {
		clearTimer();
		if (stopped || !isVisible()) return;
		timer = setTimeout(() => void refresh(), intervalMs);
	};
	function refresh(): Promise<void> {
		if (stopped || !isVisible()) return Promise.resolve();
		if (inFlight) return inFlight;
		clearTimer();
		// Publish the pending promise before invoking load, including sync errors.
		inFlight = Promise.resolve()
			.then(() => {
				if (!stopped && isVisible()) return load(isCurrent);
			})
			.catch((cause: unknown) => {
				if (!stopped) onError(cause);
			})
			.finally(() => {
				inFlight = undefined;
				schedule();
			});
		return inFlight;
	}
	const onVisibility = () => {
		clearTimer();
		if (isVisible()) void refresh();
	};
	visibility.addEventListener("visibilitychange", onVisibility);
	void refresh();
	return {
		refresh,
		stop() {
			stopped = true;
			clearTimer();
			visibility.removeEventListener("visibilitychange", onVisibility);
		},
	};
}
