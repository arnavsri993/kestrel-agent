import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVELOPMENT_LOCK_NAME,
  developmentLockDirectory,
} from "./desktop-dev-electron-lock.mjs";

describe("development Electron lock", () => {
  it("uses one product-scoped default lock", () => {
    expect(developmentLockDirectory()).toBe(developmentLockDirectory());
    expect(developmentLockDirectory()).toBe(
      join(tmpdir(), DEFAULT_DEVELOPMENT_LOCK_NAME),
    );
  });

  it("preserves an explicit lock override for isolated tests", () => {
    expect(
      developmentLockDirectory(tmpdir(), "/tmp/custom-kestrel.lock"),
    ).toBe("/tmp/custom-kestrel.lock");
  });
});
