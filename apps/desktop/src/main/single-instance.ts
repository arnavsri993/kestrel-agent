export interface SingleInstanceApplication {
  requestSingleInstanceLock(): boolean;
  quit(): void;
}

export interface TerminatingApplication {
  quit(): void;
  exit(code?: number): void;
}

/**
 * Acquire the desktop app lock before registering startup work.
 *
 * Electron can continue evaluating the entry module briefly after `quit()` is
 * requested. Returning the lock result lets callers skip all startup work in
 * that losing process instead of briefly creating a second window/core.
 */
export function acquireSingleInstanceLock(
  application: SingleInstanceApplication,
): boolean {
  const ownsLock = application.requestSingleInstanceLock();
  if (!ownsLock) application.quit();
  return ownsLock;
}

/**
 * Electron does not reliably terminate a macOS GUI process for the default
 * SIGTERM handling. The electron-vite watcher sends SIGTERM before starting
 * the rebuilt process, so development restarts must exit synchronously or the
 * new process can overlap the old one and create another app instance.
 */
export function terminateForSignal(
  application: TerminatingApplication,
  isDevelopment: boolean,
): void {
  if (isDevelopment) application.exit(0);
  else application.quit();
}
