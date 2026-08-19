import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	decryptText,
	encryptText,
	createEncryptionKey,
	type EncryptedPayload,
} from "@kestrel/encryption";
import type {
	SavedAddress,
	SavedPassword,
	SavedPaymentCard,
} from "@kestrel/shared-types";

interface StoredEncryptedField {
	payload: EncryptedPayload;
}

interface StoredPasswordRecord {
	id: string;
	url: string;
	domain: string;
	username: string;
	encryptedPassword: StoredEncryptedField;
	name?: string;
	createdAt: string;
	updatedAt: string;
	lastUsedAt?: string;
}

interface StoredAddressRecord {
	id: string;
	label?: string;
	fullName: string;
	organization?: string;
	streetAddress: string;
	streetAddressLine2?: string;
	city: string;
	state?: string;
	postalCode?: string;
	country?: string;
	phone?: string;
	email?: string;
	createdAt: string;
	updatedAt: string;
}

interface StoredPaymentCardRecord {
	id: string;
	cardholderName: string;
	encryptedCardNumber: StoredEncryptedField;
	lastFour: string;
	cardBrand?: string;
	expirationMonth: string;
	expirationYear: string;
	nickname?: string;
	billingAddressId?: string;
	createdAt: string;
	updatedAt: string;
}

interface VaultData {
	version: number;
	passwords: StoredPasswordRecord[];
	addresses: StoredAddressRecord[];
	paymentCards: StoredPaymentCardRecord[];
}

export function detectCardBrand(cardNumber: string): string {
	const cleaned = cardNumber.replace(/\D/g, "");
	if (/^4[0-9]{11}(?:[0-9]{3,6})?$/.test(cleaned) || cleaned.startsWith("4")) {
		return "visa";
	}
	if (
		/^(?:5[1-5][0-9]{2}|222[1-9]|22[3-9][0-9]|2[3-6][0-9]{2}|27[01][0-9]|2720)[0-9]{12}$/.test(
			cleaned,
		) ||
		/^(5[1-5]|2[2-7])/.test(cleaned)
	) {
		return "mastercard";
	}
	if (/^3[47][0-9]{13}$/.test(cleaned) || /^3[47]/.test(cleaned)) {
		return "amex";
	}
	if (
		/^6(?:011|5[0-9]{2}|4[4-9][0-9]|22(?:12[6-9]|1[3-9][0-9]|[2-8][0-9]{2}|9[01][0-9]|92[0-5]))[0-9]{12}$/.test(
			cleaned,
		) ||
		cleaned.startsWith("6011") ||
		cleaned.startsWith("65")
	) {
		return "discover";
	}
	if (/^(?:2131|1800|35\d{3})\d{11}$/.test(cleaned) || cleaned.startsWith("35")) {
		return "jcb";
	}
	if (/^3(?:0[0-5]|[68][0-9])[0-9]{11}$/.test(cleaned) || /^3(0[0-5]|[68])/.test(cleaned)) {
		return "diners";
	}
	if (/^62[0-9]{14,17}$/.test(cleaned) || cleaned.startsWith("62")) {
		return "unionpay";
	}
	return "generic";
}

export function maskCardNumber(cardNumber: string): string {
	const digits = cardNumber.replace(/\D/g, "");
	const lastFour = digits.slice(-4) || "••••";
	return `•••• •••• •••• ${lastFour}`;
}

export function extractDomain(urlOrDomain: string): string {
	if (!urlOrDomain) return "";
	try {
		const parsed = new URL(
			urlOrDomain.includes("://") ? urlOrDomain : `https://${urlOrDomain}`,
		);
		return parsed.hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		const part = urlOrDomain.toLowerCase().replace(/^www\./, "").split("/")[0] ?? "";
		return part.split(":")[0] ?? "";
	}
}

export function domainsMatch(domainA: string, domainB: string): boolean {
	const cleanA = extractDomain(domainA);
	const cleanB = extractDomain(domainB);
	if (!cleanA || !cleanB) return false;
	if (cleanA === cleanB) return true;
	return cleanA.endsWith(`.${cleanB}`) || cleanB.endsWith(`.${cleanA}`);
}

export class BrowserAutofillStore {
	private readonly vaultPath: string;
	private readonly keyPath: string;
	private key: Buffer;
	private vault: VaultData;
	private readonly now: () => Date;

	constructor(baseDir: string, now?: () => Date) {
		const autofillDir = join(baseDir, "browser-autofill");
		mkdirSync(autofillDir, { recursive: true, mode: 0o700 });
		this.vaultPath = join(autofillDir, "vault.json");
		this.keyPath = join(autofillDir, "vault.key");
		this.now = now ?? (() => new Date());
		this.key = this.loadOrCreateKey();
		this.vault = this.loadVault();
	}

	private loadOrCreateKey(): Buffer {
		try {
			if (existsSync(this.keyPath)) {
				const raw = readFileSync(this.keyPath);
				if (raw.length === 32) return raw;
			}
		} catch {
			// Fallback to generate fresh key
		}
		const freshKey = createEncryptionKey();
		try {
			writeFileSync(this.keyPath, freshKey, { mode: 0o600 });
		} catch {
			// Ignore write error in ephemeral environments
		}
		return freshKey;
	}

	private loadVault(): VaultData {
		try {
			if (existsSync(this.vaultPath)) {
				const content = readFileSync(this.vaultPath, "utf8");
				const parsed = JSON.parse(content) as VaultData;
				if (
					parsed &&
					typeof parsed === "object" &&
					Array.isArray(parsed.passwords) &&
					Array.isArray(parsed.addresses) &&
					Array.isArray(parsed.paymentCards)
				) {
					return parsed;
				}
			}
		} catch {
			// Failed to parse, use empty vault
		}
		return {
			version: 1,
			passwords: [],
			addresses: [],
			paymentCards: [],
		};
	}

	private persist(): void {
		try {
			mkdirSync(dirname(this.vaultPath), { recursive: true, mode: 0o700 });
			writeFileSync(
				this.vaultPath,
				JSON.stringify(this.vault, null, 2),
				{ encoding: "utf8", mode: 0o600 },
			);
		} catch {
			// Ignore persist error in memory/test environments
		}
	}

	// --------------------------------------------------------------------------
	// Passwords
	// --------------------------------------------------------------------------

	listPasswords(query?: string): SavedPassword[] {
		const q = query?.trim().toLowerCase();
		const results: SavedPassword[] = [];
		for (const record of this.vault.passwords) {
			if (
				q &&
				!record.domain.toLowerCase().includes(q) &&
				!record.username.toLowerCase().includes(q) &&
				!(record.name && record.name.toLowerCase().includes(q))
			) {
				continue;
			}
			try {
				const password = decryptText(record.encryptedPassword.payload, this.key);
				results.push({
					id: record.id,
					url: record.url,
					domain: record.domain,
					username: record.username,
					password,
					...(record.name ? { name: record.name } : {}),
					createdAt: record.createdAt,
					updatedAt: record.updatedAt,
					...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
				});
			} catch {
				// Password decryption failure for this entry, skip
			}
		}
		return results.sort((a, b) => a.domain.localeCompare(b.domain));
	}

	findPasswordsForUrl(urlOrDomain: string): SavedPassword[] {
		const targetDomain = extractDomain(urlOrDomain);
		if (!targetDomain) return [];
		return this.listPasswords().filter((entry) =>
			domainsMatch(entry.domain, targetDomain),
		);
	}

	getPassword(id: string): SavedPassword | undefined {
		const record = this.vault.passwords.find((item) => item.id === id);
		if (!record) return undefined;
		try {
			const password = decryptText(record.encryptedPassword.payload, this.key);
			return {
				id: record.id,
				url: record.url,
				domain: record.domain,
				username: record.username,
				password,
				...(record.name ? { name: record.name } : {}),
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
				...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
			};
		} catch {
			return undefined;
		}
	}

	savePassword(data: {
		id?: string;
		url: string;
		domain?: string;
		username: string;
		password: string;
		name?: string;
	}): SavedPassword {
		const nowStr = this.now().toISOString();
		const domain = data.domain ? extractDomain(data.domain) : extractDomain(data.url);
		const encrypted = encryptText(data.password, this.key);
		const existingIndex = data.id
			? this.vault.passwords.findIndex((item) => item.id === data.id)
			: this.vault.passwords.findIndex(
					(item) =>
						domainsMatch(item.domain, domain) &&
						item.username.toLowerCase() === data.username.toLowerCase(),
				);

		if (existingIndex >= 0 && this.vault.passwords[existingIndex]) {
			const existing = this.vault.passwords[existingIndex]!;
			const updated: StoredPasswordRecord = {
				id: existing.id,
				url: data.url || existing.url,
				domain: domain || existing.domain,
				username: data.username,
				encryptedPassword: { payload: encrypted },
				createdAt: existing.createdAt,
				updatedAt: nowStr,
			};
			if (data.name !== undefined) {
				if (data.name) updated.name = data.name;
			} else if (existing.name) {
				updated.name = existing.name;
			}
			if (existing.lastUsedAt) {
				updated.lastUsedAt = existing.lastUsedAt;
			}
			this.vault.passwords[existingIndex] = updated;
			this.persist();
			return {
				id: updated.id,
				url: updated.url,
				domain: updated.domain,
				username: updated.username,
				password: data.password,
				...(updated.name ? { name: updated.name } : {}),
				createdAt: updated.createdAt,
				updatedAt: updated.updatedAt,
				...(updated.lastUsedAt ? { lastUsedAt: updated.lastUsedAt } : {}),
			};
		}

		const id = data.id || `pwd-${randomUUID()}`;
		const newRecord: StoredPasswordRecord = {
			id,
			url: data.url,
			domain: domain || "unknown",
			username: data.username,
			encryptedPassword: { payload: encrypted },
			...(data.name ? { name: data.name } : {}),
			createdAt: nowStr,
			updatedAt: nowStr,
		};
		this.vault.passwords.push(newRecord);
		this.persist();
		return {
			id: newRecord.id,
			url: newRecord.url,
			domain: newRecord.domain,
			username: newRecord.username,
			password: data.password,
			...(newRecord.name ? { name: newRecord.name } : {}),
			createdAt: newRecord.createdAt,
			updatedAt: newRecord.updatedAt,
		};
	}

	deletePassword(id: string): boolean {
		const prevLen = this.vault.passwords.length;
		this.vault.passwords = this.vault.passwords.filter((item) => item.id !== id);
		if (this.vault.passwords.length !== prevLen) {
			this.persist();
			return true;
		}
		return false;
	}

	markPasswordUsed(id: string): void {
		const record = this.vault.passwords.find((item) => item.id === id);
		if (record) {
			record.lastUsedAt = this.now().toISOString();
			this.persist();
		}
	}

	// --------------------------------------------------------------------------
	// Addresses & Contacts
	// --------------------------------------------------------------------------

	listAddresses(query?: string): SavedAddress[] {
		const q = query?.trim().toLowerCase();
		return this.vault.addresses
			.filter((record) => {
				if (!q) return true;
				return (
					record.fullName.toLowerCase().includes(q) ||
					(record.organization && record.organization.toLowerCase().includes(q)) ||
					record.streetAddress.toLowerCase().includes(q) ||
					record.city.toLowerCase().includes(q) ||
					(record.email && record.email.toLowerCase().includes(q)) ||
					(record.phone && record.phone.includes(q))
				);
			})
			.map((record) => ({
				id: record.id,
				...(record.label ? { label: record.label } : {}),
				fullName: record.fullName,
				...(record.organization ? { organization: record.organization } : {}),
				streetAddress: record.streetAddress,
				...(record.streetAddressLine2 ? { streetAddressLine2: record.streetAddressLine2 } : {}),
				city: record.city,
				...(record.state ? { state: record.state } : {}),
				...(record.postalCode ? { postalCode: record.postalCode } : {}),
				...(record.country ? { country: record.country } : {}),
				...(record.phone ? { phone: record.phone } : {}),
				...(record.email ? { email: record.email } : {}),
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			}))
			.sort((a, b) => a.fullName.localeCompare(b.fullName));
	}

	getAddress(id: string): SavedAddress | undefined {
		const record = this.vault.addresses.find((item) => item.id === id);
		if (!record) return undefined;
		return { ...record };
	}

	saveAddress(data: {
		id?: string;
		label?: string;
		fullName: string;
		organization?: string;
		streetAddress: string;
		streetAddressLine2?: string;
		city: string;
		state?: string;
		postalCode?: string;
		country?: string;
		phone?: string;
		email?: string;
	}): SavedAddress {
		const nowStr = this.now().toISOString();
		const existingIndex = data.id
			? this.vault.addresses.findIndex((item) => item.id === data.id)
			: -1;

		if (existingIndex >= 0 && this.vault.addresses[existingIndex]) {
			const existing = this.vault.addresses[existingIndex]!;
			const updated: StoredAddressRecord = {
				id: existing.id,
				fullName: data.fullName,
				streetAddress: data.streetAddress,
				city: data.city,
				createdAt: existing.createdAt,
				updatedAt: nowStr,
			};
			if (data.label !== undefined) {
				if (data.label) updated.label = data.label;
			} else if (existing.label) {
				updated.label = existing.label;
			}
			if (data.organization !== undefined) {
				if (data.organization) updated.organization = data.organization;
			} else if (existing.organization) {
				updated.organization = existing.organization;
			}
			if (data.streetAddressLine2 !== undefined) {
				if (data.streetAddressLine2) updated.streetAddressLine2 = data.streetAddressLine2;
			} else if (existing.streetAddressLine2) {
				updated.streetAddressLine2 = existing.streetAddressLine2;
			}
			if (data.state !== undefined) {
				if (data.state) updated.state = data.state;
			} else if (existing.state) {
				updated.state = existing.state;
			}
			if (data.postalCode !== undefined) {
				if (data.postalCode) updated.postalCode = data.postalCode;
			} else if (existing.postalCode) {
				updated.postalCode = existing.postalCode;
			}
			if (data.country !== undefined) {
				if (data.country) updated.country = data.country;
			} else if (existing.country) {
				updated.country = existing.country;
			}
			if (data.phone !== undefined) {
				if (data.phone) updated.phone = data.phone;
			} else if (existing.phone) {
				updated.phone = existing.phone;
			}
			if (data.email !== undefined) {
				if (data.email) updated.email = data.email;
			} else if (existing.email) {
				updated.email = existing.email;
			}
			this.vault.addresses[existingIndex] = updated;
			this.persist();
			return { ...updated };
		}

		const id = data.id || `addr-${randomUUID()}`;
		const newRecord: StoredAddressRecord = {
			id,
			...(data.label ? { label: data.label } : {}),
			fullName: data.fullName,
			...(data.organization ? { organization: data.organization } : {}),
			streetAddress: data.streetAddress,
			...(data.streetAddressLine2 ? { streetAddressLine2: data.streetAddressLine2 } : {}),
			city: data.city,
			...(data.state ? { state: data.state } : {}),
			...(data.postalCode ? { postalCode: data.postalCode } : {}),
			...(data.country ? { country: data.country } : {}),
			...(data.phone ? { phone: data.phone } : {}),
			...(data.email ? { email: data.email } : {}),
			createdAt: nowStr,
			updatedAt: nowStr,
		};
		this.vault.addresses.push(newRecord);
		this.persist();
		return { ...newRecord };
	}

	deleteAddress(id: string): boolean {
		const prevLen = this.vault.addresses.length;
		this.vault.addresses = this.vault.addresses.filter((item) => item.id !== id);
		if (this.vault.addresses.length !== prevLen) {
			this.persist();
			return true;
		}
		return false;
	}

	// --------------------------------------------------------------------------
	// Payment Cards
	// --------------------------------------------------------------------------

	listPaymentCards(query?: string, revealNumber = false): SavedPaymentCard[] {
		const q = query?.trim().toLowerCase();
		const results: SavedPaymentCard[] = [];
		for (const record of this.vault.paymentCards) {
			if (
				q &&
				!record.cardholderName.toLowerCase().includes(q) &&
				!(record.nickname && record.nickname.toLowerCase().includes(q)) &&
				!record.lastFour.includes(q)
			) {
				continue;
			}
			let cardNumber = `•••• •••• •••• ${record.lastFour}`;
			if (revealNumber) {
				try {
					cardNumber = decryptText(record.encryptedCardNumber.payload, this.key);
				} catch {
					// Fallback to masked
				}
			}
			results.push({
				id: record.id,
				cardholderName: record.cardholderName,
				cardNumber,
				cardBrand: record.cardBrand || detectCardBrand(record.lastFour),
				expirationMonth: record.expirationMonth,
				expirationYear: record.expirationYear,
				...(record.nickname ? { nickname: record.nickname } : {}),
				...(record.billingAddressId ? { billingAddressId: record.billingAddressId } : {}),
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			});
		}
		return results.sort((a, b) => a.cardholderName.localeCompare(b.cardholderName));
	}

	getPaymentCard(id: string, revealNumber = true): SavedPaymentCard | undefined {
		const record = this.vault.paymentCards.find((item) => item.id === id);
		if (!record) return undefined;
		let cardNumber = `•••• •••• •••• ${record.lastFour}`;
		if (revealNumber) {
			try {
				cardNumber = decryptText(record.encryptedCardNumber.payload, this.key);
			} catch {
				// Keep masked
			}
		}
		return {
			id: record.id,
			cardholderName: record.cardholderName,
			cardNumber,
			cardBrand: record.cardBrand || detectCardBrand(record.lastFour),
			expirationMonth: record.expirationMonth,
			expirationYear: record.expirationYear,
			...(record.nickname ? { nickname: record.nickname } : {}),
			...(record.billingAddressId ? { billingAddressId: record.billingAddressId } : {}),
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		};
	}

	savePaymentCard(data: {
		id?: string;
		cardholderName: string;
		cardNumber: string;
		cardBrand?: string;
		expirationMonth: string;
		expirationYear: string;
		nickname?: string;
		billingAddressId?: string;
	}): SavedPaymentCard {
		const nowStr = this.now().toISOString();
		const digits = data.cardNumber.replace(/\D/g, "");
		const lastFour = digits.slice(-4) || "0000";
		const brand = data.cardBrand || detectCardBrand(digits);
		const encrypted = encryptText(digits, this.key);

		const existingIndex = data.id
			? this.vault.paymentCards.findIndex((item) => item.id === data.id)
			: -1;

		if (existingIndex >= 0 && this.vault.paymentCards[existingIndex]) {
			const existing = this.vault.paymentCards[existingIndex]!;
			const updated: StoredPaymentCardRecord = {
				id: existing.id,
				cardholderName: data.cardholderName,
				encryptedCardNumber: digits.length >= 12 ? { payload: encrypted } : existing.encryptedCardNumber,
				lastFour: digits.length >= 12 ? lastFour : existing.lastFour,
				cardBrand: brand,
				expirationMonth: data.expirationMonth,
				expirationYear: data.expirationYear,
				createdAt: existing.createdAt,
				updatedAt: nowStr,
			};
			if (data.nickname !== undefined) {
				if (data.nickname) updated.nickname = data.nickname;
			} else if (existing.nickname) {
				updated.nickname = existing.nickname;
			}
			if (data.billingAddressId !== undefined) {
				if (data.billingAddressId) updated.billingAddressId = data.billingAddressId;
			} else if (existing.billingAddressId) {
				updated.billingAddressId = existing.billingAddressId;
			}
			this.vault.paymentCards[existingIndex] = updated;
			this.persist();
			return {
				id: updated.id,
				cardholderName: updated.cardholderName,
				cardNumber: maskCardNumber(updated.lastFour),
				cardBrand: updated.cardBrand,
				expirationMonth: updated.expirationMonth,
				expirationYear: updated.expirationYear,
				...(updated.nickname ? { nickname: updated.nickname } : {}),
				...(updated.billingAddressId ? { billingAddressId: updated.billingAddressId } : {}),
				createdAt: updated.createdAt,
				updatedAt: updated.updatedAt,
			};
		}

		const id = data.id || `card-${randomUUID()}`;
		const newRecord: StoredPaymentCardRecord = {
			id,
			cardholderName: data.cardholderName,
			encryptedCardNumber: { payload: encrypted },
			lastFour,
			cardBrand: brand,
			expirationMonth: data.expirationMonth,
			expirationYear: data.expirationYear,
			...(data.nickname ? { nickname: data.nickname } : {}),
			...(data.billingAddressId ? { billingAddressId: data.billingAddressId } : {}),
			createdAt: nowStr,
			updatedAt: nowStr,
		};
		this.vault.paymentCards.push(newRecord);
		this.persist();
		return {
			id: newRecord.id,
			cardholderName: newRecord.cardholderName,
			cardNumber: maskCardNumber(newRecord.lastFour),
			cardBrand: newRecord.cardBrand,
			expirationMonth: newRecord.expirationMonth,
			expirationYear: newRecord.expirationYear,
			...(newRecord.nickname ? { nickname: newRecord.nickname } : {}),
			...(newRecord.billingAddressId ? { billingAddressId: newRecord.billingAddressId } : {}),
			createdAt: newRecord.createdAt,
			updatedAt: newRecord.updatedAt,
		};
	}

	deletePaymentCard(id: string): boolean {
		const prevLen = this.vault.paymentCards.length;
		this.vault.paymentCards = this.vault.paymentCards.filter((item) => item.id !== id);
		if (this.vault.paymentCards.length !== prevLen) {
			this.persist();
			return true;
		}
		return false;
	}

	// --------------------------------------------------------------------------
	// Unified Autofill Query
	// --------------------------------------------------------------------------

	queryAutofill(url?: string): {
		passwords: SavedPassword[];
		addresses: SavedAddress[];
		paymentMethods: SavedPaymentCard[];
	} {
		const passwords = url ? this.findPasswordsForUrl(url) : this.listPasswords();
		const addresses = this.listAddresses();
		const paymentMethods = this.listPaymentCards(undefined, false);
		return {
			passwords,
			addresses,
			paymentMethods,
		};
	}
}
