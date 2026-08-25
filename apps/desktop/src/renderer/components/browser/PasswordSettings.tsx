import type { PasswordEntrySummary } from "@kestrel/shared-types";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Icon } from "../Icon";

function responseError(response: { ok: boolean; error?: string }): string {
	return response.ok ? "" : response.error || "Password operation failed.";
}

export function PasswordSettings({
	browser,
}: {
	browser: UserBrowserController;
}) {
	const settings = browser.state?.settings;
	const [entries, setEntries] = useState<PasswordEntrySummary[]>([]);
	const [origin, setOrigin] = useState("");
	const [title, setTitle] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	const loadEntries = useCallback(async () => {
		const response = await window.kestrel.request({ type: "password-list" });
		if (!response.ok) throw new Error(responseError(response));
		if ("passwords" in response) setEntries(response.passwords);
	}, []);

	useEffect(() => {
		void loadEntries().catch((cause) =>
			setError(cause instanceof Error ? cause.message : "Passwords could not be loaded."),
		);
	}, [loadEntries]);

	async function saveEntry(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError("");
		setNotice("");
		if (!origin.trim() || !password) {
			setError("Add a website and password before saving.");
			return;
		}
		setBusy("save");
		try {
			const response = await window.kestrel.request({
				type: "password-save",
				origin: origin.trim(),
				...(title.trim() ? { title: title.trim() } : {}),
				username: username.trim(),
				password,
			});
			if (!response.ok) throw new Error(responseError(response));
			if ("passwords" in response) setEntries(response.passwords);
			setOrigin("");
			setTitle("");
			setUsername("");
			setPassword("");
			setNotice("Saved in Kestrel’s protected password store.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Password could not be saved.");
		} finally {
			setBusy("");
		}
	}

	async function removeEntry(entry: PasswordEntrySummary) {
		if (!window.confirm(`Remove the saved login for ${entry.title}?`)) return;
		setBusy(entry.id);
		setError("");
		setNotice("");
		try {
			const response = await window.kestrel.request({
				type: "password-remove",
				passwordId: entry.id,
			});
			if (!response.ok) throw new Error(responseError(response));
			if ("passwords" in response) setEntries(response.passwords);
			setNotice("Saved login removed.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Password could not be removed.");
		} finally {
			setBusy("");
		}
	}

	if (!settings) return null;

	return (
		<section className="settings-stack browser-settings-panel password-settings-panel" aria-labelledby="password-settings-title">
			<header className="settings-panel-header">
				<h2 id="password-settings-title">
					<Icon name="lock" /> Passwords
				</h2>
				<p>
					Keep sign-ins close at hand without putting secrets in browser history or page settings.
				</p>
			</header>

			<div className="setting-row browser-setting-row password-autofill-toggle">
				<div className="browser-setting-copy">
					<strong>Offer autofill on sign-in forms</strong>
					<p>Kestrel only offers exact-match HTTPS logins and never fills until you choose.</p>
				</div>
				<button
					type="button"
					className={`switch ${settings.passwordAutofillEnabled ? "on" : ""}`}
					role="switch"
					aria-label="Offer autofill on sign-in forms"
					aria-checked={settings.passwordAutofillEnabled}
					onClick={() =>
						void browser.updateSettings({
							passwordAutofillEnabled: !settings.passwordAutofillEnabled,
						})
					}
				>
					<span />
				</button>
			</div>

			<form className="password-save-form" onSubmit={(event) => void saveEntry(event)}>
				<div className="password-form-grid">
					<label>
						<span>Website</span>
						<input
							type="url"
							placeholder="https://accounts.example.com"
							value={origin}
							onChange={(event) => setOrigin(event.target.value)}
							autoComplete="url"
						/>
					</label>
					<label>
						<span>Login name</span>
						<input
							type="text"
							placeholder="you@example.com"
							value={username}
							onChange={(event) => setUsername(event.target.value)}
							autoComplete="username"
						/>
					</label>
					<label>
						<span>Label <small>(optional)</small></span>
						<input
							type="text"
							placeholder="Personal, work, or site name"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
						/>
					</label>
					<label>
						<span>Password</span>
						<input
							type="password"
							placeholder="Enter password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							autoComplete="new-password"
						/>
					</label>
				</div>
				<button type="submit" className="button primary" disabled={busy === "save"}>
					{busy === "save" ? "Saving…" : "Add saved login"}
				</button>
			</form>

			{error && <p className="password-settings-message error" role="alert">{error}</p>}
			{notice && <p className="password-settings-message success" role="status">{notice}</p>}

			<div className="password-entry-list" aria-label="Saved logins">
				{entries.length === 0 ? (
					<div className="password-empty-state">
						<strong>No saved logins yet</strong>
						<span>Add one above, then Kestrel will offer it when that exact site opens a sign-in form.</span>
					</div>
				) : (
					entries.map((entry) => (
						<article className="password-entry-card" key={entry.id}>
							<div>
								<strong>{entry.title}</strong>
								<span>{entry.origin}</span>
								<small>{entry.username || "No login name"}</small>
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

			<p className="password-settings-footnote">
				Saved passwords are encrypted by Kestrel’s protected credential broker. The renderer receives usernames and site labels only; the secret crosses into a page only after an explicit Fill action.
			</p>
		</section>
	);
}
