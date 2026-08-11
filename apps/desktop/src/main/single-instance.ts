export interface SingleInstanceApplication {
  requestSingleInstanceLock(): boolean;
  quit(): void;
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
