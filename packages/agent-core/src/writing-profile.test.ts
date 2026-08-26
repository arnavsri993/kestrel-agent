import { KestrelDatabase } from "@kestrel/database";
import { createEncryptionKey } from "@kestrel/encryption";
import { describe, expect, it } from "vitest";
import { WritingProfileStore } from "./writing-profile";

function fixture() {
	const database = new KestrelDatabase(":memory:", createEncryptionKey());
	const store = new WritingProfileStore(
		database,
		() => new Date("2026-08-25T15:00:00.000Z"),
	);
	return { database, store };
}

describe("encrypted writing profile", () => {
	it("requires consent, aggregates samples, and keeps exemplar retention bounded", () => {
		const { database, store } = fixture();
		store.configure({
			enabled: true,
			useSelectedExemplars: true,
			maxExemplars: 2,
		});

		expect(() =>
			store.ingest({
				text: "A sample without consent.",
				consent: false as never,
			}),
		).toThrow("Explicit consent");
		store.ingest({
			text: "I write plainly, and I keep the note short.",
			consent: true,
			useAsExemplar: true,
		});
		store.ingest({
			text: "Could we meet tomorrow? I will bring the revised brief.",
			consent: true,
			useAsExemplar: true,
		});
		store.ingest({
			text: "Thanks for taking a look!",
			consent: true,
			useAsExemplar: true,
		});

		const status = store.status();
		expect(status.status).toBe("ready");
		expect(status.sampleCount).toBe(3);
		expect(status.exemplarCount).toBe(2);
		expect(status.wordCount).toBeGreaterThan(10);
		expect(store.promptContext()).toContain("Thanks for taking a look");
		expect(store.promptContext()).not.toContain("I write plainly");
		database.close();
	});

	it("does not let slice(-0) retain raw text and encrypts the stored payload", () => {
		const { database, store } = fixture();
		store.configure({
			enabled: true,
			useSelectedExemplars: true,
			maxExemplars: 0,
		});
		store.ingest({
			text: "This text is aggregate-only.",
			consent: true,
			useAsExemplar: true,
		});

		expect(store.status().exemplarCount).toBe(0);
		expect(store.promptContext()).not.toContain("This text is aggregate-only");
		const row = database.db
			.prepare(
				"SELECT value_ciphertext FROM private_runtime_state WHERE key = ?",
			)
			.get("writing.profile.v1") as { value_ciphertext: string };
		expect(row.value_ciphertext).not.toContain("aggregate-only");
		database.close();
	});

	it("resets the profile without touching unrelated private state", () => {
		const { database, store } = fixture();
		database.setPrivateState("unrelated", { keep: true });
		store.configure({
			enabled: true,
			useSelectedExemplars: false,
			maxExemplars: 3,
		});
		store.ingest({ text: "A private sample.", consent: true });
		const reset = store.reset();

		expect(reset.status).toBe("disabled");
		expect(reset.sampleCount).toBe(0);
		expect(database.getPrivateState("unrelated")).toEqual({ keep: true });
		expect(
			database.db
				.prepare("SELECT 1 FROM private_runtime_state WHERE key = ?")
				.get("writing.profile.v1"),
		).toBeUndefined();
		database.close();
	});
});
