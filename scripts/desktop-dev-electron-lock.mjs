import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_DEVELOPMENT_LOCK_NAME = "kestrel-electron-dev.lock";

/**
 * Keep the development watcher lock product-scoped rather than worktree-scoped.
 * A second checkout should not be able to launch another visible Kestrel shell.
 */
export function developmentLockDirectory(
  temporaryDirectory = tmpdir(),
  override = process.env.KESTREL_DEV_ELECTRON_LOCK_PATH,
) {
  return override ?? join(temporaryDirectory, DEFAULT_DEVELOPMENT_LOCK_NAME);
}
