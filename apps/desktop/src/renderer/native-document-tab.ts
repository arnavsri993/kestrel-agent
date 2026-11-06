export type NativeDocumentTabStatus =
	| { state: "loading"; id?: never }
	| { state: "ready"; id: string }
	| { state: "error"; id?: never };

type Options = {
	getCurrent(): Promise<{ id?: number } | undefined>;
	readMapping(): Promise<unknown>;
	subscribeMapping(callback: (value: unknown) => void): () => void;
};

/** Resolve only this document's Chrome tab; never infer identity from a URL or active tab. */
export function createNativeDocumentTabResolver(options: Options) {
	const listeners = new Set<() => void>();
	const delays = [100, 250, 500, 1000, 2000, 2000, 2000, 2000];
	let status: NativeDocumentTabStatus = { state: "loading" };
	let generation = 0, revision = 0, nativeId: number | undefined;
	let mapping: unknown;
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
					if (Number.isSafeInteger(current?.id) && (current?.id ?? -1) >= 0) nativeId = current!.id;
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
	retry();
	return {
		getSnapshot: () => status,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		retry,
		close() { if (closed) return; closed = true; ++generation; if (timer !== undefined) clearTimeout(timer); if (deadline !== undefined) clearTimeout(deadline); timer = undefined; deadline = undefined; unsubscribeMapping(); listeners.clear(); },
	};
}
