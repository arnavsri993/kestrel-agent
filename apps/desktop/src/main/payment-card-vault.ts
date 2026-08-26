import { randomUUID } from "node:crypto";
import {
	PaymentCardEntrySchema,
	PaymentCardEntrySummarySchema,
	type PaymentCardEntry,
	type PaymentCardEntrySummary,
} from "@kestrel/shared-types";
import { z } from "zod";
import type { CredentialBroker } from "./credential-broker";

const PAYMENT_CARD_VAULT_SECRET_ID = "browser-payment-card-vault";
const PAYMENT_CARD_VAULT_VERSION = 1 as const;
const MAX_PAYMENT_CARDS = 200;

const StoredPaymentCardVaultSchema = z.object({
	version: z.literal(PAYMENT_CARD_VAULT_VERSION),
	entries: z.array(PaymentCardEntrySchema).max(MAX_PAYMENT_CARDS),
});

export interface SavePaymentCardInput {
	cardNumber: string;
	expirationMonth: string;
	expirationYear: string;
	cardholderName?: string;
	postalCode?: string;
}

function digits(value: string): string {
	return value.replace(/\D/g, "");
}

function passesLuhn(value: string): boolean {
	let sum = 0;
	let doubleDigit = false;
	for (let index = value.length - 1; index >= 0; index -= 1) {
		let digit = Number(value[index]);
		if (doubleDigit) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		doubleDigit = !doubleDigit;
	}
	return sum % 10 === 0;
}

export function normalizePaymentCardNumber(value: string): string {
	const cardNumber = digits(value);
	if (
		cardNumber.length < 12 ||
		cardNumber.length > 19 ||
		!passesLuhn(cardNumber)
	)
		throw new Error("Enter a valid payment card number.");
	return cardNumber;
}

export function normalizePaymentCardExpiration(
	monthValue: string,
	yearValue: string,
): { month: string; year: string } {
	const month = digits(monthValue).padStart(2, "0");
	const rawYear = digits(yearValue);
	if (!/^(?:\d{2}|\d{4})$/.test(rawYear))
		throw new Error("Enter a valid expiration date.");
	const year = rawYear.length === 4 ? rawYear.slice(-2) : rawYear;
	if (!/^(0[1-9]|1[0-2])$/.test(month))
		throw new Error("Enter a valid expiration date.");
	return { month, year };
}

export function paymentCardBrand(cardNumber: string): string {
	if (/^4/.test(cardNumber)) return "Visa";
	if (/^(5[1-5]|2(2[2-9]|[3-6]\d))/.test(cardNumber)) return "Mastercard";
	if (/^3[47]/.test(cardNumber)) return "American Express";
	if (/^(6011|65|64[4-9])/.test(cardNumber)) return "Discover";
	if (/^(35|2131|1800)/.test(cardNumber)) return "JCB";
	if (/^3(?:0[0-5]|[68])/.test(cardNumber)) return "Diners Club";
	return "Card";
}

function summary(entry: PaymentCardEntry): PaymentCardEntrySummary {
	return PaymentCardEntrySummarySchema.parse({
		id: entry.id,
		brand: entry.brand,
		last4: entry.last4,
		expirationMonth: entry.expirationMonth,
		expirationYear: entry.expirationYear,
		cardholderName: entry.cardholderName,
		updatedAt: entry.updatedAt,
	});
}

export class PaymentCardVault {
	private entriesPromise: Promise<PaymentCardEntry[]> | undefined;

	constructor(private readonly broker: CredentialBroker) {}

	async list(): Promise<PaymentCardEntrySummary[]> {
		const entries = await this.entries();
		return entries
			.slice()
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.map(summary);
	}

	async get(id: PaymentCardEntry["id"]): Promise<PaymentCardEntry | undefined> {
		return (await this.entries()).find((entry) => entry.id === id);
	}

	async save(input: SavePaymentCardInput): Promise<PaymentCardEntrySummary[]> {
		const cardNumber = normalizePaymentCardNumber(input.cardNumber);
		const expiration = normalizePaymentCardExpiration(
			input.expirationMonth,
			input.expirationYear,
		);
		const cardholderName = (input.cardholderName ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 200);
		const postalCode = (input.postalCode ?? "").trim().slice(0, 100);
		const now = new Date().toISOString();
		const entries = await this.entries();
		const existing = entries.find((entry) => entry.cardNumber === cardNumber);
		const next = PaymentCardEntrySchema.parse({
			id: existing?.id ?? `payment-card-${randomUUID()}`,
			brand: paymentCardBrand(cardNumber),
			last4: cardNumber.slice(-4),
			expirationMonth: expiration.month,
			expirationYear: expiration.year,
			cardholderName,
			cardNumber,
			postalCode,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		});
		const nextEntries = existing
			? entries.map((entry) => (entry.id === existing.id ? next : entry))
			: [...entries, next];
		if (nextEntries.length > MAX_PAYMENT_CARDS)
			throw new Error(`Kestrel can store up to ${MAX_PAYMENT_CARDS} payment cards.`);
		await this.writeEntries(nextEntries);
		return this.list();
	}

	async remove(id: PaymentCardEntry["id"]): Promise<PaymentCardEntrySummary[]> {
		const entries = await this.entries();
		const next = entries.filter((entry) => entry.id !== id);
		if (next.length !== entries.length) await this.writeEntries(next);
		return this.list();
	}

	private async entries(): Promise<PaymentCardEntry[]> {
		this.entriesPromise ??= this.loadEntries();
		try {
			return await this.entriesPromise;
		} catch (error) {
			this.entriesPromise = undefined;
			throw error;
		}
	}

	private async loadEntries(): Promise<PaymentCardEntry[]> {
		const raw = await this.broker.getOpaqueSecret(PAYMENT_CARD_VAULT_SECRET_ID);
		if (!raw) return [];
		try {
			const parsed: unknown = JSON.parse(raw);
			const vault = StoredPaymentCardVaultSchema.parse(parsed);
			return vault.entries.map((entry) => PaymentCardEntrySchema.parse(entry));
		} catch (error) {
			throw new Error("The saved payment cards store is malformed.", { cause: error });
		}
	}

	private async writeEntries(entries: PaymentCardEntry[]): Promise<void> {
		if (entries.length === 0) {
			await this.broker.removeOpaqueSecret(PAYMENT_CARD_VAULT_SECRET_ID);
		} else {
			await this.broker.setOpaqueSecret(
				PAYMENT_CARD_VAULT_SECRET_ID,
				JSON.stringify({ version: PAYMENT_CARD_VAULT_VERSION, entries }),
			);
		}
		this.entriesPromise = Promise.resolve(entries);
	}
}
