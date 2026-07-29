import { describe, expect, it } from "vitest";
import { parseConfigurationMessage } from "./ConfigurationMessage";

describe("configuration chat message presentation", () => {
  it("distinguishes a staged preview from a live change", () => {
    const parsed = parseConfigurationMessage({
      toolName: "agent.config.plan",
      content: JSON.stringify({
        status: "verified",
        output: {
          proposal: {
            requestSummary: "Use compact chat density.",
            baseVersionId: "config-version-base",
            diff: "--- before\n+++ after",
            isolatedChecks: [
              { id: "schema", status: "passed", detail: "Schema passed." },
            ],
          },
          liveConfigurationChanged: false,
        },
      }),
    });
    expect(parsed).toMatchObject({
      kind: "plan",
      status: "preview only",
      summary: "Use compact chat density.",
      diff: "--- before\n+++ after",
      checks: ["Schema passed."],
    });
  });

  it("surfaces verification and a conversational undo without applying it", () => {
    const parsed = parseConfigurationMessage({
      toolName: "agent.config.apply",
      content: JSON.stringify({
        status: "verified",
        output: {
          result: {
            version: { id: "config-version-active" },
            verification: [
              {
                id: "readback",
                status: "passed",
                detail: "Encrypted read-back passed.",
              },
            ],
            undo: {
              request: "Restore configuration version config-version-base",
            },
          },
        },
      }),
    });
    expect(parsed).toMatchObject({
      kind: "applied",
      status: "verified",
      version: "config-version-active",
      undoPrompt: "Restore configuration version config-version-base",
      checks: ["Encrypted read-back passed."],
    });
  });

  it("renders failed envelopes as recovery-oriented errors", () => {
    expect(
      parseConfigurationMessage({
        toolName: "agent.config.rollback",
        content: JSON.stringify({
          status: "failed",
          error: "The history changed before approval.",
        }),
      }),
    ).toMatchObject({
      kind: "error",
      summary: "The history changed before approval.",
    });
  });
});
