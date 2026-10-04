import type { MemoryFadePreview, RendererRequest } from "@kestrel/shared-types";
import { useEffect, useState } from "react";

async function request(input: RendererRequest) {
 const response = await window.kestrel.request(input);
 if (!response.ok) throw new Error(response.error);
 return response;
}

export function MemoryCleanupReview({ onApplied, disabled = false, onBusyStateChange }: { onApplied(): void; disabled?: boolean; onBusyStateChange?(busy: boolean): void }) {
	const [preview, setPreview] = useState<MemoryFadePreview | null>(null);
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [receipt, setReceipt] = useState("");
	useEffect(() => { onBusyStateChange?.(busy); return () => onBusyStateChange?.(false); }, [busy, onBusyStateChange]);
	async function review() {
		if (disabled) return;
		setBusy(true); setError(""); setPreview(null); setConfirmed(false); setReceipt("");
		try {
			const response = await request({ type: "memory-fade-plan" });
			if (!("memoryFadePreview" in response) || !response.memoryFadePreview) throw new Error("The cleanup review was not returned.");
			setPreview(response.memoryFadePreview);
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Could not review cleanup."); }
		finally { setBusy(false); }
	}
	async function apply() {
		if (!preview || !confirmed || disabled) return;
		setBusy(true); setError("");
		try {
			const response = await request({ type: "memory-fade-apply", planId: preview.plan.id, approved: true });
			if (!("memoryFadeDryRun" in response) || !response.memoryFadeDryRun?.applied) throw new Error("Cleanup was not confirmed.");
			setReceipt(response.memoryFadeDryRun.backupKey ?? ""); setPreview(null); setConfirmed(false); onApplied();
		} catch (cause) {
			setPreview(null); setConfirmed(false);
			setError(cause instanceof Error ? cause.message : "Could not clean up notes.");
		} finally { setBusy(false); }
	}
	return <details className="memory-cleanup-review">
		<summary>Review old automatic notes</summary>
		<p>Review up to 200 notes across all agents and domains. Notes you kept or confirmed are excluded. Nothing is removed until you approve this list; Kestrel takes a backup first.</p>
		<button type="button" disabled={busy || disabled} onClick={() => void review()}>{busy ? "Working…" : "Review cleanup"}</button>
		{error && <p role="alert">{error}</p>}
		{receipt && <p role="status">Reviewed notes removed. Backup: <code>{receipt}</code></p>}
		{preview && <div>
			<p>{preview.candidates.length ? `${preview.candidates.length} ${preview.candidates.length === 1 ? "note is" : "notes are"} ready for review. Some notes have separate agent copies.` : "No old automatic notes are ready to remove."}</p>
			{preview.candidates.length > 0 && <>
				<div className="memory-cleanup-candidates" tabIndex={0} role="region" aria-label="Notes in cleanup review">{preview.candidates.map(candidate => <article key={`${candidate.kind}:${candidate.id}`}><h4>{candidate.kind === "agent" ? "Agent note" : "Automatic note"}</h4><p>{candidate.content}</p></article>)}</div>
				<label className="memory-cleanup-confirm"><input type="checkbox" checked={confirmed} disabled={busy || disabled} onChange={event => setConfirmed(event.target.checked)} />I reviewed these records and want to remove them.</label>
				<div className="memory-cleanup-actions"><button type="button" className="danger" disabled={busy || disabled || !confirmed} onClick={() => void apply()}>Remove reviewed notes</button>
				<button type="button" disabled={busy || disabled} onClick={() => { setPreview(null); setConfirmed(false); }}>Cancel</button>
				</div>
			</>}
		</div>}
	</details>;
}
