import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

interface PasswordClipboard {
	writeText(value: string): void;
	readText(): string;
	clear(): void;
}

const expirations = new WeakMap<PasswordClipboard, () => void>();

/** Keep the expiry comparison private to this copy, without retaining plaintext
 * or a stable password fingerprint in the timer. This is not a password verifier. */
export function copyPasswordWithExpiry(
	clipboard: PasswordClipboard,
	password: string,
): void {
	const key = randomBytes(32);
	let copiedDigest: Buffer | undefined;
	try {
		const expected = createHmac("sha256", key).update(password, "utf8").digest();
		copiedDigest = expected;
		clipboard.writeText(password);
		expirations.get(clipboard)?.();
		const release = () => {
			key.fill(0);
			expected.fill(0);
		};
		const cancel = () => {
			clearTimeout(timer);
			release();
			if (expirations.get(clipboard) === cancel) expirations.delete(clipboard);
		};
		const timer = setTimeout(() => {
			let current: Buffer | undefined;
			try {
				current = createHmac("sha256", key)
					.update(clipboard.readText(), "utf8")
					.digest();
				if (timingSafeEqual(current, expected)) clipboard.clear();
			} catch {
				// Clipboard access can be revoked while Kestrel is in the background.
			} finally {
				release();
				current?.fill(0);
				if (expirations.get(clipboard) === cancel) expirations.delete(clipboard);
			}
		}, 60_000);
		expirations.set(clipboard, cancel);
		timer.unref?.();
	} catch (error) {
		key.fill(0);
		copiedDigest?.fill(0);
		throw error;
	}
}
