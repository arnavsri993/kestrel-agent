// Core must be idle before changing providers. Acquire the guard synchronously
// before the first await; no credential mutation may run after a failed guard.
export function createNativeCoreConfiguration({ core, configuration, isBusy, changed }) {
	let changing = false;
	let starting = false;
	let current;
	let started = false;
	let requiresRestart = false;
	const RESTART_REQUIRED = "Agent Core could not be safely stopped or restarted. Restart Kestrel before running another task.";
	const ACTIVE_CHANGE = "Wait for the active task to finish or cancel it before changing providers.";
	const abortError = () => Object.assign(new Error("Operation was cancelled."), { name: "AbortError" });
	const isAborted = signal => signal?.aborted === true;
	const mayRestore = callback => { try { return callback?.() !== false; } catch { return false; } };
	const confirmedExited = error => error?.exitConfirmed === true || core.hasProcess === false;
	const markRestartRequired = () => { requiresRestart = true; };
	async function restore(config) {
		// Starting a replacement while an old Core process may still own the
		// profile can corrupt its state. Keep the gate closed until app restart.
		if (core.hasProcess === true) { markRestartRequired(); return false; }
		try {
			await core.start(config);
			current = config;
			started = true;
			await changed?.();
			return true;
		} catch {
			markRestartRequired();
			return false;
		}
	}
	return {
		get changing() { return changing; },
		get requiresRestart() { return requiresRestart; },
		async start() {
			if (changing || starting) throw new Error(ACTIVE_CHANGE);
			if (requiresRestart) throw new Error(RESTART_REQUIRED);
			starting = true;
			try {
				const next = await configuration();
				if (changing) throw new Error(ACTIVE_CHANGE);
				await core.start(next);
				current = next;
				started = true;
			} finally { starting = false; }
		},
		async withStoppedCore(operation, { signal, shouldRestoreCore } = {}) {
			// Reserve synchronously before any await so a concurrent route cannot
			// start or mutate Core while maintenance is preparing to stop it.
			if (changing || starting || isBusy()) throw new Error(ACTIVE_CHANGE);
			if (requiresRestart) throw new Error(RESTART_REQUIRED);
			if (core.isReady === false || !started || current === undefined) throw new Error("Agent Core must be running before this operation.");
			changing = true;
			let outcome;
			try {
				if (isAborted(signal)) return { completed: false, error: abortError(), coreStatus: "ready" };
				let stopError;
				try {
					await core.stop({ requireCleanExit: true, gracefulTimeoutMs: 60000 });
					if (core.hasProcess === true) throw Object.assign(new Error("Agent Core did not exit cleanly."), { exitConfirmed: false });
				} catch (error) {
					stopError = error;
				}
				if (stopError) {
					if (!confirmedExited(stopError) || stopError.exitConfirmed === false || core.hasProcess === true) {
						markRestartRequired();
						return { completed: false, error: stopError, coreStatus: "restart-required" };
					}
					const restoreCore = mayRestore(shouldRestoreCore);
					const restored = restoreCore ? await restore(current) : false;
					if (!restoreCore) started = false;
					return { completed: false, error: stopError, coreStatus: restored ? "ready" : "restart-required" };
				}

				// The stop resolved cleanly and confirmed exit. Cancellation before
				// the operation is safe; cancellation after its commit is not a
				// reason to discard its successful result.
				let value;
				let operationError;
				if (isAborted(signal)) operationError = abortError();
				else {
					try { value = await operation(); }
					catch (error) { operationError = error; }
				}

				if (!mayRestore(shouldRestoreCore)) {
					started = false;
					return operationError
						? { completed: false, error: operationError, coreStatus: "restart-required" }
						: { completed: true, value, coreStatus: "restart-required" };
				}

				let next;
				let restartError;
				try {
					next = await configuration();
					if (core.hasProcess === true) {
						markRestartRequired();
						restartError = new Error(RESTART_REQUIRED);
					} else {
						await core.start(next);
						current = next;
						started = true;
						await changed?.();
					}
				} catch (error) {
					restartError = error;
					markRestartRequired();
				}
				if (restartError) {
					outcome = operationError
						? { completed: false, error: operationError, coreStatus: "restart-required" }
						: { completed: true, value, coreStatus: "restart-required" };
				} else {
					outcome = operationError
						? { completed: false, error: operationError, coreStatus: "ready" }
						: { completed: true, value, coreStatus: "ready" };
				}
				return outcome;
			} finally { changing = false; }
		},
		async reconfigure(mutation, rollback, validate, shouldRestoreCore) {
			if (changing || starting || isBusy()) throw new Error("Wait for the active task to finish or cancel it before changing providers.");
			if (requiresRestart) throw new Error(RESTART_REQUIRED);
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
