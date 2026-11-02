// Core must be idle before changing providers. Acquire the guard synchronously
// before the first await; no credential mutation may run after a failed guard.
export function createNativeCoreConfiguration({ core, configuration, isBusy, changed }) {
	let changing = false;
	let current;
	return {
		get changing() { return changing; },
		async start() { current = await configuration(); await core.start(current); },
		async reconfigure(mutation, rollback, validate, shouldRestoreCore) {
			if (changing || isBusy()) throw new Error("Wait for the active task to finish or cancel it before changing providers.");
			changing = true;
			if (!rollback && !validate && !shouldRestoreCore) {
				let stopped = false;
				try {
					await core.stop(); stopped = true;
					let result;
					try { result = await mutation(); }
					catch (error) { await core.start(current); stopped = false; throw error; }
					current = await configuration();
					await core.start(current); stopped = false;
					await changed?.();
					return result;
				} catch (error) {
					if (stopped) throw new Error("Provider settings were preserved, but Agent Core could not restart. Restart Kestrel before running another task.");
					throw error;
				} finally { changing = false; }
			}
			const previous = current;
			let stopped = false, mutationStarted = false;
			try {
				await core.stop(); stopped = true;
				mutationStarted = true;
				const result = await mutation();
				const next = await configuration();
				await core.start(next); stopped = false;
				await validate?.();
				await changed?.();
				await validate?.();
				current = next;
				return result;
			} catch (error) {
				try {
					if (!stopped && mutationStarted) { await core.stop(); stopped = true; }
					if (mutationStarted) await rollback?.();
					if (stopped && (shouldRestoreCore?.() ?? true)) { await core.start(previous); stopped = false; }
				} catch {
					throw new Error("Provider settings could not be restored. Restart Kestrel before running another task.");
				}
				throw error;
			} finally { changing = false; }
		},
	};
}
