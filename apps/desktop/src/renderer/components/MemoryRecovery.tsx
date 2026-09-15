import { useState } from "react";
import type { MemoryRecoveryPreview } from "@kestrel/shared-types";

export function MemoryRecovery({ sessionId, onRestored }: { sessionId: string; onRestored(): void }) {
	const [preview, setPreview] = useState<MemoryRecoveryPreview>();
	const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
	async function perform(action: "export" | "preview" | "apply") {
		setBusy(true); setNotice(""); setError("");
		try {
			const result = await window.kestrel.request(action === "apply"
				? { type: "memory-recovery-apply", sessionId, planId: preview!.planId, approved: true }
				: { type: action === "export" ? "memory-recovery-save-file" : "memory-recovery-open-file", sessionId });
			if (!result.ok) throw new Error(result.error);
			if ("cancelled" in result && result.cancelled) return;
			if (action === "preview" && "memoryRecoveryPreview" in result) setPreview(result.memoryRecoveryPreview);
			else if (action === "export") setNotice("Encrypted knowledge backup saved.");
			else if (action === "apply" && "memoryRecoveryRestored" in result) { setNotice(`Restored ${result.memoryRecoveryRestored ?? 0} records. Existing records were kept.`); setPreview(undefined); onRestored(); }
		} catch (cause) { setError(cause instanceof Error ? cause.message : "Recovery request failed."); }
		finally { setBusy(false); }
	}
	return <details><summary>Knowledge backup and recovery</summary>
		<p>Encrypted recovery for this scope in the same Kestrel profile, using its existing protected key. Keep that profile and key; this file cannot move knowledge to another profile.</p>
		<p>Supports up to 1,000 active public or personal standalone knowledge records. Sensitive, restricted, expired and task- or source-linked knowledge is excluded. Chats, source history, tasks, credentials and browser sessions are not included.</p>
		<button disabled={busy} onClick={() => void perform("export")}>Save encrypted backup</button>
		<button disabled={busy} onClick={() => void perform("preview")}>Preview recovery</button>
		{preview && <section aria-label="Recovery preview"><p>{preview.scopeName}: {preview.newRecords} missing records to restore; {preview.existingRecords} existing records will be skipped. Nothing has been restored yet.</p>
			<p>Preview expires {new Date(preview.expiresAt).toLocaleTimeString()}. Source references may point to material no longer available.</p>
			<button disabled={busy || preview.newRecords === 0} onClick={() => void perform("apply")}>Restore missing records</button><button disabled={busy} onClick={() => setPreview(undefined)}>Cancel preview</button>
		</section>}
		{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
	</details>;
}
