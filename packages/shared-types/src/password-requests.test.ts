import { describe, expect, it } from "vitest";
import {
	PasswordEntrySummarySchema,
	RendererRequestSchema,
	UserBrowserSettingsSchema,
} from "./contracts";

const PASSWORD_ID = "password-00000000-0000-4000-8000-000000000001";

describe("password renderer contracts", () => {
	it("asks before saving passwords by default", () => {
		expect(UserBrowserSettingsSchema.parse({}).autoSavePasswords).toBe(false);
	});

	it("validates password add and update requests", () => {
		expect(
		RendererRequestSchema.parse({
			type: "password-add",
			origin: "https://accounts.example.test",
			username: "person@example.test",
			password: "new-secret",
		}),
	).toMatchObject({ type: "password-add", password: "new-secret" });
		expect(
		RendererRequestSchema.parse({
			type: "password-update",
			passwordId: PASSWORD_ID,
			username: "person@example.test",
		}),
	).toMatchObject({ type: "password-update", passwordId: PASSWORD_ID });

		for (const request of [
			{
				type: "password-add",
				origin: "not-a-url",
				username: "person",
				password: "secret",
			},
			{
				type: "password-update",
				passwordId: PASSWORD_ID,
				username: "person",
				password: "contains\0nul",
			},
			{
				type: "password-update",
				passwordId: "not-a-password-id",
				username: "person",
			},
		]) {
			expect(() => RendererRequestSchema.parse(request)).toThrow();
		}
	});

	it("strips passwords from public saved-login summaries", () => {
		const summary = PasswordEntrySummarySchema.parse({
			id: PASSWORD_ID,
			origin: "https://accounts.example.test",
			title: "Accounts",
			username: "person@example.test",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
			password: "must-not-cross-the-response-boundary",
		});

		expect(summary).not.toHaveProperty("password");
	});
});
