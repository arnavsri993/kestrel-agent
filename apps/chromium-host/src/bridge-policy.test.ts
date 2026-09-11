import { describe, expect, it } from "vitest";
import { assertTrustedShell, browserUrl, HostCommandSchema } from "./bridge-policy";
const shell = "file:///fixture/kestrel/index.html";
describe("Chromium host authority", () => {
  it("requires the exact shell page, main frame and URL", () => {
    expect(() => assertTrustedShell({ samePage: true, mainFrame: true, url: shell }, shell)).not.toThrow();
    for (const source of [
      { samePage: false, mainFrame: true, url: shell },
      { samePage: true, mainFrame: false, url: shell },
      { samePage: true, mainFrame: true, url: "https://example.com" },
      { samePage: true, mainFrame: true, url: `${shell}?spoof=1` },
    ]) expect(() => assertTrustedShell(source, shell)).toThrow("Only the local");
  });
  it("rejects generic core requests and privilege parameters", () => {
    expect(HostCommandSchema.safeParse({ type: "runtime-call-tool", toolName: "exec" }).success).toBe(false);
    expect(HostCommandSchema.safeParse({ type: "send", message: "hi", provider: "nous", model: "fixture", approvalStatus: "approved" }).success).toBe(false);
    expect(HostCommandSchema.safeParse({ type: "send", message: " ", provider: "nous", model: "fixture" }).success).toBe(false);
  });
  it("defaults browser reading off and requires a boolean opt-in", () => {
    const command = { type: "send", message: "hello", provider: "nous", model: "fixture" };
    expect(HostCommandSchema.parse(command)).toMatchObject({ readBrowser: false });
    expect(HostCommandSchema.safeParse({ ...command, readBrowser: "yes" }).success).toBe(false);
  });
  it("opens only ordinary web URLs without embedded credentials", () => {
    expect(browserUrl("https://example.com")).toBe("https://example.com/");
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "https://user:secret@example.com", "chrome://settings"]) {
      expect(() => browserUrl(url)).toThrow();
    }
  });
});
