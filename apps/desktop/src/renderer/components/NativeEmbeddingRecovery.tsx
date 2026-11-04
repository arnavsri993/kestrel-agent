import { NativeEmbeddingRecoveryAppliedSchema, NativeEmbeddingRecoveryPreviewSchema, type NativeEmbeddingRecoveryPreview } from "@kestrel/shared-types";
import { useEffect, useRef, useState } from "react";

class RecoveryFailure extends Error {}

function failureMessage(message: string) {
	return message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500) || "The repair could not be completed.";
}

type Review = Extract<NativeEmbeddingRecoveryPreview, { state: "review" }>;

function discard(planId: string) {
	void window.kestrel.request({ type: "native-embedding-recovery-discard", planId }).catch(() => undefined);
}

export function NativeEmbeddingRecovery() {
	const [preview, setPreview] = useState<Review>();
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const generation = useRef(0);
	const plan = useRef<string | undefined>(undefined);

	function clear() {
		generation.current += 1;
		if (plan.current) discard(plan.current);
		plan.current = undefined;
		setPreview(undefined);
		setBusy(false);
		setNotice("");
		setError("");
	}

	useEffect(() => () => {
		generation.current += 1;
		if (plan.current) discard(plan.current);
		plan.current = undefined;
	}, []);

	useEffect(() => {
		if (!preview || busy) return;
		const expire = () => {
			if (plan.current !== preview.planId) return;
			generation.current += 1;
			discard(preview.planId);
			plan.current = undefined;
			setPreview(undefined);
			setBusy(false);
			setNotice("The review expired. Review again to continue.");
		};
		const delay = Date.parse(preview.expiresAt) - Date.now();
		if (delay <= 0) { expire(); return; }
		const timer = window.setTimeout(expire, delay);
		return () => window.clearTimeout(timer);
	}, [preview, busy]);

	async function review() {
		if (busy) return;
		const current = ++generation.current;
		setBusy(true); setError(""); setNotice("");
		try {
			const response = await window.kestrel.request({ type: "native-embedding-recovery-review" });
			if (!response.ok) throw new RecoveryFailure(failureMessage(response.error));
			if (!("nativeEmbeddingRecoveryPreview" in response)) throw new Error();
			const result = NativeEmbeddingRecoveryPreviewSchema.parse(response.nativeEmbeddingRecoveryPreview);
			if (current !== generation.current) {
				if (result.state === "review") discard(result.planId);
				return;
			}
			if (result.state === "not-needed") setNotice("No stranded indexing task needs repair.");
			else { plan.current = result.planId; setPreview(result); }
		} catch (cause) {
			if (current === generation.current) setError(cause instanceof RecoveryFailure ? cause.message : "Could not review memory processing. Try again.");
		} finally {
			if (current === generation.current) setBusy(false);
		}
	}

	async function apply() {
		if (busy || !preview || plan.current !== preview.planId || Date.parse(preview.expiresAt) <= Date.now()) return;
		const current = ++generation.current;
		setBusy(true); setError(""); setNotice("");
		try {
			const response = await window.kestrel.request({ type: "native-embedding-recovery-apply", planId: preview.planId });
			if (!response.ok) throw new RecoveryFailure(failureMessage(response.error));
			if (!("nativeEmbeddingRecoveryApplied" in response)) throw new Error();
			const result = NativeEmbeddingRecoveryAppliedSchema.parse(response.nativeEmbeddingRecoveryApplied);
			if (current !== generation.current) return;
			plan.current = undefined; setPreview(undefined);
			setNotice(result.coreStatus === "restart-required" ? "Repair saved. Restart Kestrel to continue." : "The old indexing task was cancelled.");
		} catch (cause) {
			if (current === generation.current) {
				if (plan.current) discard(plan.current);
				plan.current = undefined; setPreview(undefined);
				setError(cause instanceof RecoveryFailure ? cause.message : "Could not complete the repair. Review again to continue.");
			}
		} finally {
			if (current === generation.current) setBusy(false);
		}
	}

	return <details className="memory-agent-knowledge" onToggle={(event) => { if (!event.currentTarget.open) clear(); }}>
		<summary>Repair memory processing</summary>
		<p>This repair applies to the current Kestrel profile, regardless of the selected viewer or domain. Review a repair that pauses Kestrel’s memory processing and cancels one stranded old indexing task. Retry history is preserved; the task will not be retried and permissions will not change.</p>
		{!preview && <button type="button" disabled={busy} onClick={() => void review()}>{busy ? "Preparing review…" : "Review"}</button>}
		{busy && !preview && <button type="button" onClick={clear}>Cancel</button>}
		{preview && <section aria-label="Memory processing repair review">
			<p>This will cancel one stranded old indexing task and preserve its retry history. It will not retry the task or change permissions.</p>
			<p>Review expires {new Date(preview.expiresAt).toLocaleString()}.</p>
			<button type="button" disabled={busy} onClick={() => void apply()}>{busy ? "Saving repair…" : "Cancel old indexing task"}</button>
			<button type="button" disabled={busy} onClick={clear}>Cancel review</button>
		</section>}
		{notice && <p role="status">{notice}</p>}
		{error && <p role="alert">{error}</p>}
	</details>;
}
