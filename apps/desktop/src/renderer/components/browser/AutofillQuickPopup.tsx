import type {
	AutofillMatchResults,
	SavedAddress,
	SavedPassword,
	SavedPaymentCard,
} from "@kestrel/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { Icon } from "../Icon";

export function AutofillQuickPopup({
	browser,
	isOpen,
	onClose,
	onOpenSettings,
}: {
	browser: UserBrowserController;
	isOpen: boolean;
	onClose(): void;
	onOpenSettings(): void;
}) {
	const activeTab = browser.state?.tabs.find(
		(t) => t.id === browser.state?.activeTabId,
	);
	const [matches, setMatches] = useState<AutofillMatchResults | null>(null);
	const [loading, setLoading] = useState(false);
	const [feedback, setFeedback] = useState<string | null>(null);
	const popupRef = useRef<HTMLDivElement | null>(null);

	const loadMatches = useCallback(async () => {
		if (!isOpen || !activeTab?.id) return;
		setLoading(true);
		try {
			const res = await browser.queryAutofill(activeTab.id, activeTab.url);
			if (res) {
				setMatches(res);
			}
		} catch {
			// Ignore query error
		} finally {
			setLoading(false);
		}
	}, [browser, isOpen, activeTab?.id, activeTab?.url]);

	useEffect(() => {
		if (isOpen) {
			void loadMatches();
		}
	}, [isOpen, loadMatches]);

	// Close on outside click
	useEffect(() => {
		if (!isOpen) return;
		const handleDown = (e: MouseEvent) => {
			if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		window.addEventListener("mousedown", handleDown);
		return () => window.removeEventListener("mousedown", handleDown);
	}, [isOpen, onClose]);

	const handleApply = async (
		fillType: "password" | "address" | "payment",
		itemId: string,
		label: string,
	) => {
		try {
			await browser.applyAutofill(activeTab?.id, fillType, itemId);
			setFeedback(`Filled ${label}!`);
			setTimeout(() => {
				setFeedback(null);
				onClose();
			}, 900);
		} catch (err) {
			setFeedback(
				err instanceof Error ? err.message : "Failed to fill form fields.",
			);
			setTimeout(() => setFeedback(null), 2500);
		}
	};

	if (!isOpen) return null;

	const hasPasswords = (matches?.passwords.length ?? 0) > 0;
	const hasAddresses = (matches?.addresses.length ?? 0) > 0;
	const hasPayments = (matches?.paymentMethods.length ?? 0) > 0;
	const hasAnyMatches = hasPasswords || hasAddresses || hasPayments;

	return (
		<div ref={popupRef} className="autofill-quick-popup">
			<div className="quick-popup-header">
				<div className="header-title">
					<Icon name="key" />
					<span>Autofill Form</span>
				</div>
				<button
					type="button"
					className="quick-popup-close"
					onClick={onClose}
					title="Close"
				>
					✕
				</button>
			</div>

			{feedback && <div className="quick-popup-feedback">{feedback}</div>}

			<div className="quick-popup-body">
				{loading ? (
					<div className="quick-popup-loading">Scanning form fields...</div>
				) : !hasAnyMatches ? (
					<div className="quick-popup-empty">
						<p>No matching passwords, addresses, or cards saved yet.</p>
						<button
							type="button"
							className="quick-popup-manage-btn"
							onClick={() => {
								onClose();
								onOpenSettings();
							}}
						>
							Open Password & Autofill Manager
						</button>
					</div>
				) : (
					<>
						{/* Matching Logins */}
						{hasPasswords && (
							<div className="quick-popup-section">
								<div className="section-heading">Logins for this site</div>
								{matches?.passwords.map((pwd: SavedPassword) => (
									<button
										key={pwd.id}
										type="button"
										className="quick-fill-item"
										onClick={() =>
											handleApply("password", pwd.id, pwd.username)
										}
									>
										<div className="item-icon">🔑</div>
										<div className="item-info">
											<div className="item-primary">{pwd.username}</div>
											<div className="item-secondary">
												{pwd.name || pwd.domain}
											</div>
										</div>
										<span className="fill-pill">Fill</span>
									</button>
								))}
							</div>
						)}

						{/* Saved Addresses */}
						{hasAddresses && (
							<div className="quick-popup-section">
								<div className="section-heading">Addresses & Contacts</div>
								{matches?.addresses.map((addr: SavedAddress) => (
									<button
										key={addr.id}
										type="button"
										className="quick-fill-item"
										onClick={() =>
											handleApply("address", addr.id, addr.fullName)
										}
									>
										<div className="item-icon">📍</div>
										<div className="item-info">
											<div className="item-primary">{addr.fullName}</div>
											<div className="item-secondary">
												{addr.streetAddress}, {addr.city}
											</div>
										</div>
										<span className="fill-pill">Fill</span>
									</button>
								))}
							</div>
						)}

						{/* Saved Payment Methods */}
						{hasPayments && (
							<div className="quick-popup-section">
								<div className="section-heading">Payment Cards</div>
								{matches?.paymentMethods.map((card: SavedPaymentCard) => (
									<button
										key={card.id}
										type="button"
										className="quick-fill-item"
										onClick={() =>
											handleApply("payment", card.id, card.cardNumber)
										}
									>
										<div className="item-icon">💳</div>
										<div className="item-info">
											<div className="item-primary">
												{(card.cardBrand || "Card").toUpperCase()}{" "}
												{card.cardNumber}
											</div>
											<div className="item-secondary">
												{card.cardholderName} · Exp {card.expirationMonth}/
												{card.expirationYear.slice(-2)}
											</div>
										</div>
										<span className="fill-pill">Fill</span>
									</button>
								))}
							</div>
						)}
					</>
				)}
			</div>

			<div className="quick-popup-footer">
				<button
					type="button"
					className="footer-link-btn"
					onClick={() => {
						onClose();
						onOpenSettings();
					}}
				>
					Manage Passwords & Autofill →
				</button>
			</div>
		</div>
	);
}
