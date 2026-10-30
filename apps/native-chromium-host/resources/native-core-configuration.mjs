// Core must be idle before changing providers. Acquire the guard synchronously
// before the first await; no credential mutation may run after a failed guard.
export function createNativeCoreConfiguration({ core, configuration, isBusy, changed }) {
	let changing = false;
	let current;
	return {
		get changing() { return changing; },
		async start() { current = await configuration(); await core.start(current); },
		async reconfigure(mutation) {
			if (changing || isBusy()) throw new Error("Wait for the active task to finish or cancel it before changing providers.");
			changing = true;
			let stopped = false;
			try {
				await core.stop(); stopped = true;
				let result;
				try { result = await mutation(); }
				catch (error) {
					// A rejected input must not leave an otherwise healthy app stopped.
					await core.start(current); stopped = false;
					throw error;
				}
				current = await configuration();
				await core.start(current); stopped = false;
				await changed?.();
				return result;
			} catch (error) {
				if (stopped) throw new Error("Provider settings were preserved, but Agent Core could not restart. Restart Kestrel before running another task.");
				throw error;
			} finally { changing = false; }
		},
	};
}
