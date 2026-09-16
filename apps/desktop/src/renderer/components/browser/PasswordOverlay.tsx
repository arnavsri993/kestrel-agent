import { useEffect, useMemo, useState } from "react";
import { Icon } from "../Icon";
import type { AutofillProfile, PasswordPrompt } from "@kestrel/shared-types";

function hostname(origin: string): string {
	try {
		return new URL(origin).hostname.replace(/^www\./, "");
	} catch {
		return origin;
	}
}

export function PasswordOverlay() {
	const [prompt, setPrompt] = useState<PasswordPrompt | null>(null);
	const [chooseFields, setChooseFields] = useState(false);
	const [selectedEntryId, setSelectedEntryId] = useState("");
	const [saveUsername, setSaveUsername] = useState("");
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [profilePreview, setProfilePreview] = useState<AutofillProfile | null>(null);
	const [generated, setGenerated] = useState(false);

	useEffect(() => window.kestrel.onPasswordPrompt(setPrompt), []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			void window.kestrel.request({ type: "password-dismiss" }).catch(() => undefined);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	useEffect(() => {
		setChooseFields(false);
		setSelectedEntryId(prompt?.entries[0]?.id ?? "");
		setSaveUsername(prompt?.candidate?.username ?? "");
		setBusy("");
		setError("");
		setGenerated(false);
	}, [prompt]);

	useEffect(() => {
		setProfilePreview(null);
		if (prompt?.mode !== "profile") return;
		let cancelled = false;
		void window.kestrel.request({ type: "autofill-profile-preview" }).then((response) => {
			if (cancelled) return;
			if (!response.ok || !("autofillProfile" in response)) throw new Error("Saved info could not be loaded. Reopen the suggestion to retry.");
			setProfilePreview(response.autofillProfile);
		}).catch(() => {
			if (!cancelled) setError("Saved info could not be loaded. Reopen the suggestion to retry.");
		});
		return () => { cancelled = true; };
	}, [prompt]);

	const fillableFields = useMemo(
		() =>
			prompt?.fields.filter(
				(field) => field.kind === "username" || field.kind === "password",
			) ?? [],
		[prompt],
	);

	if (!prompt) return null;
	const saveCandidate = prompt.candidate;
	const updatedEntry = saveCandidate
		? prompt.entries.find((entry) => entry.username === saveUsername)
		: undefined;
	const updatesExistingLogin = Boolean(updatedEntry);
	const saveActionLabel = updatesExistingLogin
		? "Update password"
		: "Save password";

	async function savePassword() {
		setBusy("save");
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "password-save-suggestion",
				username: saveUsername,
			});
			if (!response.ok)
				throw new Error("The password could not be saved. Try again.");
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "The password could not be saved. Try again.",
			);
		} finally {
			setBusy("");
		}
	}

	async function fillPage(passwordId: string) {
		setBusy(passwordId);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "password-fill-page",
				passwordId,
			});
			if (!response.ok) throw new Error("The saved login could not be used.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The saved login could not be used.");
		} finally {
			setBusy("");
		}
	}

	async function fillField(passwordId: string, fieldId: string) {
		setBusy(`${passwordId}:${fieldId}`);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "password-fill-field",
				passwordId,
				fieldId,
			});
			if (!response.ok) throw new Error("That field could not be filled.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "That field could not be filled.");
		} finally {
			setBusy("");
		}
	}

	async function fillProfile(fieldId?: string) {
		setBusy("profile"); setError("");
		try {
			const response = await window.kestrel.request({ type: "autofill-profile-fill", ...(fieldId ? { fieldId } : {}) });
			if (!response.ok) throw new Error(response.error || "Form info could not be filled.");
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Form info could not be filled."); }
		finally { setBusy(""); }
	}

	async function dismiss() {
		await window.kestrel.request({ type: "password-dismiss" }).catch(() => undefined);
	}

	async function markNeverSave() {
		setBusy("never-save");
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "password-mark-never-save",
			});
			if (!response.ok) throw new Error("The never-save setting could not be updated.");
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "The never-save setting could not be updated.",
			);
		} finally {
			setBusy("");
		}
	}

	async function generatePassword() {
		setBusy("generate");
		setError("");
		try {
			const response = await window.kestrel.request({ type: "password-generate" });
			if (!response.ok) throw new Error("Kestrel could not generate a password here.");
			setGenerated(true);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Kestrel could not generate a password here.",
			);
		} finally {
			setBusy("");
		}
	}

	return (
		<div className="password-overlay-root">
			<section
				className={`password-overlay-card${prompt.mode === "profile" ? " password-overlay-card--profile" : ""}`}
				role="dialog"
				aria-label={
					prompt.mode === "profile" ? "Saved personal info" : prompt.mode === "save"
						? "Save password"
						: prompt.mode === "generate"
							? "Strong password suggestion"
							: "Saved password suggestions"
				}
				aria-live="polite"
			>
				<header className="password-overlay-header">
					<div className="password-overlay-heading">
						<span className="password-overlay-mark" aria-hidden="true"><Icon name={prompt.mode === "profile" ? "person" : "lock"} width={15} height={15} /></span>
						<span>
							<strong>
								{prompt.mode === "profile" ? "Your saved info" : prompt.mode === "save"
									? updatesExistingLogin
										? "Update saved password?"
										: "Save password?"
									: prompt.mode === "generate"
										? "Use a strong password?"
										: prompt.mode === "field"
										? "Passwords"
										: "Passwords"}
							</strong>
							<small>{hostname(prompt.origin)}</small>
						</span>
					</div>
					<button
						type="button"
						className="password-overlay-dismiss"
						onClick={() => void dismiss()}
						aria-label={
							prompt.mode === "save"
								? "Dismiss save password prompt"
								: prompt.mode === "generate"
									? "Dismiss strong password suggestion"
								: prompt.mode === "profile" ? "Dismiss saved personal info" : "Dismiss saved login suggestions"
						}
					>
						×
					</button>
				</header>

				{prompt.mode === "profile" ? (
					<>
						<p className="password-overlay-copy">Fill form keeps the information you’ve already entered.</p>
						{profilePreview ? <dl className="autofill-preview" aria-label="Saved information preview">
							{profilePreviewRows(profilePreview).map(({ label, value, icon }) => <div className="autofill-preview-row" key={label}>
								<Icon name={icon} width={17} height={17} />
								<div><dt>{label}</dt><dd>{value}</dd></div>
							</div>)}
						</dl> : <p className="password-overlay-copy" role="status">{error ? "Preview unavailable" : "Loading saved info…"}</p>}
						<div className="password-overlay-actions">
							<button className="password-overlay-secondary" type="button" disabled={Boolean(busy) || !profilePreview} onClick={() => void fillProfile(prompt.focusedFieldId)}>Fill this field</button>
							<button className="password-overlay-primary" type="button" disabled={Boolean(busy) || !profilePreview} onClick={() => void fillProfile()}><Icon name="context" width={15} height={15} />{busy ? "Filling…" : "Fill form"}</button>
						</div>
					</>
				) : prompt.mode === "save" && saveCandidate ? (
					<>
						<p className="password-overlay-copy">
							{updatesExistingLogin
								? "Replace the password for this saved login."
								: "Save this login on this device for next time."}
						</p>
						<div className="password-save-preview">
							<label htmlFor="password-save-username">Login name</label>
							<input
								id="password-save-username"
								type="text"
								value={saveUsername}
								onChange={(event) => setSaveUsername(event.target.value)}
								autoComplete="username"
								maxLength={500}
								spellCheck={false}
								aria-describedby="password-save-security-note"
							/>
						</div>
						<p id="password-save-security-note" className="password-overlay-security-note">
							Your password is stored securely and hidden here.
						</p>
						<div className="password-overlay-actions password-save-actions">
							<button
								type="button"
								className="password-overlay-secondary"
								onClick={() => void dismiss()}
							>
								Not now
							</button>
							<button
								type="button"
								className="password-overlay-secondary"
								onClick={() => void markNeverSave()}
								disabled={Boolean(busy)}
							>
								Never for this site
							</button>
							<button
								type="button"
								className="password-overlay-primary"
								onClick={() => void savePassword()}
								disabled={Boolean(busy)}
							>
								{busy === "save" ? "Saving…" : saveActionLabel}
							</button>
						</div>
					</>
				) : prompt.mode === "generate" ? (
					<>
						<p className="password-overlay-copy">
							Create a unique 20-character password for this site.
						</p>
						<p className="password-overlay-security-note">
							Fills this form directly. The password stays hidden here.
						</p>
						<div className="password-overlay-actions password-save-actions">
							<button
								type="button"
								className="password-overlay-secondary"
								onClick={() => void dismiss()}
								disabled={Boolean(busy)}
							>
								Not now
							</button>
							<button
								type="button"
								className="password-overlay-primary"
								onClick={() => void generatePassword()}
								disabled={Boolean(busy) || generated}
							>
								{busy === "generate" ? "Generating…" : generated ? "Generated" : "Generate password"}
							</button>
						</div>
					</>
				) : (prompt.mode === "page" || prompt.mode === "field") && !chooseFields ? (
					<>
						<p className="password-overlay-copy">Choose a saved login.</p>
						<div className="password-overlay-entries" role="group">
							{prompt.entries.map((entry) => (
								<button
									key={entry.id}
									type="button"
									className="password-overlay-entry"
									onClick={() => void fillPage(entry.id)}
									disabled={Boolean(busy)}
								>
									<span>
										<strong>{entry.username || "No username"}</strong>
										<small>{entry.title}</small>
									</span>
									<em>{busy === entry.id ? "Filling…" : "Fill page"}</em>
								</button>
							))}
						</div>
						<div className="password-overlay-actions">
							<button type="button" className="password-overlay-link" onClick={() => setChooseFields(true)}>
								Choose fields
							</button>
							<button type="button" className="password-overlay-link" onClick={() => void dismiss()}>
								Not now
							</button>
						</div>
					</>
				) : (
					<>
						<p className="password-overlay-copy">
							{prompt.mode === "field"
								? "Choose a saved value for this field."
								: "Pick a login, then choose the field to fill."}
						</p>
						<div className="password-overlay-select" role="group" aria-label="Saved logins">
							{prompt.entries.map((entry) => (
								<button
									key={entry.id}
									type="button"
									className={entry.id === selectedEntryId ? "selected" : ""}
									aria-pressed={entry.id === selectedEntryId}
									onClick={() => setSelectedEntryId(entry.id)}
									disabled={Boolean(busy)}
								>
									{entry.username || entry.title}
								</button>
							))}
						</div>
						<div className="password-overlay-fields" role="group" aria-label="Form fields">
							{fillableFields.map((field) => {
								const actionKey = `${selectedEntryId}:${field.id}`;
								return (
									<button
										key={field.id}
										type="button"
										className="password-overlay-field"
										onClick={() => void fillField(selectedEntryId, field.id)}
										disabled={!selectedEntryId || Boolean(busy)}
									>
										<span>{field.label || (field.kind === "password" ? "Password" : "Username")}</span>
										<em>{busy === actionKey ? "Filling…" : "Fill"}</em>
									</button>
								);
							})}
						</div>
						<div className="password-overlay-actions">
							{(prompt.mode === "page" || prompt.mode === "field") && (
								<button type="button" className="password-overlay-link" onClick={() => setChooseFields(false)}>
									Fill page instead
								</button>
							)}
							<button type="button" className="password-overlay-link" onClick={() => void dismiss()}>
								Not now
							</button>
						</div>
					</>
				)}
				{error && <p className="password-overlay-error" role="alert">{error}</p>}
			</section>
		</div>
	);
}

function profilePreviewRows(profile: AutofillProfile) {
	const joined = (keys: (keyof AutofillProfile)[], separator = " ") => keys.map((key) => profile[key]).filter(Boolean).join(separator);
	return [
		{ label: "Name", icon: "person", value: profile.name || joined(["given-name", "additional-name", "family-name"]) },
		{ label: "Email", icon: "mail", value: profile.email },
		{ label: "Phone", icon: "phone", value: profile.tel },
		{ label: "Address", icon: "address", value: [profile["street-address"] || joined(["address-line1", "address-line2", "address-line3"], "\n"), joined(["address-level2", "address-level1", "postal-code"], ", "), profile["country-name"] || profile.country].filter(Boolean).join("\n") },
		{ label: "Birthday", icon: "today", value: profile.bday || joined(["bday-year", "bday-month", "bday-day"], " / ") },
		{ label: "Organization", icon: "work", value: profile.organization },
	].filter((row) => Boolean(row.value));
}
