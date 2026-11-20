import {
	NativeHistoryTransferSchema,
	MAX_NATIVE_HISTORY_TRANSFER_BYTES,
	MAX_NATIVE_HISTORY_SOURCE_BYTES,
	parseNativeHistoryTransferFile,
	type NativeHistoryTransfer,
} from "@kestrel/shared-types";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import "./NativeBookmarkTransfer.css";

type DownloadState = "complete" | "interrupted" | "timeout";
type Downloads = {
	download(options: { url: string; filename: string; saveAs: boolean }): Promise<number>;
	search(query: { id: number }): Promise<{ state?: string }[]>;
	onChanged: { addListener(listener: (delta: DownloadDelta) => void): void; removeListener(listener: (delta: DownloadDelta) => void): void };
};
type DownloadDelta = { id: number; state?: { current?: string } };
type ParsedFile = ReturnType<typeof parseNativeHistoryTransferFile>;
type Plan = { planId: string; expiresAt: string; summary: { entriesToAdd: number; duplicateEntries: number } };

async function saveDownload(url: string): Promise<DownloadState> {
	const api = (globalThis as typeof globalThis & { chrome?: { downloads?: Downloads } }).chrome?.downloads;
	if (!api) throw new Error("History export is unavailable in this window.");
	const seen = new Map<number, string>();
	let id: number | undefined;
	let settle: (result: DownloadState) => void = () => undefined;
	const done = new Promise<DownloadState>((resolve) => { settle = resolve; });
	const listener = (delta: DownloadDelta) => {
		const state = delta.state?.current;
		if (!state) return;
		seen.set(delta.id, state);
		if (delta.id === id && (state === "complete" || state === "interrupted")) settle(state);
	};
	api.onChanged.addListener(listener);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		id = await api.download({ url, filename: "kestrel-history.json", saveAs: true });
		const state = seen.get(id) ?? (await api.search({ id }))[0]?.state;
		if (state === "complete" || state === "interrupted") settle(state);
		timer = setTimeout(() => settle("timeout"), 10 * 60_000);
		return await done;
	} finally {
		if (timer) clearTimeout(timer);
		api.onChanged.removeListener(listener);
	}
}

export function NativeHistoryTransfer({ browser }: { browser: UserBrowserController }) {
	const fileInput = useRef<HTMLInputElement | null>(null);
	const chooseButton = useRef<HTMLButtonElement | null>(null);
	const applyButton = useRef<HTMLButtonElement | null>(null);
	const restoreFocus = useRef(false);
	const generation = useRef(0);
	const planId = useRef<string | undefined>(undefined);
	const [busy, setBusy] = useState("");
	const [file, setFile] = useState<ParsedFile | null>(null);
	const [fileName, setFileName] = useState("");
	const [plan, setPlan] = useState<Plan | null>(null);
	const [exportData, setExportData] = useState<NativeHistoryTransfer | null>(null);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");

	const discard = (id: string | undefined) => {
		if (id) void window.kestrel.request({ type: "browser-discard-history-import", planId: id }).catch(() => undefined);
	};
	const clearPlan = () => {
		generation.current++;
		discard(planId.current);
		planId.current = undefined;
		setPlan(null);
	};
	useEffect(() => () => { generation.current++; discard(planId.current); }, []);
	useEffect(() => {
		if (busy) return;
		if (plan) applyButton.current?.focus();
		else if (restoreFocus.current) { chooseButton.current?.focus(); restoreFocus.current = false; }
	}, [busy, plan]);

	const prepareExport = async () => {
		const current = generation.current;
		setBusy("prepare"); setError(""); setStatus(""); setExportData(null);
		try {
			const response = await window.kestrel.request({ type: "browser-export-history" });
			if (!response.ok) throw new Error(response.error);
			if (!("historyTransfer" in response) || !("historyExportExcluded" in response)) throw new Error("The browser did not return history data.");
			const data = NativeHistoryTransferSchema.parse(response.historyTransfer);
			if (current !== generation.current) return;
			setExportData(data);
			const excluded = response.historyExportExcluded;
			setStatus(`Ready to save ${data.entries.length} history entries. ${excluded.nativeTruncated ? `At least ${excluded.entries} entries excluded; Chromium returned only a bounded recent sample.` : `${excluded.entries} entries excluded.`}`);
		} catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "History could not be prepared for export."); }
		finally { if (current === generation.current) setBusy(""); }
	};
	const saveExport = async () => {
		if (!exportData) return;
		const current = generation.current;
		setBusy("save"); setError(""); setStatus("");
		let url: string | undefined;
		try {
			const bytes = new TextEncoder().encode(JSON.stringify(exportData));
			if (bytes.byteLength > MAX_NATIVE_HISTORY_TRANSFER_BYTES) throw new Error("This history export is too large to save as one file.");
			url = URL.createObjectURL(new Blob([bytes], { type: "application/json" }));
			const result = await saveDownload(url);
			if (result === "timeout") { url = undefined;
				if (current !== generation.current) return; throw new Error("The save has not reported completion yet. Check Downloads before trying again."); }
			if (current !== generation.current) return;
			if (result !== "complete") throw new Error("The save was cancelled or did not complete. Check Downloads before trying again.");
			setStatus("History file saved."); setExportData(null);
		} catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "The history file could not be saved."); }
		finally { if (url) URL.revokeObjectURL(url); if (current === generation.current) setBusy(""); }
	};
	const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
		const selected = event.target.files?.[0];
		event.target.value = "";
		if (!selected) return;
		clearPlan(); setFile(null); setFileName(""); setError(""); setStatus("");
		if (selected.size > MAX_NATIVE_HISTORY_SOURCE_BYTES) { setError("Choose a Kestrel JSON export no larger than 10 MB."); return; }
		const current = generation.current;
		setBusy("read");
		try {
			const parsed = parseNativeHistoryTransferFile(JSON.parse(await selected.text()));
			if (current !== generation.current) return;
			if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > MAX_NATIVE_HISTORY_TRANSFER_BYTES) throw new Error("Choose history data no larger than 1 MB.");
			setFile(parsed); setFileName(selected.name); setStatus(`${parsed.data.entries.length} history entries are ready for review.`);
		} catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "Choose a valid Kestrel history JSON file."); }
		finally { if (current === generation.current) setBusy(""); }
	};
	const review = async () => {
		if (!file) return;
		const current = generation.current;
		setBusy("review"); setError(""); setStatus("");
		try {
			const response = await window.kestrel.request({ type: "browser-plan-history-import", data: file.data });
			if (!response.ok) throw new Error(response.error);
			if (!("historyImportPlan" in response)) throw new Error("The browser did not return an import review.");
			const received = response.historyImportPlan;
			if (current !== generation.current) { discard(received.planId); return; }
			planId.current = received.planId; setPlan(received); setStatus("Review the counts below before importing.");
		} catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "The history import could not be reviewed."); }
		finally { if (current === generation.current) setBusy(""); }
	};
	const apply = async () => {
		const id = planId.current;
		if (!id) return;
		const current = generation.current;
		const count = plan?.summary.entriesToAdd ?? 0;
		planId.current = undefined; restoreFocus.current = true; setPlan(null); setBusy("apply"); setError(""); setStatus("");
		try {
			const response = await window.kestrel.request({ type: "browser-apply-history-import", planId: id });
			if (!response.ok) throw new Error(response.error);
			if (!("browserState" in response)) throw new Error("The browser did not return the import result.");
			if (current !== generation.current) return;
			await browser.refresh().catch(() => undefined);
			if (current !== generation.current) return;
			setFile(null); setFileName(""); setStatus(`Imported ${count} history ${count === 1 ? "entry" : "entries"}.`);
		} catch (cause) {
			if (current !== generation.current) return;
			setError(cause instanceof Error ? cause.message : "The import result is uncertain. Check history before reviewing another import.");
			setStatus("This review has been used. Check history before reviewing another import.");
		} finally { if (current === generation.current) setBusy(""); }
	};
	const cancel = () => { clearPlan(); setFile(null); setFileName(""); setError(""); setStatus("History import cancelled."); chooseButton.current?.focus(); };

	return <section className="native-bookmark-transfer" aria-labelledby="native-history-transfer-title" data-settings-panel="browser-history-transfer">
		<header className="native-bookmark-transfer-header"><h3 id="native-history-transfer-title">Transfer history</h3></header>
		<p>Imported entries appear in Kestrel with their original dates and titles, labeled Imported. They do not appear in Chromium native history or the omnibox.</p>
		<button type="button" className="quiet-link" onClick={() => void browser.createTab("kestrel://history")}>Open Kestrel history</button>
		<p><small>To remove all imported records, use Clear browsing history in Kestrel. Chromium date-range clears may leave imported records.</small></p>
		{browser.error && <p className="native-bookmark-transfer-error" role="alert" data-testid="native-history-sync-error">{browser.error}</p>}
		<div className="setting-row browser-setting-row native-bookmark-transfer-row">
			<div className="browser-setting-copy"><strong>Export history</strong><small>Save supported entries from Kestrel’s recent history. Older Chromium records may be omitted.</small></div>
			<div className="native-bookmark-actions">
				<button type="button" className="button secondary" data-testid="native-history-export-prepare" onClick={() => void prepareExport()} disabled={Boolean(busy)}>{busy === "prepare" ? "Preparing…" : "Prepare history export"}</button>
				{exportData && <button type="button" className="button secondary" data-testid="native-history-export-save" onClick={() => void saveExport()} disabled={Boolean(busy)}>{busy === "save" ? "Saving…" : "Save JSON file"}</button>}
			</div>
		</div>
		{file && <div className="native-bookmark-plan" data-testid="native-history-import-scope"><strong>Only history will be imported.</strong>{file.source === "browser-data" && <p>{file.excluded.bookmarks} bookmarks and {file.excluded.sitePermissions} site permissions will not be imported. {file.excluded.settings && "Browser settings will not be imported."}</p>}</div>}
		<div className="setting-row browser-setting-row native-bookmark-transfer-row native-bookmark-import-row">
			<div className="browser-setting-copy"><strong>Import history</strong><small>Review changes before adding entries to Kestrel.</small></div>
			<div className="native-bookmark-actions">
				<button ref={chooseButton} type="button" className="button secondary" data-testid="native-history-import-choose" onClick={() => fileInput.current?.click()} disabled={Boolean(busy)}>{fileName || "Choose history file"}</button>
				<input ref={fileInput} className="native-bookmark-file-input" type="file" accept=".json,application/json" onChange={(event) => void readFile(event)} data-testid="native-history-import-file" aria-label="Choose Kestrel history JSON file" tabIndex={-1} aria-hidden="true" disabled={Boolean(busy)} />
				{file && !plan && <button type="button" className="button secondary" data-testid="native-history-import-plan" onClick={() => void review()} disabled={Boolean(busy)}>{busy === "review" ? "Reviewing…" : "Review import"}</button>}
				{plan && <button ref={applyButton} type="button" className="button secondary" data-testid="native-history-import-apply" onClick={() => void apply()} disabled={Boolean(busy)}>Import history</button>}
				{file && <button type="button" className="quiet-link" onClick={cancel} disabled={Boolean(busy)}>Cancel import</button>}
			</div>
		</div>
		{plan && <div className="native-bookmark-plan" data-testid="native-history-import-preview" aria-label="History import review"><strong>Review this import</strong><p>Ready to add {plan.summary.entriesToAdd} entries. {plan.summary.duplicateEntries} duplicates will be skipped.</p><small>This review expires at {new Date(plan.expiresAt).toLocaleTimeString()}. No entries are added until you choose Import history.</small></div>}
		{status && <p className="native-bookmark-transfer-status" data-testid="native-history-transfer-status" role="status" aria-live="polite">{status}</p>}
		{error && <p className="native-bookmark-transfer-error" data-testid="native-history-transfer-error" role="alert">{error}</p>}
	</section>;
}
