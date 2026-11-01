import { rmSync } from "node:fs";

async function within(promise, timeoutMs, message) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function observeExit(child) {
	let exited = false;
	let resolveExit;
	const promise = new Promise((resolve) => {
		resolveExit = resolve;
	});
	const onExit = () => {
		exited = true;
		resolveExit();
	};
	// A signal error must not become an unhandled EventEmitter error while we
	// wait for exit. Failure to exit still fails the bounded teardown below.
	const onError = () => {};
	const hasExited = () =>
		exited || child.exitCode !== null || child.signalCode !== null;
	child.once("exit", onExit);
	child.on("error", onError);
	if (hasExited()) onExit();
	return {
		promise,
		hasExited,
		dispose() {
			child.off("exit", onExit);
			child.off("error", onError);
		},
	};
}

// The caller supplies a disposable fixture root, never a normal user profile.
// Capture the public ChildProcess immediately after launch; do not rediscover
// processes by PID, executable name, or the installed application path.
export async function withDesktopFixture({
	launch,
	run,
	root,
	closeTimeoutMs = 15_000,
	killTimeoutMs = 5_000,
}) {
	let application;
	try {
		application = await launch();
	} catch (error) {
		throw new AggregateError(
			[error],
			`Desktop fixture launch failed; files retained at ${root}.`,
			{ cause: error },
		);
	}
	const child = application.process();
	const exit = observeExit(child);
	const failures = [];
	let teardownFailed = false;
	try {
		try {
			await run(application);
		} catch (error) {
			failures.push(error);
		}

		try {
			await within(
				Promise.all([
					Promise.resolve().then(() => application.close()),
					exit.promise,
				]),
				closeTimeoutMs,
				`Desktop fixture teardown did not complete within ${closeTimeoutMs}ms (child PID ${child.pid}).`,
			);
			if (child.exitCode !== 0 || child.signalCode !== null) {
				throw new Error(
					`Desktop fixture child exited abnormally (code ${child.exitCode}, signal ${child.signalCode}).`,
				);
			}
		} catch (error) {
			teardownFailed = true;
			failures.push(error);
			if (!exit.hasExited()) {
				try {
					if (!child.kill("SIGKILL")) {
						throw new Error("Could not signal the owned desktop fixture child.");
					}
				} catch (killError) {
					failures.push(killError);
				}
				try {
					await within(
						exit.promise,
						killTimeoutMs,
						`Desktop fixture child exit was not confirmed within ${killTimeoutMs}ms after forced cleanup.`,
					);
				} catch (exitError) {
					failures.push(exitError);
				}
			}
			// Even successful forced cleanup is a failure. Keep diagnostic state
			// rather than deleting files a surviving descendant could still use.
			failures.push(new Error(`Desktop fixture files retained at ${root}.`));
		}

		if (!teardownFailed && exit.hasExited()) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(
				failures,
				"Desktop fixture failed; original failure is listed first.",
				{ cause: failures[0] },
			);
		}
	} finally {
		exit.dispose();
	}
}
