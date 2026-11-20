export type NativeDocumentTabStatus =
	| { state: "loading"; id?: never }
	| { state: "ready"; id: string }
	| { state: "error"; id?: never };

type Options = {
	getCurrent(): Promise<{ id?: number; windowId?: number } | undefined>;
	readMapping(): Promise<unknown>;
	subscribeMapping(callback: (value: unknown) => void): () => void;
	subscribeCurrent?(callback: (value: { id?: number; windowId?: number }) => void): () => void;
};

/** Resolve using Chrome tab identities; never infer a Kestrel tab from its URL. */
export function createNativeDocumentTabResolver(options: Options) {
	const listeners = new Set<() => void>();
	const delays = [100, 250, 500, 1000, 2000, 2000, 2000, 2000];
	let status: NativeDocumentTabStatus = { state: "loading" };
	let generation = 0, revision = 0, nativeId: number | undefined, nativeWindowId: number | undefined;
	let mapping: unknown;
	const pendingCurrentByWindow = new Map<number, { id?: number; windowId?: number }>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	function publish(next: NativeDocumentTabStatus) {
		if (next.state === status.state && next.id === status.id) return;
		status = next;
		for (const listener of listeners) listener();
	}
	function mappedId(): string | undefined {
		if (nativeId === undefined || !mapping || typeof mapping !== "object" || Array.isArray(mapping)) return;
		const value = (mapping as Record<string, unknown>)[String(nativeId)];
		return typeof value === "string" && /^tab-[a-f0-9-]{36}$/.test(value) ? value : undefined;
	}
	function currentTabChanged(current: { id?: number; windowId?: number }) {
		if (!Number.isSafeInteger(current.id) || (current.id ?? -1) < 0 ||
			!Number.isSafeInteger(current.windowId) || (current.windowId ?? -1) < 0) return;
		if (nativeWindowId === undefined) {
			pendingCurrentByWindow.set(current.windowId!, current);
			return;
		}
		if (current.windowId !== nativeWindowId || current.id === nativeId) return;
		nativeId = current.id;
		retry();
	}
	function retry() {
		if (closed) return;
		const run = ++generation;
		if (timer !== undefined) clearTimeout(timer);
		if (deadline !== undefined) clearTimeout(deadline);
		timer = undefined;
		deadline = setTimeout(() => {
			if (closed || generation !== run) return;
			++generation; if (timer !== undefined) clearTimeout(timer); timer = undefined;
			deadline = undefined; publish({ state: "error" });
		}, 10_000);
		publish({ state: "loading" });
		let attempt = 0;
		const step = async () => {
			if (closed || run !== generation) return;
			try {
				if (nativeId === undefined) {
					const current = await options.getCurrent();
					if (closed || run !== generation) return;
					if (Number.isSafeInteger(current?.windowId) && (current?.windowId ?? -1) >= 0)
						nativeWindowId = current!.windowId;
					const pending = nativeWindowId === undefined ? undefined : pendingCurrentByWindow.get(nativeWindowId);
					pendingCurrentByWindow.clear();
					const selected = pending ?? current;
					if (Number.isSafeInteger(selected?.id) && (selected?.id ?? -1) >= 0) nativeId = selected!.id;
				}
				if (nativeId !== undefined) {
					const cached = mappedId();
					if (cached) { if (deadline !== undefined) clearTimeout(deadline); deadline = undefined; publish({ state: "ready", id: cached }); return; }
					const observed = revision;
					const read = await options.readMapping();
					if (closed || run !== generation) return;
					if (revision === observed) mapping = read;
					const id = mappedId();
					if (id) { if (deadline !== undefined) clearTimeout(deadline); deadline = undefined; publish({ state: "ready", id }); return; }
				}
			} catch { /* Retry bounded transient Chrome API failures. */ }
			if (closed || run !== generation) return;
			if (attempt >= delays.length) { if (deadline !== undefined) clearTimeout(deadline); deadline = undefined; publish({ state: "error" }); return; }
			timer = setTimeout(() => { timer = undefined; void step(); }, delays[attempt++]);
		};
		void step();
	}
	const unsubscribeMapping = options.subscribeMapping(value => {
		if (closed) return;
		++revision; mapping = value;
		const id = mappedId();
		if (id) {
			++generation; if (timer !== undefined) clearTimeout(timer); if (deadline !== undefined) clearTimeout(deadline); timer = undefined; deadline = undefined;
			publish({ state: "ready", id });
		} else if (status.state === "ready" || status.state === "error") retry();
	});
	const unsubscribeCurrent = options.subscribeCurrent?.(currentTabChanged) ?? (() => {});
	retry();
	return {
		getSnapshot: () => status,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		retry,
		close() { if (closed) return; closed = true; ++generation; if (timer !== undefined) clearTimeout(timer); if (deadline !== undefined) clearTimeout(deadline); timer = undefined; deadline = undefined; unsubscribeMapping(); unsubscribeCurrent(); pendingCurrentByWindow.clear(); listeners.clear(); },
	};
}
