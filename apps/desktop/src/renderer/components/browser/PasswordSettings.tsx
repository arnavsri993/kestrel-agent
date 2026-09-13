import { useCallback, useEffect, useMemo, useState } from "react";
import type { AutofillProfile, PasswordEntrySummary } from "@kestrel/shared-types";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { Icon } from "../Icon";

type PasswordSettingKey =
	| "offerToSavePasswords"
	| "autoSavePasswords"
	| "autofillPasswords"
	| "autofillUsernames"
	| "offerStrongPasswords"
	| "autofillProfileEnabled"
	| "autoSaveFormInfo";

function responseError(response: { ok: boolean; error?: string }): string {
	return response.ok ? "" : response.error || "Password operation failed.";
}

function displayDate(value: string | undefined): string {
	if (!value) return "Never";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleDateString();
}

function matchesSearch(entry: PasswordEntrySummary, search: string): boolean {
	return !search || `${entry.title} ${entry.origin} ${entry.username}`.toLocaleLowerCase().includes(search.toLocaleLowerCase());
}

export function PasswordSettings({ browser }: { browser: UserBrowserController }) {
	const settings = browser.state?.settings;
	const [profile, setProfile] = useState<AutofillProfile>({});
	const [entries, setEntries] = useState<PasswordEntrySummary[]>([]);
	const [usernameDrafts, setUsernameDrafts] = useState<Record<string, string>>({});
	const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
	const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
	const [removalConfirmation, setRemovalConfirmation] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [addOrigin, setAddOrigin] = useState("");
	const [addUsername, setAddUsername] = useState("");
	const [addPassword, setAddPassword] = useState("");
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	const syncEntries = useCallback((nextEntries: PasswordEntrySummary[]) => {
		setEntries(nextEntries);
		setUsernameDrafts(Object.fromEntries(nextEntries.map((entry) => [entry.id, entry.username])));
		setPasswordDrafts({});
	}, []);

	const loadEntries = useCallback(async () => {
		const profileResponse = await window.kestrel.request({ type: "autofill-profile-get" });
		if (profileResponse.ok && "autofillProfile" in profileResponse) setProfile(profileResponse.autofillProfile);
		const response = await window.kestrel.request({ type: "password-list" });
		if (!response.ok) throw new Error(responseError(response));
		if ("passwords" in response) syncEntries(response.passwords);
	}, [syncEntries]);

	useEffect(() => {
		void loadEntries().catch((cause) => setError(cause instanceof Error ? cause.message : "Passwords could not be loaded."));
	}, [loadEntries]);

	const visibleEntries = useMemo(
		() => entries.filter((entry) => matchesSearch(entry, search.trim())),
		[entries, search],
	);

	function begin(action: string) {
		setBusy(action);
		setError("");
		setNotice("");
	}

	async function runPasswordAction(entry: PasswordEntrySummary, type: "password-copy" | "password-reveal") {
		begin(`${type}-${entry.id}`);
		try {
			const response = await window.kestrel.request({ type, passwordId: entry.id });
			if (!response.ok) throw new Error(responseError(response));
			setNotice(type === "password-copy" ? "Password copied. Kestrel clears it if it remains unchanged." : "Password revealed after local device verification.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Password operation failed.");
		} finally { setBusy(""); }
	}

	function cancelEdit(entry: PasswordEntrySummary) {
		setEditingEntryId(null);
		setUsernameDrafts((drafts) => ({ ...drafts, [entry.id]: entry.username }));
		setPasswordDrafts((drafts) => ({ ...drafts, [entry.id]: "" }));
	}

	async function updateEntry(entry: PasswordEntrySummary) {
		const username = usernameDrafts[entry.id] ?? entry.username;
		const password = passwordDrafts[entry.id] ?? "";
		if (username === entry.username && !password) return cancelEdit(entry);
		begin(`update-${entry.id}`);
		try {
			const response = await window.kestrel.request({ type: "password-update", passwordId: entry.id, username, ...(password ? { password } : {}) });
			if (!response.ok) throw new Error(responseError(response));
			if ("passwords" in response) syncEntries(response.passwords);
			setEditingEntryId(null);
			setNotice(password ? "Saved login and password updated." : "Saved login name updated.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Saved login could not be updated.");
		} finally { setBusy(""); }
	}

	async function addEntry() {
		begin("add");
		try {
			const response = await window.kestrel.request({ type: "password-add", origin: addOrigin, username: addUsername, password: addPassword });
			if (!response.ok) throw new Error(responseError(response));
			if ("passwords" in response) syncEntries(response.passwords);
			setAddOrigin(""); setAddUsername(""); setAddPassword("");
			setNotice("Saved login added.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Saved login could not be added.");
		} finally { setBusy(""); }
	}

	async function removeEntry(entry: PasswordEntrySummary) {
		begin(`remove-${entry.id}`);
		try {
			const response = await window.kestrel.request({ type: "password-remove", passwordId: entry.id });
			if (!response.ok) throw new Error(responseError(response));
			if ("passwords" in response) syncEntries(response.passwords);
			setRemovalConfirmation(null); setEditingEntryId(null); setNotice("Saved login removed.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Password could not be removed.");
		} finally { setBusy(""); }
	}

	async function removeNeverSaveOrigin(origin: string) {
		if (!settings) return;
		begin(`never-${origin}`);
		try {
			await browser.updateSettings({ neverSavePasswordOrigins: settings.neverSavePasswordOrigins.filter((item) => item !== origin) });
			setNotice("Never-save exception removed.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Setting could not be updated.");
		} finally { setBusy(""); }
	}

	async function saveProfile(clear = false) {
		begin("profile");
		try {
			const response = await window.kestrel.request({ type: "autofill-profile-save", profile: clear ? {} : profile });
			if (!response.ok) throw new Error(responseError(response));
			if ("autofillProfile" in response) setProfile(response.autofillProfile);
			setNotice(clear ? "Saved form info removed." : "Form info saved securely on this Mac.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Form info could not be saved.");
		} finally { setBusy(""); }
	}

	if (!settings) return null;
	const toggle = (key: PasswordSettingKey, label: string, description: string, disabled = false) => (
		<div className="setting-row browser-setting-row password-autofill-toggle" key={key}>
			<div className="browser-setting-copy"><strong>{label}</strong><p>{description}</p></div>
			<button type="button" className={`switch ${settings[key] ? "on" : ""}`} role="switch" aria-label={label} aria-checked={settings[key]} disabled={disabled} onClick={() => void browser.updateSettings({ [key]: !settings[key] })}><span /></button>
		</div>
	);

	return (
		<section className="settings-stack browser-settings-panel password-settings-panel" aria-labelledby="password-settings-title">
			<header className="settings-panel-header"><h2 id="password-settings-title"><Icon name="lock" /> Passwords and autofill</h2><p>Saved passwords and form info stay in protected storage on this Mac.</p></header>
			<div className="password-settings-group" aria-labelledby="password-behavior-title">
				<h3 id="password-behavior-title">Password behavior</h3>
				{toggle("offerToSavePasswords", "Offer to save passwords", "Ask before storing a new or changed login after a supported HTTPS sign-in.")}
				{toggle("autoSavePasswords", "Save passwords automatically", settings.offerToSavePasswords ? "Save confirmed logins without showing a save prompt." : "Turn on save prompts before automatic saving can run.", !settings.offerToSavePasswords)}
				{toggle("autofillPasswords", "Fill passwords", settings.passwordAutofillEnabled ? "Fill a password only for an exact HTTPS origin with a matching saved login." : "Turn on Password autofill and save prompts above to use this setting.", !settings.passwordAutofillEnabled)}
				{toggle("autofillUsernames", "Fill usernames", settings.passwordAutofillEnabled ? "Fill a saved login name on matching username-first pages." : "Turn on Password autofill and save prompts above to use this setting.", !settings.passwordAutofillEnabled)}
				{toggle("offerStrongPasswords", "Offer strong passwords", settings.passwordAutofillEnabled ? "Offer a generated password for supported sign-up fields." : "Turn on Password autofill and save prompts above to use this setting.", !settings.passwordAutofillEnabled)}
			</div>
			<div className="password-settings-group" aria-labelledby="personal-info-title">
				<h3 id="personal-info-title">Personal info</h3>
				{toggle("autofillProfileEnabled", "Autofill personal info", "Offer saved name, address, contact details, and birthday on supported fields.")}
				{toggle("autoSaveFormInfo", "Remember submitted form info", settings.autofillProfileEnabled ? "Store details entered in supported forms in protected storage on this Mac." : "Turn on personal-info autofill before Kestrel can remember form details.", !settings.autofillProfileEnabled)}
			</div>
			{error ? <p className="password-settings-message error" role="alert">{error}</p> : null}
			{notice ? <p className="password-settings-message success" role="status">{notice}</p> : null}

			<details className="password-entry-card password-profile-card"><summary>Saved personal info</summary><p>Edit the details Kestrel can fill. Blank fields are skipped.</p>
				<form onSubmit={(event) => { event.preventDefault(); void saveProfile(); }} className="autofill-profile-grid">
					{([ ["name", "Full name"], ["given-name", "First name"], ["additional-name", "Middle name"], ["family-name", "Last name"], ["email", "Email"], ["tel", "Phone"], ["organization", "Company"], ["bday", "Birthday"], ["address-line1", "Street address"], ["address-line2", "Apartment / suite"], ["address-level2", "City"], ["address-level1", "State / province"], ["postal-code", "ZIP / postal code"], ["country", "Country code"], ["country-name", "Country"], ["street-address", "Full address"], ["address-line3", "Address line 3"], ["bday-day", "Birth day"], ["bday-month", "Birth month"], ["bday-year", "Birth year"] ] as const).map(([key, label]) => <label key={key}><span>{label}</span><input type={key === "bday" ? "date" : key === "email" ? "email" : "text"} autoComplete="off" maxLength={500} value={profile[key] || ""} onChange={(event) => setProfile((previous) => ({ ...previous, [key]: event.target.value }))} /></label>)}
					<button type="submit" disabled={Boolean(busy)}>Save info</button><button type="button" disabled={Boolean(busy)} onClick={() => void saveProfile(true)}>Clear saved info</button>
				</form>
			</details>

			<div className="password-entry-list" aria-labelledby="saved-passwords-title">
				<div className="password-list-heading"><div><h3 id="saved-passwords-title">Saved passwords</h3><span>{entries.length} {entries.length === 1 ? "login" : "logins"}</span></div><label className="password-search"><span className="sr-only">Search saved passwords</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sites or accounts" aria-label="Search saved passwords" /></label></div>
				{entries.length === 0 ? <div className="password-empty-state"><strong>No saved logins yet</strong><span>{settings.offerToSavePasswords ? "Kestrel will offer to save a login after a supported HTTPS sign-in." : "Turn on Offer to save passwords to save supported HTTPS logins."}</span></div> : visibleEntries.length === 0 ? <div className="password-empty-state"><strong>No matching saved logins</strong><span>Try a site name, address, or account name.</span><button type="button" className="button quiet-action-link" onClick={() => setSearch("")}>Clear search</button></div> : visibleEntries.map((entry) => {
					const editing = editingEntryId === entry.id;
					const password = passwordDrafts[entry.id] ?? "";
					const confirmingRemoval = removalConfirmation === entry.id;
					return <article className="password-entry-card password-login-card" key={entry.id}><div className="password-entry-details"><strong>{entry.title}</strong><span>{entry.origin}</span>{editing ? <><label><span>Login name</span><input type="text" value={usernameDrafts[entry.id] ?? entry.username} onChange={(event) => setUsernameDrafts((drafts) => ({ ...drafts, [entry.id]: event.target.value }))} autoComplete="username" maxLength={500} spellCheck={false} /></label><label><span>New password</span><input type="password" value={password} onChange={(event) => setPasswordDrafts((drafts) => ({ ...drafts, [entry.id]: event.target.value }))} autoComplete="new-password" maxLength={4096} /><small>Leave blank to keep the current password.</small></label></> : <span>{entry.username || "No login name"}</span>}<small>Last used {displayDate(entry.lastUsedAt)} · Updated {displayDate(entry.updatedAt)}</small></div><div className="password-entry-actions">{editing ? <><button type="button" className="button quiet-action-link" onClick={() => void updateEntry(entry)} disabled={Boolean(busy) || ((usernameDrafts[entry.id] ?? entry.username) === entry.username && !password)}>{busy === `update-${entry.id}` ? "Updating…" : password ? "Update login and password" : "Update login"}</button><button type="button" className="button quiet-action-link" onClick={() => cancelEdit(entry)} disabled={Boolean(busy)}>Cancel</button></> : <button type="button" className="button quiet-action-link" onClick={() => { setEditingEntryId(entry.id); setPasswordDrafts((drafts) => ({ ...drafts, [entry.id]: "" })); }} disabled={Boolean(busy)}>Edit</button>}<button type="button" className="button quiet-action-link" onClick={() => void runPasswordAction(entry, "password-copy")} disabled={Boolean(busy)}>Copy password</button><button type="button" className="button quiet-action-link" onClick={() => void runPasswordAction(entry, "password-reveal")} disabled={Boolean(busy)}>Reveal</button>{confirmingRemoval ? <span className="password-remove-confirmation" role="group"><span>Remove this login?</span><button type="button" className="button quiet-action-link" onClick={() => setRemovalConfirmation(null)} disabled={Boolean(busy)}>Cancel</button><button type="button" className="button quiet-action-link danger" onClick={() => void removeEntry(entry)} disabled={Boolean(busy)}>{busy === `remove-${entry.id}` ? "Removing…" : "Remove"}</button></span> : <button type="button" className="button quiet-action-link danger" onClick={() => setRemovalConfirmation(entry.id)} disabled={Boolean(busy)}>Remove</button>}</div></article>;
				})}
				<details className="password-entry-card password-add-card"><summary>Add a saved login</summary><p>Save a login for an exact HTTPS site. Kestrel asks for local device verification before it writes the password.</p><form className="password-add-form" onSubmit={(event) => { event.preventDefault(); void addEntry(); }}><label><span>Website</span><input type="url" value={addOrigin} onChange={(event) => setAddOrigin(event.target.value)} placeholder="https://example.com" autoComplete="url" required /></label><label><span>Login name</span><input type="text" value={addUsername} onChange={(event) => setAddUsername(event.target.value)} autoComplete="username" maxLength={500} /></label><label><span>Password</span><input type="password" value={addPassword} onChange={(event) => setAddPassword(event.target.value)} autoComplete="new-password" maxLength={4096} required /></label><button type="submit" disabled={Boolean(busy) || !addOrigin || !addPassword}>{busy === "add" ? "Adding…" : "Add login"}</button></form></details>
			</div>
			<div className="password-entry-list" aria-labelledby="never-save-title"><h3 id="never-save-title">Never save passwords for</h3>{settings.neverSavePasswordOrigins.length === 0 ? <span className="password-empty-state">No exceptions. Use “Never for this site” from a save prompt to add one.</span> : settings.neverSavePasswordOrigins.map((origin) => <div className="password-entry-card" key={origin}><span>{origin}</span><button type="button" className="button quiet-action-link" onClick={() => void removeNeverSaveOrigin(origin)} disabled={Boolean(busy)}>Remove</button></div>)}</div>
			<p className="password-settings-footnote">Saved passwords are never shared with the agent.</p>
		</section>
	);
}
