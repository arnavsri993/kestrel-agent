import { describe, expect, it } from "vitest";
import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { UserModelStore } from "./user-model";

describe("reviewable user model", () => {
  it("keeps inferences out of context until confirmed and preserves provenance", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const store = new UserModelStore(database, () => new Date("2026-07-22T22:00:00.000Z"));
    expect(() => store.propose({ kind: "preference", key: "invalid", value: "NaN", sourceIds: ["message-0"], confidence: Number.NaN, sensitivity: "normal" })).toThrow("between 0 and 1");
    const proposed = store.propose({ kind: "preference", key: "response_style", value: "Lead with the outcome", sourceIds: ["message-1"], confidence: 0.9, sensitivity: "normal" });
    expect(store.promptContext()).toBe("");
    expect(store.review(proposed.id, "confirm").sourceIds).toEqual(["message-1"]);
    expect(store.promptContext()).toContain("Lead with the outcome");
    const replacement = store.propose({ kind: "preference", key: "response_style", value: "Use concise prose", sourceIds: ["message-2"], confidence: 0.8, sensitivity: "normal" });
    store.review(replacement.id, "confirm");
    expect(store.list("superseded")).toHaveLength(1);
    expect(store.promptContext()).not.toContain("Lead with the outcome");
    const privateFact = store.propose({ kind: "profile", key: "private_note", value: "secret detail", sourceIds: ["message-3"], confidence: 1, sensitivity: "sensitive" });
    store.review(privateFact.id, "confirm");
    expect(store.promptContext()).not.toContain("secret detail");
    expect(store.promptContext({ includeSensitive: true })).toContain("secret detail");
    const ciphertext = database.db.prepare("SELECT value_ciphertext FROM private_runtime_state WHERE key = ?").get("memory.user-model") as { value_ciphertext: string };
    expect(ciphertext.value_ciphertext).not.toContain("Lead with the outcome");
    database.close();
  });

  it("recovers when persisted user-model facts are not an array", () => {
    const database = new KestrelDatabase(":memory:", createEncryptionKey());
    const store = new UserModelStore(database);
    database.setPrivateState("memory.user-model", { corrupted: true });
    expect(store.list()).toEqual([]);
    expect(store.promptContext()).toBe("");
    expect(store.propose({ kind: "profile", key: "name", value: "User", sourceIds: ["message-1"], confidence: 0.9, sensitivity: "normal" })).toMatchObject({ status: "proposed" });
    database.close();
  });
});
