import { useCallback, useEffect, useState } from "react";
import type { AutofillProfile, PasswordEntrySummary } from "@kestrel/shared-types";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { Icon } from "../Icon";

function responseError(response: { ok: boolean; error?: string }): string {
	return response.ok ? "" : response.error || "Password operation failed.";
}

function displayDate(value: string | undefined): string {
	if (!value) return "Never";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleDateString();
}

export function PasswordSettings({
	browser,
}: {
	browser: UserBrowserController;
}) {
	const settings = browser.state?.settings;
	const [profile, setProfile] = useState<AutofillProfile>({});
	const [entries, setEntries] = useState<PasswordEntrySummary[]>([]);
	const [usernameDrafts, setUsernameDrafts] = useState<Record<string, string>>(
		{},
	);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [removalConfirmation, setRemovalConfirmation] = useState<string | null>(
		null,
	);

	const syncEntries = useCallback((nextEntries: PasswordEntrySummary[]) => {
		setEntries(nextEntries);
		setUsernameDrafts(
			Object.fromEntries(
				nextEntries.map((entry) => [entry.id, entry.username]),
			),
		);
	}, []);

	const loadEntries = useCallback(async () => {
		const profileResponse = await window.kestrel.request({ type: "autofill-profile-get" });
		if (profileResponse.ok && "autofillProfile" in profileResponse) setProfile(profileResponse.autofillProfile);
		const response = await window.kestrel.request({ type: "password-list" });
		if (!response.ok) throw new Error(responseError(response));
		if ("passwords" in response) syncEntries(response.passwords);
	}, [syncEntries]);

	useEffect(() => {
		void loadEntries().catch((cause) =>
			setError(
				cause instanceof Error ? cause.message : "Passwords could not be loaded.",
			),
		);
	}, [loadEntries]);

	async function runPasswordAction(
		entry: PasswordEntrySummary,
		type: "password-copy" | "password-reveal",
	) {
		setBusy(`${type}-${entry.id}`);
		setError("");
		setNotice("");
		try {
			const response = await window.kestrel.request({
				type,
				passwordId: entry.id,
			});
			if (!response.ok) throw new Error(responseError(response));
			setNotice(
				type === "password-copy"
					? "Password copied. Kestrel clears it if it remains unchanged."
					: "Password revealed after local device verification.",
			);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Password operation failed.",
			);
		} finally {
			setBusy("");
		}
	}

	async function updateUsername(entry: PasswordEntrySummary) {
		const username = usernameDrafts[entry.id] ?? "";
		if (username === entry.username) return;
		setBusy(`username-${entry.id}`);
		setError("");
		setNotice("");
		try {
			const response = await window.kestrel.request({
				type: "password-update-username",
				passwordId: entry.id,
				username,
			});
			if (!response.ok) throw new Error(responseError(response));
			if ("passwords" in response) syncEntries(response.passwords);
			setNotice("Login name updated.");
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Login name could not be updated.",
			);
		} finally {
			setBusy("");
		}
	}

	async function removeEntry(entry: PasswordEntrySummary) {
		setBusy(`remove-${entry.id}`);
		setError("");
		setNotice("");
		try {
			const response = await window.kestrel.request({
				type: "password-remove",
				passwordId: entry.id,
			});
			if (!response.ok) throw new Error(responseError(response));
			if ("passwords" in response) syncEntries(response.passwords);
			setRemovalConfirmation(null);
			setNotice("Saved login removed.");
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Password could not be removed.",
			);
		} finally {
			setBusy("");
		}
	}

	async function removeNeverSaveOrigin(origin: string) {
		setBusy(`never-${origin}`);
		setError("");
		setNotice("");
		try {
			await browser.updateSettings({
				neverSavePasswordOrigins: settings!.neverSavePasswordOrigins.filter(
					(item) => item !== origin,
				),
			});
			setNotice("Never-save exception removed.");
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Setting could not be updated.",
			);
		} finally {
			setBusy("");
		}
	}

	async function saveProfile(clear = false) {
		setBusy("profile"); setError(""); setNotice("");
		try {
			const response = await window.kestrel.request({ type: "autofill-profile-save", profile: clear ? {} : profile });
			if (!response.ok) throw new Error(responseError(response));
			if ("autofillProfile" in response) setProfile(response.autofillProfile);
			setNotice(clear ? "Saved form info removed." : "Form info saved securely on this Mac.");
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Form info could not be saved."); }
		finally { setBusy(""); }
	}

	if (!settings) return null;
	const toggles = [
		["autoSavePasswords", "Save passwords automatically", "Save after the sign-in form disappears. Turn off to ask each time."],
		["autofillProfileEnabled", "Autofill personal info", "Offer your saved name, address, contact details, and birthday when you select a field."],
		["autoSaveFormInfo", "Remember submitted form info", "Keep details you type into supported forms in protected storage on this Mac."],
		[
			"offerToSavePasswords",
			"Offer to save passwords",
			"Save new or changed logins after sign-in. Turn off to stop saving.",
		],
		[
			"autofillPasswords",
			"Autofill passwords",
			"Fill a password only for an exact HTTPS origin with one matching login.",
		],
		[
			"autofillUsernames",
			"Autofill usernames",
			"Fill a saved login name on matching username-first pages.",
		],
		[
			"offerStrongPasswords",
			"Offer strong passwords",
			"Suggest a strong password during sign-up.",
		],
	] as const;

	return (
		<section
			className="settings-stack browser-settings-panel password-settings-panel"
			aria-labelledby="password-settings-title"
		>
			<header className="settings-panel-header">
				<h2 id="password-settings-title">
					<Icon name="lock" /> Passwords and autofill
				</h2>
				<p>
					Passwords stay in protected storage on this Mac.
				</p>
			</header>

			{toggles.map(([key, label, description]) => (
				<div
					className="setting-row browser-setting-row password-autofill-toggle"
					key={key}
				>
					<div className="browser-setting-copy">
						<strong>{label}</strong>
						<p>{description}</p>
					</div>
					<button
						type="button"
						className={`switch ${settings[key] ? "on" : ""}`}
						role="switch"
						aria-label={label}
						aria-checked={settings[key]}
						onClick={() =>
							void browser.updateSettings({ [key]: !settings[key] })
						}
					>
						<span />
					</button>
				</div>
			))}

			{error ? (
				<p className="password-settings-message error" role="alert">
					{error}
				</p>
			) : null}
			{notice ? (
				<p className="password-settings-message success" role="status">
					{notice}
				</p>
			) : null}

			<details className="password-entry-card">
				<summary>Saved personal info</summary>
				<p>Edit the details Kestrel uses to fill forms. Blank fields are skipped.</p>
				<form onSubmit={(event) => { event.preventDefault(); void saveProfile(); }} className="autofill-profile-grid">
					{([
						["name", "Full name"], ["given-name", "First name"], ["additional-name", "Middle name"], ["family-name", "Last name"],
						["email", "Email"], ["tel", "Phone"], ["organization", "Company"], ["bday", "Birthday"],
						["address-line1", "Street address"], ["address-line2", "Apartment / suite"], ["address-level2", "City"],
						["address-level1", "State / province"], ["postal-code", "ZIP / postal code"], ["country", "Country code"], ["country-name", "Country"],
						["street-address", "Full address"], ["address-line3", "Address line 3"], ["bday-day", "Birth day"], ["bday-month", "Birth month"], ["bday-year", "Birth year"],
					] as const).map(([key, label]) => (
						<label key={key}><span>{label}</span><input type={key === "bday" ? "date" : key === "email" ? "email" : "text"} autoComplete="off" maxLength={500} value={profile[key] || ""} onChange={(event) => setProfile((previous) => ({ ...previous, [key]: event.target.value }))} /></label>
					))}
					<button type="submit" disabled={Boolean(busy)}>Save info</button>
					<button type="button" disabled={Boolean(busy)} onClick={() => void saveProfile(true)}>Clear saved info</button>
				</form>
			</details>
			<div className="password-entry-list" aria-label="Saved logins">
				<h3>Saved passwords</h3>
				{entries.length === 0 ? (
					<div className="password-empty-state">
						<strong>No saved logins yet</strong>
						<span>Kestrel saves supported logins after you sign in when automatic saving is enabled.</span>
					</div>
				) : (
					entries.map((entry) => {
						const confirmingRemoval = removalConfirmation === entry.id;
						return (
							<article className="password-entry-card" key={entry.id}>
								<div className="password-entry-details">
									<strong>{entry.title}</strong>
									<span>{entry.origin}</span>
									<label>
										<span>Login name</span>
										<input
											type="text"
											value={usernameDrafts[entry.id] ?? entry.username}
											onChange={(event) =>
												setUsernameDrafts((drafts) => ({
													...drafts,
													[entry.id]: event.target.value,
												}))
											}
											autoComplete="off"
											maxLength={500}
											spellCheck={false}
										/>
									</label>
									<small>
										Last used {displayDate(entry.lastUsedAt)} · Updated{" "}
										{displayDate(entry.updatedAt)}
									</small>
								</div>
								<div className="password-entry-actions">
									<button
										type="button"
										className="button quiet-action-link"
										onClick={() => void updateUsername(entry)}
										disabled={
											Boolean(busy) ||
											usernameDrafts[entry.id] === entry.username
										}
									>
										Rename
									</button>
									<button
										type="button"
										className="button quiet-action-link"
										onClick={() => void runPasswordAction(entry, "password-copy")}
										disabled={Boolean(busy)}
									>
										Copy password
									</button>
									<button
										type="button"
										className="button quiet-action-link"
										onClick={() => void runPasswordAction(entry, "password-reveal")}
										disabled={Boolean(busy)}
									>
										Reveal password
									</button>
									{confirmingRemoval ? (
										<span className="password-remove-confirmation" role="group">
											<span>Remove this login?</span>
											<button
												type="button"
												className="button quiet-action-link"
												onClick={() => setRemovalConfirmation(null)}
												disabled={Boolean(busy)}
											>
												Cancel
											</button>
											<button
												type="button"
												className="button quiet-action-link danger"
												onClick={() => void removeEntry(entry)}
												disabled={Boolean(busy)}
											>
												{busy === `remove-${entry.id}` ? "Removing…" : "Remove"}
											</button>
										</span>
									) : (
										<button
											type="button"
											className="button quiet-action-link danger"
											onClick={() => setRemovalConfirmation(entry.id)}
											disabled={Boolean(busy)}
										>
											Remove
										</button>
									)}
								</div>
							</article>
						);
					})
				)}
			</div>

			<div className="password-entry-list" aria-label="Never-save password origins">
				<h3>Never save passwords for</h3>
				{settings.neverSavePasswordOrigins.length === 0 ? (
					<span className="password-empty-state">No exceptions.</span>
				) : (
					settings.neverSavePasswordOrigins.map((origin) => (
						<div className="password-entry-card" key={origin}>
							<span>{origin}</span>
							<button
								type="button"
								className="button quiet-action-link"
								onClick={() => void removeNeverSaveOrigin(origin)}
								disabled={Boolean(busy)}
							>
								Remove
							</button>
						</div>
					))
				)}
			</div>

			<p className="password-settings-footnote">
				Saved passwords are never shared with the agent.
			</p>
		</section>
	);
}
