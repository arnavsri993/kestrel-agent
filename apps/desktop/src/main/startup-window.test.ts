import { describe, expect, it } from "vitest";
import { canShowMainWindow } from "./startup-window";

describe("startup window gate", () => {
  it("keeps the renderer closed until both Electron and the encrypted core are ready", () => {
    expect(canShowMainWindow(false, false)).toBe(false);
    expect(canShowMainWindow(true, false)).toBe(false);
    expect(canShowMainWindow(false, true)).toBe(false);
    expect(canShowMainWindow(true, true)).toBe(true);
  });
});
