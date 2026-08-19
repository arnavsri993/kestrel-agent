import type {
	SavedAddress,
	SavedPassword,
	SavedPaymentCard,
	UserBrowserSettings,
} from "@kestrel/shared-types";
import { useCallback, useEffect, useState } from "react";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { Icon } from "../Icon";

type AutofillTab = "passwords" | "addresses" | "payments" | "settings";

export function AutofillManager({
	browser,
}: {
	browser: UserBrowserController;
}) {
	const [activeTab, setActiveTab] = useState<AutofillTab>("passwords");
	const [searchQuery, setSearchQuery] = useState("");

	// Passwords state
	const [passwords, setPasswords] = useState<SavedPassword[]>([]);
	const [visiblePasswordIds, setVisiblePasswordIds] = useState<Set<string>>(
		new Set(),
	);
	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	const [passwordModalOpen, setPasswordModalOpen] = useState(false);
	const [editingPassword, setEditingPassword] = useState<SavedPassword | null>(
		null,
	);
	const [pwdForm, setPwdForm] = useState({
		url: "",
		username: "",
		password: "",
		name: "",
	});

	// Addresses state
	const [addresses, setAddresses] = useState<SavedAddress[]>([]);
	const [addressModalOpen, setAddressModalOpen] = useState(false);
	const [editingAddress, setEditingAddress] = useState<SavedAddress | null>(
		null,
	);
	const [addrForm, setAddrForm] = useState({
		label: "Home",
		fullName: "",
		organization: "",
		streetAddress: "",
		streetAddressLine2: "",
		city: "",
		state: "",
		postalCode: "",
		country: "",
		phone: "",
		email: "",
	});

	// Payment Methods state
	const [paymentCards, setPaymentCards] = useState<SavedPaymentCard[]>([]);
	const [cardModalOpen, setCardModalOpen] = useState(false);
	const [editingCard, setEditingCard] = useState<SavedPaymentCard | null>(null);
	const [cardForm, setCardForm] = useState({
		cardholderName: "",
		cardNumber: "",
		expirationMonth: "12",
		expirationYear: "2028",
		nickname: "",
	});

	const [loading, setLoading] = useState(false);
	const [statusMessage, setStatusMessage] = useState<{
		type: "success" | "error";
		text: string;
	} | null>(null);

	const showFeedback = (text: string, type: "success" | "error" = "success") => {
		setStatusMessage({ type, text });
		setTimeout(() => setStatusMessage(null), 3500);
	};

	const refreshData = useCallback(async () => {
		setLoading(true);
		try {
			const [pwds, addrs, cards] = await Promise.all([
				browser.listPasswords(searchQuery),
				browser.listAddresses(searchQuery),
				browser.listPaymentMethods(searchQuery),
			]);
			setPasswords(pwds);
			setAddresses(addrs);
			setPaymentCards(cards);
		} catch {
			// Ignore refresh error
		} finally {
			setLoading(false);
		}
	}, [browser, searchQuery]);

	useEffect(() => {
		void refreshData();
	}, [refreshData]);

	const copyToClipboard = async (text: string, key: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopiedKey(key);
			setTimeout(() => setCopiedKey(null), 2000);
		} catch {
			// Fallback copy
		}
	};

	const togglePasswordVisibility = (id: string) => {
		setVisiblePasswordIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	// --------------------------------------------------------------------------
	// Password Handlers
	// --------------------------------------------------------------------------

	const handleOpenPasswordModal = (pwd?: SavedPassword) => {
		if (pwd) {
			setEditingPassword(pwd);
			setPwdForm({
				url: pwd.url,
				username: pwd.username,
				password: pwd.password,
				name: pwd.name ?? "",
			});
		} else {
			setEditingPassword(null);
			setPwdForm({ url: "", username: "", password: "", name: "" });
		}
		setPasswordModalOpen(true);
	};

	const handleSavePassword = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!pwdForm.username || !pwdForm.password || !pwdForm.url) {
			showFeedback("Please fill out website URL, username, and password.", "error");
			return;
		}
		try {
			let domain = pwdForm.url;
			try {
				domain = new URL(
					pwdForm.url.includes("://") ? pwdForm.url : `https://${pwdForm.url}`,
				).hostname.replace(/^www\./, "");
			} catch {
				domain = pwdForm.url.replace(/^www\./, "").split("/")[0] ?? "";
			}
			await browser.savePassword({
				...(editingPassword?.id ? { id: editingPassword.id } : {}),
				url: pwdForm.url.includes("://") ? pwdForm.url : `https://${pwdForm.url}`,
				domain,
				username: pwdForm.username.trim(),
				password: pwdForm.password,
				...(pwdForm.name.trim() ? { name: pwdForm.name.trim() } : {}),
			});
			setPasswordModalOpen(false);
			showFeedback(editingPassword ? "Password updated." : "Password saved securely.");
			await refreshData();
		} catch (err) {
			showFeedback(err instanceof Error ? err.message : "Failed to save password.", "error");
		}
	};

	const handleDeletePassword = async (id: string, domain: string) => {
		if (confirm(`Remove saved password for ${domain}?`)) {
			try {
				await browser.deletePassword(id);
				showFeedback("Password removed.");
				await refreshData();
			} catch (err) {
				showFeedback(err instanceof Error ? err.message : "Failed to delete password.", "error");
			}
		}
	};

	// --------------------------------------------------------------------------
	// Address Handlers
	// --------------------------------------------------------------------------

	const handleOpenAddressModal = (addr?: SavedAddress) => {
		if (addr) {
			setEditingAddress(addr);
			setAddrForm({
				label: addr.label ?? "Home",
				fullName: addr.fullName,
				organization: addr.organization ?? "",
				streetAddress: addr.streetAddress,
				streetAddressLine2: addr.streetAddressLine2 ?? "",
				city: addr.city,
				state: addr.state ?? "",
				postalCode: addr.postalCode ?? "",
				country: addr.country ?? "",
				phone: addr.phone ?? "",
				email: addr.email ?? "",
			});
		} else {
			setEditingAddress(null);
			setAddrForm({
				label: "Home",
				fullName: "",
				organization: "",
				streetAddress: "",
				streetAddressLine2: "",
				city: "",
				state: "",
				postalCode: "",
				country: "United States",
				phone: "",
				email: "",
			});
		}
		setAddressModalOpen(true);
	};

	const handleSaveAddress = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!addrForm.fullName || !addrForm.streetAddress || !addrForm.city) {
			showFeedback("Full Name, Street Address, and City are required.", "error");
			return;
		}
		try {
			await browser.saveAddress({
				...(editingAddress?.id ? { id: editingAddress.id } : {}),
				...(addrForm.label.trim() ? { label: addrForm.label.trim() } : {}),
				fullName: addrForm.fullName.trim(),
				...(addrForm.organization.trim()
					? { organization: addrForm.organization.trim() }
					: {}),
				streetAddress: addrForm.streetAddress.trim(),
				...(addrForm.streetAddressLine2.trim()
					? { streetAddressLine2: addrForm.streetAddressLine2.trim() }
					: {}),
				city: addrForm.city.trim(),
				...(addrForm.state.trim() ? { state: addrForm.state.trim() } : {}),
				...(addrForm.postalCode.trim()
					? { postalCode: addrForm.postalCode.trim() }
					: {}),
				...(addrForm.country.trim()
					? { country: addrForm.country.trim() }
					: {}),
				...(addrForm.phone.trim() ? { phone: addrForm.phone.trim() } : {}),
				...(addrForm.email.trim() ? { email: addrForm.email.trim() } : {}),
			});
			setAddressModalOpen(false);
			showFeedback(editingAddress ? "Address updated." : "Address saved.");
			await refreshData();
		} catch (err) {
			showFeedback(err instanceof Error ? err.message : "Failed to save address.", "error");
		}
	};

	const handleDeleteAddress = async (id: string, name: string) => {
		if (confirm(`Remove saved address for ${name}?`)) {
			try {
				await browser.deleteAddress(id);
				showFeedback("Address removed.");
				await refreshData();
			} catch (err) {
				showFeedback(err instanceof Error ? err.message : "Failed to delete address.", "error");
			}
		}
	};

	// --------------------------------------------------------------------------
	// Payment Card Handlers
	// --------------------------------------------------------------------------

	const handleOpenCardModal = (card?: SavedPaymentCard) => {
		if (card) {
			setEditingCard(card);
			setCardForm({
				cardholderName: card.cardholderName,
				cardNumber: card.cardNumber,
				expirationMonth: card.expirationMonth,
				expirationYear: card.expirationYear,
				nickname: card.nickname ?? "",
			});
		} else {
			setEditingCard(null);
			setCardForm({
				cardholderName: "",
				cardNumber: "",
				expirationMonth: "12",
				expirationYear: "2028",
				nickname: "",
			});
		}
		setCardModalOpen(true);
	};

	const handleSaveCard = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!cardForm.cardholderName || !cardForm.cardNumber) {
			showFeedback("Cardholder Name and Card Number are required.", "error");
			return;
		}
		try {
			await browser.savePaymentMethod({
				...(editingCard?.id ? { id: editingCard.id } : {}),
				cardholderName: cardForm.cardholderName.trim(),
				cardNumber: cardForm.cardNumber.trim(),
				expirationMonth: cardForm.expirationMonth,
				expirationYear: cardForm.expirationYear,
				...(cardForm.nickname.trim()
					? { nickname: cardForm.nickname.trim() }
					: {}),
			});
			setCardModalOpen(false);
			showFeedback(editingCard ? "Payment card updated." : "Payment card saved securely.");
			await refreshData();
		} catch (err) {
			showFeedback(err instanceof Error ? err.message : "Failed to save card.", "error");
		}
	};

	const handleDeleteCard = async (id: string, name: string) => {
		if (confirm(`Remove saved payment card for ${name}?`)) {
			try {
				await browser.deletePaymentMethod(id);
				showFeedback("Payment card removed.");
				await refreshData();
			} catch (err) {
				showFeedback(err instanceof Error ? err.message : "Failed to delete payment card.", "error");
			}
		}
	};

	// --------------------------------------------------------------------------
	// Settings Toggle Handler
	// --------------------------------------------------------------------------

	const handleSettingToggle = async (key: keyof UserBrowserSettings) => {
		if (!browser.state?.settings) return;
		const current = browser.state.settings[key];
		try {
			await browser.updateSettings({
				...browser.state.settings,
				[key]: !current,
			});
			showFeedback("Autofill settings updated.");
		} catch (err) {
			showFeedback(err instanceof Error ? err.message : "Failed to update settings.", "error");
		}
	};

	const settings = browser.state?.settings;

	return (
		<div className="autofill-manager-container">
			{/* Top Feedback Toast */}
			{statusMessage && (
				<div className={`autofill-toast ${statusMessage.type}`}>
					{statusMessage.type === "success" ? "✓ " : "⚠️ "}
					{statusMessage.text}
				</div>
			)}

			{/* Autofill Sub-Navigation */}
			<div className="autofill-subnav">
				<button
					type="button"
					className={`autofill-tab-btn ${activeTab === "passwords" ? "active" : ""}`}
					onClick={() => setActiveTab("passwords")}
				>
					<Icon name="key" /> Passwords ({passwords.length})
				</button>
				<button
					type="button"
					className={`autofill-tab-btn ${activeTab === "addresses" ? "active" : ""}`}
					onClick={() => setActiveTab("addresses")}
				>
					<Icon name="map-pin" /> Addresses & Contacts ({addresses.length})
				</button>
				<button
					type="button"
					className={`autofill-tab-btn ${activeTab === "payments" ? "active" : ""}`}
					onClick={() => setActiveTab("payments")}
				>
					<Icon name="credit-card" /> Payment Methods ({paymentCards.length})
				</button>
				<button
					type="button"
					className={`autofill-tab-btn ${activeTab === "settings" ? "active" : ""}`}
					onClick={() => setActiveTab("settings")}
				>
					<Icon name="settings" /> Preferences
				</button>
			</div>

			{/* Search & Actions Bar */}
			{activeTab !== "settings" && (
				<div className="autofill-action-bar">
					<div className="autofill-search-wrap">
						<Icon name="search" />
						<input
							type="search"
							placeholder={`Search ${activeTab}...`}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="autofill-search-input"
						/>
						{searchQuery && (
							<button
								type="button"
								className="clear-search-btn"
								onClick={() => setSearchQuery("")}
							>
								✕
							</button>
						)}
					</div>
					<div className="autofill-action-buttons">
						{activeTab === "passwords" && (
							<button
								type="button"
								className="autofill-primary-btn"
								onClick={() => handleOpenPasswordModal()}
							>
								<Icon name="plus" /> Add Password
							</button>
						)}
						{activeTab === "addresses" && (
							<button
								type="button"
								className="autofill-primary-btn"
								onClick={() => handleOpenAddressModal()}
							>
								<Icon name="plus" /> Add Address
							</button>
						)}
						{activeTab === "payments" && (
							<button
								type="button"
								className="autofill-primary-btn"
								onClick={() => handleOpenCardModal()}
							>
								<Icon name="plus" /> Add Card
							</button>
						)}
					</div>
				</div>
			)}

			{/* Tab 1: Passwords */}
			{activeTab === "passwords" && (
				<div className="autofill-content-pane">
					{passwords.length === 0 ? (
						<div className="autofill-empty-state">
							<div className="empty-icon">🔑</div>
							<h3>No Passwords Saved Yet</h3>
							<p>
								When you log into websites or add credentials manually, Kestrel
								encrypts and stores them locally with AES-256-GCM so you can
								autofill them with one click.
							</p>
							<button
								type="button"
								className="autofill-primary-btn"
								onClick={() => handleOpenPasswordModal()}
							>
								Add First Password
							</button>
						</div>
					) : (
						<div className="autofill-grid">
							{passwords.map((item) => {
								const isVisible = visiblePasswordIds.has(item.id);
								return (
									<div key={item.id} className="autofill-card password-card">
										<div className="card-header">
											<div className="domain-avatar">
												{item.domain.charAt(0).toUpperCase()}
											</div>
											<div className="card-titles">
												<div className="card-title-main">
													{item.name || item.domain}
												</div>
												<a
													href={item.url}
													target="_blank"
													rel="noreferrer"
													className="card-domain-link"
												>
													{item.domain}
												</a>
											</div>
											<div className="card-actions">
												<button
													type="button"
													className="icon-action-btn"
													title="Edit password"
													onClick={() => handleOpenPasswordModal(item)}
												>
													<Icon name="edit" />
												</button>
												<button
													type="button"
													className="icon-action-btn danger"
													title="Delete password"
													onClick={() =>
														handleDeletePassword(item.id, item.domain)
													}
												>
													<Icon name="trash" />
												</button>
											</div>
										</div>

										<div className="card-field">
											<span className="field-label">Username / Email</span>
											<div className="field-value-row">
												<span className="field-value">{item.username}</span>
												<button
													type="button"
													className="copy-btn"
													title="Copy username"
													onClick={() =>
														copyToClipboard(item.username, `u-${item.id}`)
													}
												>
													{copiedKey === `u-${item.id}` ? "Copied!" : "Copy"}
												</button>
											</div>
										</div>

										<div className="card-field">
											<span className="field-label">Password</span>
											<div className="field-value-row">
												<span className="field-value font-mono">
													{isVisible ? item.password : "••••••••••••"}
												</span>
												<div className="field-action-group">
													<button
														type="button"
														className="toggle-vis-btn"
														title={
															isVisible ? "Hide password" : "Show password"
														}
														onClick={() => togglePasswordVisibility(item.id)}
													>
														{isVisible ? "🙈" : "👁️"}
													</button>
													<button
														type="button"
														className="copy-btn"
														title="Copy password"
														onClick={() =>
															copyToClipboard(item.password, `p-${item.id}`)
														}
													>
														{copiedKey === `p-${item.id}` ? "Copied!" : "Copy"}
													</button>
												</div>
											</div>
										</div>

										{item.lastUsedAt && (
											<div className="card-footer-meta">
												Last used: {new Date(item.lastUsedAt).toLocaleDateString()}
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>
			)}

			{/* Tab 2: Addresses & Contacts */}
			{activeTab === "addresses" && (
				<div className="autofill-content-pane">
					{addresses.length === 0 ? (
						<div className="autofill-empty-state">
							<div className="empty-icon">📍</div>
							<h3>No Addresses Saved Yet</h3>
							<p>
								Save your shipping and billing addresses and contact info to
								instantly fill checkout and registration forms across the web.
							</p>
							<button
								type="button"
								className="autofill-primary-btn"
								onClick={() => handleOpenAddressModal()}
							>
								Add First Address
							</button>
						</div>
					) : (
						<div className="autofill-grid">
							{addresses.map((addr) => (
								<div key={addr.id} className="autofill-card address-card">
									<div className="card-header">
										<div className="address-badge">
											{addr.label || "Address"}
										</div>
										<div className="card-actions">
											<button
												type="button"
												className="icon-action-btn"
												title="Edit address"
												onClick={() => handleOpenAddressModal(addr)}
											>
												<Icon name="edit" />
											</button>
											<button
												type="button"
												className="icon-action-btn danger"
												title="Delete address"
												onClick={() =>
													handleDeleteAddress(addr.id, addr.fullName)
												}
											>
												<Icon name="trash" />
											</button>
										</div>
									</div>

									<div className="address-details">
										<div className="address-name">{addr.fullName}</div>
										{addr.organization && (
											<div className="address-org">{addr.organization}</div>
										)}
										<div className="address-line">{addr.streetAddress}</div>
										{addr.streetAddressLine2 && (
											<div className="address-line">
												{addr.streetAddressLine2}
											</div>
										)}
										<div className="address-line">
											{[addr.city, addr.state, addr.postalCode]
												.filter(Boolean)
												.join(", ")}
										</div>
										{addr.country && (
											<div className="address-line country-line">
												{addr.country}
											</div>
										)}
									</div>

									{(addr.phone || addr.email) && (
										<div className="address-contact-info">
											{addr.email && (
												<div className="contact-row">
													<Icon name="mail" /> <span>{addr.email}</span>
												</div>
											)}
											{addr.phone && (
												<div className="contact-row">
													<Icon name="phone" /> <span>{addr.phone}</span>
												</div>
											)}
										</div>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Tab 3: Payment Methods */}
			{activeTab === "payments" && (
				<div className="autofill-content-pane">
					{paymentCards.length === 0 ? (
						<div className="autofill-empty-state">
							<div className="empty-icon">💳</div>
							<h3>No Payment Methods Saved Yet</h3>
							<p>
								Save your credit or debit cards securely with AES-256-GCM local
								vault encryption to auto-fill checkout fields seamlessly.
							</p>
							<button
								type="button"
								className="autofill-primary-btn"
								onClick={() => handleOpenCardModal()}
							>
								Add First Payment Card
							</button>
						</div>
					) : (
						<div className="autofill-grid">
							{paymentCards.map((card) => (
								<div key={card.id} className="autofill-card card-payment-card">
									<div className="payment-card-visual">
										<div className="payment-card-top">
											<div className="card-chip-icon">💳</div>
											<span className="card-brand-badge">
												{(card.cardBrand || "Card").toUpperCase()}
											</span>
										</div>
										<div className="payment-card-number">{card.cardNumber}</div>
										<div className="payment-card-bottom">
											<div className="payment-card-holder">
												<div className="label-tiny">CARDHOLDER</div>
												<div className="value-tiny">{card.cardholderName}</div>
											</div>
											<div className="payment-card-exp">
												<div className="label-tiny">EXPIRES</div>
												<div className="value-tiny">
													{card.expirationMonth}/
													{card.expirationYear.slice(-2)}
												</div>
											</div>
										</div>
									</div>

									<div className="card-footer-actions">
										<span className="card-nickname">
											{card.nickname || card.cardholderName}
										</span>
										<div className="card-actions">
											<button
												type="button"
												className="icon-action-btn"
												title="Edit card"
												onClick={() => handleOpenCardModal(card)}
											>
												<Icon name="edit" />
											</button>
											<button
												type="button"
												className="icon-action-btn danger"
												title="Delete card"
												onClick={() =>
													handleDeleteCard(card.id, card.cardholderName)
												}
											>
												<Icon name="trash" />
											</button>
										</div>
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Tab 4: Settings & Preferences */}
			{activeTab === "settings" && (
				<div className="autofill-content-pane">
					<div className="settings-group-panel">
						<div className="settings-row">
							<div className="settings-row-text">
								<label className="settings-row-title">
									Offer to save passwords
								</label>
								<p className="settings-row-desc">
									Show a prompt to save passwords when logging into websites or
									creating new accounts.
								</p>
							</div>
							<input
								type="checkbox"
								className="toggle-switch"
								checked={settings?.offerToSavePasswords ?? true}
								onChange={() => handleSettingToggle("offerToSavePasswords")}
							/>
						</div>

						<div className="settings-row">
							<div className="settings-row-text">
								<label className="settings-row-title">
									Auto-fill logins and passwords
								</label>
								<p className="settings-row-desc">
									Automatically populate username and password fields when
									visiting matching websites.
								</p>
							</div>
							<input
								type="checkbox"
								className="toggle-switch"
								checked={settings?.autofillPasswords ?? true}
								onChange={() => handleSettingToggle("autofillPasswords")}
							/>
						</div>

						<div className="settings-row">
							<div className="settings-row-text">
								<label className="settings-row-title">
									Save and fill addresses & contact info
								</label>
								<p className="settings-row-desc">
									Automatically suggest and fill shipping, billing, phone, and
									email fields in web forms.
								</p>
							</div>
							<input
								type="checkbox"
								className="toggle-switch"
								checked={settings?.autofillAddresses ?? true}
								onChange={() => handleSettingToggle("autofillAddresses")}
							/>
						</div>

						<div className="settings-row">
							<div className="settings-row-text">
								<label className="settings-row-title">
									Save and fill payment methods
								</label>
								<p className="settings-row-desc">
									Securely store encrypted credit cards and auto-fill payment
									forms on checkout pages.
								</p>
							</div>
							<input
								type="checkbox"
								className="toggle-switch"
								checked={settings?.autofillPayments ?? true}
								onChange={() => handleSettingToggle("autofillPayments")}
							/>
						</div>
					</div>
				</div>
			)}

			{/* Modal: Password Add/Edit */}
			{passwordModalOpen && (
				<div className="autofill-modal-backdrop" onClick={() => setPasswordModalOpen(false)}>
					<div
						className="autofill-modal-content"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="modal-header">
							<h3>{editingPassword ? "Edit Password" : "Add Password"}</h3>
							<button
								type="button"
								className="modal-close-btn"
								onClick={() => setPasswordModalOpen(false)}
							>
								✕
							</button>
						</div>
						<form onSubmit={handleSavePassword} className="modal-form">
							<div className="form-group">
								<label>Website URL or Domain</label>
								<input
									type="text"
									placeholder="https://github.com/login"
									required
									value={pwdForm.url}
									onChange={(e) =>
										setPwdForm({ ...pwdForm, url: e.target.value })
									}
								/>
							</div>
							<div className="form-group">
								<label>Site Name (Optional)</label>
								<input
									type="text"
									placeholder="GitHub"
									value={pwdForm.name}
									onChange={(e) =>
										setPwdForm({ ...pwdForm, name: e.target.value })
									}
								/>
							</div>
							<div className="form-group">
								<label>Username / Email</label>
								<input
									type="text"
									placeholder="user@example.com"
									required
									value={pwdForm.username}
									onChange={(e) =>
										setPwdForm({ ...pwdForm, username: e.target.value })
									}
								/>
							</div>
							<div className="form-group">
								<label>Password</label>
								<input
									type="password"
									placeholder="••••••••"
									required
									value={pwdForm.password}
									onChange={(e) =>
										setPwdForm({ ...pwdForm, password: e.target.value })
									}
								/>
							</div>
							<div className="modal-actions">
								<button
									type="button"
									className="btn-cancel"
									onClick={() => setPasswordModalOpen(false)}
								>
									Cancel
								</button>
								<button type="submit" className="autofill-primary-btn">
									{editingPassword ? "Save Changes" : "Save Password"}
								</button>
							</div>
						</form>
					</div>
				</div>
			)}

			{/* Modal: Address Add/Edit */}
			{addressModalOpen && (
				<div className="autofill-modal-backdrop" onClick={() => setAddressModalOpen(false)}>
					<div
						className="autofill-modal-content large"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="modal-header">
							<h3>{editingAddress ? "Edit Address" : "Add Address"}</h3>
							<button
								type="button"
								className="modal-close-btn"
								onClick={() => setAddressModalOpen(false)}
							>
								✕
							</button>
						</div>
						<form onSubmit={handleSaveAddress} className="modal-form">
							<div className="form-row-two">
								<div className="form-group">
									<label>Label</label>
									<input
										type="text"
										placeholder="Home, Work, Office"
										value={addrForm.label}
										onChange={(e) =>
											setAddrForm({ ...addrForm, label: e.target.value })
										}
									/>
								</div>
								<div className="form-group">
									<label>Full Name</label>
									<input
										type="text"
										placeholder="Jane Doe"
										required
										value={addrForm.fullName}
										onChange={(e) =>
											setAddrForm({ ...addrForm, fullName: e.target.value })
										}
									/>
								</div>
							</div>
							<div className="form-group">
								<label>Company / Organization</label>
								<input
									type="text"
									placeholder="Acme Corp (Optional)"
									value={addrForm.organization}
									onChange={(e) =>
										setAddrForm({ ...addrForm, organization: e.target.value })
									}
								/>
							</div>
							<div className="form-group">
								<label>Street Address</label>
								<input
									type="text"
									placeholder="123 Main Street"
									required
									value={addrForm.streetAddress}
									onChange={(e) =>
										setAddrForm({ ...addrForm, streetAddress: e.target.value })
									}
								/>
							</div>
							<div className="form-group">
								<label>Apt, Suite, Bldg (Optional)</label>
								<input
									type="text"
									placeholder="Apt 4B"
									value={addrForm.streetAddressLine2}
									onChange={(e) =>
										setAddrForm({
											...addrForm,
											streetAddressLine2: e.target.value,
										})
									}
								/>
							</div>
							<div className="form-row-three">
								<div className="form-group">
									<label>City</label>
									<input
										type="text"
										placeholder="San Francisco"
										required
										value={addrForm.city}
										onChange={(e) =>
											setAddrForm({ ...addrForm, city: e.target.value })
										}
									/>
								</div>
								<div className="form-group">
									<label>State / Province</label>
									<input
										type="text"
										placeholder="CA"
										value={addrForm.state}
										onChange={(e) =>
											setAddrForm({ ...addrForm, state: e.target.value })
										}
									/>
								</div>
								<div className="form-group">
									<label>ZIP / Postal Code</label>
									<input
										type="text"
										placeholder="94105"
										value={addrForm.postalCode}
										onChange={(e) =>
											setAddrForm({ ...addrForm, postalCode: e.target.value })
										}
									/>
								</div>
							</div>
							<div className="form-row-two">
								<div className="form-group">
									<label>Country</label>
									<input
										type="text"
										placeholder="United States"
										value={addrForm.country}
										onChange={(e) =>
											setAddrForm({ ...addrForm, country: e.target.value })
										}
									/>
								</div>
								<div className="form-group">
									<label>Phone Number</label>
									<input
										type="tel"
										placeholder="+1 (555) 019-2834"
										value={addrForm.phone}
										onChange={(e) =>
											setAddrForm({ ...addrForm, phone: e.target.value })
										}
									/>
								</div>
							</div>
							<div className="form-group">
								<label>Email Address</label>
								<input
									type="email"
									placeholder="jane@example.com"
									value={addrForm.email}
									onChange={(e) =>
										setAddrForm({ ...addrForm, email: e.target.value })
									}
								/>
							</div>
							<div className="modal-actions">
								<button
									type="button"
									className="btn-cancel"
									onClick={() => setAddressModalOpen(false)}
								>
									Cancel
								</button>
								<button type="submit" className="autofill-primary-btn">
									{editingAddress ? "Save Changes" : "Save Address"}
								</button>
							</div>
						</form>
					</div>
				</div>
			)}

			{/* Modal: Payment Card Add/Edit */}
			{cardModalOpen && (
				<div className="autofill-modal-backdrop" onClick={() => setCardModalOpen(false)}>
					<div
						className="autofill-modal-content"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="modal-header">
							<h3>
								{editingCard ? "Edit Payment Card" : "Add Payment Card"}
							</h3>
							<button
								type="button"
								className="modal-close-btn"
								onClick={() => setCardModalOpen(false)}
							>
								✕
							</button>
						</div>
						<form onSubmit={handleSaveCard} className="modal-form">
							<div className="form-group">
								<label>Cardholder Name</label>
								<input
									type="text"
									placeholder="Jane Doe"
									required
									value={cardForm.cardholderName}
									onChange={(e) =>
										setCardForm({
											...cardForm,
											cardholderName: e.target.value,
										})
									}
								/>
							</div>
							<div className="form-group">
								<label>Card Number</label>
								<input
									type="text"
									placeholder="4111 2222 3333 4444"
									required
									value={cardForm.cardNumber}
									onChange={(e) =>
										setCardForm({ ...cardForm, cardNumber: e.target.value })
									}
								/>
							</div>
							<div className="form-row-two">
								<div className="form-group">
									<label>Exp Month</label>
									<select
										value={cardForm.expirationMonth}
										onChange={(e) =>
											setCardForm({
												...cardForm,
												expirationMonth: e.target.value,
											})
										}
									>
										{Array.from({ length: 12 }, (_, i) => {
											const m = String(i + 1).padStart(2, "0");
											return (
												<option key={m} value={m}>
													{m}
												</option>
											);
										})}
									</select>
								</div>
								<div className="form-group">
									<label>Exp Year</label>
									<select
										value={cardForm.expirationYear}
										onChange={(e) =>
											setCardForm({
												...cardForm,
												expirationYear: e.target.value,
											})
										}
									>
										{Array.from({ length: 12 }, (_, i) => {
											const yr = String(new Date().getFullYear() + i);
											return (
												<option key={yr} value={yr}>
													{yr}
												</option>
											);
										})}
									</select>
								</div>
							</div>
							<div className="form-group">
								<label>Nickname / Card Label (Optional)</label>
								<input
									type="text"
									placeholder="Travel Card"
									value={cardForm.nickname}
									onChange={(e) =>
										setCardForm({ ...cardForm, nickname: e.target.value })
									}
								/>
							</div>
							<div className="modal-actions">
								<button
									type="button"
									className="btn-cancel"
									onClick={() => setCardModalOpen(false)}
								>
									Cancel
								</button>
								<button type="submit" className="autofill-primary-btn">
									{editingCard ? "Save Changes" : "Save Card"}
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
}
