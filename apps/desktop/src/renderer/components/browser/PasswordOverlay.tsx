import { useEffect, useMemo, useState } from "react";
import type { PasswordPrompt } from "@kestrel/shared-types";

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
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
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
		setBusy("");
		setError("");
		setGenerated(false);
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
	const updatesExistingLogin = Boolean(
		saveCandidate &&
		prompt.entries.some((entry) => entry.username === saveCandidate.username),
	);

	async function savePassword() {
		setBusy("save");
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "password-save-suggestion",
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
				className="password-overlay-card"
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
						<span className="password-overlay-mark" aria-hidden="true">●</span>
						<span>
							<strong>
								{prompt.mode === "profile" ? "Fill with saved info?" : prompt.mode === "save"
									? updatesExistingLogin
										? "Update saved password?"
										: "Save password?"
									: prompt.mode === "generate"
										? "Use a strong password?"
										: prompt.mode === "field"
										? "Saved info"
										: "Use a saved login?"}
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
								: "Dismiss saved login suggestions"
						}
					>
						×
					</button>
				</header>

				{prompt.mode === "profile" ? (
					<>
						<p className="password-overlay-copy">Use your saved name, address, contact details, and birthday on this site.</p>
						<div className="password-overlay-actions">
							<button className="password-overlay-primary" type="button" disabled={Boolean(busy)} onClick={() => void fillProfile()}>{busy ? "Filling…" : "Fill form"}</button>
							<button className="password-overlay-secondary" type="button" disabled={Boolean(busy)} onClick={() => void fillProfile(prompt.focusedFieldId)}>Fill this field</button>
						</div>
					</>
				) : prompt.mode === "save" && saveCandidate ? (
					<>
						<p className="password-overlay-copy">
							Save this login securely on this device so Kestrel can offer it next time.
						</p>
						<div className="password-save-preview">
							<span>Login name</span>
							<strong>{saveCandidate.username || "No login name detected"}</strong>
						</div>
						<p className="password-overlay-security-note">
							Your password stays inside Kestrel and is never shown in this prompt.
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
								{busy === "save" ? "Saving…" : updatesExistingLogin ? "Update password" : "Save password"}
							</button>
						</div>
					</>
				) : prompt.mode === "generate" ? (
					<>
						<p className="password-overlay-copy">
							Generate a unique 20-character password with uppercase, lowercase, numbers, and symbols.
						</p>
						<p className="password-overlay-security-note">
							Kestrel fills it directly into this sign-up form and never displays the value here.
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
						<div className="password-overlay-entries" role="list">
							{prompt.entries.map((entry) => (
								<button
									key={entry.id}
									type="button"
									className="password-overlay-entry"
									onClick={() => void fillPage(entry.id)}
									disabled={Boolean(busy)}
								>
									<span>
										<strong>{entry.title}</strong>
										<small>{entry.username || "No username"}</small>
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
									onClick={() => setSelectedEntryId(entry.id)}
									disabled={Boolean(busy)}
								>
									{entry.username || entry.title}
								</button>
							))}
						</div>
						<div className="password-overlay-fields" role="list" aria-label="Form fields">
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
							{prompt.mode === "page" && (
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
