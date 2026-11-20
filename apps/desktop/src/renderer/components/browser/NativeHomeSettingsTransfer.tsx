import { MAX_NATIVE_BOOKMARK_SOURCE_BYTES, parseNativeHomeSettingsTransferFile, type NativeHomeSettingsCategory } from "@kestrel/shared-types";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import "./NativeHomeSettingsTransfer.css";

const labels: Record<NativeHomeSettingsCategory, string> = { background: "Background", shortcuts: "Site shortcuts", greeting: "Greeting", widgets: "Widgets" };
type Source = ReturnType<typeof parseNativeHomeSettingsTransferFile>;
type Plan = { planId: string; expiresAt: string; categories: NativeHomeSettingsCategory[]; changedCategories: NativeHomeSettingsCategory[] };
type Undo = { undoId: string; undoExpiresAt: string };
const names = (categories: NativeHomeSettingsCategory[]) => categories.map(category => labels[category]).join(", ");

export function NativeHomeSettingsTransfer({ browser }: { browser: UserBrowserController }) {
 const input = useRef<HTMLInputElement>(null);
 const reviewButton = useRef<HTMLButtonElement>(null);
 const preview = useRef<HTMLDivElement>(null);
 const statusElement = useRef<HTMLParagraphElement>(null);
 const busyRef = useRef(false), generation = useRef(0), planRef = useRef<string | undefined>(undefined), undoRef = useRef<Undo | undefined>(undefined);
 const [busy, setBusy] = useState(false), [source, setSource] = useState<Source | null>(null), [fileName, setFileName] = useState("");
 const [categories, setCategories] = useState<NativeHomeSettingsCategory[]>([]), [plan, setPlan] = useState<Plan | null>(null), [undo, setUndo] = useState<Undo | null>(null);
 const [status, setStatus] = useState(""), [error, setError] = useState("");
 const discard = (id?: string) => { if (id) void window.kestrel.request({ type: "browser-discard-home-settings-import", planId: id }).catch(() => undefined); };
 const clearPlan = () => { discard(planRef.current); planRef.current = undefined; setPlan(null); };
 useEffect(() => () => { generation.current++; discard(planRef.current); }, []);
 useEffect(() => { if (plan) preview.current?.focus(); }, [plan]);
 useEffect(() => {
  if (!plan && !undo) return;
  const expires = Math.min(plan ? Date.parse(plan.expiresAt) : Infinity, undo ? Date.parse(undo.undoExpiresAt) : Infinity);
  const timer = setTimeout(() => {
   if (plan && Date.now() >= Date.parse(plan.expiresAt)) { discard(planRef.current); planRef.current = undefined; setPlan(null); setStatus("Review expired. Review the file again before importing."); }
   if (undo && Date.now() >= Date.parse(undo.undoExpiresAt)) { undoRef.current = undefined; setUndo(null); setStatus("Undo expired. Imported settings remain saved."); }
  }, Math.max(0, expires - Date.now()));
  return () => clearTimeout(timer);
 }, [plan, undo]);
 const begin = () => { if (busyRef.current) return false; busyRef.current = true; setBusy(true); setError(""); setStatus(""); return true; };
 const finish = (current: number) => { if (current === generation.current) { busyRef.current = false; setBusy(false); } };

 async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
  const file = event.target.files?.[0]; event.target.value = "";
  if (!file || !begin()) return;
  clearPlan(); const current = ++generation.current; setSource(null); setFileName(""); setCategories([]);
  try {
   if (!file.size || file.size > MAX_NATIVE_BOOKMARK_SOURCE_BYTES) throw Error("Choose a JSON file up to 10 MiB.");
   const parsed = parseNativeHomeSettingsTransferFile(JSON.parse(await file.text()));
   if (current !== generation.current) return;
   setSource(parsed); setFileName(file.name); setCategories([]);
  } catch { if (current === generation.current) setError("This file could not be read as supported Home settings. Choose a valid Kestrel export up to 10 MiB."); }
  finally { finish(current); }
 }
 async function review() {
  if (!source || !categories.length || !begin()) return;
  clearPlan(); const current = generation.current;
  try {
   const response = await window.kestrel.request({ type: "browser-plan-home-settings-import", settings: source.settings, categories });
   if (current !== generation.current) { if (response.ok && "homeSettingsImportPlan" in response) discard(response.homeSettingsImportPlan.planId); return; }
   if (!response.ok) throw Error(response.error);
   if (!("homeSettingsImportPlan" in response)) throw Error("The browser did not return a review.");
   planRef.current = response.homeSettingsImportPlan.planId; setPlan(response.homeSettingsImportPlan);
  } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "The review could not be prepared."); }
  finally { finish(current); }
 }
 async function apply() {
  const id = planRef.current; if (!id || !begin()) return;
  planRef.current = undefined; setPlan(null); undoRef.current = undefined; setUndo(null); const current = generation.current;
  try {
   const response = await window.kestrel.request({ type: "browser-apply-home-settings-import", planId: id });
   if (current !== generation.current) return;
   if (!response.ok) throw Error(response.error);
   if (!("homeSettingsImportResult" in response)) throw Error("The import result is uncertain. Check Home before reviewing another import.");
   const result = response.homeSettingsImportResult;
   undoRef.current = result; setUndo(result); setSource(null); setCategories([]); setFileName("");
   setStatus(result.changedCategories.length ? `Home settings imported: ${names(result.changedCategories)}.` : "Selected Home settings already match this profile.");
   await browser.refresh().catch(() => undefined);
  } catch (cause) { if (current === generation.current) { setError(cause instanceof Error ? cause.message : "The import result is uncertain."); setStatus("This review has been used. Check Home before reviewing another import."); } }
  finally { finish(current); statusElement.current?.focus(); }
 }
 async function undoImport() {
  const token = undoRef.current; if (!token || !begin()) return;
  undoRef.current = undefined; setUndo(null); const current = generation.current;
  try {
   const response = await window.kestrel.request({ type: "browser-undo-home-settings-import", undoId: token.undoId });
   if (current !== generation.current) return;
   if (!response.ok) throw Error(response.error);
   if (!("homeSettingsUndoResult" in response)) throw Error("The undo result is uncertain. Check Home.");
   setStatus(`Previous Home settings restored: ${names(response.homeSettingsUndoResult.restoredCategories)}.`);
   await browser.refresh().catch(() => undefined);
  } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : "The undo result is uncertain. Check Home."); }
  finally { finish(current); statusElement.current?.focus(); }
 }
 return <section className="native-home-transfer" data-settings-panel="browser-home-settings-transfer" aria-labelledby="native-home-transfer-heading" aria-busy={busy}>
  <h3 id="native-home-transfer-heading">Bring your Home settings</h3>
  <p>Choose a Kestrel export and review the Home settings to replace.</p>
  <p id="native-home-transfer-scope" className="native-home-transfer-hint">Home settings only. Bookmarks, history, browser preferences, permissions and credentials are excluded.</p>
  <input ref={input} className="native-home-transfer-file" type="file" accept="application/json,.json" aria-label="Choose Home settings JSON file" aria-describedby="native-home-transfer-scope" data-testid="native-home-settings-import-file" tabIndex={-1} disabled={busy} onChange={event => void chooseFile(event)} />
  <div className="native-home-transfer-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => input.current?.click()}>Choose JSON file…</button><span className="native-home-transfer-filename">{fileName || "No file chosen"}</span></div>
  {source && <>
   <fieldset disabled={busy || !!plan}><legend>Settings to replace</legend>{source.availableCategories.map(category => <label key={category}><input type="checkbox" checked={categories.includes(category)} onChange={event => { clearPlan(); setCategories(previous => event.target.checked ? [...previous, category] : previous.filter(item => item !== category)); }} />{labels[category]}</label>)}</fieldset>
   {!plan && <button type="button" className="button secondary" ref={reviewButton} disabled={busy || !categories.length} data-testid="native-home-settings-import-plan" onClick={() => void review()}>{busy ? "Working…" : "Review import"}</button>}
   {plan && <div ref={preview} tabIndex={-1} className="native-home-transfer-preview" data-testid="native-home-settings-import-preview">
    <p><strong>Replace: {names(plan.categories)}</strong></p>
    <p>{plan.changedCategories.length ? "Only selected settings present in the file will change." : "The selected settings already match."}</p>
    <p className="native-home-transfer-hint">Review and undo expire after two minutes. Closing this Settings page or restarting ends undo.</p>
    <button type="button" className="button secondary" disabled={busy} data-testid="native-home-settings-import-apply" onClick={() => void apply()}>Import Home settings</button>
   </div>}
   <button type="button" className="button secondary" disabled={busy} onClick={() => { generation.current++; clearPlan(); setSource(null); setFileName(""); setCategories([]); setError(""); setStatus("Import review cancelled."); }}>Cancel import</button>
  </>}
  {undo && <button type="button" className="button secondary" disabled={busy} data-testid="native-home-settings-import-undo" onClick={() => void undoImport()}>Undo Home settings import</button>}
  <p ref={statusElement} tabIndex={-1} role="status" data-testid="native-home-settings-transfer-status">{status}</p>
  {error && <p role="alert" className="native-home-transfer-error" data-testid="native-home-settings-transfer-error">{error}</p>}
 </section>;
}
