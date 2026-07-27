import { describe, expect, it } from "vitest";
import { chatTitleFromPrompt, sessionTitleForDisplay } from "./chat-title";

describe("chatTitleFromPrompt", () => {
  it("turns a conversational request into a concise title", () => {
    expect(
      chatTitleFromPrompt("Please make it so chat titles are named properly."),
    ).toBe("Chat titles are named properly");
  });

  it("uses the first meaningful line and removes markdown", () => {
    expect(
      chatTitleFromPrompt(
        "\n## Fix the **billing page**\n\nKeep the existing checkout.",
      ),
    ).toBe("Fix the billing page");
  });

  it("truncates on a word boundary", () => {
    const title = chatTitleFromPrompt(
      "Investigate why the desktop application repeatedly loses the selected workspace after every restart",
    );
    expect(title).toBe(
      "Investigate why the desktop application repeatedly loses the",
    );
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it("falls back when the prompt has no usable title text", () => {
    expect(chatTitleFromPrompt("```\nconst answer = 42;\n```")).toBe("New chat");
  });

  it("keeps acronyms and existing capitalization intact", () => {
    expect(chatTitleFromPrompt("Could you fix OAuth in Kestrel?")).toBe(
      "Fix OAuth in Kestrel",
    );
  });

  it("hides the retired visible product name in setup session labels", () => {
    expect(
      sessionTitleForDisplay("Help me finish setting up Workstrand."),
    ).toBe("Help me finish setting up Kestrel.");
    expect(sessionTitleForDisplay("Main session")).toBe("Main session");
  });
});
