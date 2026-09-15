import { useEffect, useRef, useState } from "react";
import type { RuntimeSession } from "@kestrel/shared-types";

export function AgentSettingsDialog({ session, sessions, onClose, onSaved }: {
	session: RuntimeSession; sessions: RuntimeSession[]; onClose(): void; onSaved(): void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		const opener = document.activeElement;
		ref.current?.showModal();
		return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
	}, []);
	async function save(target: RuntimeSession, form: HTMLFormElement) {
		const data = new FormData(form);
		setBusy(true); setError("");
		try {
			const title = String(data.get("name") ?? "").trim();
			const instructions = String(data.get("instructions") ?? "");
			const result = await window.kestrel.request({ type: "runtime-configure-agent", sessionId: target.id, title, instructions,
				...(target.specialistDefinition ? { specialistDefinition: { ...target.specialistDefinition, name: title,
					purpose: String(data.get("purpose") ?? ""), instructions, enabled: data.get("enabled") === "on" } } : {}) });
			if (!result.ok) throw new Error(result.error);
			onSaved();
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save agent."); }
		finally { setBusy(false); }
	}
	async function add(form: HTMLFormElement) {
		const data = new FormData(form); setBusy(true); setError("");
		try {
			const result = await window.kestrel.request({ type: "runtime-add-specialist", parentSessionId: session.id,
				definition: { key: crypto.randomUUID(), name: String(data.get("name") ?? "").trim(),
					purpose: String(data.get("purpose") ?? "").trim(), instructions: "", enabled: true } });
			if (!result.ok) throw new Error(result.error);
			form.reset(); onSaved();
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add specialist."); }
		finally { setBusy(false); }
	}
	async function archive(target: RuntimeSession, archived: boolean) {
		if (!target.specialistDefinition) return;
		setBusy(true); setError("");
		try {
			const result = await window.kestrel.request({ type: "runtime-configure-agent", sessionId: target.id,
				title: target.title, instructions: target.specialistDefinition.instructions,
				specialistDefinition: { ...target.specialistDefinition, archived, enabled: false } });
			if (!result.ok) throw new Error(result.error);
			onSaved();
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update specialist."); }
		finally { setBusy(false); }
	}
	const editor = (target: RuntimeSession) => <form onSubmit={event => { event.preventDefault(); void save(target, event.currentTarget); }}>
		<label>Name<input name="name" defaultValue={target.title} required maxLength={200} /></label>
		{target.specialistDefinition && <>
			<label>Purpose<textarea name="purpose" required maxLength={2000} defaultValue={target.specialistDefinition.purpose} /></label>
			<label><input type="checkbox" name="enabled" defaultChecked={target.specialistDefinition.enabled} />Available for delegation</label>
		</>}
		<label>Instructions<textarea name="instructions" maxLength={20000} defaultValue={target.specialistDefinition?.instructions ?? target.agentInstructions ?? ""} /></label>
		<button type="submit" className="button secondary" disabled={busy}>Save</button>
		{target.specialistDefinition && <button type="button" className="button secondary" disabled={busy} onClick={() => void archive(target, true)}>Archive specialist</button>}
	</form>;
	return <dialog ref={ref} className="persistent-agent-settings" aria-labelledby="persistent-agent-settings-title" onCancel={onClose}>
		<header><h2 id="persistent-agent-settings-title">{session.title} settings</h2><button type="button" onClick={onClose}>Close</button></header>
		{error && <p role="alert">{error}</p>}
		{editor(session)}
		{session.kind === "agent" && <>
			<h3>Specialists</h3><p>Only relevant specialists run. Disabling one preserves its history.</p>
			{sessions.filter(item => item.parentSessionId === session.id && item.specialistDefinition && !item.specialistDefinition.archived).map(item =>
				<details key={item.id}><summary>{item.title}{item.specialistDefinition?.enabled ? "" : " · disabled"}</summary>{editor(item)}</details>)}
			{sessions.some(item => item.parentSessionId === session.id && item.specialistDefinition?.archived) && <details><summary>Archived specialists</summary>
				<p>History and memory are retained. Restore a specialist, then enable it when needed.</p>
				{sessions.filter(item => item.parentSessionId === session.id && item.specialistDefinition?.archived).map(item => <p key={item.id}>{item.title} <button type="button" disabled={busy} onClick={() => void archive(item, false)}>Restore {item.title}</button></p>)}
			</details>}
			<details><summary>Add specialist</summary><form onSubmit={event => { event.preventDefault(); void add(event.currentTarget); }}>
				<label>Name<input name="name" required maxLength={200} /></label>
				<label>Purpose<textarea name="purpose" required maxLength={2000} /></label>
				<button type="submit" disabled={busy}>Add specialist</button>
			</form></details>
		</>}
	</dialog>;
}
