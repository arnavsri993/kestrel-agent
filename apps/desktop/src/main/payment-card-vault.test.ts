import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CredentialBroker,
	PlaintextSecretProtection,
} from "./credential-broker";
import {
	normalizePaymentCardExpiration,
	normalizePaymentCardNumber,
	PaymentCardVault,
} from "./payment-card-vault";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createVault() {
	const root = mkdtempSync(join(tmpdir(), "kestrel-payment-card-vault-"));
	roots.push(root);
	return {
		root,
		vault: new PaymentCardVault(
			new CredentialBroker(root, new PlaintextSecretProtection()),
		),
	};
}

describe("payment card vault", () => {
	it("stores encrypted card data while listing only masked summaries", async () => {
		const { root, vault } = createVault();
		const summaries = await vault.save({
			cardNumber: "5555 5555 5555 4444",
			expirationMonth: "03",
			expirationYear: "2031",
			cardholderName: "Arnav Srivastava",
			postalCode: "63025",
		});

		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			brand: "Mastercard",
			last4: "4444",
			expirationMonth: "03",
			expirationYear: "31",
		});
		expect(summaries[0]).not.toHaveProperty("cardNumber");

		const storedPath = join(
			root,
			"secure",
			"credentials",
			"opaque-browser-payment-card-vault.bin",
		);
		expect(readFileSync(storedPath, "utf8")).not.toContain("5555555555554444");
		expect(await vault.get(summaries[0]!.id)).toMatchObject({
			cardNumber: "5555555555554444",
			postalCode: "63025",
		});
	});

	it("updates the same card instead of duplicating it", async () => {
		const { vault } = createVault();
		const first = await vault.save({
			cardNumber: "4111 1111 1111 1111",
			expirationMonth: "01",
			expirationYear: "30",
		});
		const second = await vault.save({
			cardNumber: "4111111111111111",
			expirationMonth: "12",
			expirationYear: "2032",
		});

		expect(second).toHaveLength(1);
		expect(second[0]?.id).toBe(first[0]?.id);
		expect(second[0]).toMatchObject({
			expirationMonth: "12",
			expirationYear: "32",
		});
	});

	it("rejects invalid card numbers and expiration dates", () => {
		expect(() => normalizePaymentCardNumber("4111 1111 1111 1112")).toThrow(
			"valid payment card",
		);
		expect(() => normalizePaymentCardExpiration("13", "2031")).toThrow(
			"valid expiration",
		);
		expect(() => normalizePaymentCardExpiration("3", "")).toThrow(
			"valid expiration",
		);
		expect(normalizePaymentCardExpiration("3", "2031")).toEqual({
			month: "03",
			year: "31",
		});
	});

	it("removes the protected vault when the last card is removed", async () => {
		const { root, vault } = createVault();
		const [entry] = await vault.save({
			cardNumber: "3782 822463 10005",
			expirationMonth: "11",
			expirationYear: "2030",
		});
		await vault.remove(entry!.id);

		expect(await vault.list()).toEqual([]);
		expect(() =>
			readFileSync(
				join(
					root,
					"secure",
					"credentials",
					"opaque-browser-payment-card-vault.bin",
				),
			),
		).toThrow();
	});
});
