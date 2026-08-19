import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BrowserAutofillStore,
	detectCardBrand,
	domainsMatch,
	extractDomain,
	maskCardNumber,
} from "./browser-autofill-store";

describe("BrowserAutofillStore", () => {
	let tempDir: string;
	let store: BrowserAutofillStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kestrel-autofill-test-"));
		store = new BrowserAutofillStore(tempDir, () => new Date("2026-08-15T12:00:00.000Z"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("utilities", () => {
		it("extracts domains correctly", () => {
			expect(extractDomain("https://github.com/login")).toBe("github.com");
			expect(extractDomain("http://www.google.com/search?q=test")).toBe("google.com");
			expect(extractDomain("app.slack.com")).toBe("app.slack.com");
			expect(extractDomain("localhost:3000")).toBe("localhost");
		});

		it("matches domains with subdomains", () => {
			expect(domainsMatch("github.com", "github.com")).toBe(true);
			expect(domainsMatch("auth.github.com", "github.com")).toBe(true);
			expect(domainsMatch("github.com", "https://github.com/session")).toBe(true);
			expect(domainsMatch("github.com", "gitlab.com")).toBe(false);
		});

		it("detects credit card brands", () => {
			expect(detectCardBrand("4111111111111111")).toBe("visa");
			expect(detectCardBrand("5500000000000004")).toBe("mastercard");
			expect(detectCardBrand("378282246310005")).toBe("amex");
			expect(detectCardBrand("6011000990139424")).toBe("discover");
			expect(detectCardBrand("3530111333300000")).toBe("jcb");
		});

		it("masks card numbers", () => {
			expect(maskCardNumber("4111111111114242")).toBe("•••• •••• •••• 4242");
			expect(maskCardNumber("378282246310005")).toBe("•••• •••• •••• 0005");
		});
	});

	describe("passwords", () => {
		it("saves, encrypts, and retrieves passwords", () => {
			const saved = store.savePassword({
				url: "https://github.com/login",
				username: "octocat@github.com",
				password: "SuperSecretPassword123!",
				name: "GitHub Main",
			});

			expect(saved.id).toBeTruthy();
			expect(saved.domain).toBe("github.com");
			expect(saved.username).toBe("octocat@github.com");
			expect(saved.password).toBe("SuperSecretPassword123!");

			// Retrieve list
			const list = store.listPasswords();
			expect(list).toHaveLength(1);
			expect(list[0]?.password).toBe("SuperSecretPassword123!");

			// Find by url
			const matched = store.findPasswordsForUrl("https://github.com/settings");
			expect(matched).toHaveLength(1);
			expect(matched[0]?.username).toBe("octocat@github.com");

			// Delete
			const deleted = store.deletePassword(saved.id);
			expect(deleted).toBe(true);
			expect(store.listPasswords()).toHaveLength(0);
		});

		it("updates existing password for same domain and username", () => {
			store.savePassword({
				url: "https://x.com/login",
				username: "alice",
				password: "OldPassword1",
			});

			const updated = store.savePassword({
				url: "https://x.com/i/flow/login",
				username: "alice",
				password: "NewPassword2",
			});

			expect(store.listPasswords()).toHaveLength(1);
			expect(updated.password).toBe("NewPassword2");
		});
	});

	describe("addresses", () => {
		it("saves, lists, and removes contact addresses", () => {
			const addr = store.saveAddress({
				label: "Home",
				fullName: "Jane Doe",
				organization: "Acme Corp",
				streetAddress: "123 Main St",
				streetAddressLine2: "Apt 4B",
				city: "San Francisco",
				state: "CA",
				postalCode: "94105",
				country: "USA",
				phone: "+1 555-0199",
				email: "jane.doe@example.com",
			});

			expect(addr.id).toBeTruthy();
			expect(addr.fullName).toBe("Jane Doe");

			const list = store.listAddresses("Jane");
			expect(list).toHaveLength(1);
			expect(list[0]?.city).toBe("San Francisco");

			const deleted = store.deleteAddress(addr.id);
			expect(deleted).toBe(true);
			expect(store.listAddresses()).toHaveLength(0);
		});
	});

	describe("payment cards", () => {
		it("saves, encrypts, and lists payment methods with masking", () => {
			const card = store.savePaymentCard({
				cardholderName: "Jane Doe",
				cardNumber: "4111222233334242",
				expirationMonth: "12",
				expirationYear: "2028",
				nickname: "Travel Rewards",
			});

			expect(card.id).toBeTruthy();
			expect(card.cardBrand).toBe("visa");
			expect(card.cardNumber).toBe("•••• •••• •••• 4242");

			// Fetch with full decryption
			const full = store.getPaymentCard(card.id, true);
			expect(full?.cardNumber).toBe("4111222233334242");

			// Query autofill
			const query = store.queryAutofill("https://store.example.com/checkout");
			expect(query.paymentMethods).toHaveLength(1);
			expect(query.paymentMethods[0]?.cardNumber).toBe("•••• •••• •••• 4242");

			// Delete
			const deleted = store.deletePaymentCard(card.id);
			expect(deleted).toBe(true);
			expect(store.listPaymentCards()).toHaveLength(0);
		});
	});
});
