import type { PaymentCardEntrySummary } from "@kestrel/shared-types";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../Icon";

function responseError(response: { ok: boolean; error?: string }): string {
	return response.ok ? "" : response.error || "Payment card operation failed.";
}

function expiry(entry: PaymentCardEntrySummary): string {
	return `${entry.expirationMonth}/${entry.expirationYear}`;
}

export function PaymentSettings({
	browser,
}: {
	browser: UserBrowserController;
}) {
	const settings = browser.state?.settings;
	const [entries, setEntries] = useState<PaymentCardEntrySummary[]>([]);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	const loadEntries = useCallback(async () => {
		const response = await window.kestrel.request({ type: "payment-list" });
		if (!response.ok) throw new Error(responseError(response));
		if ("paymentCards" in response) setEntries(response.paymentCards);
	}, []);

	useEffect(() => {
		void loadEntries().catch((cause) =>
			setError(
				cause instanceof Error
					? cause.message
					: "Payment cards could not be loaded.",
			),
		);
	}, [loadEntries]);

	async function removeEntry(entry: PaymentCardEntrySummary) {
		if (!window.confirm(`Remove the ${entry.brand} card ending in ${entry.last4}?`))
			return;
		setBusy(entry.id);
		setError("");
		setNotice("");
		try {
			const response = await window.kestrel.request({
				type: "payment-remove",
				paymentCardId: entry.id,
			});
			if (!response.ok) throw new Error(responseError(response));
			if ("paymentCards" in response) setEntries(response.paymentCards);
			setNotice("Saved card removed.");
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Payment card could not be removed.",
			);
		} finally {
			setBusy("");
		}
	}

	if (!settings) return null;

	return (
		<section
			className="settings-stack browser-settings-panel payment-settings-panel"
			aria-labelledby="payment-settings-title"
		>
			<header className="settings-panel-header">
				<h2 id="payment-settings-title">
					<Icon name="card" /> Payment cards
				</h2>
				<p>
					Save a card from a secure checkout, then fill payment details without retyping them.
				</p>
			</header>

			<div className="setting-row browser-setting-row payment-autofill-toggle">
				<div className="browser-setting-copy">
					<strong>Offer payment card autofill</strong>
					<p>Kestrel only offers cards on HTTPS pages and never fills until you choose.</p>
				</div>
				<button
					type="button"
					className={`switch ${settings.paymentAutofillEnabled ? "on" : ""}`}
					role="switch"
					aria-label="Offer payment card autofill"
					aria-checked={settings.paymentAutofillEnabled}
					onClick={() => {
						void browser.updateSettings({
							paymentAutofillEnabled: !settings.paymentAutofillEnabled,
						});
					}}
				>
					<span />
				</button>
			</div>

			{error && <p className="payment-settings-message error" role="alert">{error}</p>}
			{notice && <p className="payment-settings-message success" role="status">{notice}</p>}

			<div className="payment-entry-list" aria-label="Saved payment cards">
				{entries.length === 0 ? (
					<div className="payment-empty-state">
						<strong>No saved cards yet</strong>
						<span>Enter card details on a secure checkout and Kestrel will offer to save them in the protected store.</span>
					</div>
				) : (
					entries.map((entry) => (
						<article className="payment-entry-card" key={entry.id}>
							<div className="payment-entry-card-copy">
								<strong>{entry.brand} •••• {entry.last4}</strong>
								<span>Expires {expiry(entry)}</span>
								<small>{entry.cardholderName || "No cardholder name"}</small>
							</div>
							<button
								type="button"
								className="button quiet-action-link"
								onClick={() => void removeEntry(entry)}
								disabled={Boolean(busy)}
							>
								{busy === entry.id ? "Removing…" : "Remove"}
							</button>
						</article>
					))
				)}
			</div>

			<p className="payment-settings-footnote">
				Card numbers are encrypted by Kestrel’s protected credential broker. The renderer receives only the card brand, last four digits, and expiration; security codes are never stored or autofilled.
			</p>
		</section>
	);
}
