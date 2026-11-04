import {
	NativeBookmarkTransferSchema,
	parseNativeBookmarkTransferFile,
	type NativeBookmarkTransfer,
	type UserBrowserBookmarkFolder,
} from "@kestrel/shared-types";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import "./NativeBookmarkTransfer.css";

const MAX_TRANSFER_BYTES = 512 * 1024;
const MAX_SELECTED_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_DESTINATION = "Bookmarks bar";
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

type ChromeDownload = {
	id: number;
	state?: string;
	error?: string;
};
	type ChromeDownloadDelta = { id: number; state?: { current?: string } };
type NativeDownloads = {
	download(options: { url: string; filename: string; saveAs: boolean }): Promise<number>;
	search(query: { id: number }): Promise<ChromeDownload[]>;
	onChanged: {
		addListener(listener: (delta: ChromeDownloadDelta) => void): void;
		removeListener(listener: (delta: ChromeDownloadDelta) => void): void;
	};
};
type ParsedBookmarkFile = ReturnType<typeof parseNativeBookmarkTransferFile>;

function downloadsApi(): NativeDownloads {
	const downloads = (globalThis as typeof globalThis & {
		chrome?: { downloads?: NativeDownloads };
	}).chrome?.downloads;
	if (!downloads) throw new Error("Native bookmark export is unavailable in this window.");
	return downloads;
}

function responseError(response: { ok: false; error: string }): string {
	return response.error || "The bookmark transfer could not be completed.";
}

function formatExpiry(value: string): string {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return "a short time";
	const seconds = Math.max(1, Math.ceil((timestamp - Date.now()) / 1000));
	return `about ${seconds} seconds`;
}

async function waitForSavedDownload(api: NativeDownloads, url: string): Promise<"complete" | "interrupted" | "timeout"> {
	const seen = new Map<number, string>();
	let downloadId: number | undefined;
	let settle: ((result: "complete" | "interrupted" | "timeout") => void) | undefined;
	const done = new Promise<"complete" | "interrupted" | "timeout">((resolve) => { settle = resolve; });
	const onChanged = (delta: ChromeDownloadDelta) => {
		const state = delta.state?.current;
		if (!state) return;
		seen.set(delta.id, state);
		if (downloadId === delta.id && (state === "complete" || state === "interrupted")) settle?.(state);
	};
	api.onChanged.addListener(onChanged);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		// Start directly from the Save button's user gesture so Chromium can show
		// its native Save As panel.
		downloadId = await api.download({ url, filename: "kestrel-bookmarks.json", saveAs: true });
		const observed = seen.get(downloadId);
		if (observed === "complete" || observed === "interrupted") settle?.(observed);
		else {
			// A very small transfer can finish before the listener observes its event.
			const [current] = await api.search({ id: downloadId });
			if (current?.state === "complete" || current?.state === "interrupted") settle?.(current.state);
		}
		timeout = setTimeout(() => settle?.("timeout"), DOWNLOAD_TIMEOUT_MS);
		const result = await done;
		return result;
	} finally {
		if (timeout) clearTimeout(timeout);
		api.onChanged.removeListener(onChanged);
	}
}

export function NativeBookmarkTransfer({ browser }: { browser: UserBrowserController }) {
	const fileInput = useRef<HTMLInputElement | null>(null);
	const planIdRef = useRef<string | undefined>(undefined);
	const generation = useRef(0);
	const [busy, setBusy] = useState<"export-prepare" | "export-save" | "file-read" | "plan" | "apply" | "">("");
	const [transfer, setTransfer] = useState<ParsedBookmarkFile | null>(null);
	const [fileName, setFileName] = useState("");
	const [destination, setDestination] = useState(DEFAULT_DESTINATION);
	const [plan, setPlan] = useState<{ planId: string; summary: { bookmarksToAdd: number; duplicateBookmarks: number; foldersToAdd: number }; expiresAt: string } | null>(null);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const [exportData, setExportData] = useState<NativeBookmarkTransfer | null>(null);

	const discardPlan = (id: string | undefined) => {
		if (!id) return;
		void window.kestrel.request({ type: "browser-discard-bookmark-import", planId: id }).catch(() => undefined);
	};
	const clearPlan = () => {
		generation.current++;
		discardPlan(planIdRef.current);
		planIdRef.current = undefined;
		setPlan(null);
	};
	useEffect(() => () => { generation.current++; discardPlan(planIdRef.current); }, []);

	const prepareExport = async () => {
		const currentGeneration = generation.current;
		setBusy("export-prepare"); setError(""); setStatus(""); setExportData(null);
		try {
			const response = await window.kestrel.request({ type: "browser-export-bookmarks" });
			if (!response.ok) throw new Error(responseError(response));
			if (!("bookmarkTransfer" in response) || !("bookmarkExportExcluded" in response)) throw new Error("The browser did not return bookmark data.");
			const validated = NativeBookmarkTransferSchema.parse(response.bookmarkTransfer);
			if (currentGeneration !== generation.current) return;
			setExportData(validated);
			const excluded = response.bookmarkExportExcluded;
			setStatus(`Ready to save ${validated.bookmarks.length} bookmarks and ${validated.folders.length} folders. ${excluded.bookmarks} bookmarks and ${excluded.folders} folders excluded (managed or unsupported).`);
		} catch (cause) {
			if (currentGeneration !== generation.current) return;
			setError(cause instanceof Error ? cause.message : "Bookmarks could not be prepared for export.");
		} finally { if (currentGeneration === generation.current) setBusy(""); }
	};

	const saveExport = async () => {
		if (!exportData) return;
		const currentGeneration = generation.current;
		setBusy("export-save"); setError(""); setStatus("");
		let objectUrl: string | undefined;
		try {
			const api = downloadsApi();
			const bytes = new TextEncoder().encode(JSON.stringify(exportData));
			if (bytes.byteLength > MAX_TRANSFER_BYTES) throw new Error("This bookmark export is too large to save as one file.");
			objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/json" }));
			const result = await waitForSavedDownload(api, objectUrl);
			if (result === "timeout") {
				setError("The save has not reported completion yet. Check Downloads before trying again.");
				// The download may still be reading this URL. Keep it alive until the
				// extension page closes rather than risking an incomplete file.
				objectUrl = undefined;
				return;
			}
			if (result !== "complete") throw new Error("The save was cancelled or did not complete. Check Downloads before trying again.");
			if (currentGeneration !== generation.current) return;
			setStatus("Bookmark file saved.");
			setExportData(null);
		} catch (cause) {
			if (currentGeneration !== generation.current) return;
			setError(cause instanceof Error ? cause.message : "The bookmark file could not be saved.");
		} finally {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
			if (currentGeneration === generation.current) setBusy("");
		}
	};

	const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		clearPlan(); setTransfer(null); setFileName(""); setError(""); setStatus("");
		if (!file) return;
		if (file.size > MAX_SELECTED_FILE_BYTES) { setError("Choose a Kestrel JSON export smaller than 10 MB."); return; }
		const currentGeneration = generation.current;
		setBusy("file-read");
		try {
			const parsed = parseNativeBookmarkTransferFile(JSON.parse(await file.text()));
			if (currentGeneration !== generation.current) return;
			const normalizedBytes = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
			if (normalizedBytes > MAX_TRANSFER_BYTES) throw new Error("Choose a bookmark file no larger than 512 KB.");
			setTransfer(parsed); setFileName(file.name);
			setStatus(`${parsed.data.bookmarks.length} bookmarks and ${parsed.data.folders.length} folders are ready for review.`);
		} catch (cause) {
			if (currentGeneration !== generation.current) return;
			setError(cause instanceof Error ? cause.message : "Choose a valid Kestrel bookmarks JSON file.");
		} finally { if (currentGeneration === generation.current) setBusy(""); }
	};

	const reviewImport = async () => {
		if (!transfer) return;
		const currentGeneration = generation.current;
		setBusy("plan"); setError(""); setStatus("");
		try {
			const folder = destination === DEFAULT_DESTINATION ? undefined : destination;
			const response = await window.kestrel.request({
				type: "browser-plan-bookmark-import",
				data: transfer.data,
				...(folder ? { destinationFolderId: folder } : {}),
			});
			if (!response.ok) throw new Error(responseError(response));
			if (!("bookmarkImportPlan" in response)) throw new Error("The browser did not return an import review.");
			const received = response.bookmarkImportPlan;
			if (currentGeneration !== generation.current) { discardPlan(received.planId); return; }
			if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(received.planId)) throw new Error("The import review is invalid. Choose the file again.");
			planIdRef.current = received.planId;
			setPlan(received);
			setStatus("Review the counts below, then choose Import bookmarks to apply this plan.");
		} catch (cause) {
			if (currentGeneration !== generation.current) return;
			setError(cause instanceof Error ? cause.message : "The bookmark import could not be reviewed.");
		} finally { if (currentGeneration === generation.current) setBusy(""); }
	};

	const applyImport = async () => {
		const planId = planIdRef.current;
		if (!planId) return;
		const currentGeneration = generation.current;
		// Plans are one-use. Consume the local approval before dispatch so a rapid
		// second click cannot race the same token or leave a stale Apply button.
		planIdRef.current = undefined;
		setPlan(null);
		setBusy("apply"); setError(""); setStatus("");
		try {
			const response = await window.kestrel.request({ type: "browser-apply-bookmark-import", planId });
			if (!response.ok) throw new Error(responseError(response));
			if (!("bookmarkImportResult" in response)) throw new Error("The browser did not return the import result.");
			const result = response.bookmarkImportResult;
			if (currentGeneration !== generation.current) return;
			setTransfer(null); setFileName("");
			if ("browserState" in response) await browser.refresh().catch(() => undefined);
			setStatus(result.complete
				? `Imported ${result.bookmarksAdded} bookmarks and ${result.foldersAdded} folders. ${result.duplicateBookmarks} duplicates skipped.`
				: `Added ${result.bookmarksAdded} bookmarks and ${result.foldersAdded} folders; ${result.duplicateBookmarks} duplicates skipped. Some entries could not be added. Review Saved pages before importing again.`);
			if (!result.complete && result.error) setError(result.error);
		} catch (cause) {
			if (currentGeneration !== generation.current) return;
			setError(cause instanceof Error ? cause.message : "The import result is uncertain. Check Saved pages before reviewing another import.");
			setStatus("This review has been used. No automatic retry was started; check Saved pages before reviewing another import.");
		} finally { if (currentGeneration === generation.current) setBusy(""); }
	};

	const cancelImport = () => {
		clearPlan(); setTransfer(null); setFileName(""); setError(""); setStatus("Import review cancelled.");
		if (fileInput.current) fileInput.current.value = "";
	};
	const folders: UserBrowserBookmarkFolder[] = browser.state?.bookmarkFolders ?? [];

	return <section className="native-bookmark-transfer" aria-labelledby="native-bookmark-transfer-title" data-settings-panel="browser-bookmarks-transfer">
		<header className="native-bookmark-transfer-header"><h3 id="native-bookmark-transfer-title">Bookmarks and transfer</h3></header>
		<p>Move writable HTTP(S) saved pages between Kestrel profiles with a small JSON file. User bookmark titles, links, display modes, and folders are included; managed bookmarks and history, browser settings, site permissions, and sign-ins stay with this profile.</p>
		<div className="setting-row browser-setting-row native-bookmark-transfer-row">
			<div className="browser-setting-copy"><strong>Export bookmarks</strong><small>Choose where to save a portable copy of your bookmarks.</small></div>
			<div className="native-bookmark-actions">
				<button type="button" className="button secondary" data-testid="native-bookmark-export-prepare" onClick={() => void prepareExport()} disabled={Boolean(busy)}>{busy === "export-prepare" ? "Preparing…" : "Prepare bookmark export"}</button>
				{exportData && <button type="button" className="button secondary" data-testid="native-bookmark-export-save" onClick={() => void saveExport()} disabled={Boolean(busy)}>{busy === "export-save" ? "Saving…" : "Save JSON file"}</button>}
			</div>
		</div>
		{transfer && <div className="native-bookmark-plan" data-testid="native-bookmark-import-scope">
			<strong>Only bookmarks and folders will be imported.</strong>
			{(transfer.excluded.history > 0 || transfer.excluded.sitePermissions > 0 || transfer.excluded.settings) && <p>
				{transfer.excluded.history > 0 && `${transfer.excluded.history} history entries will not be imported. `}
				{transfer.excluded.sitePermissions > 0 && `${transfer.excluded.sitePermissions} site permissions will not be imported. `}
				{transfer.excluded.settings && "Browser settings will not be imported."}
			</p>}
			<small>Original bookmark dates do not transfer; Chromium dates imported bookmarks when they are added.</small>
		</div>}
		<div className="setting-row browser-setting-row native-bookmark-transfer-row">
			<div className="browser-setting-copy"><strong>Import bookmarks</strong><small>Review the changes before adding anything to this profile.</small></div>
			<div className="native-bookmark-actions">
				<label className="native-bookmark-destination">Save in
					<select data-testid="native-bookmark-import-destination" value={destination} disabled={Boolean(busy)} onChange={(event) => { clearPlan(); setDestination(event.target.value); setError(""); setStatus("Destination changed. Review the import again before applying it."); }}>
						<option value={DEFAULT_DESTINATION}>{DEFAULT_DESTINATION}</option>
						{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
					</select>
				</label>
				<button type="button" className="button secondary" data-testid="native-bookmark-import-choose" onClick={() => fileInput.current?.click()} disabled={Boolean(busy)}>{fileName || "Choose bookmark file"}</button>
				<input ref={fileInput} className="native-bookmark-file-input" type="file" accept=".json,application/json" onChange={(event) => void readFile(event)} data-testid="native-bookmark-import-file" aria-label="Choose Kestrel bookmarks JSON file" tabIndex={-1} aria-hidden="true" disabled={Boolean(busy)} />
				{transfer && !plan && <button type="button" className="button secondary" data-testid="native-bookmark-import-plan" onClick={() => void reviewImport()} disabled={Boolean(busy)}>{busy === "plan" ? "Reviewing…" : "Review import"}</button>}
				{plan && <>
					<button type="button" className="button secondary" data-testid="native-bookmark-import-apply" onClick={() => void applyImport()} disabled={Boolean(busy)}>{busy === "apply" ? "Importing…" : "Import bookmarks"}</button>
					<button type="button" className="quiet-link" data-testid="native-bookmark-import-cancel" onClick={cancelImport} disabled={Boolean(busy)}>Cancel import</button>
				</>}
			</div>
		</div>
		{plan && <div className="native-bookmark-plan" data-testid="native-bookmark-import-preview" aria-label="Bookmark import review">
			<strong>Review this import</strong>
			<p>Ready to add {plan.summary.bookmarksToAdd} bookmarks and {plan.summary.foldersToAdd} folders. {plan.summary.duplicateBookmarks} existing bookmarks will be skipped.</p>
			<small>This review expires in {formatExpiry(plan.expiresAt)}. No bookmarks are added until you choose Import bookmarks.</small>
		</div>}
		{status && <p className="native-bookmark-transfer-status" data-testid="native-bookmark-transfer-status" role="status" aria-live="polite">{status}</p>}
		{error && <p className="native-bookmark-transfer-error" data-testid="native-bookmark-transfer-error" role="alert">{error}</p>}
	</section>;
}
