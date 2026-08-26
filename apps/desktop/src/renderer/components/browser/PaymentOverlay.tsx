import { useEffect, useMemo, useState } from "react";
import type { PaymentPrompt } from "@kestrel/shared-types";

function hostname(origin: string): string {
	try {
		return new URL(origin).hostname.replace(/^www\./, "");
	} catch {
		return origin;
	}
}

function expiry(month: string, year: string): string {
	return `${month}/${year}`;
}

export function PaymentOverlay() {
	const [prompt, setPrompt] = useState<PaymentPrompt | null>(null);
	const [chooseFields, setChooseFields] = useState(false);
	const [selectedEntryId, setSelectedEntryId] = useState("");
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");

	useEffect(() => window.kestrel.onPaymentPrompt(setPrompt), []);

	useEffect(() => {
		setChooseFields(Boolean(prompt?.focusedFieldId) && prompt?.mode === "fill");
		setSelectedEntryId(prompt?.entries[0]?.id ?? "");
		setBusy("");
		setError("");
	}, [prompt]);

	const fillableFields = useMemo(
		() =>
			prompt?.fields.filter(
				(field) => field.kind !== "security-code",
			) ?? [],
		[prompt],
	);

	if (!prompt) return null;
	const promptOrigin = prompt.origin;

	async function saveCard() {
		setBusy("save");
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "payment-save",
				origin: promptOrigin,
			});
			if (!response.ok)
				throw new Error("The card could not be saved. Check the payment fields and try again.");
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "The card could not be saved. Check the payment fields and try again.",
			);
		} finally {
			setBusy("");
		}
	}

	async function fillPage(paymentCardId: string) {
		setBusy(paymentCardId);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "payment-fill-page",
				paymentCardId,
			});
			if (!response.ok) throw new Error("The saved card could not be used.");
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "The saved card could not be used.",
			);
		} finally {
			setBusy("");
		}
	}

	async function fillField(paymentCardId: string, fieldId: string) {
		setBusy(`${paymentCardId}:${fieldId}`);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "payment-fill-field",
				paymentCardId,
				fieldId,
			});
			if (!response.ok) throw new Error("That payment field could not be filled.");
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "That payment field could not be filled.",
			);
		} finally {
			setBusy("");
		}
	}

	async function dismiss() {
		await window.kestrel.request({ type: "payment-dismiss" }).catch(() => undefined);
	}

	return (
		<div className="payment-overlay-root">
			<section
				className="payment-overlay-card"
				role="dialog"
				aria-label={prompt.mode === "save" ? "Save payment card" : "Saved payment cards"}
				aria-live="polite"
			>
				<header className="payment-overlay-header">
					<div className="payment-overlay-heading">
						<span className="payment-overlay-mark" aria-hidden="true">
							▰
						</span>
						<span>
							<strong>
								{prompt.mode === "save" ? "Save card to Kestrel" : "Use a saved card?"}
							</strong>
							<small>{hostname(prompt.origin)}</small>
						</span>
					</div>
					<button
						type="button"
						className="payment-overlay-dismiss"
						onClick={() => void dismiss()}
						aria-label="Dismiss payment card suggestions"
					>
						×
					</button>
				</header>

				{prompt.mode === "save" && prompt.candidate ? (
					<>
						<p className="payment-overlay-copy">
							Save your card details securely on this device to use them faster next time.
						</p>
						<div className="payment-card-preview" aria-label={`${prompt.candidate.brand} ending in ${prompt.candidate.last4}`}>
							<div className="payment-card-preview-top">
								<strong>{prompt.candidate.brand}</strong>
								<span>KESTREL</span>
							</div>
							<div className="payment-card-preview-number">
								•••• &nbsp;•••• &nbsp;•••• &nbsp;{prompt.candidate.last4}
							</div>
							<div className="payment-card-preview-bottom">
								<span>Card ending in {prompt.candidate.last4}</span>
								{prompt.candidate.expirationMonth && prompt.candidate.expirationYear && (
									<span>Exp {expiry(prompt.candidate.expirationMonth, prompt.candidate.expirationYear)}</span>
								)}
							</div>
						</div>
						<p className="payment-overlay-security-note">
							Your security code is never saved. You’ll enter it when you pay.
						</p>
						<div className="payment-overlay-actions payment-overlay-save-actions">
							<button
								type="button"
								className="payment-overlay-secondary"
								onClick={() => void dismiss()}
							>
								Not now
							</button>
							<button
								type="button"
								className="payment-overlay-primary"
								onClick={() => void saveCard()}
								disabled={Boolean(busy)}
							>
								{busy === "save" ? "Saving…" : "Save card"}
							</button>
						</div>
					</>
				) : (
					<>
						<p className="payment-overlay-copy">
							Fill payment details with a card saved in Kestrel. Your security code stays manual.
						</p>
						<div className="payment-overlay-entries" role="list" aria-label="Saved payment cards">
							{prompt.entries.map((entry) => (
								<button
									key={entry.id}
									type="button"
									className="payment-overlay-entry"
									onClick={() => void fillPage(entry.id)}
									disabled={Boolean(busy)}
								>
									<span>
										<strong>{entry.brand} •••• {entry.last4}</strong>
										<small>Exp {expiry(entry.expirationMonth, entry.expirationYear)}</small>
									</span>
									<em>{busy === entry.id ? "Filling…" : "Fill details"}</em>
								</button>
							))}
						</div>
						{chooseFields && (
							<div className="payment-overlay-fields" role="list" aria-label="Payment fields">
								{fillableFields.map((field) => {
									const actionKey = `${selectedEntryId}:${field.id}`;
									return (
										<button
											key={field.id}
											type="button"
											className="payment-overlay-field"
											onClick={() => void fillField(selectedEntryId, field.id)}
											disabled={!selectedEntryId || Boolean(busy)}
										>
											<span>{field.label || "Payment field"}</span>
											<em>{busy === actionKey ? "Filling…" : "Fill"}</em>
										</button>
									);
								})}
							</div>
						)}
						<div className="payment-overlay-actions">
							<button
								type="button"
								className="payment-overlay-link"
								onClick={() => setChooseFields((value) => !value)}
							>
								{chooseFields ? "Fill all fields" : "Choose a field"}
							</button>
							<button type="button" className="payment-overlay-link" onClick={() => void dismiss()}>
								Not now
							</button>
						</div>
					</>
				)}
				{error && <p className="payment-overlay-error" role="alert">{error}</p>}
			</section>
		</div>
	);
}
