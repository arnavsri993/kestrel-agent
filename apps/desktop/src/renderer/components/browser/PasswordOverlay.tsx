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

	useEffect(() => window.kestrel.onPasswordPrompt(setPrompt), []);

	useEffect(() => {
		setChooseFields(prompt?.mode === "field");
		setSelectedEntryId(prompt?.entries[0]?.id ?? "");
		setBusy("");
		setError("");
	}, [prompt]);

	const fillableFields = useMemo(
		() =>
			prompt?.fields.filter(
				(field) => field.kind === "username" || field.kind === "password",
			) ?? [],
		[prompt],
	);

	if (!prompt) return null;

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

	async function dismiss() {
		await window.kestrel.request({ type: "password-dismiss" }).catch(() => undefined);
	}

	return (
		<div className="password-overlay-root">
			<section
				className="password-overlay-card"
				role="dialog"
				aria-label="Saved password suggestions"
				aria-live="polite"
			>
				<header className="password-overlay-header">
					<div className="password-overlay-heading">
						<span className="password-overlay-mark" aria-hidden="true">●</span>
						<span>
							<strong>{prompt.mode === "field" ? "Saved info" : "Use a saved login?"}</strong>
							<small>{hostname(prompt.origin)}</small>
						</span>
					</div>
					<button
						type="button"
						className="password-overlay-dismiss"
						onClick={() => void dismiss()}
						aria-label="Dismiss saved login suggestions"
					>
						×
					</button>
				</header>

				{prompt.mode === "page" && !chooseFields ? (
					<>
						<p className="password-overlay-copy">Fill this sign-in form with a saved login.</p>
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
