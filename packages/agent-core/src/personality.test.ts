import { describe, expect, it } from "vitest";
import { PersonalityRegistry } from "./personality";

describe("personality registry", () => {
  it("does not expose mutable provider or tool scopes", () => {
    const registry = new PersonalityRegistry();
    const input = {
      id: "reader",
      name: "Reader",
      description: "A read-only personality.",
      instructions: "Stay within the requested scope.",
      providerIds: ["local-provider"],
      toolNames: ["workspace.read"],
      memoryScope: "isolated" as const,
    };

    const registered = registry.register(input);
    input.providerIds.push("untrusted-provider");
    input.toolNames.push("workspace.write");
    registered.providerIds?.push("another-provider");
    registered.toolNames?.push("workspace.delete");

    const listed = registry.list().find((personality) => personality.id === "reader");
    listed?.providerIds?.push("listed-provider");
    listed?.toolNames?.push("workspace.patch");

    expect(registry.get("reader")).toMatchObject({
      providerIds: ["local-provider"],
      toolNames: ["workspace.read"],
    });
  });
});
