export const NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE = "Wait for active work to finish or cancel it before changing settings.";

/** Only this host-owned pre-mutation admission error is safe to retry. */
export class NativeCoreConfigurationBusyError extends Error {
	constructor() {
		super(NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE);
		this.name = "NativeCoreConfigurationBusyError";
	}
}

/** Never expose arbitrary Core/provider errors as settings or retry authority. */
export function nativeHostSettingsErrorMessage(error, requestType, localModelError) {
	if (error instanceof NativeCoreConfigurationBusyError) return NATIVE_CORE_CONFIGURATION_BUSY_MESSAGE;
	if (["local-runtime-bootstrap", "local-model-pull"].includes(requestType) && error instanceof Error && [localModelError, "Choose an installed model with confirmed tool support for Kestrel tasks.", "Start Ollama or use guided local setup before downloading a model.", "The local runtime checksum did not match the pinned release manifest.", "Local model setup was cancelled. Partial downloads may remain in Ollama.", "Local model setup timed out. Partial downloads may remain in Ollama."].includes(error.message)) return error.message;
	return "Kestrel settings could not be applied. Finish or cancel active tasks and check the native profile before retrying.";
}

// Core must be idle before changing providers. Acquire the guard synchronously
// before the first await; no credential mutation may run after a failed guard.
export function createNativeCoreConfiguration({ core, configuration, isBusy, changed, canRestoreCore = () => true }) {
	let changing = false;
	let starting = false;
	let current;
	let started = false;
	let requiresRestart = false;
	const RESTART_REQUIRED = "Agent Core could not be safely stopped or restarted. Restart Kestrel before running another task.";
	const afterAdmissionError = error => error instanceof NativeCoreConfigurationBusyError ? new Error("Core configuration failed after admission.", { cause: error }) : error;
	const abortError = () => Object.assign(new Error("Operation was cancelled."), { name: "AbortError" });
	const isAborted = signal => signal?.aborted === true;
	const mayRestore = callback => { try { return callback?.() !== false; } catch { return false; } };
	const mayStartCore = callback => mayRestore(canRestoreCore) && mayRestore(callback);
	const confirmedExited = error => error?.exitConfirmed === true || core.hasProcess === false;
	const markRestartRequired = () => { requiresRestart = true; };
	async function stopForReconfigure() {
		try {
			await core.stop();
			if (core.hasProcess === true) throw new Error("Agent Core exit is unconfirmed.");
		} catch {
			markRestartRequired();
			throw new Error(RESTART_REQUIRED);
		}
	}
	async function restore(config, callback) {
		// Starting a replacement while an old Core process may still own the
		// profile can corrupt its state. Keep the gate closed until app restart.
		if (core.hasProcess === true || !mayStartCore(callback)) { markRestartRequired(); return false; }
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
		async withIdleMutation(mutation, rollback, validate) {
			if (changing || starting || isBusy()) throw new NativeCoreConfigurationBusyError();
			if (requiresRestart) throw new Error(RESTART_REQUIRED);
			changing = true;
			let mutated = false;
			try {
				validate?.();
				mutated = true;
				const result = await mutation();
				validate?.();
				return result;
			} catch (error) {
				if (mutated) {
					try { await rollback?.(); }
					catch { markRestartRequired(); throw new Error("Provider settings could not be restored. Restart Kestrel before running another task."); }
				}
				throw afterAdmissionError(error);
			} finally { changing = false; }
		},
		async start() {
			if (changing || starting) throw new NativeCoreConfigurationBusyError();
			if (requiresRestart) throw new Error(RESTART_REQUIRED);
			if (!mayStartCore()) { markRestartRequired(); throw new Error(RESTART_REQUIRED); }
			starting = true;
			try {
				const next = await configuration();
				if (changing) throw new NativeCoreConfigurationBusyError();
				if (!mayStartCore()) { markRestartRequired(); throw new Error(RESTART_REQUIRED); }
				await core.start(next);
				current = next;
				started = true;
			} catch (error) { throw afterAdmissionError(error); }
			finally { starting = false; }
		},
		async withStoppedCore(operation, { signal, shouldRestoreCore } = {}) {
			// Reserve synchronously before any await so a concurrent route cannot
			// start or mutate Core while maintenance is preparing to stop it.
			if (changing || starting || isBusy()) throw new NativeCoreConfigurationBusyError();
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
						return { completed: false, error: afterAdmissionError(stopError), coreStatus: "restart-required" };
					}
					const restoreCore = mayStartCore(shouldRestoreCore);
					const restored = restoreCore ? await restore(current, shouldRestoreCore) : false;
					if (!restoreCore) { started = false; markRestartRequired(); }
					return { completed: false, error: afterAdmissionError(stopError), coreStatus: restored ? "ready" : "restart-required" };
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

				if (!mayStartCore(shouldRestoreCore)) {
					started = false;
					markRestartRequired();
					return operationError
						? { completed: false, error: afterAdmissionError(operationError), coreStatus: "restart-required" }
						: { completed: true, value, coreStatus: "restart-required" };
				}

				let next;
				let restartError;
				try {
					next = await configuration();
					if (!mayStartCore(shouldRestoreCore)) {
						started = false;
						markRestartRequired();
						restartError = new Error(RESTART_REQUIRED);
					} else if (core.hasProcess === true) {
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
						? { completed: false, error: afterAdmissionError(operationError), coreStatus: "restart-required" }
						: { completed: true, value, coreStatus: "restart-required" };
				} else {
					outcome = operationError
						? { completed: false, error: afterAdmissionError(operationError), coreStatus: "ready" }
						: { completed: true, value, coreStatus: "ready" };
				}
				return outcome;
			} catch (error) { throw afterAdmissionError(error); }
			finally { changing = false; }
		},
		async reconfigure(mutation, rollback, validate, shouldRestoreCore) {
			if (changing || starting || isBusy()) throw new NativeCoreConfigurationBusyError();
			if (requiresRestart) throw new Error(RESTART_REQUIRED);
			changing = true;
			if (!rollback && !validate && !shouldRestoreCore) {
				let stopped = false;
				try {
					await stopForReconfigure(); stopped = true;
					let result;
					try { result = await mutation(); }
					catch (error) {
						if (!mayStartCore()) { markRestartRequired(); throw new Error(RESTART_REQUIRED); }
						try { await core.start(current); stopped = false; }
						catch { markRestartRequired(); throw new Error("Provider settings were preserved, but Agent Core could not restart. Restart Kestrel before running another task."); }
						throw error;
					}
					const next = await configuration();
					if (!mayStartCore()) { markRestartRequired(); throw new Error(RESTART_REQUIRED); }
					current = next;
					await core.start(current); stopped = false;
					await changed?.();
					return result;
				} catch (error) {
					if (stopped) { markRestartRequired(); throw new Error("Provider settings were preserved, but Agent Core could not restart. Restart Kestrel before running another task."); }
					throw afterAdmissionError(error);
				} finally { changing = false; }
			}
			const previous = current;
			let stopped = false, mutationStarted = false;
			const restoreAllowed = () => mayStartCore(shouldRestoreCore);
			try {
				await stopForReconfigure(); stopped = true;
				mutationStarted = true;
				const result = await mutation();
				const next = await configuration();
				if (!restoreAllowed()) { markRestartRequired(); throw new Error(RESTART_REQUIRED); }
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
					if (stopped && restoreAllowed()) { await core.start(previous); stopped = false; }
					else if (stopped) { markRestartRequired(); }
				} catch {
					markRestartRequired();
					throw new Error("Provider settings could not be restored. Restart Kestrel before running another task.");
				}
				throw afterAdmissionError(error);
			} finally { changing = false; }
		},
	};
}
